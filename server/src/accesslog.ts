/**
 * HTTP access log of the router: one record per proxied request (WebSocket upgrades and redirect services included),
 * for counting visitors, referrers, UTM sources and crawlers.
 *
 * Privacy: client IPs are never stored or logged. Each record carries a visitor key instead: a short hash of
 * (salt, client IP, user agent). The salt is random, rotates at midnight UTC and lives only in this process's memory —
 * never in the database, its WAL or the updater's pre-update copy — so once a day is over (or Servify restarts) that
 * day's keys can't be tied to an IP by anyone. The price: a restart starts a new salt, so someone who visits before
 * and after a restart counts as two visitors that day.
 *
 * (Keeping the salt in the database was tried: SQLite leaves stale copies of rewritten rows in free page space — in the
 * live file and in VACUUM INTO copies — so deleting or overwriting the row doesn't reliably erase it.)
 *
 * Writes never happen on the request path: records are queued in memory and flushed in one transaction every
 * second (or sooner, deferred, once 1000 are waiting). Retention matches the runtime logs: 7 days
 * (SERVIFY_ACCESS_LOG_RETENTION_DAYS, default SERVIFY_LOG_RETENTION_DAYS) and at most
 * SERVIFY_ACCESS_LOG_MAX_ROWS (default 1,000,000) per service.
 */
import { createHash, randomBytes } from 'node:crypto';
import { db, services as servicesTable } from './db.ts';
import { bus } from './events.ts';
import { HttpError } from './util.ts';

const RETENTION_DAYS = Number(process.env.SERVIFY_ACCESS_LOG_RETENTION_DAYS ?? process.env.SERVIFY_LOG_RETENTION_DAYS ?? 7);
const MAX_ROWS = Number(process.env.SERVIFY_ACCESS_LOG_MAX_ROWS ?? 1_000_000);
const MAX_QUEUE = 50_000;
const FLUSH_AT = 1000;

export type AccessRecord = {
  serviceId: string;
  ts: number;
  host: string;
  method: string;
  path: string;
  status: number;
  bytes: number;
  ms: number;
  referrer: string;
  userAgent: string;
  replica: number | null;
  /** Client IP: used for the visitor key and dropped, never queued or stored. */
  ip: string;
};

type Row = Omit<AccessRecord, 'ip'> & { visitor: string; bot: number; refHost: string };

// ───────────────────────────── visitor key ─────────────────────────────

const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);
/** Today's salt: random, in memory only, replaced at the first record of each UTC day. */
let salt: { day: string; key: Buffer } | null = null;

function saltFor(day: string): Buffer {
  if (salt?.day !== day) salt = { day, key: randomBytes(32) };
  return salt.key;
}

/** Salted by the current day (not the request's start), so a request spanning midnight can't swap the salt back. */
function visitorKey(ip: string, ua: string): string {
  return createHash('sha256').update(saltFor(utcDay(Date.now()))).update(ip).update('\n').update(ua).digest('base64url').slice(0, 16);
}

// ───────────────────────────── classification ─────────────────────────────

/** Known crawlers and AI agents, most specific first: the first match names the bot in summaries. */
const BOT_NAMES = [
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai', 'PerplexityBot', 'Perplexity-User',
  'Google-Extended', 'GoogleOther', 'Googlebot', 'AdsBot-Google', 'Bingbot', 'BingPreview', 'DuckDuckBot', 'YandexBot', 'Baiduspider', 'Applebot',
  'Bytespider', 'CCBot', 'Amazonbot', 'meta-externalagent', 'FacebookBot', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot',
  'Discordbot', 'TelegramBot', 'WhatsApp', 'Diffbot', 'cohere-ai', 'MistralAI-User', 'YouBot', 'DataForSeoBot', 'AhrefsBot', 'SemrushBot',
  'MJ12bot', 'DotBot', 'PetalBot', 'SeznamBot', 'UptimeRobot', 'Pingdom', 'curl', 'Wget', 'python-requests', 'python-httpx', 'aiohttp',
  'Go-http-client', 'node-fetch', 'axios', 'okhttp', 'Java', 'libwww-perl', 'Scrapy', 'HeadlessChrome',
];
const BOT_NAME_RE = new RegExp(BOT_NAMES.map((n) => n.replace(/[-.]/g, '\\$&')).join('|'), 'i');
const BOT_RE = /bot\b|bot\/|crawl|spider|slurp|scrape|fetcher|preview|monitor|uptime|headless|python|curl|wget|go-http|node-fetch|axios|okhttp|java\/|libwww|httpx|aiohttp|GPTBot|OAI-SearchBot|ChatGPT|Claude|anthropic|Perplexity|Bytespider|CCBot|Google-Extended|GoogleOther|meta-externalagent|facebookexternalhit|cohere|Diffbot/i;

