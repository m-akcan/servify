/**
 * Deploy pipeline: queued → building (pull or build) → deploying (start new replicas, health-check)
 * → active (switch traffic, drain old). Failed deploys never touch the running version.
 */
import { createWriteStream, existsSync, readFileSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { parseRepo, sameRepo } from './imageupdates.ts';
import { engineAuthHeader, savedLoginHosts } from './registryauth.ts';
import { databaseOf, demuxLines, normalizeImageRef, type DockerClient } from './docker.ts';
import { dockerFor, nodeOf, nodeName, onlineNodes, LOCAL } from './nodes.ts';
import { spawn } from 'node:child_process';
import { deployments as deploymentsTable, services as servicesTable, projects as projectsTable, backupsTable } from './db.ts';
import type { Deployment, DeployTrigger, Service } from './types.ts';
import { bus, recordActivity, type Actor } from './events.ts';
import { config } from './config.ts';
import { id, KeyedLock, sleep } from './util.ts';
import { ensureSafetyBackup, isRestoring, keepsData, SafetyBackupError } from './backups.ts';
import { diskBlock } from './diskguard.ts';
import { resolveEnv } from './vars.ts';
import {
  busy,
  holds,
  isHeld,
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
  networkName,
  INSTANCE_ID,
} from './engine.ts';
import { buildSource, imageTag } from './builder.ts';
import { nextRun } from './cron.ts';
import { notify } from './notify.ts';
import { hasSharedVolume, mountsFor, hostMountsFor, sharedWriteOwners } from './volumes.ts';

/** Order to roll per-replica services in (clusters override: standbys first, primary last). */
let rollingOrderHook: ((svc: Service, want: number) => number[] | null) | null = null;
export function setRollingOrder(fn: typeof rollingOrderHook) {
  rollingOrderHook = fn;
}
function rollingOrder(svc: Service, want: number): number[] {
  return rollingOrderHook?.(svc, want) ?? Array.from({ length: want }, (_, i) => i);
}
import { iconForStack, referencedServicesOn } from './ops.ts';
import { betterIcon } from './icons.ts';

const lock = new KeyedLock();

/** `docker pull` through the CLI, which uses the user's credential store. Resolves null on success, else why it failed. */
function cliPull(d: DockerClient, ref: string, log: (l: string) => void): Promise<string | null> {
  return new Promise((resolve) => {
    log(`▸ Retrying pull with the docker CLI (uses your docker login credentials)`);
    const child = spawn('docker', ['pull', '--', ref], { env: { ...process.env, DOCKER_HOST: d.hostEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let last = '';
    const onData = (err: boolean) => (b: Buffer) => {
      for (const l of b.toString('utf8').split(/\r?\n/)) {
        if (!l.trim() || /Downloading|Extracting|Waiting/.test(l)) continue;
        log(l);
        if (err) last = l.trim();
      }
    };
    child.stdout.on('data', onData(false));
    child.stderr.on('data', onData(true));
    child.on('error', (e) => resolve(`docker CLI: ${e.message}`));
    child.on('close', (code) => resolve(code === 0 ? null : last || `docker pull exited with ${code}`));
  });
}

/**
 * Pull through the Engine API — on this machine with the registry login of the user Servify runs as — then, if that
 * fails, through the docker CLI. Null on success, else the reason. Logins never go to remote servers.
 */
export async function pull(d: DockerClient, ref: string, log: (l: string) => void, local: boolean): Promise<string | null> {
  try {
    const host = parseRepo(ref)?.registry;
    const auth = local && host ? await engineAuthHeader(host).catch(() => null) : null;
    if (auth) log(`▸ Using the saved docker login for ${host}`);
    await d.pullImage(ref, (l) => log(l), auth);
    return null;
  } catch (e) {
    const engine = (e as Error).message;
    log(`! ${engine}`);
    const cli = await cliPull(d, ref, log);
    // The CLI's answer is the better one (it has every login); if it couldn't even start, keep the Engine's.
    return cli === null ? null : cli.startsWith('docker CLI: ') ? engine : cli;
  }
}

/** Docker Hub's answer for a name with no account part (library/…), which can't be private: it doesn't exist there. */
function notOnDockerHub(raw: string, ref: string): boolean {
  const r = parseRepo(ref);
  return !!r && r.registry === 'docker.io' && r.repo.startsWith('library/') && /repository does not exist/i.test(raw);
}

/** A failed pull in a few words: what went wrong and with which registry (the raw message stays in the log). */
export function pullProblem(raw: string, ref: string): string {
  const r = parseRepo(ref);
  const host = r?.registry ?? 'the registry';
  const login = () => (savedLoginHosts().has(host) ? `${host} refused the saved login` : `no credentials for ${host}`);
  if (/toomanyrequests|rate limit/i.test(raw)) return `rate limited by ${host}`;
  if (notOnDockerHub(raw, ref)) return `not found — ${r!.repo.replace(/^library\//, '')} is not on Docker Hub`;
  if (/repository does not exist or may require/i.test(raw)) return `not found or private — ${login()}`;
  if (/no such host|connection refused|timed? ?out|deadline exceeded|unreachable|network|dial tcp|\bEOF\b|x509|certificate|tls/i.test(raw)) return `registry unreachable — ${host}`;
  if (/unauthori[sz]ed|authentication required|denied|forbidden|\b40[13]\b/i.test(raw)) return `unauthorized — ${login()}`;
  if (/manifest unknown|name unknown|not found/i.test(raw)) return `not found — ${ref}`;
  return raw.split('\n')[0].replace(/^Error response from daemon:\s*/, '').slice(0, 160);
}

/** The local image came from a registry under this name. Without it the name only exists here (built or tagged locally). */
function pulledFromRegistry(img: any, ref: string): boolean {
  const r = parseRepo(ref);
  if (!r) return true;
  // The classic image store records a digest only for pulled or pushed repositories; the containerd store records one
  // for every tag, so there this is always true and the registry's answer decides (see notOnDockerHub).
  return ((img?.RepoDigests as string[] | undefined) ?? []).some((dg) => sameRepo(dg.split('@')[0], r));
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
    // A full disk must not take the whole process down (an unhandled stream error would): the log just stops.
    ws.on('error', (e) => console.error(`[deploy] log of ${dep.id} can't be written: ${e.message}`));
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
  if (s.type === 'upload') return `upload${s.label ? ` · ${s.label}` : ''}`;
  // Never credentials someone put into the URL (https://user:token@host/…): the label goes into activity and notifications.
  if (s.type === 'git') return `${s.repo.replace(/^([a-z+]+:\/\/)[^/@]*@/i, '$1').replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '')}${s.branch ? `@${s.branch}` : ''}`;
  return (s as any).path;
}

/**
 * How long a new image on a service with data may take to become healthy, when the service's own grace is shorter: its
 * first start may migrate the data (Nextcloud, Gitea, databases' minor upgrades…), and being killed half-way is the worst
 * outcome. Crashes still fail at once; only "not healthy yet" waits longer.
 */
export const UPGRADE_GRACE_SEC = Number(process.env.SERVIFY_UPGRADE_GRACE_SECONDS ?? 600);

/** Queue a deployment for the service. Returns immediately; the pipeline runs in the background. */
const PRE_DEPLOY_MAX_MS = Number(process.env.SERVIFY_PRE_DEPLOY_MAX_SECONDS ?? 900) * 1000;

/** Run the pre-deploy command in a one-off container from the new image (same variables, network, volumes). */
async function runPreDeploy(svc: Service, dep: Deployment, env: Record<string, string>, command: string, log: (l: string) => void) {
  log(`▸ Pre-deploy: ${command}`);
  const d = dockerFor(nodeOf(svc));
  const network = networkName(svc.projectId);
  await d.ensureNetwork(network, { [LABEL.managed]: 'true', [LABEL.instance]: INSTANCE_ID, [LABEL.project]: svc.projectId });
  const host = await hostMountsFor(svc, dep.config.volumes, d);
  const spec: any = {
    Image: dep.image,
    Env: Object.entries({ ...env, SERVIFY_PRE_DEPLOY: '1' }).map(([k, v]) => `${k}=${v}`),
    Entrypoint: ['/bin/sh', '-c'],
    Cmd: [command],
    Labels: { 'servify.predeploy': 'true', [LABEL.instance]: INSTANCE_ID, [LABEL.project]: svc.projectId, [LABEL.service]: svc.id, [LABEL.deployment]: dep.id },
    HostConfig: {
      Mounts: [...mountsFor(svc.id, dep.config.volumes, 0), ...host.mounts],
      ...(host.binds.length ? { Binds: host.binds } : {}),
      NanoCpus: dep.config.resources.cpus ? Math.round(dep.config.resources.cpus * 1e9) : undefined,
      Memory: dep.config.resources.memoryMb ? dep.config.resources.memoryMb * 1024 * 1024 : undefined,
      Init: true,
    },
    NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [] } } },
  };
  const cid = await d.createContainer(`svf-predeploy-${svc.slug}-${dep.id.slice(-6)}`, spec);
  try {
    await d.startContainer(cid);
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      void d.killContainer(cid).catch(() => {});
    }, PRE_DEPLOY_MAX_MS);
    const exitCode = await d.waitContainer(cid).finally(() => clearTimeout(killer));
    const res = await d.logs(cid, { tail: 400, timestamps: false });
    for await (const f of demuxLines(res)) log(`  │ ${f.text}`);
    if (timedOut) throw new Error(`pre-deploy command killed after ${Math.round(PRE_DEPLOY_MAX_MS / 1000)}s — the running version is untouched`);
    if (exitCode !== 0) throw new Error(`pre-deploy command failed (exit ${exitCode}) — the running version is untouched`);
    log('✓ Pre-deploy finished');
  } finally {
    await d.removeContainer(cid, true, true).catch(() => {});
  }
}

