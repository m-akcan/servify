/**
 * The engine: a desired-state reconciler.
 * DB says "service X should run deployment D with N replicas"; the engine converges Docker to that.
 * Every Docker object Servify owns carries `servify.*` labels, so restarts re-adopt containers.
 */
import net from 'node:net';
import { hostname } from 'node:os';
import http from 'node:http';
import { docker, demuxLines, jsonLines, type ContainerSummary } from './docker.ts';
import { services as servicesTable, projects as projectsTable, deployments as deploymentsTable } from './db.ts';
import type { Service, Project, Deployment, Replica, ReplicaState } from './types.ts';
import { bus, SYSTEM, recordActivity } from './events.ts';
import { config } from './config.ts';
import { sleep, id as newId } from './util.ts';
import { kv } from './db.ts';
import { notify } from './notify.ts';
import { mountsFor, hasSharedVolume, hostMountsFor } from './volumes.ts';
import { LOCAL, nodeOf, isOnline, onlineNodes, dockerFor, dockerForContainer, setContainerNode, forgetContainer, containerNodeOf, forwardPort, pruneForwards, onNodeChange } from './nodes.ts';

/** Every Servify instance (data dir) gets its own id so instances never touch each other's containers. */
export const INSTANCE_ID = (() => {
  let v = kv.get('instance_id');
  if (!v) {
    v = newId('ins');
    kv.set('instance_id', v);
  }
  return v;
})();

export const LABEL = {
  managed: 'servify.managed',
  project: 'servify.project',
  service: 'servify.service',
  deployment: 'servify.deployment',
  index: 'servify.replica',
  instance: 'servify.instance',
};

/** Ours if labelled with our instance id, or a legacy (pre-instance) container whose service we own. */
function isOurs(labels: Record<string, string>): boolean {
  const inst = labels[LABEL.instance];
  if (inst) return inst === INSTANCE_ID;
  const sid = labels[LABEL.service];
  return !!sid && !!servicesTable.get(sid);
}

type Runtime = Replica & {
  network: string;
  probing: boolean;
  fails: number;
  lastProbe: number;
  crashTimes: number[];
};

const runtime = new Map<string, Runtime>(); // containerId → runtime
/** Remote replicas: the server-side published port behind each local forwarder. */
const remotePorts = new Map<string, number>();
function dropRuntime(cid: string) {
  runtime.delete(cid);
  remotePorts.delete(cid);
  forgetContainer(cid);
}
/** Services with a deploy in flight: the deploy pipeline owns container lifecycle for them. */
export const busy = new Map<string, Set<string>>(); // serviceId → deployment ids being rolled out
/** Containers being drained before removal. */
const draining = new Set<string>();
const lastPublished = new Map<string, string>();
/** Short-lived memo of crash-looping services to back off re-creation. */
const backoffUntil = new Map<string, number>();

const joined = new Set<string>();
/** In-container mode: attach Servify's own container to a project network so it can reach replicas. */
async function joinNetwork(network: string) {
  if (joined.has(network)) return;
  const self = process.env.HOSTNAME || hostname();
  try {
    await docker.connectNetwork(network, self);
    joined.add(network);
  } catch (e) {
    console.error(`[engine] could not join ${network} (is HOSTNAME this container's id?):`, (e as Error).message);
  }
}

