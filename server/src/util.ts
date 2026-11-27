import { randomBytes, createHash } from 'node:crypto';

const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function id(prefix = ''): string {
  const bytes = randomBytes(12);
  let out = '';
  for (const b of bytes) out += ALPHA[b % ALPHA.length];
  return prefix ? `${prefix}_${out}` : out;
}

export function shortId(n = 6): string {
  const bytes = randomBytes(n);
  let out = '';
  for (const b of bytes) out += ALPHA[b % ALPHA.length];
  return out;
}

export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'svc';
}

export function secret(bytes = 18): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function now(): number {
  return Date.now();
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function assert(cond: unknown, status: number, message: string): asserts cond {
  if (!cond) throw new HttpError(status, message);
}

/** Small async mutex keyed by string, used to serialize operations per service. */
export class KeyedLock {
  private chains = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.chains.set(key, tail);
    tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return next;
  }
}

export function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

/**
 * Credentials written into a repository URL (https://user:token@host/repo) taken out of it, so the URL can be
 * shown and logged and the secret is stored sealed. `user` is the name that goes with the token; '' means the
 * token itself was the user name (https://token@host/repo), which is sent that way again.
 */
export function splitRepoCredentials(repo: string): { repo: string; user?: string; token?: string } {
  const m = /^(https?:\/\/)([^/@\s]+)@(.+)$/i.exec(repo.trim());
  if (!m) return { repo };
  const dec = (v: string) => {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  const at = m[2].indexOf(':');
  const name = dec(at < 0 ? m[2] : m[2].slice(0, at));
  const pass = at < 0 ? '' : dec(m[2].slice(at + 1));
  const clean = `${m[1]}${m[3]}`;
  if (pass) return { repo: clean, user: name, token: pass };
  return name ? { repo: clean, user: '', token: name } : { repo: clean };
}
