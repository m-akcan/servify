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

export function createToken(name: string, scope: 'read' | 'write', kind: 'agent' | 'device' = 'agent'): { token: string; record: TokenRecord } {
  const raw = `svf_${randomBytes(24).toString('base64url')}`;
  const record: TokenRecord = {
    id: id(kind === 'device' ? 'dev' : 'tok'),
    name: name.trim().slice(0, 60) || kind,
    prefix: raw.slice(0, 10),
    scope,
    kind,
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

/** tokenId: the token the request came with (agents and signed-in devices). */
export type Principal = { actor: Actor; scope: 'read' | 'write'; tokenId?: string };

export function principalFor(opts: { cookie?: string; bearer?: string }): Principal | null {
  if (opts.bearer) {
    const t = resolveToken(opts.bearer);
    if (!t) return null;
    // A signed-in phone is the owner, like a dashboard session.
    if (t.kind === 'device') return { actor: { type: 'user', name: 'you' }, scope: 'write', tokenId: t.id };
    return { actor: { type: 'agent', name: t.name }, scope: t.scope, tokenId: t.id };
  }
  if (config.authMode === 'none') return { actor: { type: 'user', name: 'you' }, scope: 'write' };
  if (validSession(opts.cookie)) return { actor: { type: 'user', name: 'you' }, scope: 'write' };
  return null;
}

const loginAttempts: number[] = [];
/** One limit for every way of signing in with the owner password (dashboard and app). */
export function throttleLogin() {
  const now = Date.now();
  while (loginAttempts.length && now - loginAttempts[0] > 60_000) loginAttempts.shift();
  if (loginAttempts.length > 10) throw new HttpError(429, 'too many attempts, wait a minute');
  loginAttempts.push(now);
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * DNS-rebinding protection: only answer to hostnames we expect. A bare IP address can't be a
 * rebinding attack (that needs the attacker's hostname), so LAN and VPN addresses always work.
 */
export function hostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  if (hostHeader.startsWith('[')) return true; // IPv6 literal, [addr] or [addr]:port
  const host = hostHeader.replace(/:\d+$/, '').toLowerCase();
  if (LOCAL_HOSTS.has(host)) return true;
  if (IPV4.test(host)) return true;
  if (host === config.host) return true;
  if (config.allowedHosts.includes(host)) return true;
  if (host.endsWith('.localhost')) return true;
  return false;
}

/** Origins of the Servify mobile app's WebView (Capacitor). They get CORS, never credentials. */
export const APP_ORIGINS = new Set(['http://localhost', 'https://localhost', 'capacitor://localhost']);

/**
 * CSRF guard: browsers always send Origin on cross-site writes. It must be exactly our own
 * origin — hosted apps live on *.localhost too, so a mere "is local" check is not enough.
 * A request with an Authorization header carries its own credential, which no other site can
 * attach, so it can't be forged; that is how the mobile app calls the API.
 */
export function originOk(origin: string | undefined, host: string | undefined, method: string, authHeader?: string): boolean {
  if (!origin) return true; // non-browser clients (curl, agents, MCP SDKs)
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  if (authHeader?.startsWith('Bearer ')) return true;
  try {
    return new URL(origin).host.toLowerCase() === (host ?? '').toLowerCase();
  } catch {
    return false;
  }
}
