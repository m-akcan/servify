/**
 * Deploy pipeline: queued → building (pull or build) → deploying (start new replicas, health-check)
 * → active (switch traffic, drain old). Failed deploys never touch the running version.
 */
import { createWriteStream, existsSync, readFileSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { docker, normalizeImageRef } from './docker.ts';
import { deployments as deploymentsTable, services as servicesTable, projects as projectsTable } from './db.ts';
import type { Deployment, DeployTrigger, Service } from './types.ts';
import { bus, recordActivity, type Actor } from './events.ts';
import { config } from './config.ts';
import { id, KeyedLock } from './util.ts';
import { resolveEnv } from './vars.ts';
import {
  busy,
  createReplica,
  drainAndRemove,
  effectiveReplicas,
  replicasOf,
  requestReconcile,
  tailContainer,
  waitHealthy,
  refreshServiceStatus,
  LABEL,
} from './engine.ts';
import { buildSource } from './builder.ts';

const lock = new KeyedLock();
const logStreams = new Map<string, WriteStream>();

export function deploymentLogPath(depId: string) {
  return join(config.logsDir, `deploy-${depId}.log`);
}

export function readDeploymentLog(depId: string): string[] {
  const p = deploymentLogPath(depId);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean);
}

function logger(dep: Deployment) {
  let ws = logStreams.get(dep.id);
  if (!ws) {
    ws = createWriteStream(deploymentLogPath(dep.id), { flags: 'a' });
    logStreams.set(dep.id, ws);
  }
  const stream = ws;
  return (line: string) => {
    const ts = Date.now();
    const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    stream.write(`${ts} ${clean}\n`);
    bus.publish({ type: 'deployment.log', deploymentId: dep.id, serviceId: dep.serviceId, line: clean, ts });
  };
}

function closeLog(depId: string) {
  logStreams.get(depId)?.end();
  logStreams.delete(depId);
}

function saveDep(dep: Deployment) {
  deploymentsTable.put(dep);
  bus.publish({ type: 'deployment.updated', deployment: dep });
}

function setServiceStatus(serviceId: string, status: Service['status'], patch: Partial<Service> = {}) {
  const svc = servicesTable.get(serviceId);
  if (!svc) return;
  Object.assign(svc, patch, { status, updatedAt: Date.now() });
  servicesTable.put(svc);
  bus.publish({ type: 'service.updated', service: svc });
}

function sourceLabel(svc: Service): string {
  const s = svc.source;
  if (s.type === 'image') return s.image;
  if (s.type === 'git') return `${s.repo.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '')}${s.branch ? `@${s.branch}` : ''}`;
  return s.path;
}

/** Queue a deployment for the service. Returns immediately; the pipeline runs in the background. */
export function queueDeployment(
  svc: Service,
  trigger: DeployTrigger,
  actor: Actor,
  opts: { image?: string; port?: number | null; fromDeployment?: Deployment } = {},
): Deployment {
  // Cancel older queued deployments of this service — only the newest matters.
  for (const d of deploymentsTable.all('WHERE service_id = ?', svc.id)) {
    if (d.status === 'queued') {
      d.status = 'cancelled';
      d.finishedAt = Date.now();
      saveDep(d);
    }
  }
  const base = opts.fromDeployment;
  const dep: Deployment = {
    id: id('dep'),
    serviceId: svc.id,
    projectId: svc.projectId,
    status: 'queued',
    image: opts.image ?? null,
    port: opts.port ?? null,
    sourceLabel: base?.sourceLabel ?? sourceLabel(svc),
    commitSha: base?.commitSha ?? null,
    commitMessage: base?.commitMessage ?? null,
    builder: base?.builder ?? null,
    trigger,
    actor: actor.name,
    config: base
      ? structuredClone(base.config)
      : {
          env: { ...svc.env },
          port: svc.port,
          protocol: svc.protocol,
          startCommand: svc.startCommand,
          volumes: structuredClone(svc.volumes),
          resources: { ...svc.resources },
          source: structuredClone(svc.source),
        },
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    error: null,
  };
  deploymentsTable.insert(dep);
  bus.publish({ type: 'deployment.updated', deployment: dep });
  recordActivity(
    actor,
    'deployment.queued',
    trigger === 'rollback' ? `Rolled back ${svc.name}` : `Deploy ${svc.name} (${dep.sourceLabel})`,
    svc.projectId,
    svc.id,
  );
  void lock.run(svc.id, () => runDeployment(dep.id, actor));
  return dep;
}

