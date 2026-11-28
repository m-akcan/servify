/**
 * Data for the Traffic screen, from the same read-only endpoints as the dashboard's traffic board:
 *
 * - GET /access-log/totals?hours=N    exact requests, 5xx, bot requests and (human) visitors per service, N >= 1 hour
 * - GET /access-log/recent?after=ID   the newest requests across services (the live feed)
 * - GET /services/:id/metrics?seconds the router's per-second (or 10 s+) request rate, 5xx rate and p95 per service
 * - GET /services/:id/access-log      rows of one service, for the status split, top paths and hosts, and latency
 *
 * The access log never holds client IPs or locations (visitors are a hash with a salt kept only in Servify's memory),
 * so there is nothing per country or per IP to show.
 */
import { ApiError, type Client } from './client.ts';
import type { ServiceMetricsPoint } from '../../../server/src/types.ts';

export type RangeKey = '5m' | '15m' | '1h' | '24h' | '7d';
/**
 * `bucket`: the chart's resolution (about 90–100 points whatever the range, whole milliseconds so bucket keys stay
 * exact). `hours`: what /access-log/totals is asked for; it counts whole hours (at least one), so the two short ranges
 * take their numbers from the rows and the router's rate instead.
 */
export const RANGES: { key: RangeKey; label: string; long: string; sec: number; bucket: number; hours: number | null }[] = [
  { key: '5m', label: '5m', long: 'last 5 minutes', sec: 300, bucket: 3000, hours: null },
  { key: '15m', label: '15m', long: 'last 15 minutes', sec: 900, bucket: 10_000, hours: null },
  { key: '1h', label: '1h', long: 'last hour', sec: 3600, bucket: 40_000, hours: 1 },
  { key: '24h', label: '24h', long: 'last 24 hours', sec: 86400, bucket: 960_000, hours: 24 },
  { key: '7d', label: '7d', long: 'last 7 days', sec: 7 * 86400, bucket: 6_720_000, hours: 168 },
];
export const rangeOf = (k: RangeKey) => RANGES.find((r) => r.key === k) ?? RANGES[1];
export const bucketMs = (k: RangeKey) => rangeOf(k).bucket;

export type Totals = { requests: number; errors: number; bots: number; visitors: number };
export type TotalsResp = { since: number; services: Record<string, Totals> };

export type FeedEntry = {
  id: number;
  serviceId: string;
  ts: number;
  host: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  bot: boolean;
  botName: string | null;
  refHost: string;
};
export type RecentResp = { entries: FeedEntry[]; last: number };

type AccessEntry = {
  id: number;
  ts: number;
  host: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  referrer: string;
  userAgent: string;
  visitor: string;
  bot: boolean;
};
type AccessPage = { entries: AccessEntry[]; next: string | null };

/** One request as the breakdown uses it (rows from either the per-service log or the live feed). */
export type Req = { id: number; serviceId: string; ts: number; host: string; path: string; status: number; ms: number; bot: boolean; refHost: string; visitor?: string };

/** The server is older than the traffic board (Servify 0.2.2): unknown routes answer 404 or a non-JSON page. */
export class NoTrafficApi extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

async function guarded<T>(p: Promise<unknown>, ok: (v: unknown) => boolean): Promise<T> {
  let v: unknown;
  try {
    v = await p;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 405)) throw new NoTrafficApi('no traffic API');
    throw e;
  }
  if (!ok(v)) throw new NoTrafficApi('no traffic API');
  return v as T;
}

export function fetchTotals(api: Client, hours: number): Promise<TotalsResp> {
  return guarded(api.get(`/access-log/totals?hours=${hours}`), (v) => isObj(v) && isObj(v.services));
}

export function fetchRecent(api: Client, after: number | null, limit: number): Promise<RecentResp> {
  const q = after !== null ? `after=${after}&limit=${limit}` : `limit=${limit}`;
  return guarded(api.get(`/access-log/recent?${q}`), (v) => isObj(v) && Array.isArray(v.entries) && typeof v.last === 'number');
}

export async function fetchMetrics(api: Client, serviceId: string, seconds: number): Promise<ServiceMetricsPoint[]> {
  const r = await api.get<{ points?: ServiceMetricsPoint[] }>(`/services/${encodeURIComponent(serviceId)}/metrics?seconds=${seconds}`);
  return Array.isArray(r?.points) ? r.points : [];
}