export function networkName(projectId: string) {
  return `servify_${projectId}`;
}
export function volumeName(serviceId: string, name: string) {
  return `servify_${serviceId}_${name.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
}

export function replicasOf(serviceId: string): Replica[] {
  const out: Replica[] = [];
  for (const r of runtime.values()) {
    if (r.serviceId !== serviceId) continue;
    const { network, probing, fails, lastProbe, crashTimes, ...pub } = r;
    out.push(pub);
  }
  return out.sort((a, b) => (a.deploymentId === b.deploymentId ? a.index - b.index : a.deploymentId < b.deploymentId ? -1 : 1));
}

/** Upstreams eligible for traffic: healthy replicas of the active deployment. */
/**
 * Network names of a replica. Clusters: only the primary answers to the service name (writes); standbys
 * answer to `<name>-read`. Everyone keeps `<name>-<index>`.
 */
export function replicaAliases(svc: Service, index: number): string[] {
  if (svc.cluster) {
    const role = index === svc.cluster.primary ? [svc.slug] : [`${svc.slug}-read`];
    return [...new Set([...role, `${svc.slug}-${index}`])];
  }
  return [...new Set([svc.slug, `${svc.slug}-${index}`, ...(svc.aliases ?? [])])];
}

/** Replica indexes the reconciler must leave alone (fenced cluster members being rebuilt). */
export const holds = new Map<string, Set<number>>();
export function isHeld(serviceId: string, index: number) {
  return holds.get(serviceId)?.has(index) ?? false;
}

export function upstreamsFor(svc: Service): Runtime[] {
  const out: Runtime[] = [];
  for (const r of runtime.values()) {
    if (r.serviceId !== svc.id) continue;
    if (svc.cluster && r.index !== svc.cluster.primary) continue; // writes go to the primary only
    if (r.deploymentId !== svc.activeDeploymentId) continue;
    if (r.state !== 'healthy' || draining.has(r.containerId)) continue;
    if (!r.host || !r.port || !isOnline(r.nodeId)) continue;
    out.push(r);
  }
  return out.sort((a, b) => a.index - b.index);
}

export function anyReplicaStarting(svc: Service): boolean {
  for (const r of runtime.values()) if (r.serviceId === svc.id && (r.state === 'starting' || busy.has(svc.id))) return true;
  return false;
}

export function noteConn(containerId: string, delta: number) {
  const r = runtime.get(containerId);
  if (r) r.activeConns = Math.max(0, r.activeConns + delta);
}

export function setReplicaStats(containerId: string, cpu: number | null, memMb: number | null) {
  const r = runtime.get(containerId);
  if (r) {
    r.cpu = cpu;
    r.memMb = memMb;
  }
}
export function setReplicaRps(containerId: string, rps: number) {
  const r = runtime.get(containerId);
  if (r) r.rps = rps;
}
export function allRuntime(): Replica[] {
  return [...runtime.values()];
}

function publishReplicas(svc: Service) {
  const reps = replicasOf(svc.id).map((r) => ({ ...r, cpu: null, memMb: null, rps: 0, activeConns: 0 }));
  const key = JSON.stringify(reps.map((r) => [r.containerId, r.state, r.dockerState, r.restarts, r.deploymentId]));
  if (lastPublished.get(svc.id) === key) return;
  lastPublished.set(svc.id, key);
  bus.publish({ type: 'replicas', serviceId: svc.id, projectId: svc.projectId, replicas: replicasOf(svc.id) });
  refreshServiceStatus(svc.id);
}

/** Derive the service status from replica health (unless a build/deploy is in progress). */
export function refreshServiceStatus(serviceId: string) {
  const svc = servicesTable.get(serviceId);
  if (!svc) return;
  if (busy.has(serviceId)) return;
  if (!isOnline(nodeOf(svc))) return; // unknown, not down: keep the last status until the server is back
  let next = svc.status;
  if (svc.stopped) next = 'stopped';
  else if (!svc.activeDeploymentId) next = svc.status === 'failed' ? 'failed' : 'idle';
  else if (deployedSchedule(svc)) next = 'running';
  else {
    const reps = replicasOf(serviceId).filter((r) => r.deploymentId === svc.activeDeploymentId);
    const healthy = reps.filter((r) => r.state === 'healthy').length;
    const want = effectiveReplicas(svc);
    const crashing = (backoffUntil.get(serviceId) ?? 0) > Date.now();
    if (crashing && healthy === 0) next = 'crashed';
    else if (healthy >= want) next = 'running';
    // Scaling up: new replicas still starting while the rest serve traffic is healthy, not degraded.
    else if (healthy > 0) next = reps.every((r) => r.state === 'healthy' || r.state === 'starting') ? 'running' : 'degraded';
    else if (reps.some((r) => r.state === 'starting')) next = 'deploying';
    else next = reps.length ? 'crashed' : 'deploying';
  }
  if (next !== svc.status) {
    const prev = svc.status;
    svc.status = next;
    servicesTable.put(svc);
    bus.publish({ type: 'service.updated', service: svc });
    const project = projectsTable.get(svc.projectId);
    if (next === 'crashed' && (prev === 'running' || prev === 'degraded')) {
      // At most one "down" per service per 10 minutes, and "recovered" only answers a "down" that was sent,
      // so a flapping service produces two messages, not a stream.
      const last = lastCrashNotice.get(svc.id) ?? 0;
      if (Date.now() - last > 10 * 60_000) {
        lastCrashNotice.set(svc.id, Date.now());
        crashedAt.set(svc.id, Date.now());
        notify({
          event: 'service.crashed',
          level: 'error',
          title: `${svc.name} is down`,
          message: `${project?.name ?? ''}: no replica of ${svc.name} is healthy. Servify keeps restarting it; check the logs.`,
          projectId: svc.projectId,
          serviceId: svc.id,
        });
      }
    } else if (next === 'running' && crashedAt.has(svc.id)) {
      const mins = Math.max(1, Math.round((Date.now() - crashedAt.get(svc.id)!) / 60_000));
      crashedAt.delete(svc.id);
      notify({
        event: 'service.recovered',
        level: 'success',
        title: `${svc.name} recovered`,
        message: `${project?.name ?? ''}: ${svc.name} is healthy again after ~${mins} min.`,
        projectId: svc.projectId,
        serviceId: svc.id,
      });
    }
  }
}
const lastCrashNotice = new Map<string, number>();
const crashedAt = new Map<string, number>();

/** The schedule that is actually deployed (editing the setting only takes effect on deploy). */
export function deployedSchedule(svc: Service, dep?: Deployment | null): string | null {
  const d = dep ?? (svc.activeDeploymentId ? deploymentsTable.get(svc.activeDeploymentId) : null);
  return ((d?.config as any)?.schedule as string | null | undefined) ?? null;
}

export function effectiveReplicas(svc: Service, dep?: Deployment | null): number {
  const deployed = dep ?? (svc.activeDeploymentId ? deploymentsTable.get(svc.activeDeploymentId) : null);
  if (svc.stopped || deployedSchedule(svc, deployed)) return 0; // cron services run as one-off jobs, not replicas
  // Cap on what is actually mounted (the deployed config), not just the editable setting:
  // removing a volume in settings must not let N replicas share the deployed volume.
  if (hasSharedVolume(svc.volumes) || hasSharedVolume(deployed?.config.volumes)) return Math.min(1, svc.replicas);
  return Math.max(0, svc.replicas);
}

/** Services whose containers the reconciler is touching right now (the deployer waits for these). */
export const converging = new Set<string>();

// ───────────────────────────── container creation ─────────────────────────────

export function containerName(project: Project, svc: Service, dep: Deployment, index: number) {
  return `svf-${project.slug}-${svc.slug}-${dep.id.slice(-6)}-${index}`.slice(0, 120);
}

export async function createReplica(svc: Service, dep: Deployment, index: number): Promise<string> {
  const project = projectsTable.get(svc.projectId);
  if (!project) throw new Error('project missing');
  if (!dep.image) throw new Error('deployment has no image');
  const network = networkName(project.id);
  const node = nodeOf(svc);
  const d = dockerFor(node);
  const remote = node !== LOCAL;
  await d.ensureNetwork(network, { [LABEL.managed]: 'true', [LABEL.instance]: INSTANCE_ID, [LABEL.project]: project.id });
  if (config.inContainer && !remote) await joinNetwork(network);
  const port = dep.port;
  const env = { ...(dep as any).resolvedEnv ?? dep.config.env };
  if (port && !env.PORT) env.PORT = String(port);
  env.SERVIFY_REPLICA_INDEX = String(index);
  env.SERVIFY_DEPLOYMENT_ID = dep.id;
  if (svc.cluster) {
    // Role at creation; Servify re-points running standbys itself after a failover.
    env.SERVIFY_PG_ROLE = index === svc.cluster.primary ? 'primary' : 'standby';
    env.SERVIFY_PG_PRIMARY = `${svc.slug}-${svc.cluster.primary}`;
  }

  // Only volumes currently attached to this service are mounted (volumes can move between services).
  const mounts = mountsFor(svc.id, dep.config.volumes, index);
  const host = await hostMountsFor(svc, dep.config.volumes, d); // re-validated: settings may predate today's rules
  for (const m of mounts) {
    await d.createVolume(m.Source, { [LABEL.managed]: 'true', [LABEL.instance]: INSTANCE_ID, [LABEL.project]: project.id });
  }

  const exposed = port && dep.config.protocol !== 'none' ? { [`${port}/tcp`]: {} } : undefined;
  const spec: any = {
    Image: dep.image,
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    Hostname: `${svc.slug}-${index}`.slice(0, 63),
    Labels: {
      [LABEL.managed]: 'true',
      [LABEL.instance]: INSTANCE_ID,
      [LABEL.project]: project.id,
      [LABEL.service]: svc.id,
      [LABEL.deployment]: dep.id,
      [LABEL.index]: String(index),
    },
    ExposedPorts: exposed,
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped' },
      PortBindings:
        exposed && (remote || !config.inContainer) ? { [`${port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '' }] } : undefined,
      Mounts: [...mounts, ...host.mounts],
      ...(host.binds.length ? { Binds: host.binds } : {}),
      NanoCpus: dep.config.resources.cpus ? Math.round(dep.config.resources.cpus * 1e9) : undefined,
      Memory: dep.config.resources.memoryMb ? dep.config.resources.memoryMb * 1024 * 1024 : undefined,
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
      Init: true,
    },
    NetworkingConfig: {
      EndpointsConfig: { [network]: { Aliases: replicaAliases(svc, index) } },
    },
  };
  if (dep.config.startCommand) {
    spec.Entrypoint = ['/bin/sh', '-c'];
    spec.Cmd = [dep.config.startCommand];
  } else {
    if (dep.config.entrypoint?.length) spec.Entrypoint = dep.config.entrypoint;
    if (dep.config.cmd?.length) spec.Cmd = dep.config.cmd;
  }
  const name = containerName(project, svc, dep, index);
  // A stale container with the same name (e.g. from a crash mid-create) must go first.
  await d.removeContainer(name, true).catch(() => {});
  const cid = await d.createContainer(name, spec);
  setContainerNode(cid, node);
  await d.startContainer(cid);
  await adopt(cid, node);
  return cid;
}

