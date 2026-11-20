/**
 * Deploy pipeline: queued → building (pull or build) → deploying (start new replicas, health-check)
 * → active (switch traffic, drain old). Failed deploys never touch the running version.
 */
import { createWriteStream, existsSync, readFileSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { databaseOf, normalizeImageRef, type DockerClient } from './docker.ts';
import { dockerFor, nodeOf, nodeName, onlineNodes, LOCAL } from './nodes.ts';
import { spawn } from 'node:child_process';
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
  converging,
} from './engine.ts';
import { buildSource, imageTag } from './builder.ts';
import { nextRun } from './cron.ts';
import { notify } from './notify.ts';
import { hasSharedVolume } from './volumes.ts';

/** Order to roll per-replica services in (clusters override: standbys first, primary last). */
let rollingOrderHook: ((svc: Service, want: number) => number[] | null) | null = null;
export function setRollingOrder(fn: typeof rollingOrderHook) {
  rollingOrderHook = fn;
}
function rollingOrder(svc: Service, want: number): number[] {
  return rollingOrderHook?.(svc, want) ?? Array.from({ length: want }, (_, i) => i);
}
import { iconForStack, referencedServicesOn } from './ops.ts';

const lock = new KeyedLock();

/** `docker pull` through the CLI, which uses the user's credential store. */
function cliPull(d: DockerClient, ref: string, log: (l: string) => void): Promise<boolean> {
  return new Promise((resolve) => {
    log(`▸ Retrying pull with the docker CLI (uses your docker login credentials)`);
    const child = spawn('docker', ['pull', ref], { env: { ...process.env, DOCKER_HOST: d.hostEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (b: Buffer) => {
      for (const l of b.toString('utf8').split(/\r?\n/)) if (l.trim() && !/Downloading|Extracting|Waiting/.test(l)) log(l);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}
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
  if (s.type === 'external') return s.url;
  if (s.type === 'redirect') return `→ ${s.to}`;
  if (s.type === 'image') return s.image;
  if (s.type === 'git') return `${s.repo.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '')}${s.branch ? `@${s.branch}` : ''}`;
  return (s as any).path;
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
      ? // Rollbacks/restarts reuse the old image and settings, but always mount today's volumes.
        { ...structuredClone(base.config), volumes: structuredClone(svc.volumes), ports: structuredClone(svc.ports ?? []) }
      : {
          env: { ...svc.env },
          port: svc.port,
          protocol: svc.protocol,
          startCommand: svc.startCommand,
          cmd: svc.cmd ?? null,
          entrypoint: svc.entrypoint ?? null,
          volumes: structuredClone(svc.volumes),
          ports: structuredClone(svc.ports ?? []),
          resources: { ...svc.resources },
          source: structuredClone(svc.source),
          schedule: svc.schedule ?? null,
        } as any,
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
    const node = nodeOf(svc);
    const d = dockerFor(node);
    dep.nodeId = node === LOCAL ? null : node;
    if (node !== LOCAL) log(`▸ Deploying on server ${nodeName(node)}`);
    const crossRefs = referencedServicesOn(svc);
    if (crossRefs.length) log(`! ${svc.name} references ${crossRefs.join(', ')} on another server — private names (and \${{ ….HOST }}) only resolve on the same server. Move them together, or use their public URL / TCP address.`);
    // Images live per server: after a move, a rollback or restart may find its image elsewhere.
    if (dep.image && !(await d.inspectImage(dep.image))) {
      if (src.type === 'image' && !dep.image.startsWith('servify/')) {
        log(`▸ ${dep.image} is not on ${nodeName(node)} yet`);
        dep.image = null; // pulled below
      } else {
        // A built image: copy the exact image from a server that has it (a rebuild could produce different code).
        let from: string | null = null;
        for (const n of onlineNodes()) {
          if (n !== node && (await dockerFor(n).inspectImage(dep.image).catch(() => null))) {
            from = n;
            break;
          }
        }
        if (!from) throw new Error(`image ${dep.image} is no longer on any server — deploy again to ${src.type === 'image' ? 'pull' : 'build'} it fresh`);
        log(`▸ Copying ${dep.image} from ${nodeName(from)} to ${nodeName(node)}`);
        await d.loadImage(await dockerFor(from).exportImage(dep.image));
      }
    }
    if (!dep.image) {
      if (src.type === 'image') {
        const ref = normalizeImageRef(src.image);
        const local = await d.inspectImage(ref);
        if (!local || ref.endsWith(':latest')) {
          log(`▸ Pulling ${ref}`);
          try {
            await d.pullImage(ref, (l) => log(l));
          } catch (e) {
            // The Engine API doesn't see `docker login` credentials; the CLI does (private registries).
            const viaCli = await cliPull(d, ref, log);
            if (!viaCli) {
              if (!local) throw e;
              log(`! pull failed (${(e as Error).message}); using cached image`);
            }
          }
        } else {
          log(`▸ Using cached image ${ref}`);
        }
        dep.image = ref;
        dep.builder = 'image';
        // A tag like `:latest` moves on. Pin this deployment to the exact image under its own name, so
        // rollbacks, restarts and moves bring back this image, not whatever the tag points at by then.
        // Kept and cleaned up like built images (the last 5 per service stay for rollbacks).
        const pinned = await d.inspectImage(ref);
        const project = projectsTable.get(svc.projectId);
        if (!project) throw new Error('the project was deleted');
        if (pinned?.Id) {
          const tag = imageTag(project, svc, dep);
          await d.tagImage(pinned.Id, tag);
          dep.image = tag;
          dep.sourceLabel = `${sourceLabel(svc)} · ${String(pinned.Id).replace(/^sha256:/, '').slice(0, 7)}`;
          log(`▸ Using ${ref} (${String(pinned.Id).replace(/^sha256:/, '').slice(0, 12)}) as ${tag}`);
        }
      } else {
        const project = projectsTable.get(svc.projectId)!;
        const result = await buildSource(svc, project, dep, log);
        dep.image = result.image;
        dep.commitSha = result.commitSha;
        dep.commitMessage = result.commitMessage;
        dep.builder = result.builder;
        if (result.commitSha) dep.sourceLabel = `${sourceLabel(svc)} · ${result.commitSha.slice(0, 7)}`;
        // Swap the generic git/folder icon for the detected language once we know it.
        const fresh = servicesTable.get(svc.id);
        const langIcon = iconForStack(result.builder.replace(/ · buildkit$/, ''));
        if (fresh && langIcon && (fresh.icon === 'git' || fresh.icon === 'folder')) setServiceStatus(svc.id, fresh.status, { icon: langIcon });
      }
    } else {
      log(`▸ Reusing image ${dep.image}`);
    }

    // ─── port detection ───
    const img = await d.inspectImage(dep.image!);
    if (!img) throw new Error(`image ${dep.image} not found after build`);
    dep.database = databaseOf(img); // how backups dump it, whatever the image is called
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

    // ─── scheduled job: nothing long-lived to start, the image is simply armed ───
    const schedule = ((dep.config as any).schedule as string | null) ?? null;
    if (schedule) {
      dep.status = 'active';
      dep.finishedAt = Date.now();
      saveDep(dep);
      const prevActive = svc.activeDeploymentId;
      if (prevActive && prevActive !== dep.id) {
        const prev = deploymentsTable.get(prevActive);
        if (prev && prev.status === 'active') {
          prev.status = 'superseded';
          saveDep(prev);
        }
      }
      setServiceStatus(svc.id, 'running', { activeDeploymentId: dep.id, stopped: false, detectedPort: dep.port });
      const next = nextRun(schedule);
      log(`✓ Cron job armed — schedule "${schedule}"${next ? `, next run ${next.toLocaleString()}` : ''}`);
      const old = replicasOf(svc.id).map((r) => r.containerId);
      if (old.length) await drainAndRemove(old, 2000);
      recordActivity(actor, 'deployment.active', `${svc.name} armed on schedule ${schedule}`, svc.projectId, svc.id);
      return;
    }

    // ─── deploy ───
    dep.status = 'deploying';
    saveDep(dep);
    setServiceStatus(svc.id, 'deploying');
    // Let any reconcile already touching this service finish before we take ownership.
    for (let i = 0; converging.has(svc.id) && i < 100; i++) await new Promise((r) => setTimeout(r, 100));
    // Shared volume → one replica, recreated. Per-replica volumes → rolled one index at a time (replica i's
    // data is never mounted by two containers). Stateless → surge.
    // Fixed host ports can't be held by two containers at once: one replica, old one stopped first.
    const shared = hasSharedVolume(dep.config.volumes) || hasSharedVolume(svc.volumes) || !!dep.config.ports?.length;
    const rolling = !shared && dep.config.volumes.some((v) => v.perReplica);
    const want = shared ? 1 : Math.max(1, svc.replicas);
    const oldContainers = replicasOf(svc.id)
      .filter((r) => r.deploymentId !== dep.id)
      .map((r) => r.containerId);
    const recreate = shared;
    if (recreate && oldContainers.length) {
      log(`▸ Stateful service: stopping ${oldContainers.length} old replica(s) before starting the new one`);
      await drainAndRemove(oldContainers, 3000);
    }
    const grace = (svc.healthcheck.graceSec || 60) * 1000;
    if (rolling) {
      log(`▸ Rolling ${want} replica${want > 1 ? 's' : ''} one at a time (each has its own volume)`);
      for (const i of rollingOrder(svc, want)) {
        const old = replicasOf(svc.id).filter((r) => r.deploymentId !== dep.id && r.index === i).map((r) => r.containerId);
        if (old.length) {
          log(`▸ Replica ${i}: stopping the old version`);
          await drainAndRemove(old, 3000);
        }
        const cid = await createReplica(svc!, dep, i);
        newContainers.push(cid);
        const h = await waitHealthy([cid], svc, grace, log);
        if (!h.ok) {
          const tail = await tailContainer(cid, 40);
          if (tail.length) {
            log(`── last output from replica ${i} ──`);
            for (const l of tail) log(l);
          }
          throw new Error(`replica ${i}: ${h.reason ?? 'failed health checks'}`);
        }
        log(`✓ Replica ${i} healthy`);
      }
    } else {
      log(`▸ Starting ${want} replica${want > 1 ? 's' : ''}`);
      newContainers = await Promise.all(Array.from({ length: want }, (_, i) => createReplica(svc!, dep, i)));
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
    }
    log(`✓ ${want}/${want} replicas healthy`);

    // ─── switch traffic ───
    svc = servicesTable.get(svc.id)!;
    if (!svc) throw new Error('service was deleted during the deploy');
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
    if (svc.stopped) {
      // Stopped while we were rolling out: keep the new version as the one to start later, but honour the stop.
      setServiceStatus(svc.id, 'stopped', { activeDeploymentId: dep.id, detectedPort: dep.port });
      log('▸ Service was stopped during the deploy — new version saved, replicas shut down');
      await drainAndRemove([...newContainers, ...oldContainers], 1000);
      newContainers = [];
      return;
    }
    setServiceStatus(svc.id, 'running', { activeDeploymentId: dep.id, detectedPort: dep.port });
    log(`✓ Traffic switched to ${dep.id.slice(-6)}`);
    recordActivity(actor, 'deployment.active', `${svc.name} is live (${dep.sourceLabel})`, svc.projectId, svc.id);
    notify({
      event: 'deploy.succeeded',
      level: 'success',
      title: `${svc.name} deployed`,
      message: `${project.name}: ${dep.sourceLabel} is live on ${want} replica${want > 1 ? 's' : ''} (${Math.round((Date.now() - (dep.startedAt ?? dep.createdAt)) / 1000)}s, by ${actor.name}).`,
      projectId: svc.projectId,
      serviceId: svc.id,
      deploymentId: dep.id,
    });

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
    const tail = readDeploymentLog(dep.id).slice(-8).map((l) => l.slice(l.indexOf(' ') + 1)).join('\n');
    notify({
      event: 'deploy.failed',
      level: 'error',
      title: `Deploy of ${svc?.name ?? 'a service'} failed`,
      message: `${projectsTable.get(dep.projectId)?.name ?? ''}: ${msg.slice(0, 300)}${s?.activeDeploymentId ? '\nThe previous version is still serving traffic.' : ''}\n\n${tail}`.trim(),
      projectId: dep.projectId,
      serviceId: dep.serviceId,
      deploymentId: dep.id,
    });
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

/** On boot: deployments that were mid-flight when Servify stopped can never finish — fail them cleanly. */
export function recoverInterrupted() {
  const stuck = deploymentsTable.all().filter((d) => d.status === 'queued' || d.status === 'building' || d.status === 'deploying');
  for (const d of stuck) {
    d.status = 'failed';
    d.error = 'interrupted: Servify restarted during this deploy';
    d.finishedAt = Date.now();
    deploymentsTable.put(d);
  }
  for (const svc of servicesTable.all()) {
    if (svc.status === 'building' || svc.status === 'deploying') {
      svc.status = svc.activeDeploymentId ? 'running' : 'failed';
      servicesTable.put(svc);
    }
  }
  if (stuck.length) console.log(`[deployer] marked ${stuck.length} interrupted deployment(s) as failed`);
}
