/**
 * Hung replicas. The engine takes a replica that fails its health check out of routing, and Docker restarts a container
 * that exits — but a container that keeps running while it is stuck (deadlocked, out of connections, answering 500 to
 * the health check forever) would stay like that. This restarts it once it has failed for a sustained time, with
 * growing gaps between restarts and a cap per window; past the cap it stops, marks the service as needing attention and
 * notifies once. Counting starts over once the replica has been healthy for a while, or with a new deployment.
 *
 * Never touched: services being deployed (or queued behind the deploy lock), backed up or restored, stopped, asleep or
 * just woken, replicas within their startup grace, cron jobs, and PostgreSQL cluster members — restarting a primary
 * would be a failover; the cluster watches its members itself (pgcluster.ts). A replica on a server that is offline, or
 * whose connection is new or has gone quiet, is "unknown", never "unhealthy".
 */
import { services as servicesTable, projects as projectsTable } from './db.ts';
import type { Service } from './types.ts';
import { busy, converging, isHeld, probeHealth, probeNow, restartReplica, markUnhealthy, deployedSchedule, type ProbeHealth } from './engine.ts';
import { deployPending, UPGRADE_GRACE_SEC } from './deployer.ts';
import { backupLockHeld, isBackingUp, isRestoring, keepsData } from './backups.ts';
import { isWaking, lastWokenAt } from './sleep.ts';
import { isJobRunning } from './cronjobs.ts';
import { dockerFor, onlineSince, nodeName, LOCAL } from './nodes.ts';
import { bus, recordActivity, SYSTEM } from './events.ts';
import { notify } from './notify.ts';
import { appendServiceLog } from './logstore.ts';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const v = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** The default for services that don't say (healthcheck.autoRestart absent). */
export const AUTO_RESTART_DEFAULT = !/^(0|false|off|no)$/i.test(process.env.SERVIFY_AUTO_RESTART ?? '');
/** How long a running replica must keep failing its health check before it is restarted (per service: healthcheck.restartAfterSec). */
export const RESTART_AFTER_SEC = num('SERVIFY_RESTART_AFTER_SECONDS', 120);
/** At most this many automatic restarts of a replica within the window; then Servify stops and asks for attention. */
const MAX_RESTARTS = num('SERVIFY_RESTART_MAX', 3);
const WINDOW_MS = num('SERVIFY_RESTART_WINDOW_SECONDS', 3600) * 1000;
/** After n restarts in the window, a replica must keep failing this much longer than the threshold: base·2^(n−1) (2, 4, 8 … min by default). */
const BACKOFF_MS = num('SERVIFY_RESTART_BACKOFF_SECONDS', 120) * 1000;
/** Healthy this long without a break: the restart count (and "needs attention") starts over. */
const RESET_MS = num('SERVIFY_RESTART_RESET_SECONDS', 600) * 1000;
const CHECK_MS = num('SERVIFY_RESTART_CHECK_MS', 5000) || 5000;
/** Consecutive failed probes needed as well as the time (one slow answer is not a hang). */
const MIN_FAILS = 3;

type Track = {
  deploymentId: string;
  /** When Servify restarted this replica (within the window). */
  restarts: number[];
  /** Set when the cap was reached and the notice sent: no more restarts until it is healthy again for RESET_MS. */
  gaveUpAt: number | null;
  healthySince: number | null;
  /** Failures before this moment don't count (a deploy, backup or sleep was in the way, or the setting was off). */
  notBefore: number;
};
const tracks = new Map<string, Track>(); // `${serviceId}#${index}`
const acting = new Set<string>();

const keyOf = (serviceId: string, index: number) => `${serviceId}#${index}`;

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 120 ? `${m} min` : `${Math.round(m / 60)} h`;
}

/** Why this kind of service is never restarted for failing health checks (null = it is covered). */
export function notCovered(svc: Service): string | null {
  if (svc.source.type === 'external' || svc.source.type === 'redirect') return 'routes run nothing';
  if (svc.schedule || deployedSchedule(svc)) return 'cron jobs run one-off containers';
  if (svc.cluster) return 'PostgreSQL cluster members are looked after by the cluster itself (failover when the primary stops answering)';
  if (svc.protocol === 'none') return 'workers have no health check (Docker restarts one that exits)';
  return null;
}

export function restartAfterSec(svc: Service): number {
  return svc.healthcheck.restartAfterSec ?? RESTART_AFTER_SEC;
}

function enabled(svc: Service): boolean {
  return (svc.healthcheck.autoRestart ?? AUTO_RESTART_DEFAULT) && !notCovered(svc);
}

/** Startup grace of a fresh container: the service's own, or the long first-start grace for services with data (migrations, WAL replay). */
function graceMs(svc: Service): number {
  const own = svc.healthcheck.graceSec || 60;
  return (keepsData(svc) ? Math.max(own, UPGRADE_GRACE_SEC) : own) * 1000;
}