/** Inspect a container and register/refresh its runtime entry. */
export async function adopt(cid: string, nodeId = containerNodeOf(cid)): Promise<Runtime | null> {
  if (!isOnline(nodeId)) return runtime.get(cid) ?? null; // unknown while the server is offline: keep what we knew
  const remote = nodeId !== LOCAL;
  let info: any;
  try {
    info = await dockerFor(nodeId).inspectContainer(cid);
  } catch (e) {
    if (!isOnline(nodeId)) return runtime.get(cid) ?? null;
    if ((e as any)?.status !== 404) return runtime.get(cid) ?? null; // a transient error is not a deleted container
    dropRuntime(cid);
    return null;
  }
  setContainerNode(cid, nodeId);
  const labels = info.Config.Labels ?? {};
  const serviceId = labels[LABEL.service];
  const deploymentId = labels[LABEL.deployment];
  const index = Number(labels[LABEL.index] ?? 0);
  const dep = deploymentsTable.get(deploymentId);
  const port = dep?.port ?? null;
  const network = networkName(labels[LABEL.project]);
  if (config.inContainer && !remote) await joinNetwork(network);
  let host: string | null = null;
  let hostPort: number | null = null;
  if (port) {
    if (remote) {
      // Published on the server's 127.0.0.1; reached through a local forwarder over the agent tunnel.
      const b = info.NetworkSettings?.Ports?.[`${port}/tcp`]?.[0];
      if (b?.HostPort) {
        try {
          hostPort = await forwardPort(nodeId, Number(b.HostPort));
          host = '127.0.0.1';
          remotePorts.set(cid, Number(b.HostPort));
        } catch {}
      }
    } else if (config.inContainer) {
      host = info.NetworkSettings?.Networks?.[network]?.IPAddress || null;
      hostPort = port;
    } else {
      const b = info.NetworkSettings?.Ports?.[`${port}/tcp`]?.[0];
      if (b?.HostPort) {
        host = '127.0.0.1';
        hostPort = Number(b.HostPort);
      }
    }
  }
  const dockerState: string = info.State?.Status ?? 'unknown';
  const prev = runtime.get(cid);
  const restarts = info.RestartCount ?? 0;
  const r: Runtime = prev ?? {
    containerId: cid,
    nodeId,
    name: String(info.Name ?? '').replace(/^\//, ''),
    serviceId,
    deploymentId,
    index,
    state: 'starting',
    dockerState,
    host,
    port: hostPort,
    startedAt: null,
    restarts,
    cpu: null,
    memMb: null,
    rps: 0,
    activeConns: 0,
    network,
    probing: false,
    fails: 0,
    lastProbe: 0,
    crashTimes: [],
  };
  if (prev && restarts > prev.restarts) {
    r.crashTimes.push(Date.now());
    r.state = 'starting';
  }
  r.restarts = restarts;
  r.nodeId = nodeId;
  r.dockerState = dockerState;
  r.host = host;
  r.port = hostPort;
  r.startedAt = info.State?.StartedAt ? Date.parse(info.State.StartedAt) : null;
  if (dockerState !== 'running') {
    if (r.state !== 'exited' && prev && dockerState === 'exited') r.crashTimes.push(Date.now());
    r.state = dockerState === 'restarting' ? 'starting' : 'exited';
  } else if (r.state === 'exited') {
    r.state = 'starting';
  }
  if (draining.has(cid)) r.state = 'draining';
  runtime.set(cid, r);
  return r;
}

// ───────────────────────────── health probing ─────────────────────────────

/**
 * TCP health: the connection must open *and stay open* for a moment. Docker's port forwarder accepts
 * connections even while nothing listens inside the container, then closes them immediately — a bare
 * "connected" check would mark a still-initialising database healthy.
 */
function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let settled = false;
    let hold: NodeJS.Timeout | null = null;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (hold) clearTimeout(hold);
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => {
      hold = setTimeout(() => done(true), 300);
    });
    sock.on('data', () => {}); // greetings (MySQL, SMTP…) are fine
    sock.once('end', () => done(false));
    sock.once('close', () => done(false));
    sock.once('error', () => done(false));
  });
}

