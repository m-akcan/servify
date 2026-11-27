import { startAuthentication, startRegistration, browserSupportsWebAuthn, WebAuthnError } from '@simplewebauthn/browser';
import { api, ApiError } from './api.ts';

export type PasskeySignIn = { available: true; rpId: string } | { available: false; reason: string };
export type PasswordSignIn = { allowed: true } | { allowed: false; code: string; reason: string };
export type AuthStatus = { setUp: boolean; authenticated: boolean; authMode: 'password' | 'none'; passwordSignIn?: PasswordSignIn; passkeySignIn?: PasskeySignIn };

/**
 * Can this page use passkeys? The server decides for the host (HTTPS or localhost, a host name it answers on — an IP
 * address never works, even where the browser calls it a secure context); the browser must support WebAuthn too.
 */
export function passkeysHere(p: PasskeySignIn | undefined): { ok: true; rpId: string } | { ok: false; reason: string } {
  if (!p) return { ok: false, reason: 'This Servify doesn’t support passkeys yet.' };
  if (!p.available) return { ok: false, reason: p.reason };
  if (!window.isSecureContext) return { ok: false, reason: 'Passkeys need HTTPS (or localhost).' };
  if (!browserSupportsWebAuthn()) return { ok: false, reason: 'This browser doesn’t support passkeys.' };
  return { ok: true, rpId: p.rpId };
}

/** A cancelled browser prompt: not worth an error message. */
export function cancelled(e: unknown): boolean {
  const name = (e as Error)?.name;
  return name === 'NotAllowedError' || name === 'AbortError' || (e instanceof WebAuthnError && (e.code === 'ERROR_CEREMONY_ABORTED' || e.code === 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY'));
}

/** Ask the browser / password manager for a passkey for this host. Returns what /auth/passkey/login or /auth/reauth take. */
export async function getAssertion(): Promise<{ challengeId: string; response: unknown }> {
  const { challengeId, options } = await api.post<{ challengeId: string; options: any }>('/auth/passkey/options');
  const response = await startAuthentication({ optionsJSON: options });
  return { challengeId, response };
}

export async function signInWithPasskey() {
  await api.post('/auth/passkey/login', await getAssertion());
}

/** Add a passkey (the session must be freshly confirmed). Returns the server's suggestion for the password policy. */
export async function addPasskey(name: string): Promise<{ suggestPolicy: 'private' | null }> {
  const { challengeId, options } = await api.post<{ challengeId: string; options: any }>('/auth/passkeys/options');
  const response = await startRegistration({ optionsJSON: options });
  return api.post('/auth/passkeys', { challengeId, response, name });
}

export const needsReauth = (e: unknown) => e instanceof ApiError && e.code === 'reauth_required';