/** Something else owns the service right now. */
function pausedBecause(svc: Service): string | null {
  if (svc.stopped) return 'stopped';
  if (svc.sleeping || isWaking(svc.id)) return 'asleep';
  const woke = lastWokenAt(svc.id);
  if (woke && Date.now() - woke < graceMs(svc)) return 'just woken';
  if (busy.has(svc.id) || deployPending(svc.id)) return 'deploying';
  if (isRestoring(svc.id) || backupLockHeld(svc.id) || isBackingUp(svc.id)) return 'being backed up or restored';
  if (converging.has(svc.id)) return 'reconciling';
  if (isJobRunning(svc.id)) return 'running a job';
  return null;
}

/** Since when this replica counts as hung, or null when it doesn't (yet). */
function failingSince(svc: Service, rep: ProbeHealth, t: Track, now: number): number | null {
  if (rep.dockerState !== 'running' || rep.failingSince === null || !rep.startedAt) return null;
  // Offline, or a quiet or fresh connection: probes through the tunnel say nothing about the replica.
  const up = onlineSince(rep.nodeId);
  if (up === null) return null;
  let since = Math.max(rep.failingSince, up, t.notBefore);
  if (!rep.everHealthy) {
    const graceEnd = rep.startedAt + graceMs(svc);
    if (now < graceEnd) return null;
    since = Math.max(since, graceEnd);
  }
  return since;
}

function publish(serviceId: string) {
  const svc = servicesTable.get(serviceId);
  if (svc) bus.publish({ type: 'service.updated', service: svc });
}

function say(svc: Service, rep: ProbeHealth, text: string) {
  appendServiceLog(svc.id, rep.deploymentId, rep.index, text);
}

async function restart(svc: Service, rep: ProbeHealth, t: Track, since: number) {
  const where = rep.nodeId === LOCAL ? '' : ` on ${nodeName(rep.nodeId)}`;
  // Last look before acting: Docker answers (else the state is unknown, not unhealthy), it is the same container
  // still running, and it fails a probe once more.
  let info: any;
  try {
    info = await dockerFor(rep.nodeId).inspectContainer(rep.containerId);
  } catch {
    return;
  }
  if (info?.State?.Status !== 'running' || Date.parse(info.State.StartedAt) !== rep.startedAt) return;
  if (await probeNow(rep.containerId)) return;
  const fresh = servicesTable.get(svc.id);
  if (!fresh || fresh.activeDeploymentId !== rep.deploymentId || !enabled(fresh) || pausedBecause(fresh) || isHeld(fresh.id, rep.index)) return;
  const failedFor = duration(Date.now() - since);
  try {
    await restartReplica(rep.containerId);
  } catch (e) {
    console.error(`[autorestart] could not restart ${svc.slug}#${rep.index}:`, (e as Error).message);
    return;
  }
  t.restarts.push(Date.now());
  const n = t.restarts.length;
  const project = projectsTable.get(svc.projectId);
  const summary = `Restarted replica #${rep.index} of ${svc.name}${where}: it failed its health check for ${failedFor} while running`;
  console.log(`[autorestart] ${summary}`);
  say(svc, rep, `Replica #${rep.index} failed its health check for ${failedFor} while running — restarted it (automatic restart ${n} of ${MAX_RESTARTS} within ${duration(WINDOW_MS)})`);
  recordActivity(SYSTEM, 'service.restarted', `${summary} (${n}/${MAX_RESTARTS} within ${duration(WINDOW_MS)})`, svc.projectId, svc.id);
  notify({
    event: 'service.crashed',
    level: 'info',
    title: `${svc.name}: restarted a hung replica`,
    message: `${project?.name ?? ''}: replica #${rep.index}${where} was running but failed its health check for ${failedFor}. Servify restarted it (automatic restart ${n} of ${MAX_RESTARTS} within ${duration(WINDOW_MS)}).`,
    projectId: svc.projectId,
    serviceId: svc.id,
  });
  publish(svc.id);
}

function giveUp(svc: Service, rep: ProbeHealth, t: Track, since: number) {
  t.gaveUpAt = Date.now();
  markUnhealthy(rep.containerId);
  const where = rep.nodeId === LOCAL ? '' : ` on ${nodeName(rep.nodeId)}`;
  const project = projectsTable.get(svc.projectId);
  const text = `Replica #${rep.index}${where} still fails its health check after ${t.restarts.length} automatic restart${t.restarts.length === 1 ? '' : 's'} within ${duration(WINDOW_MS)}`;
  console.log(`[autorestart] ${svc.name}: ${text} — giving up`);
  say(svc, rep, `${text} (failing for ${duration(Date.now() - since)}). Servify stopped restarting it: check the logs. Restarts resume once it has been healthy for ${duration(RESET_MS)}, or after a deploy or restart.`);
  recordActivity(SYSTEM, 'service.attention', `${svc.name} needs attention: ${text.charAt(0).toLowerCase()}${text.slice(1)} — no more automatic restarts`, svc.projectId, svc.id);
  notify({
    event: 'service.crashed',
    level: 'error',
    title: `${svc.name} needs attention`,
    message: `${project?.name ?? ''}: ${text.charAt(0).toLowerCase()}${text.slice(1)}. Servify stopped restarting it — check its logs. Restarts resume once it has been healthy for ${duration(RESET_MS)}, or after a deploy or restart.`,
    projectId: svc.projectId,
    serviceId: svc.id,
  });
  publish(svc.id);
}

