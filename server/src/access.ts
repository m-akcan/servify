/**
 * Router access control: IP allow/deny lists (IPv4 and IPv6 CIDRs), HTTP basic auth and per-client rate limits for
 * services, plus the built-in limits on deploy hooks and failed basic-auth attempts. proxy.ts enforces them on every
 * path through the router (HTTP, HTTPS, WebSocket upgrades, TCP proxy ports, UDP relays); this module only decides.
 *
 * Kept fast: rules are compiled once per service into a net.BlockList (native matching) when the service changes, a
 * verified basic-auth header is remembered for a while (scrypt runs once, off the main thread), and every limiter is a
 * capped map, so no visitor can grow memory without bound.
 *
 * The client address always comes from proxy.ts clientIpOf(): the socket peer, or the X-Forwarded-For hop a trusted
 * proxy (SERVIFY_TRUSTED_PROXIES) reports. Behind an untrusted proxy every visitor looks like the proxy — the router
 * notices (a private peer sending X-Forwarded-For) and the dashboard says so.
 */
import net from 'node:net';
import { scrypt, timingSafeEqual, randomBytes } from 'node:crypto';
import { kv } from './db.ts';
import { seal, open } from './crypto.ts';
import { bus } from './events.ts';
import { HttpError, sha256 } from './util.ts';
import { hashPassword } from './auth.ts';
import type { AccessControl, Service } from './types.ts';

/** The "private networks only" preset: RFC 1918, loopback, link-local, CGNAT (Tailscale), IPv6 loopback/ULA/link-local. */
export const PRIVATE = 'private';
export const PRIVATE_NETWORKS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16', '100.64.0.0/10', '::1/128', 'fc00::/7', 'fe80::/10'];

// ───────────────────────────── addresses and rules ─────────────────────────────

/** "::ffff:192.0.2.1" → "192.0.2.1", "[2001:db8::1]" → "2001:db8::1", zone ids dropped; null when not an address. */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    s = s.slice(1, end > 0 ? end : undefined);
  }
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(s)) s = s.slice(7);
  const fam = net.isIP(s);
  if (!fam) return null;
  return fam === 6 ? s.toLowerCase() : s;
}

const family = (ip: string) => (net.isIP(ip) === 6 ? 'ipv6' : 'ipv4') as 'ipv4' | 'ipv6';

/** One allow/deny entry, validated: an address, a CIDR, or `private`. Returns its canonical form. */
export function parseRule(entry: string): string {
  const s = String(entry ?? '').trim().toLowerCase();
  if (s === PRIVATE) return PRIVATE;
  const parts = s.split('/');
  if (parts.length > 2) throw new HttpError(400, `not an IP address or CIDR: ${entry}`);
  const ip = normalizeIp(parts[0]);
  if (!ip) throw new HttpError(400, `not an IP address or CIDR: ${entry} (e.g. 192.168.1.0/24, 2001:db8::/32 or "private")`);
  if (parts.length === 1) return ip;
  const max = net.isIP(ip) === 6 ? 128 : 32;
  if (!/^\d{1,3}$/.test(parts[1]) || Number(parts[1]) > max) throw new HttpError(400, `bad prefix length in ${entry} (0–${max})`);
  return `${ip}/${Number(parts[1])}`;
}

/** A list of entries from the API → canonical, de-duplicated. Throws a 400 naming the first bad one. */
export function parseRules(list: unknown, what: string): string[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new HttpError(400, `${what} must be a list of IP addresses or CIDRs`);
  if (list.length > 500) throw new HttpError(400, `${what}: at most 500 entries`);
  return [...new Set(list.map((e) => String(e)).filter((e) => e.trim()).map(parseRule))];
}

export type IpMatcher = net.BlockList;

export function compileRules(rules: string[] | undefined | null): IpMatcher | null {
  if (!rules?.length) return null;
  const bl = new net.BlockList();
  const add = (rule: string) => {
    const [ip, bits] = rule.split('/');
    if (bits === undefined) bl.addAddress(ip, family(ip));
    else bl.addSubnet(ip, Number(bits), family(ip));
  };
  for (const r of rules) {
    if (r === PRIVATE) PRIVATE_NETWORKS.forEach(add);
    else add(r);
  }
  return bl;
}

export function matches(m: IpMatcher, ip: string | null): boolean {
  const n = normalizeIp(ip);
  return !!n && m.check(n, family(n));
}

