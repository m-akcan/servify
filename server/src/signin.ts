/**
 * Signing in as the owner: where the password may be used (the password policy), throttling of failed attempts per
 * client address, the activity entries and notifications about them, and which host names passkeys can be bound to.
 *
 * The policy and the passkeys are read from the database on every use (never cached), so `servify auth reset` on the
 * host takes effect at once, also while Servify runs.
 */
import { kv, passkeysTable } from './db.ts';
import { PASSWORD_POLICY_KEY as POLICY_KEY } from './auth.ts';
import { config } from './config.ts';
import { getSettings } from './settings.ts';
import { recordActivity, SYSTEM, type Actor } from './events.ts';
import { notify } from './notify.ts';
import { HttpError } from './util.ts';
import { ipKey, isPrivateIp, normalizeIp } from './access.ts';
import { FailureThrottle } from './throttle.ts';
import type { DashboardClient } from './proxy.ts';

// ───────────────────────────── password policy ─────────────────────────────

export const PASSWORD_POLICIES = ['everywhere', 'private', 'off'] as const;
export type PasswordPolicy = (typeof PASSWORD_POLICIES)[number];

/** Missing (every install before passkeys) = everywhere, as it always was. */
export function passwordPolicy(): PasswordPolicy {
  const v = kv.get(POLICY_KEY);
  return v === 'private' || v === 'off' ? v : 'everywhere';
}

export type Refusal = { status: number; code: string; message: string };

/**
 * May this client sign in with the owner password (dashboard, phone app, confirming in Settings)? "Private networks"
 * goes by the visitor's real address (dashboardClient), and fails closed behind a proxy Servify doesn't trust.
 */
export function passwordRefusal(client: DashboardClient): Refusal | null {
  if (config.authMode === 'none') return null;
  const policy = passwordPolicy();
  if (policy === 'everywhere') return null;
  if (policy === 'off') return { status: 403, code: 'password_off', message: 'Password sign-in is turned off on this Servify: sign in with a passkey, or approve this phone from the dashboard.' };
  if (client.unsure) {
    return {
      status: 403,
      code: 'password_private_only',
      message: "Password sign-in is limited to private networks, and Servify can't tell where this request comes from (a proxy in front of it isn't in SERVIFY_TRUSTED_PROXIES). Sign in with a passkey.",
    };
  }
  if (!isPrivateIp(client.ip)) return { status: 403, code: 'password_private_only', message: 'Password sign-in is limited to private networks (home, office, VPN): sign in with a passkey, or approve this phone from the dashboard.' };
  return null;
}

/** Passkeys that can sign in today (bound to a host Servify still answers on). */
export function usablePasskeys() {
  return passkeysTable.all().filter((p) => rpAllowed(p.rpId));
}

/** Change the policy. "Off" needs a passkey that works on a host Servify answers on (or the owner would be locked out). */
export function setPasswordPolicy(actor: Actor, policy: unknown): PasswordPolicy {
  if (!PASSWORD_POLICIES.includes(policy as PasswordPolicy)) throw new HttpError(400, `policy must be one of ${PASSWORD_POLICIES.join(', ')}`);
  const p = policy as PasswordPolicy;
  if (config.authMode === 'none') throw new HttpError(400, 'sign-in is turned off on this Servify (SERVIFY_AUTH=none)');
  if (p === 'off' && !usablePasskeys().length) throw new HttpError(409, 'add a passkey first: with password sign-in off, a passkey is the only way into the dashboard');
  const before = passwordPolicy();
  kv.set(POLICY_KEY, p);
  if (before !== p) recordActivity(actor, 'auth.policy', `Password sign-in: ${describePolicy(p)}`);
  return p;
}

export function describePolicy(p: PasswordPolicy): string {
  return p === 'everywhere' ? 'allowed everywhere' : p === 'private' ? 'private networks only' : 'off (passkeys only)';
}

// ───────────────────────────── relying party (passkey host) ─────────────────────────────

