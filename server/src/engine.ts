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
export function upstreamsFor(svc: Service): Runtime[] {
  const out: Runtime[] = [];
  for (const r of runtime.values()) {
    if (r.serviceId !== svc.id) continue;
    if (r.deploymentId !== svc.activeDeploymentId) continue;
    if (r.state !== 'healthy' || draining.has(r.containerId)) continue;
    if (!r.host || !r.port) continue;
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
  let next = svc.status;
  if (svc.stopped) next = 'stopped';
  else if (!svc.activeDeploymentId) next = svc.status === 'failed' ? 'failed' : 'idle';
  else if (svc.schedule) next = 'running';
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
    svc.status = next;
    servicesTable.put(svc);
    bus.publish({ type: 'service.updated', service: svc });
  }
}

export function effectiveReplicas(svc: Service): number {
  if (svc.stopped || svc.schedule) return 0; // cron services run as one-off jobs, not replicas
  if (svc.volumes.length > 0) return Math.min(1, svc.replicas);
  return Math.max(0, svc.replicas);
}

// ───────────────────────────── container creation ─────────────────────────────

export function containerName(project: Project, svc: Service, dep: Deployment, index: number) {
  return `svf-${project.slug}-${svc.slug}-${dep.id.slice(-6)}-${index}`.slice(0, 120);
}

export async function createReplica(svc: Service, dep: Deployment, index: number): Promise<string> {
  const project = projectsTable.get(svc.projectId);
  if (!project) throw new Error('project missing');
  if (!dep.image) throw new Error('deployment has no image');
  const network = networkName(project.id);
  await docker.ensureNetwork(network, { [LABEL.managed]: 'true', [LABEL.instance]: INSTANCE_ID, [LABEL.project]: project.id });
  if (config.inContainer) await joinNetwork(network);
  const port = dep.port;
  const env = { ...(dep as any).resolvedEnv ?? dep.config.env };
  if (port && !env.PORT) env.PORT = String(port);
  env.SERVIFY_REPLICA_INDEX = String(index);
  env.SERVIFY_DEPLOYMENT_ID = dep.id;

  for (const v of dep.config.volumes) {
    await docker.createVolume(volumeName(svc.id, v.name), { [LABEL.managed]: 'true', [LABEL.instance]: INSTANCE_ID, [LABEL.service]: svc.id });
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
        exposed && !config.inContainer ? { [`${port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '' }] } : undefined,
      Mounts: dep.config.volumes.map((v) => ({ Type: 'volume', Source: volumeName(svc.id, v.name), Target: v.mountPath })),
      NanoCpus: dep.config.resources.cpus ? Math.round(dep.config.resources.cpus * 1e9) : undefined,
      Memory: dep.config.resources.memoryMb ? dep.config.resources.memoryMb * 1024 * 1024 : undefined,
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
      Init: true,
    },
    NetworkingConfig: {
      EndpointsConfig: { [network]: { Aliases: [svc.slug, `${svc.slug}-${index}`] } },
    },
  };
  if (dep.config.startCommand) {
    spec.Entrypoint = ['/bin/sh', '-c'];
    spec.Cmd = [dep.config.startCommand];
  }
  const name = containerName(project, svc, dep, index);
  // A stale container with the same name (e.g. from a crash mid-create) must go first.
  await docker.removeContainer(name, true).catch(() => {});
  const cid = await docker.createContainer(name, spec);
  await docker.startContainer(cid);
  await adopt(cid);
  return cid;
}

/** Inspect a container and register/refresh its runtime entry. */
async function adopt(cid: string): Promise<Runtime | null> {
  let info: any;
  try {
    info = await docker.inspectContainer(cid);
  } catch {
    runtime.delete(cid);
    return null;
  }
  const labels = info.Config.Labels ?? {};
  const serviceId = labels[LABEL.service];
  const deploymentId = labels[LABEL.deployment];
  const index = Number(labels[LABEL.index] ?? 0);
  const dep = deploymentsTable.get(deploymentId);
  const port = dep?.port ?? null;
  const network = networkName(labels[LABEL.project]);
  if (config.inContainer) await joinNetwork(network);
  let host: string | null = null;
  let hostPort: number | null = null;
  if (port) {
    if (config.inContainer) {
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

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
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
      if (!svc) continue;
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
    const res = await docker.logs(cid, { tail: lines, timestamps: false });
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
        await docker.stopContainer(c, 10);
      } catch {}
      await docker.removeContainer(c, true).catch(() => {});
      runtime.delete(c);
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
  const containers = (await docker.listContainers([`${LABEL.managed}=true`])).filter((c) => isOurs(c.Labels));
  const live = new Set(containers.map((c) => c.Id));
  for (const cid of [...runtime.keys()]) if (!live.has(cid)) runtime.delete(cid);

  const byService = new Map<string, ContainerSummary[]>();
  for (const c of containers) {
    const sid = c.Labels[LABEL.service];
    if (!sid) continue;
    if (!byService.has(sid)) byService.set(sid, []);
    byService.get(sid)!.push(c);
  }

  // Orphans: containers whose service no longer exists.
  for (const [sid, list] of byService) {
    if (!servicesTable.get(sid)) {
      await Promise.all(list.map((c) => docker.removeContainer(c.Id, true)));
      for (const c of list) runtime.delete(c.Id);
      byService.delete(sid);
    }
  }

  const all = servicesTable.all();
  for (const svc of all) {
    const list = byService.get(svc.id) ?? [];
    for (const c of list) {
      if (!runtime.has(c.Id) || runtime.get(c.Id)!.dockerState !== c.State) await adopt(c.Id);
    }
    if (busy.has(svc.id)) {
      publishReplicas(svc);
      continue;
    }
    await convergeService(svc, list);
    publishReplicas(svc);
  }
}

async function convergeService(svc: Service, list: ContainerSummary[]) {
  const inflight = busy.get(svc.id);
  const active = svc.activeDeploymentId;
  const want = active ? effectiveReplicas(svc) : 0;
  const dep = active ? deploymentsTable.get(active) : null;

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
      await docker.startContainer(c.Id).catch(async () => {
        await docker.removeContainer(c.Id, true);
        runtime.delete(c.Id);
      });
      await adopt(c.Id);
    }
  }
}

// ───────────────────────────── docker events ─────────────────────────────

async function watchEvents() {
  for (;;) {
    try {
      const res = await docker.events([`${LABEL.managed}=true`]);
      for await (const ev of jsonLines(res)) {
        const cid: string = ev.id ?? ev.Actor?.ID;
        const action: string = ev.Action ?? ev.status ?? '';
        if (!cid) continue;
        const attrs = ev.Actor?.Attributes ?? {};
        if (attrs[LABEL.instance] && attrs[LABEL.instance] !== INSTANCE_ID) continue;
        if (['die', 'start', 'restart', 'destroy', 'oom', 'stop', 'kill'].includes(action.split(':')[0])) {
          if (action === 'destroy') runtime.delete(cid);
          else await adopt(cid);
          const r = runtime.get(cid);
          const svcId = r?.serviceId ?? ev.Actor?.Attributes?.[LABEL.service];
          const svc = svcId ? servicesTable.get(svcId) : null;
          if (svc) publishReplicas(svc);
          if (action === 'die' || action === 'destroy') requestReconcile();
        }
      }
    } catch (e) {
      console.error('[engine] docker event stream lost:', (e as Error).message);
    }
    await sleep(2000);
  }
}

export async function startEngine() {
  startProber();
  void watchEvents();
  await reconcile();
  setInterval(() => requestReconcile(), 5000);
}