function httpProbe(host: string, port: number, path: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path, timeout: timeoutMs, headers: { 'User-Agent': 'servify-health/1' } }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

async function probe(r: Runtime, svc: Service) {
  if (r.probing) return;
  r.probing = true;
  try {
    let ok: boolean;
    const dep = deploymentsTable.get(r.deploymentId);
    const protocol = dep?.config.protocol ?? svc.protocol;
    if (r.dockerState !== 'running') ok = false;
    else if (protocol === 'none' || !r.port || !r.host) {
      // Workers: healthy once they have stayed up for a moment.
      ok = !!r.startedAt && Date.now() - r.startedAt > 2500;
    } else if (protocol === 'http' && svc.healthcheck.path) {
      ok = await httpProbe(r.host, r.port, svc.healthcheck.path, svc.healthcheck.timeoutSec * 1000);
    } else {
      ok = await tcpProbe(r.host, r.port, svc.healthcheck.timeoutSec * 1000);
    }
    r.lastProbe = Date.now();
    const before = r.state;
    if (draining.has(r.containerId)) r.state = 'draining';
    else if (ok) {
      r.fails = 0;
      r.state = 'healthy';
    } else if (r.dockerState !== 'running') {
      r.state = 'exited';
    } else {
      r.fails++;
      if (r.state === 'healthy' && r.fails >= 3) r.state = 'unhealthy';
    }
    if (before !== r.state) publishReplicas(svc);
  } finally {
    r.probing = false;
  }
}

