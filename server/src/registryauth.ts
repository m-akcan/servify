/**
 * Registry logins, from two places:
 *
 *   - Servify's own (Settings → Registry logins): a registry host, a username and a token, sealed in the database
 *     (kv `registry.logins`, AES-256-GCM like every other secret) and never returned by the API. Used for pulls on
 *     this machine and on remote servers — passed to that server's Docker for the one pull request (X-Registry-Auth
 *     through the agent tunnel, which pipes the Docker socket and keeps nothing) — and for image update checks.
 *   - the docker CLI's login of the user Servify runs as, looked up the way the CLI does: ~/.docker/config.json (or
 *     $DOCKER_CONFIG) `credHelpers` for the registry, else `credsStore`, else the `auths` entry. Used for pulls on this
 *     machine only (never sent to remote servers by Servify itself) and for update checks.
 *
 * A Servify login wins over a docker one for the same host. Credentials are never logged or put in an error message —
 * errors name the host only.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { kv } from './db.ts';
import { sealJson, openJson } from './crypto.ts';
import { HttpError, id as newId } from './util.ts';
import { recordActivity, type Actor } from './events.ts';

export type RegistryCredentials = { username: string; password: string } | { identitytoken: string };
export type CredentialSource = 'servify' | 'docker';

// ───────────────────────────── Servify's own logins ─────────────────────────────

type StoredLogin = { id: string; registry: string; username: string; password: string; createdAt: number; updatedAt: number };
/** What the API shows: never the token. */
export type PublicRegistryLogin = Omit<StoredLogin, 'password'> & { hasPassword: true };
const KEY = 'registry.logins';

function loadLogins(): StoredLogin[] {
  const raw = kv.get(KEY);
  if (!raw) return [];
  try {
    return openJson<StoredLogin[]>(raw);
  } catch {
    return [];
  }
}
function saveLogins(list: StoredLogin[]) {
  kv.set(KEY, sealJson(list));
  cache.clear();
}
const toPublic = ({ password: _pw, ...l }: StoredLogin): PublicRegistryLogin => ({ ...l, hasPassword: true });

export function listRegistryLogins(): PublicRegistryLogin[] {
  return loadLogins().map(toPublic);
}

/** "ghcr.io", "https://ghcr.io/", "GHCR.IO", "localhost:5000", "docker.io" → the plain host; refuses anything else. */
export function normalizeRegistryHost(raw: string): string {
  const v = String(raw ?? '').trim();
  const host = hostOf(v);
  if (!host || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(host) || (!host.includes('.') && !host.includes(':') && host !== 'localhost'))
    throw new HttpError(400, `not a registry host: ${v || '(empty)'} — e.g. ghcr.io, registry.gitlab.com or localhost:5000`);
  return host;
}

/** Add a login, or change one. An empty password keeps the stored one. One login per registry. */
export function upsertRegistryLogin(actor: Actor, input: { id?: string; registry?: string; username?: string; password?: string }): PublicRegistryLogin {
  const list = loadLogins();
  const prev = input.id ? list.find((l) => l.id === input.id) : undefined;
  if (input.id && !prev) throw new HttpError(404, 'registry login not found');
  const registry = normalizeRegistryHost(input.registry ?? prev?.registry ?? '');
  const username = String(input.username ?? prev?.username ?? '').trim();
  if (!username || username.length > 200) throw new HttpError(400, 'a username is required (for ghcr.io: your GitHub user name)');
  const password = input.password ? String(input.password) : prev?.password;
  if (!password) throw new HttpError(400, 'a password or access token is required (for ghcr.io: a personal access token with read:packages)');
  if (password.length > 4096) throw new HttpError(400, 'that token is too long');
  const other = list.find((l) => l.registry === registry && l.id !== prev?.id);
  if (other) throw new HttpError(409, `there is already a login for ${registry} (${other.username}): edit or remove it first`);
  const now = Date.now();
  const rec: StoredLogin = { id: prev?.id ?? newId('reg'), registry, username, password, createdAt: prev?.createdAt ?? now, updatedAt: now };
  saveLogins(prev ? list.map((l) => (l.id === rec.id ? rec : l)) : [...list, rec]);
  recordActivity(actor, 'settings.registries', `${prev ? 'Updated' : 'Added'} the registry login for ${registry} (${username})`);
  return toPublic(rec);
}

