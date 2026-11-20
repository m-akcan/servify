/**
 * Persistent runtime logs. Every running replica is followed once; lines are batched into SQLite (one
 * transaction every half second, bounded queue) so logs survive redeploys, scaling and restarts, and live
 * viewers subscribe to the same feed instead of opening their own Docker streams.
 *
 * Retention: SERVIFY_LOG_RETENTION_DAYS (default 7) and at most SERVIFY_LOG_MAX_LINES per service (default 200k).
 */
import { EventEmitter } from 'node:events';
import { db } from './db.ts';
import { demuxLines } from './docker.ts';
import { dockerForContainer, isOnline } from './nodes.ts';
import { allRuntime } from './engine.ts';
import { bus } from './events.ts';
import type { Replica } from './types.ts';

export type LogLine = { ts: number; replica: number; deploymentId: string; stream: 'stdout' | 'stderr'; text: string };

const RETENTION_DAYS = Number(process.env.SERVIFY_LOG_RETENTION_DAYS ?? 7);
const MAX_LINES = Number(process.env.SERVIFY_LOG_MAX_LINES ?? 200_000);
const MAX_QUEUE = 20_000;
const MAX_LINE = 8192;

const feed = new EventEmitter();
feed.setMaxListeners(0);

type Pending = LogLine & { serviceId: string; cid: string };
let queue: Pending[] = [];
let dropped = 0;

const insert = db.prepare('INSERT INTO logs (service_id, deployment_id, cid, replica, ts, stream, text) VALUES (?, ?, ?, ?, ?, ?, ?)');

export function flushLogs() {
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  db.exec('BEGIN');
  try {
    for (const l of batch) insert.run(l.serviceId, l.deploymentId, l.cid, l.replica, l.ts, l.stream, l.text);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[logs] write failed:', (e as Error).message);
  }
}

function parseTs(line: string): { ts: number; text: string } {
  const sp = line.indexOf(' ');
  const t = Date.parse(line.slice(0, sp));
  if (sp > 0 && Number.isFinite(t)) return { ts: t, text: line.slice(sp + 1) };
  return { ts: Date.now(), text: line };
}

// ───────────────────────────── collector ─────────────────────────────

const following = new Map<string, () => void>();

function lastTs(cid: string): number {
  const r = db.prepare('SELECT MAX(ts) AS ts FROM logs WHERE cid = ?').get(cid) as { ts: number | null };
  return r.ts ?? 0;
}

function attach(r: Replica) {
  if (following.has(r.containerId)) return;
  let res: any = null;
  let dead = false;
  following.set(r.containerId, () => {
    dead = true;
    res?.destroy();
  });
  (async () => {
    try {
      const since = lastTs(r.containerId);
      res = await dockerForContainer(r.containerId).logs(r.containerId, { follow: true, tail: since ? 'all' : 1000, since: since ? since / 1000 : undefined });
      if (dead) return res.destroy();
      for await (const f of demuxLines(res)) {
        const { ts, text } = parseTs(f.text);
        if (ts <= since) continue; // resumed stream: skip what we already stored
        const line: Pending = { ts, replica: r.index, deploymentId: r.deploymentId, stream: f.stream, text: text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text, serviceId: r.serviceId, cid: r.containerId };
        if (queue.length >= MAX_QUEUE) {
          queue.shift();
          dropped++;
        }
        queue.push(line);
        feed.emit(r.serviceId, line);
      }
    } catch {}
    following.delete(r.containerId);
  })();
}

function sync() {
  const reps = allRuntime().filter((r) => r.dockerState === 'running');
  const live = new Set(reps.map((r) => r.containerId));
  for (const r of reps) if (isOnline(r.nodeId)) attach(r); // offline servers: resume (with `since`) once back
  for (const [cid, stop] of following) if (!live.has(cid)) {
    // Let the stream drain its last lines (crash output!) before letting go.
    setTimeout(stop, 3000);
    following.delete(cid);
  }
}

function retention() {
  flushLogs();
  db.prepare('DELETE FROM logs WHERE ts < ?').run(Date.now() - RETENTION_DAYS * 86400_000);
  const svcs = db.prepare('SELECT service_id, COUNT(*) AS n FROM logs GROUP BY service_id HAVING n > ?').all(MAX_LINES) as { service_id: string }[];
  for (const s of svcs) {
    db.prepare('DELETE FROM logs WHERE service_id = ? AND id < (SELECT id FROM logs WHERE service_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)').run(s.service_id, s.service_id, MAX_LINES);
  }
  if (dropped) {
    console.warn(`[logs] dropped ${dropped} lines under load`);
    dropped = 0;
  }
}

export function startLogCollector() {
  setInterval(flushLogs, 500);
  setInterval(sync, 5000);
  setInterval(retention, 3600_000);
  setTimeout(retention, 60_000);
  bus.subscribe((ev) => {
    if (ev.type === 'replicas') sync();
    if (ev.type === 'service.deleted') {
      flushLogs();
      db.prepare('DELETE FROM logs WHERE service_id = ?').run(ev.serviceId);
    }
  });
  sync();
}

// ───────────────────────────── queries ─────────────────────────────

export function queryLogs(
  serviceId: string,
  opts: { tail?: number; since?: number; until?: number; search?: string; deploymentId?: string; stream?: 'stdout' | 'stderr' } = {},
): LogLine[] {
  flushLogs();
  const where = ['service_id = ?'];
  const params: (string | number)[] = [serviceId];
  if (opts.since) {
    where.push('ts >= ?');
    params.push(opts.since);
  }
  if (opts.until) {
    where.push('ts <= ?');
    params.push(opts.until);
  }
  if (opts.deploymentId) {
    where.push('deployment_id = ?');
    params.push(opts.deploymentId);
  }
  if (opts.stream) {
    where.push('stream = ?');
    params.push(opts.stream);
  }
  if (opts.search) {
    where.push("text LIKE ? ESCAPE '\\'");
    params.push(`%${opts.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  const tail = Math.max(1, Math.min(opts.tail ?? 300, 10_000));
  const rows = db
    .prepare(`SELECT ts, replica, deployment_id AS deploymentId, stream, text FROM logs WHERE ${where.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ?`)
    .all(...params, tail) as LogLine[];
  return rows.reverse();
}

export function subscribeLogs(serviceId: string, fn: (l: LogLine) => void): () => void {
  const h = (l: Pending) => fn({ ts: l.ts, replica: l.replica, deploymentId: l.deploymentId, stream: l.stream, text: l.text });
  feed.on(serviceId, h);
  return () => feed.off(serviceId, h);
}

export function logStats(serviceId: string) {
  flushLogs();
  return db.prepare('SELECT COUNT(*) AS lines, MIN(ts) AS oldest FROM logs WHERE service_id = ?').get(serviceId) as { lines: number; oldest: number | null };
}