let probeTimer: NodeJS.Timeout | null = null;
function startProber() {
  if (probeTimer) return;
  probeTimer = setInterval(() => {
    const now = Date.now();
    for (const r of runtime.values()) {
      const svc = servicesTable.get(r.serviceId);
      if (!svc || !isOnline(r.nodeId)) continue;
      const interval = r.state === 'healthy' ? svc.healthcheck.intervalSec * 1000 : 700;
      if (now - r.lastProbe >= interval) void probe(r, svc);
    }
  }, 350);
}

export async function waitHealthy(cids: string[], svc: Service, timeoutMs: number, onLine?: (l: string) => void): Promise<{ ok: boolean; reason?: string; cid?: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastReport = 0;
  while (Date.now() < deadline) {
    let allOk = true;
    for (const cid of cids) {
      const r = await adopt(cid);
      if (!r) return { ok: false, reason: 'container disappeared', cid };
      if (r.dockerState === 'exited' || r.dockerState === 'dead' || r.restarts > 0) {
        return { ok: false, reason: `replica ${r.index} exited during startup`, cid };
      }
      if (r.state !== 'healthy') {
        allOk = false;
        await probe(r, svc);
      }
    }
    if (allOk && cids.every((c) => runtime.get(c)?.state === 'healthy')) return { ok: true };
    if (onLine && Date.now() - lastReport > 5000) {
      lastReport = Date.now();
      const n = cids.filter((c) => runtime.get(c)?.state === 'healthy').length;
      onLine(`waiting for health checks… ${n}/${cids.length} healthy`);
    }
    await sleep(500);
  }
  return { ok: false, reason: `health check timed out after ${Math.round(timeoutMs / 1000)}s` };
}