/** Crawlers, AI agents, uptime checks and HTTP libraries (and clients that send no user agent) are not people. */
export function isBot(ua: string): boolean {
  return !ua || BOT_RE.test(ua);
}

export function botName(ua: string): string {
  if (!ua) return '(no user agent)';
  const m = ua.match(BOT_NAME_RE);
  if (m) return BOT_NAMES.find((n) => n.toLowerCase() === m[0].toLowerCase()) ?? m[0];
  const named = ua.match(/([A-Za-z][\w.-]*(?:bot|crawler|spider))\b/i);
  return named ? named[1] : ua.split(/[\s/;(]/)[0] || ua.slice(0, 40);
}

const refHostOf = (ref: string) => (ref.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i)?.[1] ?? '').toLowerCase();

// ───────────────────────────── queue + writer ─────────────────────────────

let queue: Row[] = [];
let dropped = 0;
let flushQueued = false;

const cut = (s: string | undefined, n: number) => (!s ? '' : s.length > n ? s.slice(0, n) : s);

/**
 * Called by the router once per finished request. Cheap: hashes and queues, never touches the database. Never throws — it runs in a socket 'close' listener, where an exception would stop the router.
 */
export function recordAccess(r: AccessRecord) {
  try {
    queueRecord(r);
  } catch (e) {
    dropped++;
    console.error('[access-log] record skipped:', (e as Error).message);
  }
}

function queueRecord(r: AccessRecord) {
  if (queue.length >= MAX_QUEUE) {
    dropped++; // the writer can't keep up: drop rather than slow the router down (O(1), unlike shifting the queue)
    return;
  }
  const ua = cut(r.userAgent, 512);
  const referrer = cut(r.referrer, 1024);
  const row: Row = {
    serviceId: r.serviceId,
    ts: r.ts,
    host: cut(r.host, 255),
    method: cut(r.method, 16),
    path: cut(r.path, 2048),
    status: r.status,
    bytes: r.bytes,
    ms: Math.round(r.ms * 10) / 10,
    referrer,
    userAgent: ua,
    replica: r.replica,
    visitor: visitorKey(r.ip, ua),
    bot: isBot(ua) ? 1 : 0,
    refHost: refHostOf(referrer),
  };
  queue.push(row);
  if (queue.length >= FLUSH_AT && !flushQueued) {
    flushQueued = true;
    setImmediate(flushAccessLog);
  }
}

const insert = db.prepare(
  'INSERT INTO access_log (service_id, ts, host, method, path, status, bytes, ms, referrer, ref_host, ua, visitor, bot, replica) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
);

export function flushAccessLog() {
  flushQueued = false;
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  db.exec('BEGIN');
  try {
    for (const r of batch) insert.run(r.serviceId, r.ts, r.host, r.method, r.path, r.status, r.bytes, r.ms, r.referrer, r.refHost, r.userAgent, r.visitor, r.bot, r.replica);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[access-log] write failed:', (e as Error).message);
  }
}

function retention() {
  flushAccessLog();
  db.prepare('DELETE FROM access_log WHERE ts < ?').run(Date.now() - RETENTION_DAYS * 86400_000);
  const big = db.prepare('SELECT service_id, COUNT(*) AS n FROM access_log GROUP BY service_id HAVING n > ?').all(MAX_ROWS) as { service_id: string }[];
  for (const s of big) {
    db.prepare('DELETE FROM access_log WHERE service_id = ? AND id < (SELECT id FROM access_log WHERE service_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)').run(s.service_id, s.service_id, MAX_ROWS);
  }
  if (dropped) {
    console.warn(`[access-log] dropped ${dropped} records under load`);
    dropped = 0;
  }
}

