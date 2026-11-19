import { docker } from './docker.ts';
import { drainTraffic } from './proxy.ts';
import { allRuntime, setReplicaRps, setReplicaStats } from './engine.ts';
import { bus } from './events.ts';
import { services as servicesTable } from './db.ts';
import type { ServiceMetricsPoint } from './types.ts';

const HISTORY = 900; // 15 minutes at 1s
const history = new Map<string, ServiceMetricsPoint[]>();
const prevCpu = new Map<string, { total: number; system: number }>();
let tick = 0;

export function metricsHistory(serviceId: string, seconds = 900): ServiceMetricsPoint[] {
  const h = history.get(serviceId) ?? [];
  return h.slice(-seconds);
}

export function latestMetrics(serviceId: string): ServiceMetricsPoint | null {
  const h = history.get(serviceId);
  return h?.length ? h[h.length - 1] : null;
}

function cpuPercent(cid: string, s: any): number | null {
  const total = s?.cpu_stats?.cpu_usage?.total_usage;
  const system = s?.cpu_stats?.system_cpu_usage;
  const cpus = s?.cpu_stats?.online_cpus || s?.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
  if (total == null || system == null) return null;
  const prev = prevCpu.get(cid);
  prevCpu.set(cid, { total, system });
  if (!prev) return null;
  const dt = total - prev.total;
  const ds = system - prev.system;
  if (ds <= 0 || dt < 0) return 0;
  return (dt / ds) * cpus * 100;
}

function memMb(s: any): number | null {
  const m = s?.memory_stats;
  if (!m?.usage) return null;
  const cache = m.stats?.inactive_file ?? m.stats?.total_inactive_file ?? 0;
  return Math.max(0, m.usage - cache) / 1024 / 1024;
}

async function pollStats() {
  const reps = allRuntime().filter((r) => r.dockerState === 'running');
  const live = new Set(reps.map((r) => r.containerId));
  for (const k of prevCpu.keys()) if (!live.has(k)) prevCpu.delete(k);
  await Promise.all(
    reps.map(async (r) => {
      try {
        const s = await docker.stats(r.containerId);
        setReplicaStats(r.containerId, cpuPercent(r.containerId, s), memMb(s));
      } catch {}
    }),
  );
}

export function startMetrics() {
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const elapsed = Math.max(0.2, (now - last) / 1000);
    last = now;
    tick++;
    const traffic = drainTraffic(elapsed);
    const reps = allRuntime();
    for (const r of reps) setReplicaRps(r.containerId, traffic[r.serviceId]?.replicas[r.containerId] ?? 0);

    const svcPayload: Record<string, { rps: number; errors: number; p95: number; replicas: Record<string, number> }> = {};
    for (const svc of servicesTable.all()) {
      const t = traffic[svc.id];
      const mine = reps.filter((r) => r.serviceId === svc.id && r.dockerState === 'running');
      const point: ServiceMetricsPoint = {
        t: now,
        rps: t?.rps ?? 0,
        p50: t?.p50 ?? 0,
        p95: t?.p95 ?? 0,
        errors: t?.errors ?? 0,
        cpu: mine.reduce((a, r) => a + (r.cpu ?? 0), 0),
        memMb: mine.reduce((a, r) => a + (r.memMb ?? 0), 0),
        replicas: mine.length,
      };
      let h = history.get(svc.id);
      if (!h) history.set(svc.id, (h = []));
      h.push(point);
      if (h.length > HISTORY) h.splice(0, h.length - HISTORY);
      if (t || mine.length) {
        const perReplica: Record<string, number> = {};
        for (const r of mine) perReplica[r.containerId] = t?.replicas[r.containerId] ?? 0;
        svcPayload[svc.id] = { rps: point.rps, errors: point.errors, p95: point.p95, replicas: perReplica };
      }
    }
    bus.publish({ type: 'traffic', tick, services: svcPayload });
  }, 1000);

  const loop = async () => {
    await pollStats().catch(() => {});
    setTimeout(loop, 3000);
  };
  void loop();
}