export function deleteRegistryLogin(actor: Actor, loginId: string) {
  const list = loadLogins();
  const l = list.find((x) => x.id === loginId);
  if (!l) throw new HttpError(404, 'registry login not found');
  saveLogins(list.filter((x) => x.id !== loginId));
  recordActivity(actor, 'settings.registries', `Removed the registry login for ${l.registry}`);
}

function servifyLogin(host: string): StoredLogin | undefined {
  return loadLogins().find((l) => l.registry === host);
}

/**
 * Sign in to the registry with a stored login the way a pull does: its /v2/ challenge, then Basic auth or a Bearer
 * token for it. Says whether the registry accepted it, never echoing the token.
 */
export async function testRegistryLogin(loginId: string): Promise<{ ok: boolean; message: string }> {
  const l = loadLogins().find((x) => x.id === loginId);
  if (!l) throw new HttpError(404, 'registry login not found');
  const insecure = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/.test(l.registry);
  const host = l.registry === 'docker.io' ? 'registry-1.docker.io' : l.registry;
  const base = `${insecure ? 'http' : 'https'}://${host}/v2/`;
  const basic = `Basic ${Buffer.from(`${l.username}:${l.password}`).toString('base64')}`;
  const opts = (extra: Record<string, string> = {}) => ({ headers: { 'user-agent': 'servify', ...extra }, signal: AbortSignal.timeout(10_000) });
  try {
    const first = await fetch(base, opts());
    if (first.ok) return { ok: true, message: `${l.registry} answers without a login (the login is only checked on a pull)` };
    const challenge = first.headers.get('www-authenticate') ?? '';
    if (first.status !== 401) return { ok: false, message: `${l.registry} answered HTTP ${first.status} at /v2/: is this a container registry?` };
    if (/^basic /i.test(challenge)) {
      const r = await fetch(base, opts({ authorization: basic }));
      return r.ok ? { ok: true, message: `${l.registry} accepted the login` } : { ok: false, message: `${l.registry} refused the username or password (HTTP ${r.status})` };
    }
    const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1].toLowerCase(), m[2]]));
    if (!params.realm) return { ok: false, message: `${l.registry} sent an authentication challenge Servify doesn't understand` };
    const t = new URL(params.realm);
    if (params.service) t.searchParams.set('service', params.service);
    const r = await fetch(t, opts({ authorization: basic }));
    if (r.ok) return { ok: true, message: `${l.registry} accepted the login` };
    return {
      ok: false,
      message: r.status === 401 || r.status === 403 ? `${l.registry} refused the username or token${l.registry === 'ghcr.io' ? ' (it needs a GitHub personal access token with read:packages)' : ''}` : `${l.registry}'s token service answered HTTP ${r.status}`,
    };
  } catch (e) {
    return { ok: false, message: (e as Error).name === 'TimeoutError' ? `${l.registry} did not answer` : `${l.registry} could not be reached` };
  }
}

// ───────────────────────────── the docker CLI's logins ─────────────────────────────

/** Docker Hub's name in the CLI's config and credential helpers. */
const HUB_SERVER = 'https://index.docker.io/v1/';
const isHub = (host: string) => /^(docker\.io|index\.docker\.io|registry-1\.docker\.io)$/.test(host);

/** "https://index.docker.io/v1/", "ghcr.io", "https://ghcr.io" → the plain host ("docker.io" for Docker Hub). */
function hostOf(key: string): string {
  const host = key.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  return isHub(host) ? 'docker.io' : host;
}