const privateMatcher = compileRules([PRIVATE])!;
export const isPrivateIp = (ip: string | null | undefined) => matches(privateMatcher, ip ?? null);

/** What limiters count by: the address, or its /64 for IPv6 (one host usually holds a whole /64). */
export function ipKey(ip: string | null): string {
  const n = normalizeIp(ip);
  if (!n) return String(ip ?? '?');
  if (net.isIP(n) !== 6) return n;
  const [head, tail] = n.includes('::') ? n.split('::') : [n, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const size = (a: string[]) => a.reduce((k, g) => k + (g.includes('.') ? 2 : 1), 0);
  const groups = [...h, ...Array(tail === null ? 0 : Math.max(0, 8 - size(h) - size(t))).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

// ───────────────────────────── limiters ─────────────────────────────

/**
 * Token buckets keyed by client (and whatever else the caller folds into the key), in a capped map: the least recently
 * seen key is dropped once `maxKeys` are tracked, so memory stays bounded whatever the number of visitors.
 */
export class Limiter {
  private m = new Map<string, { tokens: number; at: number }>();
  private maxKeys: number;
  constructor(maxKeys = 50_000) {
    this.maxKeys = maxKeys;
  }
  private bucket(key: string, capacity: number, perSec: number, create: boolean) {
    const now = Date.now();
    let b = this.m.get(key);
    if (b) {
      b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * perSec);
      b.at = now;
      this.m.delete(key); // most recently used goes last
      this.m.set(key, b);
    } else if (create) {
      b = { tokens: capacity, at: now };
      this.m.set(key, b);
      if (this.m.size > this.maxKeys) this.m.delete(this.m.keys().next().value!);
    }
    return b;
  }
  /** Spend one token: 0 when allowed, else the whole seconds until one is back. */
  take(key: string, capacity: number, perSec: number): number {
    const b = this.bucket(key, capacity, perSec, true)!;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / perSec));
  }
  /** Seconds until a token is available (0 = now), spending nothing. */
  wait(key: string, capacity: number, perSec: number): number {
    const b = this.bucket(key, capacity, perSec, false);
    return !b || b.tokens >= 1 ? 0 : Math.max(1, Math.ceil((1 - b.tokens) / perSec));
  }
  /** Give back a token spent on something that turned out fine. */
  refund(key: string, capacity: number) {
    const b = this.m.get(key);
    if (b) b.tokens = Math.min(capacity, b.tokens + 1);
  }
  get size() {
    return this.m.size;
  }
}

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Built-in limits, on by default. Deploy hooks: requests per minute per client (0 = off), and failed ones (bad token or
 * signature, unknown hook) per 10 minutes — past that every hook request from that client waits. Basic auth: failed
 * attempts per client and service per 5 minutes.
 */
export const LIMITS = {
  hookPerMinute: envNum('SERVIFY_HOOK_RATE_LIMIT', 120),
  hookFailures: envNum('SERVIFY_HOOK_FAIL_LIMIT', 20),
  authFailures: envNum('SERVIFY_AUTH_FAIL_LIMIT', 10),
};
const HOOK_FAIL_WINDOW = 600;
const AUTH_FAIL_WINDOW = 300;

const serviceLimiter = new Limiter();
const hookLimiter = new Limiter(20_000);
const failLimiter = new Limiter(20_000);

export type Denial = { status: 401 | 403 | 429; title: string; message: string; headers: Record<string, string> };

const tooMany = (retry: number, message: string): Denial => ({ status: 429, title: 'Too many requests', message, headers: { 'retry-after': String(retry), 'cache-control': 'no-store' } });

/** Deploy hooks and git webhooks (router and dashboard port): null to go ahead, else the 429. */
export function hookGate(ip: string | null): Denial | null {
  const key = ipKey(ip);
  if (LIMITS.hookFailures > 0) {
    const w = failLimiter.wait(`hookfail|${key}`, LIMITS.hookFailures, LIMITS.hookFailures / HOOK_FAIL_WINDOW);
    if (w) return tooMany(w, 'Too many failed hook requests from this address. Try again later.');
  }
  if (LIMITS.hookPerMinute > 0) {
    const w = hookLimiter.take(`hook|${key}`, LIMITS.hookPerMinute, LIMITS.hookPerMinute / 60);
    if (w) return tooMany(w, 'Too many hook requests from this address. Try again later.');
  }
  return null;
}

