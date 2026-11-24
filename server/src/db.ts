import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';
import { sealJson, openJson, isSealed, open as openSealed } from './crypto.ts';

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');

db.exec(`
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS services (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS services_project ON services(project_id);
CREATE TABLE IF NOT EXISTS deployments (id TEXT PRIMARY KEY, service_id TEXT NOT NULL, project_id TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS deployments_service ON deployments(service_id, created_at);
CREATE TABLE IF NOT EXISTS activity (id TEXT PRIMARY KEY, project_id TEXT, service_id TEXT, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS activity_ts ON activity(created_at);
CREATE TABLE IF NOT EXISTS tokens (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, service_id TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS runs_service ON runs(service_id, created_at);
CREATE TABLE IF NOT EXISTS certs (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS backups (id TEXT PRIMARY KEY, service_id TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS backups_service ON backups(service_id, created_at);
CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, service_id TEXT NOT NULL, deployment_id TEXT NOT NULL, cid TEXT NOT NULL, replica INTEGER NOT NULL, ts INTEGER NOT NULL, stream TEXT NOT NULL, text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS logs_service_ts ON logs(service_id, ts);
CREATE INDEX IF NOT EXISTS logs_cid_ts ON logs(cid, ts);
CREATE TABLE IF NOT EXISTS volumes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS volumes_project ON volumes(project_id);
CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS access_log (id INTEGER PRIMARY KEY AUTOINCREMENT, service_id TEXT NOT NULL, ts INTEGER NOT NULL, host TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL, bytes INTEGER NOT NULL, ms REAL NOT NULL, referrer TEXT NOT NULL, ref_host TEXT NOT NULL, ua TEXT NOT NULL, visitor TEXT NOT NULL, bot INTEGER NOT NULL, replica INTEGER);
CREATE INDEX IF NOT EXISTS access_log_service_ts ON access_log(service_id, ts);
CREATE TABLE IF NOT EXISTS metrics (service_id TEXT NOT NULL, t INTEGER NOT NULL, rps REAL, p50 REAL, p95 REAL, errors REAL, cpu REAL, mem REAL, replicas INTEGER, PRIMARY KEY (service_id, t));
`);

type Row = { data: string };

type Codec<T> = { encode: (v: T) => unknown; decode: (stored: any) => T };

/** Tiny JSON-document table helper: indexed columns for lookups, the rest lives in `data`. */
function table<T extends { id: string; createdAt?: number }>(name: string, cols: Record<string, (v: T) => unknown> = {}, codec?: Codec<T>) {
  const enc = (v: T) => JSON.stringify(codec ? codec.encode(v) : v);
  const dec = (data: string) => (codec ? codec.decode(JSON.parse(data)) : (JSON.parse(data) as T));
  const colNames = Object.keys(cols);
  const insertSql = `INSERT INTO ${name} (id, ${colNames.map((c) => c + ', ').join('')}data, created_at) VALUES (?, ${colNames
    .map(() => '?, ')
    .join('')}?, ?)`;
  const updateSql = `UPDATE ${name} SET ${colNames.map((c) => c + ' = ?, ').join('')}data = ? WHERE id = ?`;
  return {
    get(id: string): T | null {
      const r = db.prepare(`SELECT data FROM ${name} WHERE id = ?`).get(id) as Row | undefined;
      return r ? dec(r.data) : null;
    },
    all(where = '', ...params: (string | number | null)[]): T[] {
      const rows = db.prepare(`SELECT data FROM ${name} ${where}`).all(...params) as Row[];
      return rows.map((r) => dec(r.data));
    },
    insert(v: T): T {
      db.prepare(insertSql).run(
        v.id,
        ...colNames.map((c) => cols[c](v) as any),
        enc(v),
        v.createdAt ?? Date.now(),
      );
      return v;
    },
    put(v: T): T {
      db.prepare(updateSql).run(...colNames.map((c) => cols[c](v) as any), enc(v), v.id);
      return v;
    },
    delete(id: string) {
      db.prepare(`DELETE FROM ${name} WHERE id = ?`).run(id);
    },
    /** Raw rows still written in the legacy (unsealed) format. */
    unsealedIds(): string[] {
      if (!codec) return [];
      return (db.prepare(`SELECT id FROM ${name} WHERE json_extract(data, '$.sealed') IS NULL`).all() as { id: string }[]).map((r) => r.id);
    },
  };
}

// ───────────────────────────── sealing (secrets at rest) ─────────────────────────────

/** Services: variables and the git token live in one sealed blob. */
const serviceCodec: Codec<any> = {
  encode(s) {
    const { env, ...rest } = s;
    const source = { ...s.source };
    const token = source.token;
    delete source.token;
    return { ...rest, source, sealed: sealJson({ env, token }) };
  },
  decode(stored) {
    if (!stored.sealed) return stored; // legacy row, sealed on next write / boot migration
    const { sealed, ...rest } = stored;
    const { env, token } = openJson<{ env: Record<string, string>; token?: string }>(sealed);
    return { ...rest, env: env ?? {}, source: token ? { ...rest.source, token } : rest.source };
  },
};