export function startAccessLog() {
  setInterval(flushAccessLog, 1000).unref();
  setInterval(retention, 3600_000).unref();
  setTimeout(retention, 90_000).unref();
  bus.subscribe((ev) => {
    if (ev.type === 'service.deleted') {
      flushAccessLog();
      db.prepare('DELETE FROM access_log WHERE service_id = ?').run(ev.serviceId);
    }
  });
}

// ───────────────────────────── queries ─────────────────────────────

export type AccessEntry = {
  id: number;
  ts: number;
  time: string;
  host: string;
  method: string;
  path: string;
  status: number;
  bytes: number;
  ms: number;
  referrer: string;
  userAgent: string;
  visitor: string;
  bot: boolean;
  replica: number | null;
};

export type AccessQuery = {
  since?: number;
  until?: number;
  /** Path prefix ("/blog"); with a "*" anywhere it is a glob ("*.php"). */
  path?: string;
  /** 404, "4xx", or a list: "301,302,5xx". */
  status?: string;
  /** Substring of path, referrer, user agent or host. */
  q?: string;
  /** true = only bots, false = only people. */
  bot?: boolean;
  visitor?: string;
  limit?: number;
  /** Paging cursor: the `next` value of the previous page. */
  before?: string;
};

const like = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function whereFor(serviceId: string, o: AccessQuery) {
  const where = ['service_id = ?'];
  const params: (string | number)[] = [serviceId];
  if (o.since) {
    where.push('ts >= ?');
    params.push(o.since);
  }
  if (o.until) {
    where.push('ts <= ?');
    params.push(o.until);
  }
  if (o.path) {
    if (o.path.includes('*')) {
      where.push("path LIKE ? ESCAPE '\\'");
      params.push(like(o.path).replace(/\*/g, '%'));
    } else {
      where.push("path LIKE ? ESCAPE '\\'");
      params.push(`${like(o.path)}%`);
    }
  }
  if (o.status) {
    const parts = o.status.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const ors: string[] = [];
    for (const p of parts) {
      if (/^[1-5]xx$/.test(p)) {
        ors.push('(status >= ? AND status < ?)');
        params.push(Number(p[0]) * 100, Number(p[0]) * 100 + 100);
      } else if (/^\d{3}$/.test(p)) {
        ors.push('status = ?');
        params.push(Number(p));
      } else throw new HttpError(400, `invalid status filter "${p}" (use 404, 4xx or a comma list)`);
    }
    if (ors.length) where.push(`(${ors.join(' OR ')})`);
  }
  if (o.q) {
    where.push("(path LIKE ? ESCAPE '\\' OR referrer LIKE ? ESCAPE '\\' OR ua LIKE ? ESCAPE '\\' OR host LIKE ? ESCAPE '\\')");
    const v = `%${like(o.q)}%`;
    params.push(v, v, v, v);
  }
  if (o.bot !== undefined) {
    where.push('bot = ?');
    params.push(o.bot ? 1 : 0);
  }
  if (o.visitor) {
    where.push('visitor = ?');
    params.push(o.visitor);
  }
  return { where, params };
}

/** Newest first. `next` is the cursor for the following (older) page, null on the last one. */
export function queryAccessLog(serviceId: string, o: AccessQuery = {}): { entries: AccessEntry[]; next: string | null } {
  flushAccessLog();
  const { where, params } = whereFor(serviceId, o);
  if (o.before) {
    const [ts, id] = o.before.split('-').map(Number);
    if (!Number.isFinite(ts) || !Number.isFinite(id)) throw new HttpError(400, 'invalid "before" cursor');
    where.push('(ts < ? OR (ts = ? AND id < ?))');
    params.push(ts, ts, id);
  }
  const limit = Math.max(1, Math.min(Number.isFinite(o.limit) ? Math.floor(o.limit!) : 100, 1000));
  const rows = db
    .prepare(
      `SELECT id, ts, host, method, path, status, bytes, ms, referrer, ua, visitor, bot, replica FROM access_log WHERE ${where.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ?`,
    )
    .all(...params, limit + 1) as any[];
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const entries: AccessEntry[] = page.map((r) => ({
    id: r.id,
    ts: r.ts,
    time: new Date(r.ts).toISOString(),
    host: r.host,
    method: r.method,
    path: r.path,
    status: r.status,
    bytes: r.bytes,
    ms: r.ms,
    referrer: r.referrer,
    userAgent: r.ua,
    visitor: r.visitor,
    bot: !!r.bot,
    replica: r.replica,
  }));
  const last = page[page.length - 1];
  return { entries, next: more && last ? `${last.ts}-${last.id}` : null };
}