function tick() {
  const now = Date.now();
  const seen = new Set<string>();
  for (const svc of servicesTable.all()) {
    if (!svc.activeDeploymentId || notCovered(svc)) continue;
    const on = enabled(svc);
    const paused = on ? pausedBecause(svc) : 'off';
    for (const rep of probeHealth(svc.id)) {
      if (rep.deploymentId !== svc.activeDeploymentId) continue;
      const key = keyOf(svc.id, rep.index);
      seen.add(key);
      let t = tracks.get(key);
      if (!t || t.deploymentId !== rep.deploymentId) {
        // A new deployment starts with a clean slate (and clears "needs attention").
        if (t?.gaveUpAt) setTimeout(() => publish(svc.id), 0);
        t = { deploymentId: rep.deploymentId, restarts: [], gaveUpAt: null, healthySince: null, notBefore: 0 };
        tracks.set(key, t);
      }
      if (rep.state === 'healthy') {
        t.healthySince ??= now;
        if (now - t.healthySince >= RESET_MS && (t.restarts.length || t.gaveUpAt)) {
          const wasStuck = t.gaveUpAt;
          t.restarts = [];
          t.gaveUpAt = null;
          if (wasStuck) {
            recordActivity(SYSTEM, 'service.recovered', `${svc.name}: replica #${rep.index} has been healthy for ${duration(RESET_MS)} — automatic restarts are back on`, svc.projectId, svc.id);
            notify({ event: 'service.recovered', level: 'success', title: `${svc.name} is healthy again`, message: `${projectsTable.get(svc.projectId)?.name ?? ''}: replica #${rep.index} has passed its health checks for ${duration(RESET_MS)}. Automatic restarts are back on.`, projectId: svc.projectId, serviceId: svc.id });
            publish(svc.id);
          }
        }
        continue;
      }
      t.healthySince = null;
      if (paused) {
        t.notBefore = now; // failures while something else owned it don't count afterwards
        continue;
      }
      if (t.gaveUpAt || acting.has(key)) continue;
      const since = failingSince(svc, rep, t, now);
      if (since === null || rep.fails < MIN_FAILS || now - since < restartAfterSec(svc) * 1000) continue;
      t.restarts = t.restarts.filter((x) => now - x < WINDOW_MS);
      if (t.restarts.length >= MAX_RESTARTS) {
        giveUp(svc, rep, t, since);
        continue;
      }
      // Exponential backoff on top of the threshold (which starts over after each restart, past the startup grace).
      if (t.restarts.length && now - since < restartAfterSec(svc) * 1000 + BACKOFF_MS * 2 ** (t.restarts.length - 1)) continue;
      acting.add(key);
      void restart(svc, rep, t, since)
        .catch((e) => console.error('[autorestart]', (e as Error).message))
        .finally(() => acting.delete(key));
    }
  }
  // Replicas that no longer exist (scaled down, service deleted) keep nothing — except a pending "needs attention"
  // while the replica is merely missing for a moment (being recreated).
  for (const [key, t] of tracks) {
    if (seen.has(key)) continue;
    const sid = key.slice(0, key.lastIndexOf('#'));
    const svc = servicesTable.get(sid);
    if (!svc || svc.activeDeploymentId !== t.deploymentId || !t.gaveUpAt) tracks.delete(key);
  }
}

/** For the dashboard and API: whether hung replicas are restarted, and what happened lately. */
export function autoRestartInfo(svc: Service) {
  const why = notCovered(svc);
  const now = Date.now();
  let restarts = 0;
  let lastRestartAt: number | null = null;
  const stuck: number[] = [];
  for (const [key, t] of tracks) {
    if (!key.startsWith(`${svc.id}#`) || t.deploymentId !== svc.activeDeploymentId) continue;
    const recent = t.restarts.filter((x) => now - x < WINDOW_MS);
    restarts += recent.length;
    for (const x of recent) lastRestartAt = Math.max(lastRestartAt ?? 0, x);
    if (t.gaveUpAt) stuck.push(Number(key.slice(key.lastIndexOf('#') + 1)));
  }
  return {
    enabled: !why && (svc.healthcheck.autoRestart ?? AUTO_RESTART_DEFAULT),
    explicit: svc.healthcheck.autoRestart !== undefined,
    afterSec: restartAfterSec(svc),
    maxRestarts: MAX_RESTARTS,
    windowSec: Math.round(WINDOW_MS / 1000),
    unavailable: why,
    restarts,
    lastRestartAt,
    attention: stuck.length
      ? `Replica${stuck.length > 1 ? 's' : ''} ${stuck.map((i) => `#${i}`).join(', ')} still fail${stuck.length > 1 ? '' : 's'} the health check after ${MAX_RESTARTS} automatic restart${MAX_RESTARTS === 1 ? '' : 's'}. Servify stopped restarting ${stuck.length > 1 ? 'them' : 'it'}: check the logs, then deploy or restart.`
      : null,
  };
}

export function startAutoRestart() {
  setInterval(tick, CHECK_MS).unref();
}