/** Deployments: the config snapshot's variables + token and the fully resolved env (which embeds other services' secrets). */
const deploymentCodec: Codec<any> = {
  encode(d) {
    const { resolvedEnv, config: cfg, ...rest } = d;
    const source = { ...cfg.source };
    const token = source.token;
    delete source.token;
    return { ...rest, config: { ...cfg, env: undefined, source }, sealed: sealJson({ env: cfg.env, token, resolvedEnv }) };
  },
  decode(stored) {
    if (!stored.sealed) return stored;
    const { sealed, ...rest } = stored;
    const { env, token, resolvedEnv } = openJson<{ env: Record<string, string>; token?: string; resolvedEnv?: Record<string, string> }>(sealed);
    const out: any = { ...rest, config: { ...rest.config, env: env ?? {}, source: token ? { ...rest.config.source, token } : rest.config.source } };
    if (resolvedEnv) out.resolvedEnv = resolvedEnv;
    return out;
  },
};

import type { Project, Service, Deployment, ActivityEntry, JobRun, CertRecord, BackupRecord, VolumeRecord, ServerNode } from './types.ts';

export type TokenRecord = {
  id: string;
  name: string;
  prefix: string;
  scope: 'read' | 'write';
  createdAt: number;
  lastUsedAt: number | null;
};

export const projects = table<Project>('projects');
export const services = table<Service>('services', { project_id: (s) => s.projectId }, serviceCodec);
export const deployments = table<Deployment>('deployments', { service_id: (d) => d.serviceId, project_id: (d) => d.projectId }, deploymentCodec);
export const activityTable = table<ActivityEntry & { createdAt: number }>('activity', {
  project_id: (a) => a.projectId,
  service_id: (a) => a.serviceId,
});

export const runsTable = table<JobRun>('runs', { service_id: (r) => r.serviceId });
export const certsTable = table<CertRecord>('certs');
export const backupsTable = table<BackupRecord>('backups', { service_id: (b) => b.serviceId });
export const volumesTable = table<VolumeRecord>('volumes', { project_id: (v) => v.projectId });
export const nodesTable = table<ServerNode>('nodes');

/**
 * Boot migration: seal rows written before encryption existed, then compact the file so the old
 * plaintext pages (and the WAL) don't keep the secrets around.
 */
export function migrateSealing(): number {
  let n = 0;
  for (const t of [services, deployments] as const) {
    for (const id of t.unsealedIds()) {
      const v = t.get(id);
      if (v) {
        t.put(v as any);
        n++;
      }
    }
  }
  // Touch every sealed row once so a wrong master key fails loudly at boot, not mid-request.
  for (const r of db.prepare(`SELECT data FROM services WHERE json_extract(data, '$.sealed') IS NOT NULL LIMIT 1`).all() as Row[]) {
    openSealed(JSON.parse(r.data).sealed);
  }
  const s = kv.get('settings');
  if (s && !isSealed(s)) {
    kv.set('settings', sealJson(JSON.parse(s)));
    n++;
  }
  if (n) {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  return n;
}

/**
 * Boot migration: services created before the access log existed get the switch written out (on), so every
 * stored service says whether its requests are recorded.
 */
export function migrateAccessLog(): number {
  let n = 0;
  for (const { id } of db.prepare(`SELECT id FROM services WHERE json_extract(data, '$.accessLog') IS NULL`).all() as { id: string }[]) {
    const s = services.get(id);
    if (s) {
      services.put({ ...s, accessLog: true });
      n++;
    }
  }
  return n;
}

export const tokensTable = {
  insert(rec: TokenRecord, hash: string) {
    db.prepare('INSERT INTO tokens (id, hash, data, created_at) VALUES (?, ?, ?, ?)').run(rec.id, hash, JSON.stringify(rec), rec.createdAt);
  },
  byHash(hash: string): TokenRecord | null {
    const r = db.prepare('SELECT data FROM tokens WHERE hash = ?').get(hash) as Row | undefined;
    return r ? JSON.parse(r.data) : null;
  },
  list(): TokenRecord[] {
    return (db.prepare('SELECT data FROM tokens ORDER BY created_at DESC').all() as Row[]).map((r) => JSON.parse(r.data));
  },
  touch(rec: TokenRecord) {
    db.prepare('UPDATE tokens SET data = ? WHERE id = ?').run(JSON.stringify(rec), rec.id);
  },
  delete(id: string) {
    db.prepare('DELETE FROM tokens WHERE id = ?').run(id);
  },
};

export const kv = {
  get(key: string): string | null {
    const r = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  },
  set(key: string, value: string) {
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  },
  delete(key: string) {
    db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  },
};

export const sessionsTable = {
  create(id: string, expiresAt: number) {
    db.prepare('INSERT INTO sessions (id, expires_at) VALUES (?, ?)').run(id, expiresAt);
  },
  valid(id: string): boolean {
    const r = db.prepare('SELECT expires_at FROM sessions WHERE id = ?').get(id) as { expires_at: number } | undefined;
    return !!r && r.expires_at > Date.now();
  },
  delete(id: string) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  },
  prune() {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  },
};