/** A hook answered with a failure (401/403/404): counts toward the failure limit. */
export function hookFailed(ip: string | null) {
  if (LIMITS.hookFailures > 0) failLimiter.take(`hookfail|${ipKey(ip)}`, LIMITS.hookFailures, LIMITS.hookFailures / HOOK_FAIL_WINDOW);
}

// ───────────────────────────── basic auth ─────────────────────────────

const authKey = (serviceId: string) => `basic_auth:${serviceId}`;
const HASH_FORMAT = /^[0-9a-f]{32}:[0-9a-f]{64}$/;

export function checkBasicPassword(pw: unknown): string {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'basic auth password: at least 8 characters');
  if (pw.length > 200) throw new HttpError(400, 'basic auth password: at most 200 characters');
  return pw;
}

/** Hash and store a service's basic-auth password (sealed, apart from the service record). */
export function setBasicAuthPassword(serviceId: string, pw: string) {
  kv.set(authKey(serviceId), seal(hashPassword(checkBasicPassword(pw))));
}

/** The stored hash (exports with secrets, copies). Never sent to a browser or a token. */
export function basicAuthHash(serviceId: string): string | null {
  const v = kv.get(authKey(serviceId));
  if (!v) return null;
  try {
    return open(v);
  } catch {
    return null;
  }
}

/** Take a hash from an export (`salt:hash`, hex); anything else, or none, locks the site with a random password. */
export function setBasicAuthHash(serviceId: string, hash: unknown) {
  if (typeof hash === 'string' && HASH_FORMAT.test(hash)) kv.set(authKey(serviceId), seal(hash));
  else kv.set(authKey(serviceId), seal(hashPassword(randomBytes(24).toString('base64url'))));
}

export function copyBasicAuth(fromId: string, toId: string) {
  setBasicAuthHash(toId, basicAuthHash(fromId));
}

export function deleteBasicAuth(serviceId: string) {
  kv.delete(authKey(serviceId));
}

const verified = new Map<string, number>(); // sha256(service, hash, header) → valid until
let verifying = 0;
const MAX_VERIFYING = 32;

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function scryptAsync(pw: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(pw, salt, 32, (err, key) => (err ? reject(err) : resolve(key))));
}

/** true / false, or null when too many checks are already running (answer 429). */
async function verifyBasic(serviceId: string, username: string, hash: string | null, header: string | undefined): Promise<boolean | null> {
  const m = /^Basic\s+([A-Za-z0-9+/=._~-]+)\s*$/i.exec(header ?? '');
  if (!m || !hash) return false;
  const ck = sha256(`${serviceId}\0${hash}\0${m[1]}`);
  const until = verified.get(ck);
  if (until && until > Date.now()) return true;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  if (verifying >= MAX_VERIFYING) return null;
  verifying++;
  try {
    const [saltHex, hashHex] = hash.split(':');
    const got = await scryptAsync(decoded.slice(i + 1), Buffer.from(saltHex, 'hex'));
    const ok = timingSafeEqual(got, Buffer.from(hashHex, 'hex')) && safeEqual(decoded.slice(0, i), username);
    if (ok) {
      verified.set(ck, Date.now() + 10 * 60_000);
      if (verified.size > 5000) verified.delete(verified.keys().next().value!);
    }
    return ok;
  } finally {
    verifying--;
  }
}

// ───────────────────────────── per-service rules ─────────────────────────────

export type CompiledAccess = {
  allow: IpMatcher | null;
  deny: IpMatcher | null;
  rate: { capacity: number; perSec: number } | null;
  basic: { username: string; exempt: string[]; hash: string | null; realm: string } | null;
  /** Rules that depend on the client address (they go wrong behind an untrusted proxy). */
  byAddress: boolean;
};

const compiled = new Map<string, CompiledAccess | null>();
bus.subscribe((ev) => {
  if (ev.type === 'service.updated') compiled.delete(ev.service.id);
  else if (ev.type === 'service.deleted') {
    compiled.delete(ev.serviceId);
    proxyNotes.delete(ev.serviceId);
  }
});

/** Already compiled rules by service id (undefined: not compiled yet). */
export const cachedAccess = (serviceId: string): CompiledAccess | null | undefined => (compiled.has(serviceId) ? compiled.get(serviceId)! : undefined);

