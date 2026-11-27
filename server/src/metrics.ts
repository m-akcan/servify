import { dockerForContainer, isOnline } from './nodes.ts';
import { drainTraffic } from './proxy.ts';
import { allRuntime, setReplicaRps, setReplicaStats } from './engine.ts';
import { bus } from './events.ts';
import { services as servicesTable, db } from './db.ts';
import { persistPaused, noteSkipped } from './diskguard.ts';
import type { ServiceMetricsPoint } from './types.ts';

const HISTORY = 900; // 15 minutes at 1s
const history = new Map<string, ServiceMetricsPoint[]>();
const prevCpu = new Map<string, { total: number; system: number }>();
let tick = 0;

const RETENTION_DAYS = Number(process.env.SERVIFY_METRICS_RETENTION_DAYS ?? 7);
const BUCKET_MS = 10_000;

/**
 * Up to 15 minutes: 1-second points from memory. Longer ranges (or right after a restart): 10-second rows
 * from SQLite, averaged into at most ~360 points (p95 and replicas take the max of each bucket).
 */
export function metricsHistory(serviceId: string, seconds = 900): ServiceMetricsPoint[] {
  const mem = history.get(serviceId) ?? [];
  const from = Date.now() - seconds * 1000;
  if (seconds <= HISTORY && mem.length && mem[0].t <= from + 2000) return mem.slice(-seconds);
  const step = Math.max(BUCKET_MS, Math.ceil((seconds * 1000) / 360 / BUCKET_MS) * BUCKET_MS);
  const rows = db
    .prepare(
      `SELECT (t / ?) * ? AS t, AVG(rps) AS rps, AVG(p50) AS p50, MAX(p95) AS p95, AVG(errors) AS errors, AVG(cpu) AS cpu, AVG(mem) AS memMb, MAX(replicas) AS replicas
       FROM metrics WHERE service_id = ? AND t >= ? GROUP BY 1 ORDER BY 1`,
    )
    .all(step, step, serviceId, from) as unknown as ServiceMetricsPoint[];
  // Stitch on the freshest in-memory seconds not yet flushed to disk.
  const lastRow = rows.length ? rows[rows.length - 1].t : 0;
  const tailPts = seconds <= HISTORY ? mem.filter((p) => p.t > lastRow + step) : [];
  return [...rows, ...tailPts];
}

type Acc = { n: number; rps: number; p50: number; p95: number; errors: number; cpu: number; mem: number; replicas: number };
const acc = new Map<string, Acc>();
const upsert = db.prepare('INSERT OR REPLACE INTO metrics (service_id, t, rps, p50, p95, errors, cpu, mem, replicas) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');

function accumulate(serviceId: string, p: ServiceMetricsPoint) {
  const a = acc.get(serviceId) ?? { n: 0, rps: 0, p50: 0, p95: 0, errors: 0, cpu: 0, mem: 0, replicas: 0 };
  a.n++;
  a.rps += p.rps;
  a.p50 += p.p50;
  a.p95 = Math.max(a.p95, p.p95);
  a.errors += p.errors;
  a.cpu += p.cpu;
  a.mem += p.memMb;
  a.replicas = Math.max(a.replicas, p.replicas);
  acc.set(serviceId, a);
}

function flushBucket(t: number) {
  if (!acc.size) return;
  if (persistPaused()) {
    // Low-disk protection: the last 15 minutes stay in memory (the charts), nothing goes to the database.
    let n = 0;
    for (const a of acc.values()) if (a.n && !(a.rps === 0 && a.replicas === 0 && a.cpu === 0)) n++;
    noteSkipped('metricRows', n);
    acc.clear();
    return;
  }
  db.exec('BEGIN');
  try {
    for (const [sid, a] of acc) {
      if (!a.n || (a.rps === 0 && a.replicas === 0 && a.cpu === 0)) continue; // idle services cost nothing
      upsert.run(sid, t, a.rps / a.n, a.p50 / a.n, a.p95, a.errors / a.n, a.cpu / a.n, a.mem / a.n, a.replicas);
    }
    db.exec('COMMIT');
  } catch (e) {
    // SQLite has already rolled back on some errors (disk full): a second ROLLBACK throws, and this runs in a timer.
    try {
      db.exec('ROLLBACK');
    } catch {}
    console.error('[metrics] write failed:', (e as Error).message);
  }
  acc.clear();
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
  const reps = allRuntime().filter((r) => r.dockerState === 'running' && isOnline(r.nodeId));
  const live = new Set(reps.map((r) => r.containerId));
  for (const k of prevCpu.keys()) if (!live.has(k)) prevCpu.delete(k);
  await Promise.all(
    reps.map(async (r) => {
      try {
        const s = await dockerForContainer(r.containerId).stats(r.containerId);
        setReplicaStats(r.containerId, cpuPercent(r.containerId, s), memMb(s));
      } catch {}
    }),
  );
}

let currentBucket = 0;

/** Rows past the retention are deleted: returns how many. */
export function pruneMetrics(): number {
  return Number(db.prepare('DELETE FROM metrics WHERE t < ?').run(Date.now() - RETENTION_DAYS * 86400_000).changes);
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
      accumulate(svc.id, point);
      if (t || mine.length) {
        const perReplica: Record<string, number> = {};
        for (const r of mine) perReplica[r.containerId] = t?.replicas[r.containerId] ?? 0;
        svcPayload[svc.id] = { rps: point.rps, errors: point.errors, p95: point.p95, replicas: perReplica };
      }
    }
    bus.publish({ type: 'traffic', tick, services: svcPayload });
    const bucket = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    if (bucket !== currentBucket) {
      if (currentBucket) flushBucket(currentBucket);
      currentBucket = bucket;
    }
  }, 1000);
  setInterval(pruneMetrics, 3600_000);
  bus.subscribe((ev) => {
    if (ev.type === 'service.deleted') {
      history.delete(ev.serviceId);
      db.prepare('DELETE FROM metrics WHERE service_id = ?').run(ev.serviceId);
    }
  });

  const loop = async () => {
    await pollStats().catch(() => {});
    setTimeout(loop, 3000);
  };
  void loop();
}