export function queueDeployment(
  svc: Service,
  trigger: DeployTrigger,
  actor: Actor,
  opts: { image?: string; port?: number | null; fromDeployment?: Deployment; useCachedImage?: boolean; skipSafetyBackup?: boolean; safetyBackupId?: string | null } = {},
): Deployment {
  // A deploy (or restart, rollback…) wakes a sleeping service: its new replicas must run.
  if (svc.sleeping) {
    svc.sleeping = false;
    const fresh = servicesTable.get(svc.id);
    if (fresh?.sleeping) {
      fresh.sleeping = false;
      servicesTable.put(fresh);
    }
  }
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
    repoDigests: base?.repoDigests ?? null,
    baseImage: base?.baseImage ?? null,
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
          preDeployCommand: svc.preDeployCommand ?? null,
          cmd: svc.cmd ?? null,
          entrypoint: svc.entrypoint ?? null,
          volumes: structuredClone(svc.volumes),
          ports: structuredClone(svc.ports ?? []),
          resources: { ...svc.resources },
          source: structuredClone(svc.source),
          schedule: svc.schedule ?? null,
        } as any,
    ...(opts.useCachedImage ? { useCachedImage: true } : {}),
    // Only someone can decide to go ahead without a backup: never a git push, a hook or an auto-update.
    ...(opts.skipSafetyBackup && actor.type !== 'system' ? { skipSafetyBackup: true } : {}),
    // A tag switch backed up just before queueing this deploy: that backup is the one it relies on.
    ...(opts.safetyBackupId ? { safetyBackupId: opts.safetyBackupId } : {}),
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
  // A restore owns the service's data until it is done (it wipes the volumes): the deploy stays queued meanwhile,
  // and can still be cancelled.
  // The same for the owners of volumes it writes to through read-and-write shares.
  const restoringNow = () => {
    const sid = deploymentsTable.get(depId)?.serviceId ?? '';
    const s = servicesTable.get(sid);
    return isRestoring(sid) || (!!s && sharedWriteOwners(s).some((o) => isRestoring(o.id)));
  };
  while (restoringNow()) await sleep(1000);
  // A cluster failover, switchover or rebuild holds members back while it works on them: let it finish first (the
  // deploy isn't marked as running yet, so the cluster keeps looking after itself meanwhile).
  const clusterId = deploymentsTable.get(depId)?.serviceId ?? '';
  if (servicesTable.get(clusterId)?.cluster) for (let i = 0; holds.get(clusterId)?.size && i < 300; i++) await sleep(1000);
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
  // Stateful and one-at-a-time deploys stop the old version first: a failure then is an outage until it is back.
  let stoppedOld = false;

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
    if (crossRefs.length) log(`▸ ${crossRefs.join(', ')} run${crossRefs.length === 1 ? 's' : ''} on another server — reached over Servify's private network relay (main port only)`);
    // Set by restarts, rollbacks and moves: they bring back an image that ran before rather than a fresh pull.
    const reusing = !!dep.image;
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
        const full = diskBlock('pull', node);
        if (full) throw new Error(full.replace('image pulls are refused', 'copying images onto it is refused'));
        log(`▸ Copying ${dep.image} from ${nodeName(from)} to ${nodeName(node)}`);
        await d.loadImage(await dockerFor(from).exportImage(dep.image));
      }
    }
    if (!dep.image) {
      if (src.type === 'image') {
        const ref = normalizeImageRef(src.image);
        const local = await d.inspectImage(ref);
        const update = dep.trigger === 'update';
        if (local && !update && !pulledFromRegistry(local, ref)) {
          log(`▸ Using local image ${ref} (made on this server, not pulled from a registry)`);
        } else if (!local || ref.endsWith(':latest') || update) {
          // Low disk space on that server's Docker disk: no download. A restart, rollback or move — or "deploy the
          // cached image" — goes on with the copy already there, as it would when the registry is down.
          const full = diskBlock('pull', node);
          const raw = full ? full : (log(`▸ Pulling ${ref}${update && local ? ' (update)' : ''}`), await pull(d, ref, log, node === LOCAL));
          if (raw) {
            const reason = full ? 'low disk space' : pullProblem(raw, ref);
            if (local && !update && !full && notOnDockerHub(raw, ref)) {
              log(`▸ ${ref} is not on Docker Hub — using the local image (made on this server)`);
            } else if (local && !update && reusing) {
              // Restarts, rollbacks and moves bring back a version that ran before: a registry hiccup mustn't stop them.
              log(`! pull failed (${reason}); using the copy on this server`);
            } else if (local && !update && dep.useCachedImage) {
              log(`! pull failed (${reason}); deploying the copy already on this server, as asked — it may be older than the registry's`);
            } else {
              dep.cachedImageAvailable = !!local;
              const stays = svc.activeDeploymentId ? 'Nothing changed: the running version stays.' : 'Nothing was started.';
              log(
                local
                  ? `▸ ${stays} To deploy the copy already on this server anyway (it may be older), use "Deploy cached image" on this deployment (API: POST /api/services/:id/deploy {"useCachedImage": true}).`
                  : `▸ ${stays}`,
              );
              if (full) {
                log(`✗ ${full}`);
                throw new Error(full);
              }
              throw new Error(`pull failed: ${reason}`);
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
        dep.repoDigests = pinned?.RepoDigests?.length ? pinned.RepoDigests : null;
        if (pinned?.Id) {
          const tag = imageTag(project, svc, dep);
          await d.tagImage(pinned.Id, tag);
          dep.image = tag;
          dep.sourceLabel = `${sourceLabel(svc)} · ${String(pinned.Id).replace(/^sha256:/, '').slice(0, 7)}`;
          log(`▸ Using ${ref} (${String(pinned.Id).replace(/^sha256:/, '').slice(0, 12)}) as ${tag}`);
        }
      } else {
        const full = diskBlock('build', node);
        if (full) {
          log(`✗ ${full}`);
          log(`▸ ${svc.activeDeploymentId ? 'Nothing changed: the running version stays.' : 'Nothing was started.'}`);
          throw new Error(full);
        }
        const project = projectsTable.get(svc.projectId)!;
        const result = await buildSource(svc, project, dep, log);
        dep.image = result.image;
        dep.commitSha = result.commitSha;
        dep.commitMessage = result.commitMessage;
        dep.builder = result.builder;
        dep.baseImage = result.baseImage;
        if (result.commitSha) dep.sourceLabel = `${sourceLabel(svc)} · ${result.commitSha.slice(0, 7)}`;
        // Swap the generic git/folder icon for the detected language, or the logo of the image the Dockerfile starts from.
        const fresh = servicesTable.get(svc.id);
        const langIcon = iconForStack(result.builder.replace(/ · buildkit$/, ''));
        const icon = fresh && (langIcon && (fresh.icon === 'git' || fresh.icon === 'folder') ? langIcon : betterIcon(fresh, result.baseImage?.ref));
        if (fresh && icon) setServiceStatus(svc.id, fresh.status, { icon });
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

    // ─── a new image on a service's data: a safety backup first (before pre-deploy migrations too) ───
    // Restarts, variable changes, volume and project moves bring back the same image: nothing to guard. Compared by
    // image id, since every deployment gets its own tag. What runs is asked of the container itself: deployments from before images were pinned name a moving tag, which
    // after this deploy's pull already points at the new image.
    const prevDep = svc.activeDeploymentId && svc.activeDeploymentId !== dep.id ? deploymentsTable.get(svc.activeDeploymentId) : null;
    const prevReplica = prevDep ? replicasOf(svc.id).find((r) => r.deploymentId === prevDep.id) : null;
    let prevImageId: string | null = null;
    if (prevReplica) prevImageId = (await d.inspectContainer(prevReplica.containerId).catch(() => null))?.Image ?? null;
    if (!prevImageId && prevDep?.image) prevImageId = (await d.inspectImage(prevDep.image).catch(() => null))?.Id ?? null;
    const upgrade = !!prevDep?.image && prevImageId !== img.Id && keepsData(svc);
    const preTaken = dep.safetyBackupId ? backupsTable.get(dep.safetyBackupId) : null;
    if (upgrade) {
      if (preTaken?.status === 'succeeded') {
        log(`▸ Safety backup: the one from just before the switch (${new Date(preTaken.startedAt).toLocaleString()}, on ${preTaken.destinationName})`);
      } else if (dep.skipSafetyBackup) {
        log(`! No safety backup: skipped as asked by ${actor.name}`);
        recordActivity(actor, 'backup.skipped', `Deploying a new image of ${svc.name} without a safety backup (skipped by ${actor.name})`, svc.projectId, svc.id);
      } else {
        try {
          const r = await ensureSafetyBackup(svc, { purpose: 'deploy', actor, what: `deploying ${dep.sourceLabel}`, log });
          if (r.status === 'off') log(`! No safety backup: ${r.message} — turn them on in Settings → Safety backups`);
          dep.safetyBackupId = r.backup?.id ?? null;
        } catch (e) {
          if (e instanceof SafetyBackupError) dep.safetyRefused = true;
          throw e;
        }
      }
    }
    // A new image writing to other services' volumes (read-and-write shares) can change their data too: the owners'
    // safety backups, by their own settings. Scheduled jobs included — they start nothing long-lived, but they write.
    const writesTo = !!prevDep?.image && prevImageId !== img.Id ? sharedWriteOwners(svc) : [];
    for (const owner of writesTo) {
      if (preTaken?.status === 'succeeded' && preTaken.serviceId === owner.id) continue;
      if (dep.skipSafetyBackup) {
        log(`! No safety backup of ${owner.name}'s data (shared read and write): skipped as asked by ${actor.name}`);
        continue;
      }
      try {
        const r = await ensureSafetyBackup(owner, { purpose: 'deploy', actor, what: `deploying ${dep.sourceLabel} on ${svc.name}, which writes to its volume`, log });
        if (r.status === 'off') log(`! No safety backup of ${owner.name}'s data, which ${svc.name} writes to: ${r.message}`);
      } catch (e) {
        if (e instanceof SafetyBackupError) dep.safetyRefused = true;
        throw e;
      }
    }

    // ─── pre-deploy: once per new version (not on restarts, rollbacks or variable-only changes) ───
    const preDeploy = dep.config.preDeployCommand;
    if (preDeploy && !['restart', 'rollback', 'config'].includes(dep.trigger)) await runPreDeploy(svc, dep, env, preDeploy, log);

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
      const next = nextRun(schedule, new Date(), svc.scheduleTz);
      log(`✓ Cron job armed — schedule "${schedule}"${svc.scheduleTz ? ` (${svc.scheduleTz})` : ''}${next ? `, next run ${next.toLocaleString()}` : ''}`);
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
    if (svc.cluster) {
      // Still (or again) held after the wait at the start: don't roll over a fenced member.
      if (holds.get(svc.id)?.size) throw new Error('a cluster member is still fenced or being rebuilt — deploy again when the cluster is healthy');
      svc = servicesTable.get(svc.id)!; // roll with the primary the cluster decided on
    }
    const shared = hasSharedVolume(dep.config.volumes) || hasSharedVolume(svc.volumes) || !!dep.config.ports?.length;
    const rolling = !shared && dep.config.volumes.some((v) => v.perReplica);
    const want = shared ? 1 : Math.max(1, svc.replicas);
    const oldContainers = replicasOf(svc.id)
      .filter((r) => r.deploymentId !== dep.id)
      .map((r) => r.containerId);
    const recreate = shared;
    if (recreate && oldContainers.length) {
      log(`▸ Stateful service: stopping ${oldContainers.length} old replica(s) before starting the new one`);
      stoppedOld = true;
      await drainAndRemove(oldContainers, 3000);
    }
    const ownGrace = svc.healthcheck.graceSec || 60;
    const graceSec = upgrade ? Math.max(ownGrace, UPGRADE_GRACE_SEC) : ownGrace;
    if (graceSec > ownGrace) log(`▸ New image on ${svc.name}'s data: allowing up to ${graceSec}s for the first start (data migrations) instead of ${ownGrace}s`);
    const grace = graceSec * 1000;
    if (rolling) {
      log(`▸ Rolling ${want} replica${want > 1 ? 's' : ''} one at a time (each has its own volume)`);
      for (const i of rollingOrder(svc, want)) {
        if (isHeld(svc.id, i)) throw new Error(`replica ${i} was fenced by a cluster failover during this deploy — deploy again when the cluster is healthy`);
        const old = replicasOf(svc.id).filter((r) => r.deploymentId !== dep.id && r.index === i).map((r) => r.containerId);
        if (old.length) {
          log(`▸ Replica ${i}: stopping the old version`);
          stoppedOld = true;
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
    let msg = (e as Error).message || String(e);
    const unattended = actor.type === 'system';
    if (dep.safetyRefused) {
      msg = `${msg} — nothing changed, the running version stays.${unattended ? '' : ' Deploy again with "skip safety backup" (API: {"skipSafetyBackup": true}) to go ahead without one.'}`;
    }
    log(`✗ ${msg}`);
    if (stoppedOld) log('! The previous version had been stopped for this deploy: Servify starts it again now (on data the new version may already have changed)');
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
      title: dep.safetyRefused && unattended && dep.trigger === 'update' ? `Auto-update of ${svc?.name ?? 'a service'} skipped` : `Deploy of ${svc?.name ?? 'a service'} ${dep.safetyRefused ? 'refused' : 'failed'}`,
      message: `${projectsTable.get(dep.projectId)?.name ?? ''}: ${msg.slice(0, 300)}${!s?.activeDeploymentId ? '' : stoppedOld ? '\nThe previous version had been stopped for this deploy and is being started again — check that it came back (the new version may already have changed its data).' : '\nThe previous version is still serving traffic.'}\n\n${tail}`.trim(),
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

/** A deploy runs, or is queued behind another one (or a restore) under the service's deploy lock. */
export function deployPending(serviceId: string) {
  return busy.has(serviceId) || lock.held(serviceId);
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
