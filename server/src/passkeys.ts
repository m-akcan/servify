/**
 * Passkeys (WebAuthn) for the owner: discoverable credentials, so signing in needs no user name — the password manager
 * or device offers the passkey for this host. User verification is required both when a passkey is added and when it
 * signs in (a passkey can be the only way in once password sign-in is limited or off), so an authenticator that can't
 * verify its user fails when it is added, not later.
 *
 * Every challenge is single use (taken on the first verify attempt, pass or fail), expires after two minutes, and is
 * bound to the host name (relying-party id), the origin and its purpose; challenges for adding a passkey also to the
 * dashboard session that asked. Each passkey records the host it belongs to and only signs in there.
 */
import { randomBytes } from 'node:crypto';
import { kv, passkeysTable, type PasskeyRecord } from './db.ts';
import { HttpError, id, sha256 } from './util.ts';
import { rpAllowed, type RelyingParty } from './signin.ts';

type WebAuthn = typeof import('@simplewebauthn/server');
let lib: WebAuthn | null = null;
/** Loaded on first use only (it probes WebCrypto features, which Node reports as experimental). */
const webauthn = async () => (lib ??= await import('@simplewebauthn/server'));

/** ES256, EdDSA, RS256: what password managers, phones and security keys use. */
const ALGORITHMS = [-7, -8, -257];
const CHALLENGE_TTL = 2 * 60_000;
const MAX_CHALLENGES = 1000;

export class PasskeyError extends HttpError {
  constructor(message: string, code = 'passkey_failed', status = 401) {
    super(status, message, code);
  }
}

/** The owner's WebAuthn user handle (random, stable): passkeys made for this Servify carry it. */
function userId(): string {
  let v = kv.get('webauthn_user_id');
  if (!v) {
    v = randomBytes(32).toString('base64url');
    kv.set('webauthn_user_id', v);
  }
  return v;
}

type Purpose = 'login' | 'register';
type Challenge = { challenge: string; purpose: Purpose; rpId: string; origin: string; session: string | null; expiresAt: number };
const challenges = new Map<string, Challenge>();

function putChallenge(c: Omit<Challenge, 'expiresAt'>): string {
  const now = Date.now();
  for (const [k, v] of challenges) if (v.expiresAt <= now) challenges.delete(k);
  while (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value!);
  const cid = randomBytes(18).toString('base64url');
  challenges.set(cid, { ...c, expiresAt: now + CHALLENGE_TTL });
  return cid;
}

/** Single use: gone after this, whatever happens next. */
function takeChallenge(cid: unknown, purpose: Purpose, rp: Extract<RelyingParty, { ok: true }>, session: string | null): Challenge {
  const c = typeof cid === 'string' ? challenges.get(cid) : undefined;
  if (typeof cid === 'string') challenges.delete(cid);
  if (!c || c.expiresAt <= Date.now()) throw new PasskeyError('This passkey request expired or was already used. Try again.', 'challenge_expired');
  if (c.purpose !== purpose || c.rpId !== rp.rpId || c.origin !== rp.origin || c.session !== session) throw new PasskeyError('This passkey request belongs to another page or host. Try again.', 'challenge_mismatch');
  return c;
}

const sessionRef = (sid: string) => sha256(`passkey-session:${sid}`);

// ───────────────────────────── signing in ─────────────────────────────

export async function loginOptions(rp: Extract<RelyingParty, { ok: true }>) {
  const w = await webauthn();
  const options = await w.generateAuthenticationOptions({ rpID: rp.rpId, userVerification: 'required', timeout: CHALLENGE_TTL });
  return { challengeId: putChallenge({ challenge: options.challenge, purpose: 'login', rpId: rp.rpId, origin: rp.origin, session: null }), options };
}