/**
 * Host names a passkey may be bound to: localhost, the dashboard domain, SERVIFY_ALLOWED_HOSTS and SERVIFY_HOST when
 * it is a name. Narrower than the dashboard's host check on purpose: never any *.localhost (hosted apps live there)
 * and never an IP address (WebAuthn doesn't allow those).
 */
export function rpAllowed(rpId: string): boolean {
  if (!rpId || normalizeIp(rpId)) return false;
  if (rpId === 'localhost') return true;
  const dd = config.authMode === 'none' ? null : getSettings().dashboardDomain;
  if (dd && rpId === dd) return true;
  if (config.allowedHosts.map((h) => h.toLowerCase()).includes(rpId)) return true;
  return rpId === config.host.toLowerCase();
}

export type RelyingParty = { ok: true; rpId: string; origin: string } | { ok: false; reason: string };

/**
 * The passkey host for this request: the exact host name the browser used (from Host), and the origin it must report.
 * WebAuthn needs a secure context — HTTPS, or localhost — and a host name, not an address.
 */
export function relyingParty(hostHeader: string | undefined, client: DashboardClient): RelyingParty {
  const host = String(hostHeader ?? '').trim().toLowerCase();
  if (!host) return { ok: false, reason: 'no host' };
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
  if (normalizeIp(hostname)) return { ok: false, reason: 'Passkeys need a host name, not an IP address: open the dashboard at http://localhost on this machine, or at its dashboard domain over HTTPS (Settings → HTTPS).' };
  const secure = client.proto === 'https' || hostname === 'localhost' || hostname.endsWith('.localhost');
  if (!secure) return { ok: false, reason: `Passkeys need HTTPS: ${hostname} is reached over plain HTTP. Use the dashboard domain over HTTPS (Settings → HTTPS), or http://localhost on this machine.` };
  if (!rpAllowed(hostname)) return { ok: false, reason: `Passkeys aren't offered on ${hostname}: use localhost, the dashboard domain, or add it to SERVIFY_ALLOWED_HOSTS.` };
  // Browsers leave the default port out of the origin.
  const port = /:(\d+)$/.exec(host)?.[1];
  const keepPort = port && !((client.proto === 'https' && port === '443') || (client.proto === 'http' && port === '80'));
  return { ok: true, rpId: hostname, origin: `${client.proto}://${hostname}${keepPort ? `:${port}` : ''}` };
}

// ───────────────────────────── throttling ─────────────────────────────

const envNum = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * Password (dashboard, phone, confirming) and passkey failures are counted separately: an attacker guessing passwords
 * from the owner's network (a shared NAT, CGNAT) never locks the owner's passkey out, and passkey sign-in is outside
 * the global slow-down. Passkey failures are rare for the real owner, so they lock that address's passkey attempts.
 */
const throttles = {
  password: new FailureThrottle({ globalFree: envNum('SERVIFY_LOGIN_GLOBAL_FREE', 30) }),
  passkey: new FailureThrottle({ globalFree: Number.MAX_SAFE_INTEGER }),
};
export type ThrottleKind = keyof typeof throttles;

export class Throttled extends Error {
  retryAfter: number;
  constructor(retryAfter: number) {
    super(`Too many failed attempts from your network. Try again in ${retryAfter < 120 ? `${retryAfter} s` : `${Math.ceil(retryAfter / 60)} min`}.`);
    this.retryAfter = retryAfter;
  }
}

/** Throws Throttled when this address must wait. Then, for passwords, the global slow-down (a delay, never a refusal). */
export async function beforeAttempt(kind: ThrottleKind, client: DashboardClient): Promise<void> {
  const ms = throttles[kind].lockedMs(ipKey(client.ip));
  if (ms > 0) throw new Throttled(Math.ceil(ms / 1000));
  const delay = throttles[kind].globalDelayMs();
  if (delay > 0) await new Promise((r) => setTimeout(r, delay * (0.75 + Math.random() * 0.25)));
}

export type FailureWhat = 'password' | 'phone' | 'passkey' | 'confirm';

export function attemptFailed(kind: ThrottleKind, what: FailureWhat, client: DashboardClient) {
  const r = throttles[kind].fail(ipKey(client.ip));
  noteFailure(what, client.ip, r.lockMs > 0, r.dailyCap);
}