const refHostOf = (ref: string) => (ref.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i)?.[1] ?? '').toLowerCase();

/** The newest `limit` rows of one service since `since`; `partial` when there were more. */
export async function fetchRows(api: Client, serviceId: string, since: number, limit: number): Promise<{ rows: Req[]; partial: boolean }> {
  const r = await api.get<AccessPage>(`/services/${encodeURIComponent(serviceId)}/access-log?since=${Math.floor(since)}&limit=${limit}`);
  const entries = Array.isArray(r?.entries) ? r.entries : [];
  return {
    partial: !!r?.next,
    rows: entries.map((e) => {
      const ref = refHostOf(e.referrer ?? '');
      return { id: e.id, serviceId, ts: e.ts, host: e.host, path: e.path, status: e.status, ms: e.ms, bot: e.bot, refHost: ref && ref !== e.host ? ref : '', visitor: e.visitor };
    }),
  };
}

export const feedToReq = (e: FeedEntry): Req => ({ id: e.id, serviceId: e.serviceId, ts: e.ts, host: e.host, path: e.path, status: e.status, ms: e.ms, bot: e.bot, refHost: e.refHost });

/** Runs `fn` over `items`, at most `n` at a time. */
export async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          out[i] = { status: 'fulfilled', value: await fn(items[i]) };
        } catch (e) {
          out[i] = { status: 'rejected', reason: e };
        }
      }
    }),
  );
  return out;
}

// ───────────────────────────── series ─────────────────────────────

/** Requests per second (and 5xx per second, worst p95) per bucket, keyed by the bucket's start time. */
export type Series = { bucketMs: number; rps: Map<number, number>; err: Map<number, number>; p95: Map<number, number> };

export const emptySeries = (k: RangeKey): Series => ({ bucketMs: bucketMs(k), rps: new Map(), err: new Map(), p95: new Map() });

/**
 * Metrics points are sparse (idle buckets are skipped) and their step depends on the range: 1 s points from memory,
 * or rows averaged over 10 s or more from the database (aligned to the step), with the newest seconds stitched on.
 * Each point counts for its own step, missing ones count as zero, and everything is placed by its timestamp.
 */
export function addPoints(s: Series, points: ServiceMetricsPoint[], rangeSec: number, from: number) {
  const dbStep = Math.max(10_000, Math.ceil((rangeSec * 1000) / 360 / 10_000) * 10_000);
  for (const p of points) {
    if (p.t < from) continue;
    // Database rows sit exactly on the step; in-memory seconds carry Date.now() and practically never do.
    const w = p.t % dbStep === 0 ? dbStep : 1000;
    const b = Math.floor(p.t / s.bucketMs) * s.bucketMs;
    s.rps.set(b, (s.rps.get(b) ?? 0) + (p.rps * w) / 1000);
    s.err.set(b, (s.err.get(b) ?? 0) + (p.errors * w) / 1000);
    if (p.rps > 0) s.p95.set(b, Math.max(s.p95.get(b) ?? 0, p.p95));
  }
}

/** One live second from the event stream: `rps` requests landed in the second ending at `t`. */
export function addTick(s: Series, t: number, rps: number, err: number, p95: number) {
  const b = Math.floor(t / s.bucketMs) * s.bucketMs;
  s.rps.set(b, (s.rps.get(b) ?? 0) + rps);
  s.err.set(b, (s.err.get(b) ?? 0) + err);
  if (rps > 0) s.p95.set(b, Math.max(s.p95.get(b) ?? 0, p95));
}

/** `rps`/`err` maps hold request counts per bucket; this turns them into rates for drawing. */
export function seriesPoints(s: Series, now: number, rangeMs: number): { t: number; rps: number; err: number }[] {
  const first = Math.floor((now - rangeMs) / s.bucketMs) * s.bucketMs;
  const cur = Math.floor(now / s.bucketMs) * s.bucketMs;
  const out: { t: number; rps: number; err: number }[] = [];
  for (let i = 0, b = first; b <= cur; i++, b = first + i * s.bucketMs) {
    // The current bucket is still filling: divide by the time it has had, and draw it at "now".
    const live = b === cur;
    const secs = live ? Math.max(1, (now - b) / 1000) : s.bucketMs / 1000;
    out.push({ t: live ? now : b + s.bucketMs / 2, rps: (s.rps.get(b) ?? 0) / secs, err: (s.err.get(b) ?? 0) / secs });
  }
  return out;
}

