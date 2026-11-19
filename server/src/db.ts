import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';

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
`);

type Row = { data: string };

/** Tiny JSON-document table helper: indexed columns for lookups, the rest lives in `data`. */
function table<T extends { id: string; createdAt?: number }>(name: string, cols: Record<string, (v: T) => unknown> = {}) {
  const colNames = Object.keys(cols);
  const insertSql = `INSERT INTO ${name} (id, ${colNames.map((c) => c + ', ').join('')}data, created_at) VALUES (?, ${colNames
    .map(() => '?, ')
    .join('')}?, ?)`;
  const updateSql = `UPDATE ${name} SET ${colNames.map((c) => c + ' = ?, ').join('')}data = ? WHERE id = ?`;
  return {
    get(id: string): T | null {
      const r = db.prepare(`SELECT data FROM ${name} WHERE id = ?`).get(id) as Row | undefined;
      return r ? (JSON.parse(r.data) as T) : null;
    },
    all(where = '', ...params: (string | number | null)[]): T[] {
      const rows = db.prepare(`SELECT data FROM ${name} ${where}`).all(...params) as Row[];
      return rows.map((r) => JSON.parse(r.data) as T);
    },
    insert(v: T): T {
      db.prepare(insertSql).run(
        v.id,
        ...colNames.map((c) => cols[c](v) as any),
        JSON.stringify(v),
        v.createdAt ?? Date.now(),
      );
      return v;
    },
    put(v: T): T {
      db.prepare(updateSql).run(...colNames.map((c) => cols[c](v) as any), JSON.stringify(v), v.id);
      return v;
    },
    delete(id: string) {
      db.prepare(`DELETE FROM ${name} WHERE id = ?`).run(id);
    },
  };
}

import type { Project, Service, Deployment, ActivityEntry } from './types.ts';

export type TokenRecord = {
  id: string;
  name: string;
  prefix: string;
  scope: 'read' | 'write';
  createdAt: number;
  lastUsedAt: number | null;
};

export const projects = table<Project>('projects');
export const services = table<Service>('services', { project_id: (s) => s.projectId });
export const deployments = table<Deployment>('deployments', { service_id: (d) => d.serviceId, project_id: (d) => d.projectId });
export const activityTable = table<ActivityEntry & { createdAt: number }>('activity', {
  project_id: (a) => a.projectId,
  service_id: (a) => a.serviceId,
});

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