export async function tailContainer(cid: string, lines = 30): Promise<string[]> {
  try {
    const res = await dockerForContainer(cid).logs(cid, { tail: lines, timestamps: false });
    const out: string[] = [];
    for await (const f of demuxLines(res)) out.push(f.text);
    return out;
  } catch {
    return [];
  }
}

// ───────────────────────────── removal / draining ─────────────────────────────

export async function drainAndRemove(cids: string[], graceMs = 8000) {
  if (!cids.length) return;
  for (const c of cids) {
    draining.add(c);
    const r = runtime.get(c);
    if (r) r.state = 'draining';
  }
  const svcIds = new Set(cids.map((c) => runtime.get(c)?.serviceId).filter(Boolean) as string[]);
  for (const sid of svcIds) {
    const s = servicesTable.get(sid);
    if (s) publishReplicas(s);
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (cids.every((c) => (runtime.get(c)?.activeConns ?? 0) === 0)) break;
    await sleep(250);
  }
  // Small settle so in-flight keep-alive requests finish.
  await sleep(300);
  await Promise.all(
    cids.map(async (c) => {
      try {
        await dockerForContainer(c).stopContainer(c, 10);
      } catch {}
      try {
        await dockerForContainer(c).removeContainer(c, true);
      } catch {
        if (!isOnline(containerNodeOf(c))) {
          // The server is offline: forget the container here; the reconciler removes it when the server is back.
          draining.delete(c);
          return;
        }
      }
      dropRuntime(c);
      draining.delete(c);
    }),
  );
  for (const sid of svcIds) {
    const s = servicesTable.get(sid);
    if (s) publishReplicas(s);
  }
}

// ───────────────────────────── reconcile loop ─────────────────────────────

let reconciling = false;
let again = false;

export function requestReconcile() {
  if (reconciling) {
    again = true;
    return;
  }
  void reconcile();
}

export async function reconcile(): Promise<void> {
  if (reconciling) {
    again = true;
    return;
  }
  reconciling = true;
  try {
    do {
      again = false;
      await reconcileOnce();
    } while (again);
  } catch (e) {
    console.error('[engine] reconcile failed:', (e as Error).message);
  } finally {
    reconciling = false;
  }
}

