/**
 * App sleeping: an HTTP service with `sleepAfterMinutes` is stopped (its containers kept) after that long without a
 * request through the router, and started again by the next request, which waits until a replica is healthy.
 * Only traffic through Servify's router counts and wakes it — a call from another service straight over the
 * private network doesn't, which is why databases and non-HTTP services can't sleep.
 */
import { deployments as deploymentsTable, services as servicesTable } from './db.ts';
import { dockerForContainer } from './nodes.ts';
import { busy, replicasOf, requestReconcile } from './engine.ts';
import { bus, recordActivity, SYSTEM } from './events.ts';
import type { Service } from './types.ts';
import { getTemplate } from './templates.ts';

const UNIT = Number(process.env.SERVIFY_SLEEP_UNIT_MS) || 60_000; // one "minute" (shorter in tests)
const CHECK = Number(process.env.SERVIFY_SLEEP_CHECK_MS) || 30_000;
const WAKE_TIMEOUT = 90_000;

const lastHit = new Map<string, number>();
const startedAt = Date.now();
const waking = new Map<string, Promise<boolean>>();
const wokeAt = new Map<string, number>();

/** Being woken up right now, or when it last was (null = not since Servify started). */
export const isWaking = (serviceId: string) => waking.has(serviceId);
export const lastWokenAt = (serviceId: string) => wokeAt.get(serviceId) ?? null;

/** The router saw a request for this service. */
export function touch(serviceId: string) {
  lastHit.set(serviceId, Date.now());
}

/** Why a service can't sleep, or null when it can. */
export function cannotSleep(svc: Service): string | null {
  if (svc.protocol !== 'http') return 'only HTTP services can sleep (other traffic doesn’t pass the router)';
  if (svc.ports?.length) return 'it publishes ports on the server, and that traffic doesn’t pass the router';
  if (svc.cluster) return 'clusters can’t sleep';
  if (svc.source.type === 'external' || svc.source.type === 'redirect') return 'routes don’t run anything';
  const category = svc.templateId ? getTemplate(svc.templateId)?.category : null;
  if (category === 'database' || category === 'cache' || category === 'queue') return 'apps reach it over the private network, which doesn’t wake it';
  const dep = svc.activeDeploymentId ? deploymentsTable.get(svc.activeDeploymentId) : null;
  if (dep?.database) return 'databases can’t sleep: apps reach them over the private network, which doesn’t wake them';
  if ((dep?.config as any)?.schedule) return 'cron services already run only when scheduled';
  return null;
}

async function sleepService(svc: Service, idleMs: number) {
  const fresh = servicesTable.get(svc.id);
  if (!fresh || fresh.sleeping || fresh.stopped || fresh.status !== 'running') return;
  fresh.sleeping = true;
  fresh.status = 'sleeping';
  fresh.updatedAt = Date.now();
  servicesTable.put(fresh);
  bus.publish({ type: 'service.updated', service: fresh });
  recordActivity(SYSTEM, 'service.sleeping', `${fresh.name} went to sleep after ${Math.round(idleMs / UNIT)} min without requests`, fresh.projectId, fresh.id);
  for (const r of replicasOf(fresh.id)) await dockerForContainer(r.containerId).stopContainer(r.containerId, 10).catch(() => {});
}

/** Start a sleeping service again; resolves true once a replica is healthy. Concurrent callers share one wake-up. */
export function wake(serviceId: string, why = 'a request'): Promise<boolean> {
  const running = waking.get(serviceId);
  if (running) return running;
  const p = (async () => {
    const svc = servicesTable.get(serviceId);
    if (!svc) return false;
    if (svc.sleeping) {
      svc.sleeping = false;
      svc.status = 'deploying';
      svc.updatedAt = Date.now();
      servicesTable.put(svc);
      bus.publish({ type: 'service.updated', service: svc });
      recordActivity(SYSTEM, 'service.waking', `${svc.name} woke up for ${why}`, svc.projectId, svc.id);
      lastHit.set(serviceId, Date.now());
      wokeAt.set(serviceId, Date.now());
      for (const r of replicasOf(serviceId).filter((x) => x.deploymentId === svc.activeDeploymentId)) {
        await dockerForContainer(r.containerId).startContainer(r.containerId).catch(() => {});
      }
      requestReconcile(); // recreates any replica that was removed while it slept
    }
    const until = Date.now() + WAKE_TIMEOUT;
    while (Date.now() < until) {
      const fresh = servicesTable.get(serviceId);
      if (!fresh || fresh.sleeping || fresh.stopped) return false;
      if (replicasOf(serviceId).some((r) => r.deploymentId === fresh.activeDeploymentId && r.state === 'healthy')) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  })().finally(() => waking.delete(serviceId));
  waking.set(serviceId, p);
  return p;
}

function check() {
  for (const svc of servicesTable.all()) {
    if (!svc.sleepAfterMinutes || svc.sleeping || svc.stopped || svc.status !== 'running' || busy.has(svc.id)) continue;
    if (cannotSleep(svc)) continue;
    // An open WebSocket, stream or slow download is activity too: idle time starts when the last one closes.
    if (replicasOf(svc.id).some((r) => r.activeConns > 0)) {
      touch(svc.id);
      continue;
    }
    const dep = svc.activeDeploymentId ? deploymentsTable.get(svc.activeDeploymentId) : null;
    // Idle since the last request, the deploy that started it, or Servify's own start — whichever is latest.
    const since = Math.max(lastHit.get(svc.id) ?? 0, dep?.finishedAt ?? 0, startedAt);
    const idle = Date.now() - since;
    if (idle >= svc.sleepAfterMinutes * UNIT) void sleepService(svc, idle).catch((e) => console.error('[sleep]', e));
  }
}

export function startSleeper() {
  setInterval(check, CHECK).unref();
}
