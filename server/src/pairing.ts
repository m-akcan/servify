/**
 * Approving a phone from the dashboard (for when password sign-in is limited or off). The app asks for a pairing and
 * shows a short code; the owner, signed in on the dashboard, compares it and approves; the app's next poll receives a
 * normal device token — exactly once.
 *
 * Kept in memory only (a pairing lives five minutes; a restart simply asks the phone to start over). The app's
 * pairingId is a long secret and is stored hashed; the dashboard refers to requests by a separate short id. Neither
 * the code nor the pairingId is ever put on the event bus or in the activity log (read-only tokens can see those).
 *
 * Limits: a few starts per address per 10 minutes, at most PER_IP pending per address and GLOBAL pending in all. When
 * all slots are taken, new requests are refused (429) rather than pushing out older ones — otherwise anyone could
 * push the owner's own request out — and the dashboard can deny every pending request at once to free them.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { sha256, HttpError, id } from './util.ts';
import { bus, recordActivity } from './events.ts';
import { createToken } from './auth.ts';
import { ipKey, Limiter } from './access.ts';
import { cleanName } from './passkeys.ts';

/** Five minutes (SERVIFY_PAIRING_TTL_MS shortens it for tests). */
export const PAIRING_TTL = Number(process.env.SERVIFY_PAIRING_TTL_MS) > 0 ? Number(process.env.SERVIFY_PAIRING_TTL_MS) : 5 * 60_000;
/** Finished requests (denied, expired) still answer polls for this long, so the app learns what happened. */
const KEEP_AFTER = 10 * 60_000;
const PER_IP = 2;
const GLOBAL = 10;
const STARTS = 5; // per address per 10 minutes
const POLLS = 120; // per address per minute
/** No 0/O, 1/I/L: easy to compare on a phone screen. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

type Pairing = { id: string; secretHash: string; code: string; name: string; ip: string | null; createdAt: number; expiresAt: number; status: 'pending' | 'approved' | 'denied' };
const pairings = new Map<string, Pairing>(); // by secretHash
const limiter = new Limiter(20_000);

function sweep() {
  const now = Date.now();
  let changed = false;
  for (const [k, p] of pairings) {
    if (p.expiresAt + KEEP_AFTER <= now) {
      pairings.delete(k);
      changed ||= p.status === 'pending';
    }
  }
  if (changed) signal();
}
const pending = () => [...pairings.values()].filter((p) => p.status === 'pending' && p.expiresAt > Date.now());
/** The dashboard refreshes its list on this (owners only; no payload). */
const signal = () => bus.publish({ type: 'auth.pairing' });

export class PairingLimited extends HttpError {
  retryAfter: number;
  constructor(message: string, retryAfter: number) {
    super(429, message, 'throttled');
    this.retryAfter = retryAfter;
  }
}

export function startPairing(ip: string | null, rawName: unknown) {
  sweep();
  const key = ipKey(ip);
  const wait = limiter.take(`start|${key}`, STARTS, STARTS / 600);
  if (wait) throw new PairingLimited('Too many pairing requests from your network. Try again later.', wait);
  const all = pending();
  if (all.filter((p) => ipKey(p.ip) === key).length >= PER_IP) throw new PairingLimited('This network already has pairing requests waiting: approve or deny them in the dashboard, or wait five minutes.', 60);
  if (all.length >= GLOBAL) throw new PairingLimited('Too many pairing requests are waiting. Deny the ones you don’t recognise in the dashboard (Settings → Security), or wait five minutes.', 60);
  const pairingId = randomBytes(32).toString('base64url');
  const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  const now = Date.now();
  const p: Pairing = { id: id('pair'), secretHash: sha256(pairingId), code, name: cleanName(rawName) || 'Phone', ip, createdAt: now, expiresAt: now + PAIRING_TTL, status: 'pending' };
  pairings.set(p.secretHash, p);
  signal();
  return { pairingId, code, expiresAt: p.expiresAt };
}

/** Polled by the app. "approved" hands out the device token once; the pairing is gone afterwards. */
export function pollPairing(ip: string | null, pairingId: string) {
  const wait = limiter.take(`poll|${ipKey(ip)}`, POLLS, POLLS / 60);
  if (wait) throw new PairingLimited('Polling too fast. Slow down.', wait);
  sweep();
  const p = typeof pairingId === 'string' && pairingId.length >= 20 ? pairings.get(sha256(pairingId)) : undefined;
  if (!p) return { status: 404, body: { status: 'expired' as const } };
  const now = Date.now();
  if (p.expiresAt <= now) return { status: 200, body: { status: p.status === 'denied' ? ('denied' as const) : ('expired' as const) } };
  if (p.status === 'pending') return { status: 200, body: { status: 'pending' as const, expiresAt: p.expiresAt } };
  if (p.status === 'denied') return { status: 200, body: { status: 'denied' as const } };
  // Approved: mint the token now, synchronously, and forget the pairing so a second poll gets nothing.
  pairings.delete(p.secretHash);
  const { token, record } = createToken(p.name, 'write', 'device');
  recordActivity({ type: 'user', name: 'you' }, 'device.signin', `Signed in on ${record.name} (approved from the dashboard)`);
  signal();
  return { status: 200, body: { status: 'approved' as const, token, device: record } };
}

export function listPairings() {
  sweep();
  return pending()
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((p) => ({ id: p.id, code: p.code, name: p.name, ip: p.ip, createdAt: p.createdAt, expiresAt: p.expiresAt }));
}

function byId(pid: string): Pairing {
  sweep();
  const p = [...pairings.values()].find((x) => x.id === pid);
  if (!p || p.status !== 'pending' || p.expiresAt <= Date.now()) throw new HttpError(404, 'no such pairing request (it may have expired)');
  return p;
}

export function decidePairing(pid: string, approve: boolean) {
  const p = byId(pid);
  p.status = approve ? 'approved' : 'denied';
  if (!approve) recordActivity({ type: 'user', name: 'you' }, 'device.denied', `Denied a phone's sign-in request (${p.name})`);
  signal();
  return { ok: true };
}

export function denyAllPairings(): number {
  const all = pending();
  for (const p of all) p.status = 'denied';
  if (all.length) {
    recordActivity({ type: 'user', name: 'you' }, 'device.denied', `Denied ${all.length} phone sign-in request${all.length === 1 ? '' : 's'}`);
    signal();
  }
  return all.length;
}