async function reconcileOnce() {
  // Every online server's containers. Offline servers keep their last known runtime: unknown is not gone.
  const nodes = onlineNodes();
  const containers: (ContainerSummary & { node: string })[] = [];
  const listed = new Set<string>();
  for (const node of nodes) {
    try {
      const list = (await dockerFor(node).listContainers([`${LABEL.managed}=true`])).filter((c) => isOurs(c.Labels));
      for (const c of list) containers.push({ ...c, node });
      listed.add(node);
    } catch (e) {
      console.error(`[engine] could not list containers on ${node}:`, (e as Error).message);
    }
  }
  const live = new Set(containers.map((c) => c.Id));
  for (const [cid, r] of [...runtime]) if (listed.has(r.nodeId) && !live.has(cid)) dropRuntime(cid);
  for (const c of containers) setContainerNode(c.Id, c.node);

  const byService = new Map<string, (ContainerSummary & { node: string })[]>();
  for (const c of containers) {
    const sid = c.Labels[LABEL.service];
    if (!sid) continue;
    if (!byService.has(sid)) byService.set(sid, []);
    byService.get(sid)!.push(c);
  }

  // Orphans: containers whose service no longer exists.
  for (const [sid, list] of byService) {
    if (!servicesTable.get(sid)) {
      await Promise.allSettled(list.map((c) => dockerFor(c.node).removeContainer(c.Id, true)));
      for (const c of list) dropRuntime(c.Id);
      byService.delete(sid);
    }
  }

  const ids = servicesTable.all().map((s) => s.id);
  for (const sid of ids) {
    try {
      for (const c of byService.get(sid) ?? []) {
        if (!runtime.has(c.Id) || runtime.get(c.Id)!.dockerState !== c.State) await adopt(c.Id, c.node);
      }
      // Re-read state right before acting: a deploy may have switched versions while this pass ran.
      const svc = servicesTable.get(sid);
      if (!svc) continue;
      if (busy.has(sid)) {
        publishReplicas(svc);
        continue;
      }
      const home = nodeOf(svc);
      // Moved to another server: what is left on the old one goes once no deploy is rolling it out.
      const strays = (byService.get(sid) ?? []).filter((c) => c.node !== home && !draining.has(c.Id));
      if (strays.length) void drainAndRemove(strays.map((c) => c.Id), 4000);
      if (!isOnline(home)) {
        publishReplicas(svc);
        continue; // never recreate or remove anything on a server we can't see
      }
      converging.add(sid);
      try {
        const fresh = (await dockerFor(home).listContainers([`${LABEL.service}=${sid}`])).filter((c) => isOurs(c.Labels) && c.Labels[LABEL.managed] === 'true');
        if (!busy.has(sid)) await convergeService(servicesTable.get(sid) ?? svc, fresh);
      } finally {
        converging.delete(sid);
      }
      publishReplicas(servicesTable.get(sid) ?? svc);
    } catch (e) {
      console.error(`[engine] converge ${sid} failed:`, (e as Error).message);
    }
  }

  // Close forwarders that no replica uses any more.
  for (const node of nodes) {
    if (node === LOCAL) continue;
    const keep = new Set<number>();
    for (const [cid, port] of remotePorts) if (runtime.get(cid)?.nodeId === node) keep.add(port);
    pruneForwards(node, keep);
  }
}