async function runDeployment(depId: string, actor: Actor) {
  const dep = deploymentsTable.get(depId);
  if (!dep || dep.status !== 'queued') return;
  let svc = servicesTable.get(dep.serviceId);
  if (!svc) return;
  const log = logger(dep);
  const inflight = busy.get(svc.id) ?? new Set<string>();
  busy.set(svc.id, inflight);
  inflight.add(dep.id);
  dep.startedAt = Date.now();
  let newContainers: string[] = [];

  try {
    // ─── build / pull ───
    dep.status = 'building';
    saveDep(dep);
    setServiceStatus(svc.id, 'building');
    const src = dep.config.source;
    if (!dep.image) {
      if (src.type === 'image') {
        const ref = normalizeImageRef(src.image);
        const local = await docker.inspectImage(ref);
        if (!local || ref.endsWith(':latest')) {
          log(`▸ Pulling ${ref}`);
          try {
            await docker.pullImage(ref, (l) => log(l));
          } catch (e) {
            if (!local) throw e;
            log(`! pull failed (${(e as Error).message}); using cached image`);
          }
        } else {
          log(`▸ Using cached image ${ref}`);
        }
        dep.image = ref;
        dep.builder = 'image';
      } else {
        const project = projectsTable.get(svc.projectId)!;
        const result = await buildSource(svc, project, dep, log);
        dep.image = result.image;
        dep.commitSha = result.commitSha;
        dep.commitMessage = result.commitMessage;
        dep.builder = result.builder;
        if (result.commitSha) dep.sourceLabel = `${sourceLabel(svc)} · ${result.commitSha.slice(0, 7)}`;
      }
    } else {
      log(`▸ Reusing image ${dep.image}`);
    }

    // ─── port detection ───
    const img = await docker.inspectImage(dep.image!);
    if (!img) throw new Error(`image ${dep.image} not found after build`);
    const exposed = Object.keys(img.Config?.ExposedPorts ?? {})
      .filter((p) => p.endsWith('/tcp'))
      .map((p) => Number.parseInt(p, 10))
      .sort((a, b) => a - b);
    if (dep.config.protocol === 'none') dep.port = null;
    else dep.port = dep.config.port ?? dep.port ?? exposed[0] ?? 8080;
    log(`▸ Image ready · ${dep.config.protocol === 'none' ? 'worker (no port)' : `port ${dep.port}`}`);

    // Resolve variables against the project now, so every replica gets identical env.
    svc = servicesTable.get(svc.id)!;
    const project = projectsTable.get(svc.projectId)!;
    const siblings = servicesTable.all('WHERE project_id = ?', svc.projectId);
    const { env, unresolved } = resolveEnv(svc, dep.config.env, project, siblings, dep.port);
    if (unresolved.length) log(`! unresolved variable references: ${unresolved.join(', ')}`);
    (dep as any).resolvedEnv = env;

    // ─── deploy ───
    dep.status = 'deploying';
    saveDep(dep);
    setServiceStatus(svc.id, 'deploying');
    const want = Math.max(1, effectiveReplicas({ ...svc, stopped: false }));
    const oldContainers = replicasOf(svc.id)
      .filter((r) => r.deploymentId !== dep.id)
      .map((r) => r.containerId);
    const recreate = dep.config.volumes.length > 0;
    if (recreate && oldContainers.length) {
      log(`▸ Stateful service: stopping ${oldContainers.length} old replica(s) before starting the new one`);
      await drainAndRemove(oldContainers, 3000);
    }
    log(`▸ Starting ${want} replica${want > 1 ? 's' : ''}`);
    newContainers = await Promise.all(
      Array.from({ length: want }, (_, i) => createReplica(svc!, dep, i)),
    );
    const grace = (svc.healthcheck.graceSec || 60) * 1000;
    const health = await waitHealthy(newContainers, svc, grace, log);
    if (!health.ok) {
      if (health.cid) {
        const tail = await tailContainer(health.cid, 40);
        if (tail.length) {
          log('── last output from the failing replica ──');
          for (const l of tail) log(l);
        }
      }
      throw new Error(health.reason ?? 'replicas failed health checks');
    }
    log(`✓ ${want}/${want} replicas healthy`);

    // ─── switch traffic ───
    svc = servicesTable.get(svc.id)!;
    const prevActive = svc.activeDeploymentId;
    dep.status = 'active';
    dep.finishedAt = Date.now();
    saveDep(dep);
    if (prevActive && prevActive !== dep.id) {
      const prev = deploymentsTable.get(prevActive);
      if (prev && prev.status === 'active') {
        prev.status = 'superseded';
        saveDep(prev);
      }
    }
    setServiceStatus(svc.id, 'running', { activeDeploymentId: dep.id, stopped: false, port: svc.port });
    log(`✓ Traffic switched to ${dep.id.slice(-6)}`);
    recordActivity(actor, 'deployment.active', `${svc.name} is live (${dep.sourceLabel})`, svc.projectId, svc.id);

    if (!recreate && oldContainers.length) {
      log(`▸ Draining ${oldContainers.length} old replica(s)`);
      await drainAndRemove(oldContainers);
    }
    log('✓ Deploy complete');
  } catch (e) {
    const msg = (e as Error).message || String(e);
    log(`✗ ${msg}`);
    dep.status = 'failed';
    dep.error = msg;
    dep.finishedAt = Date.now();
    saveDep(dep);
    if (newContainers.length) await drainAndRemove(newContainers, 0);
    const s = servicesTable.get(dep.serviceId);
    if (s) {
      setServiceStatus(s.id, s.activeDeploymentId ? 'running' : 'failed');
    }
    recordActivity(actor, 'deployment.failed', `Deploy of ${svc?.name ?? 'service'} failed: ${msg.slice(0, 140)}`, dep.projectId, dep.serviceId);
  } finally {
    inflight.delete(dep.id);
    if (!inflight.size) busy.delete(dep.serviceId);
    closeLog(dep.id);
    refreshServiceStatus(dep.serviceId);
    requestReconcile();
  }
}

export function isDeploying(serviceId: string) {
  return busy.has(serviceId);
}

export { LABEL };