export function seriesCount(s: Series, from: number): number {
  let n = 0;
  for (const [b, v] of s.rps) if (b + s.bucketMs > from) n += v;
  return n;
}

export function seriesErrCount(s: Series, from: number): number {
  let n = 0;
  for (const [b, v] of s.err) if (b + s.bucketMs > from) n += v;
  return n;
}

export function prune(s: Series, from: number) {
  for (const m of [s.rps, s.err, s.p95]) for (const b of m.keys()) if (b + s.bucketMs < from) m.delete(b);
}

// ───────────────────────────── breakdown ─────────────────────────────

const PATH_ONLY = (p: string) => {
  const i = p.indexOf('?');
  return i >= 0 ? p.slice(0, i) : p;
};

export type Breakdown = {
  n: number;
  statuses: { '2xx': number; '3xx': number; '4xx': number; '5xx': number; other: number };
  hosts: { key: string; n: number }[];
  paths: { key: string; n: number }[];
  referrers: { key: string; n: number }[];
  bots: number;
  visitors: number;
  latency: { p50: number; p95: number; p99: number; hist: number[] } | null;
};

/** Upper bounds of the latency histogram's bars, in ms (the last bar is everything slower). */
export const LAT_EDGES = [10, 50, 100, 250, 500, 1000];

function top(m: Map<string, number>, n: number) {
  return [...m].map(([key, v]) => ({ key, n: v })).sort((a, b) => b.n - a.n).slice(0, n);
}

export function breakdown(rows: Req[]): Breakdown {
  const statuses = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
  const hosts = new Map<string, number>();
  const paths = new Map<string, number>();
  const refs = new Map<string, number>();
  const visitors = new Set<string>();
  const ms: number[] = [];
  const hist = new Array(LAT_EDGES.length + 1).fill(0);
  let bots = 0;
  for (const r of rows) {
    const cls = Math.floor(r.status / 100);
    if (cls === 2) statuses['2xx']++;
    else if (cls === 3) statuses['3xx']++;
    else if (cls === 4) statuses['4xx']++;
    else if (cls === 5) statuses['5xx']++;
    else statuses.other++;
    if (r.host) hosts.set(r.host, (hosts.get(r.host) ?? 0) + 1);
    if (r.bot) bots++;
    else {
      // Paths and sources count people, as in the dashboard's summary; crawlers would drown them out.
      const p = PATH_ONLY(r.path) || '/';
      paths.set(p, (paths.get(p) ?? 0) + 1);
      if (r.refHost) refs.set(r.refHost, (refs.get(r.refHost) ?? 0) + 1);
      if (r.visitor) visitors.add(r.visitor);
    }
    // Upgrades (WebSockets) and redirects are logged with 0 ms: they say nothing about response time.
    if (r.ms > 0) {
      ms.push(r.ms);
      let i = LAT_EDGES.findIndex((e) => r.ms < e);
      if (i < 0) i = LAT_EDGES.length;
      hist[i]++;
    }
  }
  ms.sort((a, b) => a - b);
  const q = (p: number) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
  return {
    n: rows.length,
    statuses,
    hosts: top(hosts, 6),
    paths: top(paths, 8),
    referrers: top(refs, 5),
    bots,
    visitors: visitors.size,
    latency: ms.length ? { p50: q(0.5), p95: q(0.95), p99: q(0.99), hist } : null,
  };
}

// ───────────────────────────── formatting ─────────────────────────────

export const fmtRate = (n: number) => (n <= 0 ? '0' : n < 0.1 ? '<0.1' : n < 10 ? n.toFixed(1) : n < 1000 ? Math.round(n).toString() : `${(n / 1000).toFixed(1)}k`);
export const fmtCount = (n: number) =>
  n < 1000 ? String(Math.round(n)) : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1e6).toFixed(1)}M`;
export const fmtMs = (n: number) => (n < 1 ? '<1 ms' : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)} s`);
export const pct = (a: number, b: number) => (b <= 0 ? '0%' : a / b < 0.001 && a > 0 ? '<0.1%' : `${((a / b) * 100).toFixed(a / b < 0.1 ? 1 : 0)}%`);