async function convergeService(svc: Service, list: ContainerSummary[]) {
  const inflight = busy.get(svc.id);
  const active = svc.activeDeploymentId;
  const dep = active ? deploymentsTable.get(active) : null;
  const want = active ? effectiveReplicas(svc, dep) : 0;

  const toRemove: string[] = [];
  const ofActive = new Map<number, ContainerSummary>();
  for (const c of list) {
    const d = c.Labels[LABEL.deployment];
    if (inflight?.has(d)) continue;
    if (draining.has(c.Id)) continue;
    const idx = Number(c.Labels[LABEL.index] ?? 0);
    if (d !== active || idx >= want || ofActive.has(idx)) {
      toRemove.push(c.Id);
      continue;
    }
    ofActive.set(idx, c);
  }
  if (toRemove.length) void drainAndRemove(toRemove, 4000);

  if (!dep || !dep.image || svc.stopped) return;
  const d = dockerFor(nodeOf(svc));

  // Crash-loop detection: many restarts in a short window → back off.
  const recentCrashes = [...runtime.values()]
    .filter((r) => r.serviceId === svc.id && r.deploymentId === active)
    .reduce((n, r) => n + r.crashTimes.filter((t) => Date.now() - t < 120_000).length, 0);
  if (recentCrashes >= 5 && (backoffUntil.get(svc.id) ?? 0) < Date.now()) {
    backoffUntil.set(svc.id, Date.now() + 30_000);
    recordActivity(SYSTEM, 'service.crashloop', `${svc.name} is crash-looping — backing off`, svc.projectId, svc.id);
  }
  const backingOff = (backoffUntil.get(svc.id) ?? 0) > Date.now();

  for (let i = 0; i < want; i++) {
    if (busy.has(svc.id)) return; // a deploy just started: it owns the containers now
    if (isHeld(svc.id, i)) continue; // fenced: never restart or recreate it until it's released
    const c = ofActive.get(i);
    if (!c) {
      if (backingOff) continue;
      try {
        await createReplica(svc, dep, i);
      } catch (e) {
        console.error(`[engine] failed to create replica ${svc.slug}#${i}:`, (e as Error).message);
      }
    } else if (c.State === 'exited' || c.State === 'created' || c.State === 'dead') {
      if (backingOff) continue;
      const r = runtime.get(c.Id);
      r?.crashTimes.push(Date.now());
      await d.startContainer(c.Id).catch(async () => {
        await d.removeContainer(c.Id, true).catch(() => {});
        dropRuntime(c.Id);
      });
      await adopt(c.Id);
    }
  }
}

// ───────────────────────────── docker events ─────────────────────────────

const watching = new Set<string>();
/** Follow one server's Docker events while it is online. */
async function watchEvents(node: string) {
  if (watching.has(node)) return;
  watching.add(node);
  try {
    while (isOnline(node)) {
      try {
        const res = await dockerFor(node).events([`${LABEL.managed}=true`]);
        for await (const ev of jsonLines(res)) {
          const cid: string = ev.id ?? ev.Actor?.ID;
          const action: string = ev.Action ?? ev.status ?? '';
          if (!cid) continue;
          const attrs = ev.Actor?.Attributes ?? {};
          if (attrs[LABEL.instance] && attrs[LABEL.instance] !== INSTANCE_ID) continue;
          if (['die', 'start', 'restart', 'destroy', 'oom', 'stop', 'kill'].includes(action.split(':')[0])) {
            if (action === 'destroy') dropRuntime(cid);
            else await adopt(cid, node);
            const r = runtime.get(cid);
            const svcId = r?.serviceId ?? ev.Actor?.Attributes?.[LABEL.service];
            const svc = svcId ? servicesTable.get(svcId) : null;
            if (svc) publishReplicas(svc);
            if (action === 'die' || action === 'destroy') requestReconcile();
          }
        }
      } catch (e) {
        if (isOnline(node)) console.error(`[engine] docker event stream lost (${node}):`, (e as Error).message);
      }
      await sleep(2000);
    }
  } finally {
    watching.delete(node);
  }
}

export async function startEngine() {
  startProber();
  void watchEvents(LOCAL);
  onNodeChange((node, online) => {
    // The dashboard shows each service's server state: re-send the services that live there.
    for (const svc of servicesTable.all()) if (nodeOf(svc) === node) bus.publish({ type: 'service.updated', service: svc });
    if (!online) return;
    // Back online: refresh what we knew (new forwarders), follow its events, and converge.
    void (async () => {
      for (const [cid, r] of [...runtime]) if (r.nodeId === node) await adopt(cid, node);
      void watchEvents(node);
      requestReconcile();
    })();
  });
  await reconcile();
  setInterval(() => requestReconcile(), 5000);
}
