/** Talking to one Servify over its REST API with the device token. */
import { appHeaders, noteFeatures } from './appversion.ts';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Raised when the token stopped working (signed out from the dashboard, or revoked). */
export class SignedOutError extends ApiError {}

function humanize(status: number, serverMessage: string | undefined, host: string): string {
  if (status === 403 && serverMessage === 'host not allowed') {
    return `Servify refused the address ${host}. Add it to SERVIFY_ALLOWED_HOSTS on the server, or use its IP address.`;
  }
  if (status === 429) return serverMessage ?? 'Too many attempts. Wait a minute and try again.';
  return serverMessage ?? `Request failed (${status})`;
}

export function networkMessage(base: string): string {
  const host = new URL(base).host;
  return `Can't reach ${host}. Check that you're on your home Wi-Fi or connected to your VPN, and that Servify is running.`;
}

/**
 * Whether anything answers at this address. Used when a normal request fails: a Servify without
 * phone sign-in sends no CORS headers, so the app can't read its replies, but an opaque
 * (no-cors) request still succeeds there, while a dead address fails.
 */
export async function answers(base: string, timeoutMs = 6000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetch(`${base}/api/health`, { mode: 'no-cors', credentials: 'omit', cache: 'no-store', signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function call<T>(base: string, token: string | null, method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    const headers: Record<string, string> = { ...appHeaders(base) };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    res = await fetch(`${base}/api${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'omit',
      cache: 'no-store',
      signal: ctrl.signal,
    });
  } catch {
    throw new ApiError(0, networkMessage(base));
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  // What this server supports (for example the X-Servify-App header), learned from any /auth/status answer.
  if (res.ok && path === '/auth/status' && data && typeof data === 'object') noteFeatures(base, data.features);
  if (!res.ok) {
    const msg = humanize(res.status, data?.error, new URL(base).host);
    if (res.status === 401 && token && !path.startsWith('/auth/device')) throw new SignedOutError(401, 'This phone was signed out of Servify. Sign in again.');
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export type Client = {
  base: string;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
};

export function client(base: string, token: string): Client {
  return {
    base,
    get: (p) => call(base, token, 'GET', p),
    post: (p, b) => call(base, token, 'POST', p, b ?? {}),
    del: (p) => call(base, token, 'DELETE', p),
  };
}
