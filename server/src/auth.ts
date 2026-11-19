import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { kv, sessionsTable, tokensTable, type TokenRecord } from './db.ts';
import { id, sha256, HttpError } from './util.ts';
import { config } from './config.ts';
import type { Actor } from './events.ts';

export const SESSION_COOKIE = 'servify_session';
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30;

export function isSetUp(): boolean {
  return config.authMode === 'none' || !!kv.get('password_hash');
}

function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(pw: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  const hash = scryptSync(pw, Buffer.from(saltHex, 'hex'), 32);
  return timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

export function setPassword(pw: string) {
  if (!pw || pw.length < 6) throw new HttpError(400, 'password must be at least 6 characters');
  kv.set('password_hash', hashPassword(pw));
}

export function checkPassword(pw: string): boolean {
  const stored = kv.get('password_hash');
  return !!stored && verifyPassword(pw, stored);
}

export function createSession(): { id: string; maxAge: number } {
  const sid = randomBytes(32).toString('base64url');
  sessionsTable.create(sid, Date.now() + SESSION_TTL);
  return { id: sid, maxAge: SESSION_TTL / 1000 };
}

export function validSession(sid: string | undefined): boolean {
  return !!sid && sessionsTable.valid(sid);
}

export function destroySession(sid: string | undefined) {
  if (sid) sessionsTable.delete(sid);
}

export function createToken(name: string, scope: 'read' | 'write'): { token: string; record: TokenRecord } {
  const raw = `svf_${randomBytes(24).toString('base64url')}`;
  const record: TokenRecord = {
    id: id('tok'),
    name: name.trim() || 'agent',
    prefix: raw.slice(0, 10),
    scope,
    createdAt: Date.now(),
    lastUsedAt: null,
  };
  tokensTable.insert(record, sha256(raw));
  return { token: raw, record };
}

const touchThrottle = new Map<string, number>();

export function resolveToken(raw: string | undefined): TokenRecord | null {
  if (!raw || !raw.startsWith('svf_')) return null;
  const rec = tokensTable.byHash(sha256(raw));
  if (!rec) return null;
  const last = touchThrottle.get(rec.id) ?? 0;
  if (Date.now() - last > 30_000) {
    touchThrottle.set(rec.id, Date.now());
    rec.lastUsedAt = Date.now();
    tokensTable.touch(rec);
  }
  return rec;
}

export type Principal = { actor: Actor; scope: 'read' | 'write' };

export function principalFor(opts: { cookie?: string; bearer?: string }): Principal | null {
  if (opts.bearer) {
    const t = resolveToken(opts.bearer);
    if (t) return { actor: { type: 'agent', name: t.name }, scope: t.scope };
    return null;
  }
  if (config.authMode === 'none') return { actor: { type: 'user', name: 'you' }, scope: 'write' };
  if (validSession(opts.cookie)) return { actor: { type: 'user', name: 'you' }, scope: 'write' };
  return null;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** DNS-rebinding protection: only answer to hostnames we expect. */
export function hostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, '').toLowerCase();
  if (LOCAL_HOSTS.has(host)) return true;
  if (host === config.host) return true;
  if (config.allowedHosts.includes(host)) return true;
  if (host.endsWith('.localhost')) return true;
  return false;
}