const PATH_ONLY = "CASE WHEN instr(path, '?') > 0 THEN substr(path, 1, instr(path, '?') - 1) ELSE path END";

/**
 * One UTC day (YYYY-MM-DD, default today) of a service: requests and unique visitors with bots apart from people,
 * status classes, and the top paths, referrer hosts, UTM sources, user agents and bots.
 */
export function accessSummary(serviceId: string, day?: string, top = 20) {
  flushAccessLog();
  const d = day ?? utcDay(Date.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) throw new HttpError(400, 'day must be YYYY-MM-DD (UTC)');
  const from = Date.parse(`${d}T00:00:00Z`);
  const to = from + 86400_000;
  const n = Math.max(1, Math.min(top, 100));
  const base = 'service_id = ? AND ts >= ? AND ts < ?';
  const p = [serviceId, from, to];
  const all = <T,>(sql: string, ...extra: (string | number)[]) => db.prepare(sql).all(...p, ...extra) as T[];

  const totals = all<{ bot: number; requests: number; visitors: number; bytes: number }>(
    `SELECT bot, COUNT(*) AS requests, COUNT(DISTINCT visitor) AS visitors, COALESCE(SUM(bytes), 0) AS bytes FROM access_log WHERE ${base} GROUP BY bot`,
  );
  const t = (b: 0 | 1) => totals.find((x) => x.bot === b) ?? { requests: 0, visitors: 0, bytes: 0 };
  const statuses = all<{ cls: number; n: number }>(`SELECT status / 100 AS cls, COUNT(*) AS n FROM access_log WHERE ${base} GROUP BY cls`);
  const topPaths = all<{ path: string; requests: number; visitors: number }>(
    `SELECT ${PATH_ONLY} AS path, COUNT(*) AS requests, COUNT(DISTINCT visitor) AS visitors FROM access_log WHERE ${base} AND bot = 0 GROUP BY 1 ORDER BY requests DESC LIMIT ?`,
    n,
  );
  // Referrers from other sites only: a page's own links (same host) are navigation, not traffic sources.
  const topReferrers = all<{ host: string; requests: number; visitors: number }>(
    `SELECT ref_host AS host, COUNT(*) AS requests, COUNT(DISTINCT visitor) AS visitors FROM access_log WHERE ${base} AND bot = 0 AND ref_host != '' AND ref_host != host GROUP BY ref_host ORDER BY visitors DESC, requests DESC LIMIT ?`,
    n,
  );
  const utmRows = all<{ path: string; visitor: string }>(`SELECT path, visitor FROM access_log WHERE ${base} AND bot = 0 AND path LIKE '%utm_%'`);
  const utm = new Map<string, { requests: number; visitors: Set<string> }>();
  for (const r of utmRows) {
    let q: URLSearchParams;
    try {
      q = new URLSearchParams(r.path.slice(r.path.indexOf('?') + 1));
    } catch {
      continue;
    }
    const src = q.get('utm_source');
    if (!src) continue;
    const key = [src, q.get('utm_medium'), q.get('utm_campaign')].filter(Boolean).join(' / ');
    const e = utm.get(key) ?? { requests: 0, visitors: new Set<string>() };
    e.requests++;
    e.visitors.add(r.visitor);
    utm.set(key, e);
  }
  const topUtm = [...utm]
    .map(([source, e]) => ({ source, requests: e.requests, visitors: e.visitors.size }))
    .sort((a, b) => b.visitors - a.visitors || b.requests - a.requests)
    .slice(0, n);
  const topUserAgents = all<{ userAgent: string; requests: number; visitors: number }>(
    `SELECT ua AS userAgent, COUNT(*) AS requests, COUNT(DISTINCT visitor) AS visitors FROM access_log WHERE ${base} AND bot = 0 GROUP BY ua ORDER BY visitors DESC, requests DESC LIMIT ?`,
    n,
  );
  const botUas = all<{ ua: string; requests: number }>(`SELECT ua, COUNT(*) AS requests FROM access_log WHERE ${base} AND bot = 1 GROUP BY ua`);
  const bots = new Map<string, number>();
  for (const r of botUas) bots.set(botName(r.ua), (bots.get(botName(r.ua)) ?? 0) + r.requests);
  const topBots = [...bots].map(([name, requests]) => ({ name, requests })).sort((a, b) => b.requests - a.requests).slice(0, n);

  return {
    day: d,
    timezone: 'UTC',
    requests: { total: t(0).requests + t(1).requests, humans: t(0).requests, bots: t(1).requests },
    uniqueVisitors: { humans: t(0).visitors, bots: t(1).visitors },
    bytes: t(0).bytes + t(1).bytes,
    statuses: Object.fromEntries(statuses.map((s) => [`${s.cls}xx`, s.n])),
    topPaths,
    topReferrers,
    topUtm,
    topUserAgents,
    topBots,
    note: 'Paths, referrers, UTM sources and user agents count people only; bots are listed apart. Visitors are counted per UTC day; a Servify restart starts a new salt, so someone seen before and after it counts twice that day.',
  };
}

