/**
 * Registry logins of the user Servify runs as, looked up the way the docker CLI does: ~/.docker/config.json (or
 * $DOCKER_CONFIG) `credHelpers` for the registry, else `credsStore`, else the `auths` entry.
 *
 * Used for pulls on this machine only (never sent to remote servers through the agent tunnel) and for image update
 * checks. Credentials stay in memory: never logged, stored or put in an error message — errors name the host only.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type RegistryCredentials = { username: string; password: string } | { identitytoken: string };

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

/** Registries with a saved login (any kind), as plain hosts. */
export function savedLoginHosts(): Set<string> {
  const cfg = readConfig();
  return new Set([...Object.keys(cfg.auths ?? {}), ...Object.keys(cfg.credHelpers ?? {})].map(hostOf));
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

/** The saved login for a registry host ("ghcr.io", "localhost:5000", "docker.io"), or null. */
export function credentialsFor(registry: string): Promise<RegistryCredentials | null> {
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

/** The Engine API's X-Registry-Auth header value (base64url JSON), or null without a saved login. */
export async function engineAuthHeader(registry: string): Promise<string | null> {
  const c = await credentialsFor(registry);
  if (!c) return null;
  const serveraddress = isHub(hostOf(registry)) ? HUB_SERVER : hostOf(registry);
  return Buffer.from(JSON.stringify({ ...c, serveraddress })).toString('base64url');
}