/** The service's rules, compiled once per change (null: nothing to enforce). */
export function compiledFor(svc: Service): CompiledAccess | null {
  if (compiled.has(svc.id)) return compiled.get(svc.id)!;
  const a = svc.access;
  let c: CompiledAccess | null = null;
  if (a && (a.allow?.length || a.deny?.length || a.basicAuth || a.rateLimit)) {
    let allow: IpMatcher | null = null;
    let deny: IpMatcher | null = null;
    try {
      allow = compileRules(a.allow);
      deny = compileRules(a.deny);
    } catch {
      // A stored rule that no longer parses: refuse everyone rather than open up.
      allow = new net.BlockList();
    }
    c = {
      allow,
      deny,
      rate: svc.protocol === 'http' && a.rateLimit ? { capacity: a.rateLimit.requests, perSec: a.rateLimit.requests / a.rateLimit.perSeconds } : null,
      basic: svc.protocol === 'http' && a.basicAuth ? { username: a.basicAuth.username, exempt: a.basicAuth.exemptPaths ?? [], hash: basicAuthHash(svc.id), realm: svc.name.replace(/["\\\r\n]/g, '') } : null,
      byAddress: !!(allow || deny || (svc.protocol === 'http' && a.rateLimit)),
    };
  }
  compiled.set(svc.id, c);
  return c;
}

const forbidden = (): Denial => ({ status: 403, title: 'Access denied', message: 'This site is not available from your network.', headers: { 'cache-control': 'no-store' } });

/** IP allow/deny (HTTP and TCP alike). An address that can't be read fails closed. */
export function ipGate(c: CompiledAccess, ip: string | null): Denial | null {
  if (!c.allow && !c.deny) return null;
  const n = normalizeIp(ip);
  if (!n) return forbidden();
  if (c.deny && c.deny.check(n, family(n))) return forbidden();
  if (c.allow && !c.allow.check(n, family(n))) return forbidden();
  return null;
}

/** Everything for an HTTP request (or WebSocket handshake): IP rules, then the rate limit, then basic auth. */
export function httpGate(serviceId: string, c: CompiledAccess, ip: string | null, path: string, authorization: string | undefined): Denial | null | Promise<Denial | null> {
  const denied = ipGate(c, ip);
  if (denied) return denied;
  const key = ipKey(ip);
  if (c.rate) {
    const w = serviceLimiter.take(`${serviceId}|${key}`, c.rate.capacity, c.rate.perSec);
    if (w) return tooMany(w, 'Too many requests from your address. Slow down and try again shortly.');
  }
  const b = c.basic;
  if (!b || b.exempt.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`) || path.startsWith(`${p}?`))) return null;
  const challenge: Denial = { status: 401, title: 'Sign in required', message: 'This site is protected with a user name and password.', headers: { 'www-authenticate': `Basic realm="${b.realm || 'Servify'}", charset="UTF-8"`, 'cache-control': 'no-store' } };
  if (!authorization) return challenge;
  const fkey = `auth|${serviceId}|${key}`;
  const cap = LIMITS.authFailures;
  // A wrong password costs a token; one is taken before checking (and given back when it was right), so a burst of
  // parallel guesses can't run more checks than the limit allows.
  if (cap > 0) {
    const w = failLimiter.take(fkey, cap, cap / AUTH_FAIL_WINDOW);
    if (w) return tooMany(w, 'Too many failed sign-ins from your address. Try again later.');
  }
  return verifyBasic(serviceId, b.username, b.hash, authorization).then(
    (ok) => {
      if (ok === null) {
        if (cap > 0) failLimiter.refund(fkey, cap);
        return tooMany(2, 'The server is busy checking sign-ins. Try again in a moment.');
      }
      if (ok && cap > 0) failLimiter.refund(fkey, cap);
      return ok ? null : challenge;
    },
    () => challenge,
  );
}

// ───────────────────────────── untrusted proxies ─────────────────────────────

/**
 * A private address that isn't in SERVIFY_TRUSTED_PROXIES sent X-Forwarded-For to a service whose rules go by
 * address: there is a reverse proxy in front that Servify doesn't believe, so every visitor looks like that proxy.
 * Remembered per service (and 'dashboard') for a day; the peer is a proxy's private address, not a visitor's.
 */
const proxyNotes = new Map<string, { peer: string; lastSeenAt: number }>();
const NOTE_TTL = 24 * 3600_000;

/** Returns true when this is news (not seen in the last day), so the caller can tell the dashboard once. */
export function noteUntrustedProxy(key: string, peer: string): boolean {
  const prev = proxyNotes.get(key);
  const fresh = !prev || Date.now() - prev.lastSeenAt > NOTE_TTL;
  // Only news when there was no live note: alternating peers (two proxy replicas, 127.0.0.1 and ::1) update it quietly.
  if (prev && !fresh && prev.peer === peer && Date.now() - prev.lastSeenAt < 10_000) return false;
  proxyNotes.set(key, { peer, lastSeenAt: Date.now() });
  if (proxyNotes.size > 10_000) proxyNotes.delete(proxyNotes.keys().next().value!);
  return fresh;
}

export function untrustedProxy(key: string): { peer: string; lastSeenAt: number } | null {
  const n = proxyNotes.get(key);
  return n && Date.now() - n.lastSeenAt < NOTE_TTL ? n : null;
}

export function untrustedProxyMessage(peer: string): string {
  return `Requests arrive through a proxy at ${peer} that sends X-Forwarded-For, but SERVIFY_TRUSTED_PROXIES doesn't include it: every visitor looks like ${peer}, so address rules and rate limits treat them all as that one address. Add the proxy's address (or its network) to SERVIFY_TRUSTED_PROXIES and restart Servify.`;
}

// ───────────────────────────── validation (PATCH, imports) ─────────────────────────────

export type AccessInput = {
  allow?: string[] | null;
  deny?: string[] | null;
  basicAuth?: { username: string; password?: string | null; exemptPaths?: string[] | null } | null;
  rateLimit?: { requests: number; perSeconds: number } | null;
};

export const MASK = '••••••••';

function exemptPaths(list: unknown): string[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > 50) throw new HttpError(400, 'exemptPaths: a list of at most 50 paths');
  return [...new Set(list.map((p) => String(p).trim()).filter(Boolean))].map((p) => {
    if (!p.startsWith('/') || p.length > 200 || /[\s?#]/.test(p)) throw new HttpError(400, `exempt path must start with / (no spaces, ? or #): ${p}`);
    return p;
  });
}

/**
 * Merge a PATCH into the stored rules (fields left out stay; null clears). Returns the new rules and the password to
 * hash when one was given (the stored record never holds it). Throws a 400 on anything invalid.
 */
export function mergeAccess(svc: Service, patch: AccessInput | null): { access: AccessControl | null; password: string | null } {
  if (patch === null) return { access: null, password: null };
  const cur = svc.access ?? {};
  const next: AccessControl = { ...cur };
  let password: string | null = null;
  if (patch.allow !== undefined) next.allow = parseRules(patch.allow, 'allow');
  if (patch.deny !== undefined) next.deny = parseRules(patch.deny, 'deny');
  if (patch.rateLimit !== undefined) {
    const r = patch.rateLimit;
    if (r && (!Number.isInteger(r.requests) || r.requests < 1 || r.requests > 1_000_000 || !Number.isInteger(r.perSeconds) || r.perSeconds < 1 || r.perSeconds > 86_400)) throw new HttpError(400, 'rate limit: 1–1,000,000 requests per 1–86,400 seconds');
    next.rateLimit = r ? { requests: r.requests, perSeconds: r.perSeconds } : null;
  }
  if (patch.basicAuth !== undefined) {
    const b = patch.basicAuth;
    if (!b) next.basicAuth = null;
    else {
      const username = String(b.username ?? '').trim();
      if (!username || username.length > 100 || username.includes(':') || /[\r\n]/.test(username)) throw new HttpError(400, 'basic auth user name: 1–100 characters, no colon');
      const given = b.password === undefined || b.password === null || b.password === MASK ? null : checkBasicPassword(b.password);
      if (!given && !cur.basicAuth) throw new HttpError(400, 'basic auth needs a password (at least 8 characters)');
      password = given;
      next.basicAuth = { username, setAt: given ? Date.now() : cur.basicAuth!.setAt, ...(b.exemptPaths !== undefined ? { exemptPaths: exemptPaths(b.exemptPaths) } : cur.basicAuth?.exemptPaths ? { exemptPaths: cur.basicAuth.exemptPaths } : {}) };
      if (!next.basicAuth.exemptPaths?.length) delete next.basicAuth.exemptPaths;
    }
  }
  const proto = svc.protocol;
  if (proto !== 'http' && (next.basicAuth || next.rateLimit)) throw new HttpError(400, 'basic auth and rate limits need an HTTP service (TCP routes take IP allow/deny lists only)');
  if (proto === 'none' && (next.allow?.length || next.deny?.length)) throw new HttpError(400, `${svc.name} isn't reachable through the router (it's a worker): nothing to restrict`);
  for (const k of ['allow', 'deny'] as const) if (!next[k]?.length) delete next[k];
  for (const k of ['basicAuth', 'rateLimit'] as const) if (!next[k]) delete next[k];
  return { access: Object.keys(next).length ? next : null, password };
}

/** What a service's rules look like outside the server: no hash, a mask where the password is. */
export function publicAccess(svc: Service) {
  const a = svc.access;
  if (!a) return null;
  return {
    allow: a.allow ?? [],
    deny: a.deny ?? [],
    basicAuth: a.basicAuth ? { username: a.basicAuth.username, password: MASK, exemptPaths: a.basicAuth.exemptPaths ?? [], setAt: a.basicAuth.setAt } : null,
    rateLimit: a.rateLimit ?? null,
  };
}

/** Warnings for the service view: an untrusted proxy in front, rules that its TCP proxy port can't apply. */
export function accessWarnings(svc: Service): string[] {
  const out: string[] = [];
  const a = svc.access;
  if (!a) return out;
  const note = untrustedProxy(svc.id);
  if (note && (a.allow?.length || a.deny?.length || a.rateLimit)) out.push(untrustedProxyMessage(note.peer));
  if (svc.protocol === 'http' && svc.publicTcpPort && (a.basicAuth || a.rateLimit)) out.push(`Its TCP proxy port ${svc.publicTcpPort} skips basic auth and the rate limit (only the IP lists apply there): turn the TCP proxy off if it shouldn't be reachable without them.`);
  if (svc.ports?.length && (a.allow?.length || a.deny?.length)) out.push('Ports published straight on the server bypass the router, so these rules don\'t apply to them: use a firewall for those.');
  return out;
}

/** For a spec export: the rules, with the password hash only when secrets are included. */
export function exportAccess(svc: Service, secrets: boolean): (AccessControl & { basicAuth?: (NonNullable<AccessControl['basicAuth']> & { passwordHash?: string }) | null }) | null {
  if (!svc.access) return null;
  const a = structuredClone(svc.access) as any;
  if (a.basicAuth && secrets) {
    const h = basicAuthHash(svc.id);
    if (h) a.basicAuth.passwordHash = h;
  }
  return a;
}

/** A spec's rules, checked like a PATCH; the hash (if any) is stored for the new service. Invalid rules throw. */
export function importAccess(svc: Service, raw: any): AccessControl | null {
  if (!raw || typeof raw !== 'object') return null;
  const next: AccessControl = {};
  const allow = parseRules(raw.allow, 'allow');
  const deny = parseRules(raw.deny, 'deny');
  if (allow.length) next.allow = allow;
  if (deny.length) next.deny = deny;
  if (svc.protocol === 'http' && raw.rateLimit && Number.isInteger(raw.rateLimit.requests) && Number.isInteger(raw.rateLimit.perSeconds) && raw.rateLimit.requests >= 1 && raw.rateLimit.perSeconds >= 1)
    next.rateLimit = { requests: Math.min(1_000_000, raw.rateLimit.requests), perSeconds: Math.min(86_400, raw.rateLimit.perSeconds) };
  if (svc.protocol === 'http' && raw.basicAuth && typeof raw.basicAuth.username === 'string' && raw.basicAuth.username.trim() && !raw.basicAuth.username.includes(':')) {
    // Without a hash (an export without secrets) the site stays locked until the owner sets a password.
    setBasicAuthHash(svc.id, raw.basicAuth.passwordHash);
    next.basicAuth = { username: raw.basicAuth.username.trim().slice(0, 100), setAt: Date.now(), ...(Array.isArray(raw.basicAuth.exemptPaths) && raw.basicAuth.exemptPaths.length ? { exemptPaths: exemptPaths(raw.basicAuth.exemptPaths) } : {}) };
  }
  return Object.keys(next).length ? next : null;
}