function readConfig(): any {
  try {
    return JSON.parse(readFileSync(join(process.env.DOCKER_CONFIG || join(homedir(), '.docker'), 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** Registries with a saved login (Servify's or the docker CLI's, any kind), as plain hosts. */
export function savedLoginHosts(): Set<string> {
  const cfg = readConfig();
  return new Set([...Object.keys(cfg.auths ?? {}), ...Object.keys(cfg.credHelpers ?? {})].map(hostOf).concat(loadLogins().map((l) => l.registry)));
}

function fromHelper(helper: string, server: string): Promise<RegistryCredentials | null> {
  return new Promise((resolve) => {
    const child = execFile(`docker-credential-${helper}`, ['get'], { timeout: 10_000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return resolve(null); // not found, or the helper isn't installed: fall back to auths
      try {
        const out = JSON.parse(stdout) as { Username?: string; Secret?: string };
        if (!out.Secret) return resolve(null);
        resolve(out.Username === '<token>' ? { identitytoken: out.Secret } : { username: out.Username ?? '', password: out.Secret });
      } catch {
        resolve(null);
      }
    });
    child.stdin?.end(server);
  });
}

function fromAuths(entry: any): RegistryCredentials | null {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.identitytoken) return { identitytoken: String(entry.identitytoken) };
  if (entry.auth) {
    const plain = Buffer.from(String(entry.auth), 'base64').toString('utf8');
    const i = plain.indexOf(':');
    if (i > 0) return { username: plain.slice(0, i), password: plain.slice(i + 1) };
  }
  if (entry.username && entry.password) return { username: String(entry.username), password: String(entry.password) };
  return null;
}

const cache = new Map<string, { at: number; creds: Promise<RegistryCredentials | null> }>();
const CACHE_MS = 60_000;

/** The saved login for a registry host ("ghcr.io", "localhost:5000", "docker.io"), or null. Servify's own first. */
export async function credentialsFor(registry: string): Promise<RegistryCredentials | null> {
  return (await credentialsWithSource(registry))?.creds ?? null;
}

export async function credentialsWithSource(registry: string): Promise<{ creds: RegistryCredentials; source: CredentialSource } | null> {
  const own = servifyLogin(hostOf(registry));
  if (own) return { creds: { username: own.username, password: own.password }, source: 'servify' };
  const creds = await dockerCredentials(registry);
  return creds ? { creds, source: 'docker' } : null;
}

function dockerCredentials(registry: string): Promise<RegistryCredentials | null> {
  const host = hostOf(registry);
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.creds;
  const creds = (async () => {
    const cfg = readConfig();
    const helpers: Record<string, string> = cfg.credHelpers ?? {};
    const auths: Record<string, any> = cfg.auths ?? {};
    const server = isHub(host) ? HUB_SERVER : host;
    const helper = Object.entries(helpers).find(([k]) => hostOf(k) === host)?.[1] || cfg.credsStore;
    if (helper) {
      // Helpers store what `docker login` was given: Hub under its v1 URL, others usually under the bare host.
      for (const s of isHub(host) ? [HUB_SERVER, 'index.docker.io', 'docker.io'] : [server, `https://${server}`]) {
        const c = await fromHelper(helper, s);
        if (c) return c;
      }
    }
    const key = Object.keys(auths).find((k) => hostOf(k) === host);
    return key ? fromAuths(auths[key]) : null;
  })();
  cache.set(host, { at: Date.now(), creds });
  return creds;
}

/**
 * The Engine API's X-Registry-Auth header value (base64url JSON) and where the login came from, or null without one.
 * `remote`: for a remote server's Docker. Only Servify's own logins go there, never the docker CLI's.
 */
export async function engineAuthHeader(registry: string, opts: { remote?: boolean } = {}): Promise<{ header: string; source: CredentialSource } | null> {
  const host = hostOf(registry);
  const found = opts.remote ? (servifyLogin(host) ? await credentialsWithSource(registry) : null) : await credentialsWithSource(registry);
  if (!found) return null;
  const serveraddress = isHub(host) ? HUB_SERVER : host;
  return { header: Buffer.from(JSON.stringify({ ...found.creds, serveraddress })).toString('base64url'), source: found.source };
}
