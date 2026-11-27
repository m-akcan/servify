import { scryptSync, scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { kv, sessionsTable, tokensTable, projects as projectsTable, type TokenRecord } from './db.ts';
import { id, sha256, HttpError } from './util.ts';
import { config } from './config.ts';
import { getSettings } from './settings.ts';
import type { Actor } from './events.ts';
import type { TokenScope } from './policy.ts';

export const SESSION_COOKIE = 'servify_session';
/** A dashboard session ends 30 days after sign-in at the latest (as it always did)… */
export const SESSION_TTL = 1000 * 60 * 60 * 24 * 30;
/** …and after 7 days without being used. */
export const SESSION_IDLE = 1000 * 60 * 60 * 24 * 7;
/** Adding or removing a passkey and changing the password policy need a sign-in or confirmation this recent. */
export const REAUTH_WINDOW = 5 * 60_000;
/** kv key of the password policy (signin.ts); `servify auth reset` writes it directly. */
export const PASSWORD_POLICY_KEY = 'password_policy';

export function isSetUp(): boolean {
  return config.authMode === 'none' || !!kv.get('password_hash');
}

export function hashPassword(pw: string): string {
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

// scrypt off the main thread, a few at a time: the router shares this process, so a flood of sign-in attempts must
// not stall every hosted site (the per-address throttle in signin.ts runs before any of this).
const MAX_HASHING = 2;
let hashing = 0;
const hashQueue: (() => void)[] = [];
async function hashSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (hashing >= MAX_HASHING) await new Promise<void>((r) => hashQueue.push(r));
  hashing++;
  try {
    return await fn();
  } finally {
    hashing--;
    hashQueue.shift()?.();
  }
}

/** checkPassword without blocking the event loop. */
export async function checkPasswordAsync(pw: string): Promise<boolean> {
  const stored = kv.get('password_hash');
  if (!stored || typeof pw !== 'string') return false;
  const [saltHex, hashHex] = stored.split(':');
  const hash = await hashSlot(
    () => new Promise<Buffer>((resolve, reject) => scrypt(pw, Buffer.from(saltHex, 'hex'), 32, (err, key) => (err ? reject(err) : resolve(key)))),
  );
  return timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

export function createSession(): { id: string; maxAge: number } {
  const sid = randomBytes(32).toString('base64url');
  sessionsTable.create(sid, Date.now() + SESSION_TTL);
  return { id: sid, maxAge: SESSION_TTL / 1000 };
}

/**
 * Valid: within its absolute lifetime and used in the last SESSION_IDLE. Sessions from before the idle timeout existed
 * (no last-use time) start counting now. Use is noted at most once a minute.
 */
export function validSession(sid: string | undefined): boolean {
  if (!sid) return false;
  const r = sessionsTable.get(sid);
  if (!r) return false;
  const now = Date.now();
  if (r.expiresAt <= now || (r.seenAt !== null && now - r.seenAt > SESSION_IDLE)) {
    sessionsTable.delete(sid);
    return false;
  }
  if (r.seenAt === null || now - r.seenAt > 60_000) sessionsTable.touch(sid, now);
  return true;
}

/** Signed in or confirmed (password or passkey) within REAUTH_WINDOW. */
export function sessionFresh(sid: string | undefined): boolean {
  if (!sid || !validSession(sid)) return false;
  const r = sessionsTable.get(sid);
  return !!r?.reauthAt && Date.now() - r.reauthAt < REAUTH_WINDOW;
}

/** Until when the session counts as freshly confirmed (ms), or null. */
export function sessionFreshUntil(sid: string | undefined): number | null {
  const r = sid ? sessionsTable.get(sid) : null;
  return r?.reauthAt ? r.reauthAt + REAUTH_WINDOW : null;
}

export function markReauthenticated(sid: string) {
  sessionsTable.reauthed(sid);
}

export function destroySession(sid: string | undefined) {
  if (sid) sessionsTable.delete(sid);
}

/**
 * `projects`: ids of the (base) projects an agent token is limited to; left out, it reaches all of them. Validate
 * them first (normalizeTokenProjects below). Device tokens act as the owner: always write, never limited.
 */
export function createToken(name: string, scope: TokenScope, kind: 'agent' | 'device' = 'agent', projects?: string[] | null): { token: string; record: TokenRecord } {
  if (!['read', 'deploy', 'write'].includes(scope)) throw new HttpError(400, 'scope must be read, deploy or write');
  if (kind === 'device' && (scope !== 'write' || projects)) throw new HttpError(400, 'device tokens act as the owner');
  if (projects && !projects.length) throw new HttpError(400, 'pick at least one project, or leave the list out for all projects');
  // Deploy and project-limited tokens get their own prefix: Servify 0.2.3 and older only accept `svf_`, so after a
  // rollback to such a version these tokens stop working instead of acting as full write tokens.
  const narrowed = scope === 'deploy' || !!projects;
  const raw = `${narrowed ? 'svs_' : 'svf_'}${randomBytes(24).toString('base64url')}`;
  const record: TokenRecord = {
    id: id(kind === 'device' ? 'dev' : 'tok'),
    name: name.trim().slice(0, 60) || kind,
    prefix: raw.slice(0, 10),
    scope,
    kind,
    // Only written when set: a token for all projects is stored exactly as before scoped tokens existed.
    ...(projects ? { projects: [...projects] } : {}),
    createdAt: Date.now(),
    lastUsedAt: null,
  };
  tokensTable.insert(record, sha256(raw));
  return { token: raw, record };
}

/**
 * Validate a token's project list: ids or slugs of existing base projects → their ids. Environments are refused
 * (pick the project: its environments and pull-request previews come with it, and they read its shared variables).
 */
export function normalizeTokenProjects(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) throw new HttpError(400, 'projects must be a list of project ids or slugs');
  if (!raw.length) throw new HttpError(400, 'pick at least one project, or leave the list out for all projects');
  if (raw.length > 100) throw new HttpError(400, 'at most 100 projects');
  const ids = new Set<string>();
  for (const r of raw) {
    if (typeof r !== 'string' || !r.trim()) throw new HttpError(400, 'projects must be a list of project ids or slugs');
    const ref = r.trim();
    const p = projectsTable.get(ref) ?? projectsTable.all(`WHERE json_extract(data, '$.slug') = ?`, ref)[0];
    if (!p) throw new HttpError(404, `project not found: ${ref}`);
    if (p.parentId) {
      const base = projectsTable.get(p.parentId);
      throw new HttpError(400, `${p.slug} is an environment of ${base?.name ?? 'another project'}: pick ${base?.slug ?? 'that project'} — its environments and previews come with it`);
    }
    ids.add(p.id);
  }
  return [...ids];
}

const touchThrottle = new Map<string, number>();

/** `X-Servify-App: <versionName>/<versionCode>`, as the phone app sends it; anything else is ignored. */
export function parseAppHeader(h: string | undefined): { name: string; code: number } | null {
  const m = h ? /^(\d{1,4}\.\d{1,4}\.\d{1,4})\/(\d{1,9})$/.exec(h.trim()) : null;
  return m ? { name: m[1], code: Number(m[2]) } : null;
}

/**
 * The token's record, with its last use noted (at most every 30 s). `appHeader`: the phone app's X-Servify-App header;
 * for device tokens its version is kept on the record (written only when it changes), so the dashboard can show which
 * phones run an old app.
 */
export function resolveToken(raw: string | undefined, appHeader?: string): TokenRecord | null {
  if (!raw || !(raw.startsWith('svf_') || raw.startsWith('svs_'))) return null;
  const rec = tokensTable.byHash(sha256(raw));
  if (!rec) return null;
  let dirty = false;
  const app = rec.kind === 'device' ? parseAppHeader(appHeader) : null;
  if (app && (rec.lastAppVersion !== app.name || rec.lastAppVersionCode !== app.code)) {
    rec.lastAppVersion = app.name;
    rec.lastAppVersionCode = app.code;
    dirty = true;
  }
  const last = touchThrottle.get(rec.id) ?? 0;
  if (Date.now() - last > 30_000) {
    touchThrottle.set(rec.id, Date.now());
    rec.lastUsedAt = Date.now();
    dirty = true;
  }
  if (dirty) tokensTable.touch(rec);
  return rec;
}

/**
 * tokenId: the token the request came with (agents and signed-in devices). projects: the project ids an agent token
 * is limited to (their environments come with them); missing = all projects. See scopes.ts.
 */
export type Principal = { actor: Actor; scope: TokenScope; tokenId?: string; projects?: string[] };

export function principalFor(opts: { cookie?: string; bearer?: string; app?: string }): Principal | null {
  if (opts.bearer) {
    const t = resolveToken(opts.bearer, opts.app);
    if (!t) return null;
    // A signed-in phone is the owner, like a dashboard session.
    if (t.kind === 'device') return { actor: { type: 'user', name: 'you' }, scope: 'write', tokenId: t.id };
    // A record from before scoped tokens (or one for all projects) has no projects: unlimited, as it always was. A
    // scope this version doesn't know reads as read-only rather than more.
    const scope: TokenScope = t.scope === 'write' || t.scope === 'deploy' ? t.scope : 'read';
    return { actor: { type: 'agent', name: t.name }, scope, tokenId: t.id, ...(Array.isArray(t.projects) ? { projects: [...t.projects] } : {}) };
  }
  if (config.authMode === 'none') return { actor: { type: 'user', name: 'you' }, scope: 'write' };
  if (validSession(opts.cookie)) return { actor: { type: 'user', name: 'you' }, scope: 'write' };
  return null;
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
  // The dashboard domain (Settings → HTTPS): the router serves the dashboard there.
  if (config.authMode !== 'none' && host === getSettings().dashboardDomain) return true;
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