// ───────────────────────────── across services (the traffic board) ─────────────────────────────

export type RecentAccess = Pick<AccessEntry, 'id' | 'ts' | 'host' | 'method' | 'path' | 'status' | 'ms' | 'bot'> & { serviceId: string; refHost: string; botName: string | null };

/**
 * The newest requests across every service, newest first — the traffic board's live feed. `after` is the highest id
 * the caller already has (the response's `last`), so polling only returns what's new. Leaves out the visitor key,
 * full referrer and user agent: the board shows where requests go, not who sent them.
 */
export function recentAccess(after?: number, limit = 50): { entries: RecentAccess[]; last: number } {
  flushAccessLog();
  const n = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 50, 200));
  const rows = (
    after !== undefined && Number.isFinite(after)
      ? db.prepare('SELECT id, service_id, ts, host, method, path, status, ms, bot, ref_host, ua FROM access_log WHERE id > ? ORDER BY id DESC LIMIT ?').all(after, n)
      : db.prepare('SELECT id, service_id, ts, host, method, path, status, ms, bot, ref_host, ua FROM access_log ORDER BY id DESC LIMIT ?').all(n)
  ) as any[];
  const entries = rows.map((r) => ({
    id: r.id,
    serviceId: r.service_id,
    ts: r.ts,
    host: r.host,
    method: r.method,
    path: r.path,
    status: r.status,
    ms: r.ms,
    bot: !!r.bot,
    botName: r.bot ? botName(r.ua) : null,
    refHost: r.ref_host && r.ref_host !== r.host ? r.ref_host : '',
  }));
  const top = (db.prepare('SELECT MAX(id) AS id FROM access_log').get() as { id: number | null }).id ?? 0;
  return { entries, last: Math.max(after ?? 0, top) };
}

export type AccessTotals = { requests: number; errors: number; bots: number; visitors: number };
let totalsCache: { key: string; at: number; value: { since: number; services: Record<string, AccessTotals> } } | null = null;

/**
 * Requests, server errors (5xx), bot requests and unique visitors per service over the last `hours`. One indexed range
 * query per service that has rows; cached for 15 s because the board polls it.
 */
export function accessTotals(hours = 24): { since: number; services: Record<string, AccessTotals> } {
  const h = Math.max(1, Math.min(Number.isFinite(hours) ? hours : 24, 24 * 7));
  const key = String(h);
  if (totalsCache && totalsCache.key === key && Date.now() - totalsCache.at < 15_000) return totalsCache.value;
  flushAccessLog();
  const since = Date.now() - h * 3600_000;
  const ids = servicesTable.all().map((s) => s.id); // deleted services' rows are removed with them
  const q = db.prepare(
    'SELECT COUNT(*) AS requests, COALESCE(SUM(status >= 500), 0) AS errors, COALESCE(SUM(bot), 0) AS bots, COUNT(DISTINCT CASE WHEN bot = 0 THEN visitor END) AS visitors FROM access_log WHERE service_id = ? AND ts >= ?',
  );
  const services: Record<string, AccessTotals> = {};
  for (const id of ids) {
    const r = q.get(id, since) as AccessTotals;
    if (r.requests) services[id] = { requests: r.requests, errors: r.errors, bots: r.bots, visitors: r.visitors };
  }
  const value = { since, services };
  totalsCache = { key, at: Date.now(), value };
  return value;
}