/** Verify a sign-in (or a confirmation in Settings) with a passkey. Throws PasskeyError on anything wrong. */
export async function verifyLogin(rp: Extract<RelyingParty, { ok: true }>, body: { challengeId?: unknown; response?: any }): Promise<PasskeyRecord> {
  const c = takeChallenge(body?.challengeId, 'login', rp, null);
  const response = body?.response;
  if (!response || typeof response.id !== 'string' || typeof response.response !== 'object') throw new PasskeyError('not a passkey response', 'passkey_failed', 400);
  const rec = passkeysTable.all('WHERE credential_id = ?', response.id)[0];
  if (!rec) throw new PasskeyError('This passkey is not known to this Servify (it may have been removed).', 'unknown_passkey');
  if (rec.rpId !== rp.rpId) throw new PasskeyError(`This passkey belongs to ${rec.rpId}, not ${rp.rpId}.`, 'wrong_host');
  if (!rpAllowed(rec.rpId)) throw new PasskeyError(`This passkey belongs to ${rec.rpId}, which this Servify no longer answers on.`, 'wrong_host');
  const handle = response.response?.userHandle;
  if (handle && handle !== userId()) throw new PasskeyError('This passkey was made for another account.', 'unknown_passkey');
  const w = await webauthn();
  let result;
  try {
    result = await w.verifyAuthenticationResponse({
      response,
      expectedChallenge: c.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      requireUserVerification: true,
      credential: { id: rec.credentialId, publicKey: Buffer.from(rec.publicKey, 'base64url'), counter: rec.counter, transports: rec.transports as any },
    });
  } catch (e) {
    throw new PasskeyError(`Passkey not accepted: ${(e as Error).message}`);
  }
  if (!result.verified) throw new PasskeyError('Passkey not accepted.');
  const fresh = passkeysTable.get(rec.id);
  if (fresh) passkeysTable.put({ ...fresh, counter: result.authenticationInfo.newCounter, backedUp: result.authenticationInfo.credentialBackedUp, lastUsedAt: Date.now() });
  return fresh ?? rec;
}

// ───────────────────────────── adding passkeys ─────────────────────────────

export async function registrationOptions(rp: Extract<RelyingParty, { ok: true }>, sid: string) {
  const w = await webauthn();
  const existing = passkeysTable.all().filter((p) => p.rpId === rp.rpId);
  const options = await w.generateRegistrationOptions({
    rpName: 'Servify',
    rpID: rp.rpId,
    userName: 'owner',
    userDisplayName: `Servify owner (${rp.rpId})`,
    userID: Buffer.from(userId(), 'base64url'),
    attestationType: 'none',
    timeout: CHALLENGE_TTL,
    supportedAlgorithmIDs: ALGORITHMS,
    excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports as any })),
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
  });
  return { challengeId: putChallenge({ challenge: options.challenge, purpose: 'register', rpId: rp.rpId, origin: rp.origin, session: sessionRef(sid) }), options };
}

/** Well-known passkey providers, for a default name (the owner can rename it). */
const PROVIDERS: Record<string, string> = {
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud Keychain',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
};

export function cleanName(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 60);
}

export async function verifyRegistration(rp: Extract<RelyingParty, { ok: true }>, sid: string, body: { challengeId?: unknown; response?: any; name?: unknown }): Promise<PasskeyRecord> {
  const c = takeChallenge(body?.challengeId, 'register', rp, sessionRef(sid));
  const response = body?.response;
  if (!response || typeof response.id !== 'string') throw new PasskeyError('not a passkey response', 'passkey_failed', 400);
  const w = await webauthn();
  let result;
  try {
    result = await w.verifyRegistrationResponse({ response, expectedChallenge: c.challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpId, requireUserVerification: true, supportedAlgorithmIDs: ALGORITHMS });
  } catch (e) {
    throw new PasskeyError(`Passkey not added: ${(e as Error).message}`, 'passkey_failed', 400);
  }
  if (!result.verified || !result.registrationInfo) throw new PasskeyError('Passkey not added.', 'passkey_failed', 400);
  const info = result.registrationInfo;
  if (passkeysTable.all('WHERE credential_id = ?', info.credential.id).length) throw new PasskeyError('This passkey is already added.', 'passkey_exists', 409);
  const now = Date.now();
  const rec: PasskeyRecord = {
    id: id('pk'),
    credentialId: info.credential.id,
    publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
    counter: info.credential.counter,
    transports: (response.response?.transports ?? info.credential.transports ?? []).filter((t: unknown) => typeof t === 'string').slice(0, 8),
    rpId: rp.rpId,
    name: cleanName(body?.name) || PROVIDERS[info.aaguid] || 'Passkey',
    aaguid: info.aaguid,
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
    createdAt: now,
    lastUsedAt: null,
  };
  passkeysTable.insert(rec);
  return rec;
}

// ───────────────────────────── managing ─────────────────────────────

export function publicPasskey(p: PasskeyRecord) {
  return { id: p.id, name: p.name, rpId: p.rpId, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt, deviceType: p.deviceType, backedUp: p.backedUp, usable: rpAllowed(p.rpId) };
}

export function listPasskeys() {
  return passkeysTable.all('ORDER BY created_at').map(publicPasskey);
}