export function attemptSucceeded(kind: ThrottleKind, client: DashboardClient) {
  throttles[kind].succeed(ipKey(client.ip));
}

/** For tests and the Security page: failures per minute across all addresses. */
export function throttleState() {
  return { passwordFailuresPerMinute: throttles.password.globalRate(), passwordDelayMs: throttles.password.globalDelayMs() };
}

// ───────────────────────────── activity and notifications ─────────────────────────────

/**
 * Failures are written to the activity log in batches — one entry once things are quiet for QUIET (or every 10
 * minutes during a long run) — and notified once per burst (a burst ends after 30 quiet minutes) when it reaches
 * NOTIFY_AT failures or an address hits the daily cap. The entries name up to three addresses with their counts.
 */
const QUIET = envNum('SERVIFY_AUTH_LOG_QUIET_MS', 60_000);
const MAX_BATCH = 10 * 60_000;
const BURST_GAP = 30 * 60_000;
const NOTIFY_AT = 10;

type Batch = { first: number; last: number; total: number; what: Record<FailureWhat, number>; ips: Map<string, number>; locked: Set<string> };
let batch: Batch | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let burst: { last: number; total: number; notified: boolean; ips: Set<string> } | null = null;

function noteFailure(what: FailureWhat, ip: string | null, locked: boolean, dailyCap: boolean) {
  const now = Date.now();
  const addr = ip ?? 'unknown address';
  if (!batch) batch = { first: now, last: now, total: 0, what: { password: 0, phone: 0, passkey: 0, confirm: 0 }, ips: new Map(), locked: new Set() };
  batch.last = now;
  batch.total++;
  batch.what[what]++;
  batch.ips.set(addr, (batch.ips.get(addr) ?? 0) + 1);
  if (locked) batch.locked.add(addr);
  scheduleFlush();

  if (!burst || now - burst.last > BURST_GAP) burst = { last: now, total: 0, notified: false, ips: new Set() };
  burst.last = now;
  burst.total++;
  burst.ips.add(addr);
  if (!burst.notified && (burst.total >= NOTIFY_AT || dailyCap)) {
    burst.notified = true;
    const n = burst.ips.size;
    notify({
      event: 'auth.failed',
      level: 'error',
      title: 'Failed sign-ins to Servify',
      message: `${burst.total} failed sign-in attempt${burst.total === 1 ? '' : 's'} from ${n} address${n === 1 ? '' : 'es'} in a short time${dailyCap ? ' (one reached the daily limit)' : ''}. Servify slows each address down and locks it out for a while; details are in the activity log. If this wasn't you, consider passkeys and limiting password sign-in to private networks (Settings → Security).`,
    });
  }
}

function scheduleFlush() {
  if (!batch) return;
  if (flushTimer) clearTimeout(flushTimer);
  const at = Math.min(batch.last + QUIET, batch.first + MAX_BATCH);
  flushTimer = setTimeout(flushFailures, Math.max(0, at - Date.now()));
  flushTimer.unref?.();
}

export function flushFailures() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const b = batch;
  batch = null;
  if (!b || !b.total) return;
  const kinds = Object.entries(b.what)
    .filter(([, n]) => n)
    .map(([k, n]) => `${n} ${k === 'password' ? 'password' : k === 'phone' ? 'phone app' : k === 'passkey' ? 'passkey' : 'confirmation'}`)
    .join(', ');
  const top = [...b.ips].sort((x, y) => y[1] - x[1]);
  const named = top.slice(0, 3).map(([ip, n]) => `${ip} (${n})`).join(', ') + (top.length > 3 ? ` and ${top.length - 3} more` : '');
  const mins = Math.max(1, Math.round((b.last - b.first) / 60_000));
  const locked = b.locked.size ? `; ${b.locked.size} address${b.locked.size === 1 ? '' : 'es'} locked out for a while` : '';
  recordActivity(SYSTEM, 'auth.failed', `${b.total} failed sign-in attempt${b.total === 1 ? '' : 's'} (${kinds}) within ${mins} min from ${named}${locked}`);
}
