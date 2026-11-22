/**
 * Image update checks for services that run a registry image. Two questions, answered with the registry's
 * HTTP API (manifest HEAD requests and the tag list — no pulls):
 *   1. Was a different image published under the same tag (postgres:16 got a patch release)?
 *   2. Is there a newer tag of the same shape (1.25-alpine → 1.27-alpine, 16 → 17)?
 * The answer is "unknown" whenever Servify can't be sure (a local-only or copied image, a private registry, the
 * registry not answering) — unknown never notifies and never updates. Notifications and automatic updates happen
 * at most once per published image.
 */
import { createHash } from 'node:crypto';
import { deployments as deploymentsTable, kv, services as servicesTable } from './db.ts';
import { dockerFor, nodeOf } from './nodes.ts';
import { normalizeImageRef, splitImageRef } from './docker.ts';
import { bus, recordActivity, SYSTEM } from './events.ts';
import { notify } from './notify.ts';
import { queueDeployment } from './deployer.ts';
import type { Service } from './types.ts';

export type ImageUpdate = {
  ref: string;
  checkedAt: number;
  status: 'current' | 'changed' | 'unknown';
  /** Why it is unknown. */
  reason?: string;
  /** Newest tag of the same shape and major version (or of the same shape, for a major-only tag like "16"). */
  newerTag?: string | null;
  /** Newest tag of the same shape with a higher major version. */
  newerMajor?: string | null;
  remoteDigest?: string;
  /** What we last told people about / automatically deployed, so neither happens twice. */
  notifiedFor?: string;
  autoUpdatedTo?: string;
};

const KEY = 'imageUpdates';
const TIMEOUT = 10_000;
const ACCEPT = [
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
].join(', ');

let cache: Record<string, ImageUpdate> | null = null;
function all(): Record<string, ImageUpdate> {
  if (!cache) {
    try {
      cache = JSON.parse(kv.get(KEY) ?? '{}');
    } catch {
      cache = {};
    }
  }
  return cache!;
}
function store(serviceId: string, u: ImageUpdate | null) {
  const m = all();
  if (u) m[serviceId] = u;
  else delete m[serviceId];
  kv.set(KEY, JSON.stringify(m));
}
export const imageUpdateOf = (serviceId: string): ImageUpdate | null => all()[serviceId] ?? null;

// ─── registry client ───

type Repo = { registry: string; repo: string; tag: string; base: string };

/** Split an image reference the way Docker does: no dot, colon or "localhost" in the first part means Docker Hub. */
export function parseRepo(ref: string): Repo | null {
  const [image, tag] = splitImageRef(normalizeImageRef(ref));
  if (!tag) return null; // pinned by digest: nothing to update
  const first = image.split('/')[0];
  const hasRegistry = image.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  let registry = hasRegistry ? first : 'docker.io';
  let repo = hasRegistry ? image.slice(first.length + 1) : image;
  if (registry === 'docker.io' || registry === 'index.docker.io' || registry === 'registry-1.docker.io') {
    registry = 'docker.io';
    if (!repo.includes('/')) repo = `library/${repo}`;
  }
  const insecure = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/.test(registry);
  const host = registry === 'docker.io' ? 'registry-1.docker.io' : registry;
  return { registry, repo, tag, base: `${insecure ? 'http' : 'https'}://${host}/v2/${repo}` };
}

/** The repository's name as `RepoDigests` spells it ("postgres", "ghcr.io/owner/app", "localhost:5000/app"). */
const familiar = (r: Repo) => (r.registry === 'docker.io' ? r.repo.replace(/^library\//, '') : `${r.registry}/${r.repo}`);
export function sameRepo(name: string, r: Repo): boolean {
  const n = name.replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, '').replace(/^library\//, '');
  return n === familiar(r);
}

const tokens = new Map<string, { token: string; until: number }>();

/** A request to the registry, following the anonymous Bearer-token challenge (Docker Hub, ghcr.io, most others). */
async function registryFetch(r: Repo, url: string, init: RequestInit = {}): Promise<Response> {
  const key = `${r.registry}/${r.repo}`;
  const cached = tokens.get(key);
  const go = (token?: string) =>
    fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), 'user-agent': 'servify', ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(TIMEOUT) });
  let res = await go(cached && cached.until > Date.now() ? cached.token : undefined);
  if (res.status !== 401) return res;
  const challenge = res.headers.get('www-authenticate') ?? '';
  if (!/^bearer /i.test(challenge)) return res;
  const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1].toLowerCase(), m[2]]));
  if (!params.realm) return res;
  const t = new URL(params.realm);
  if (params.service) t.searchParams.set('service', params.service);
  t.searchParams.set('scope', params.scope || `repository:${r.repo}:pull`);
  const tr = await fetch(t, { headers: { 'user-agent': 'servify' }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!tr.ok) return res;
  const body = (await tr.json()) as { token?: string; access_token?: string; expires_in?: number };
  const token = body.token ?? body.access_token;
  if (!token) return res;
  tokens.set(key, { token, until: Date.now() + Math.max(30, (body.expires_in ?? 300) - 30) * 1000 });
  res = await go(token);
  return res;
}

/** The digest the tag points at right now, as `docker pull` would record it. */
async function remoteDigest(r: Repo): Promise<string> {
  const url = `${r.base}/manifests/${encodeURIComponent(r.tag)}`;
  let res = await registryFetch(r, url, { method: 'HEAD', headers: { accept: ACCEPT } });
  if (res.status === 401 || res.status === 403) throw new Error('the registry needs credentials');
  if (res.status === 404) throw new Error(`the tag ${r.tag} is no longer in the registry`);
  if (!res.ok) throw new Error(`the registry answered ${res.status}`);
  const header = res.headers.get('docker-content-digest');
  if (header) return header;
  res = await registryFetch(r, url, { headers: { accept: ACCEPT } });
  if (!res.ok) throw new Error(`the registry answered ${res.status}`);
  return `sha256:${createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex')}`;
}

/** Every tag of the repository, up to 10 pages of 1000. */
async function listTags(r: Repo): Promise<string[]> {
  const out: string[] = [];
  let url: string | null = `${r.base}/tags/list?n=1000`;
  for (let page = 0; url && page < 10; page++) {
    const res = await registryFetch(r, url);
    if (!res.ok) break;
    const body = (await res.json()) as { tags?: string[] | null };
    out.push(...(body.tags ?? []));
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
    url = next ? new URL(next, url).toString() : null;
  }
  return out;
}

// ─── tag comparison ───

type Version = { nums: number[]; shape: string };
/** "1.25.3-alpine" → [1,25,3] with shape "v0|3|-alpine". Tags with another shape aren't comparable. */
export function parseVersion(tag: string): Version | null {
  const m = /^(v?)(\d+)(?:\.(\d+))?(?:\.(\d+))?([-_][A-Za-z0-9._-]*)?$/.exec(tag);
  if (!m) return null;
  const nums = [m[2], m[3], m[4]].filter((x) => x !== undefined).map(Number);
  // A date or build number (20240101) isn't a version; compare those only with each other.
  const datey = nums[0] >= 1000 ? 'd' : '';
  return { nums, shape: `${m[1]}|${nums.length}|${m[5] ?? ''}|${datey}` };
}
const cmp = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
};

/**
 * The newest same-shape tag within the current major (only for x.y / x.y.z), and the newest of the next major up —
 * not the highest major: many apps (Nextcloud, databases) can only upgrade one major at a time.
 */
export function newerTags(current: string, tags: string[]): { newerTag: string | null; newerMajor: string | null } {
  const cur = parseVersion(current);
  if (!cur) return { newerTag: null, newerMajor: null };
  let minor: { tag: string; v: Version } | null = null;
  let major: { tag: string; v: Version } | null = null;
  for (const tag of tags) {
    const v = parseVersion(tag);
    if (!v || v.shape !== cur.shape || cmp(v.nums, cur.nums) <= 0) continue;
    if (v.nums[0] === cur.nums[0]) {
      if (cur.nums.length > 1 && (!minor || cmp(v.nums, minor.v.nums) > 0)) minor = { tag, v };
    } else if (!major || v.nums[0] < major.v.nums[0] || (v.nums[0] === major.v.nums[0] && cmp(v.nums, major.v.nums) > 0)) major = { tag, v };
  }
  return { newerTag: minor?.tag ?? null, newerMajor: major?.tag ?? null };
}

// ─── checks ───

export const checkable = (s: Service) => s.source.type === 'image' && !s.source.image.includes('@') && !!s.activeDeploymentId;

type Remote = { digest: string; tags: string[] } | { error: string };

export async function remoteFacts(r: Repo): Promise<Remote> {
  try {
    const digest = await remoteDigest(r);
    const tags = parseVersion(r.tag) ? await listTags(r).catch(() => []) : [];
    return { digest, tags };
  } catch (e) {
    const msg = (e as Error).name === 'TimeoutError' ? 'the registry did not answer' : (e as Error).message;
    return { error: msg.startsWith('fetch failed') ? 'the registry could not be reached' : msg };
  }
}

/** Only the digest the tag points at (one request, no tag listing). */
export async function remoteDigestOf(r: Repo): Promise<{ digest: string } | { error: string }> {
  try {
    return { digest: await remoteDigest(r) };
  } catch (e) {
    const msg = (e as Error).name === 'TimeoutError' ? 'the registry did not answer' : (e as Error).message;
    return { error: msg.startsWith('fetch failed') ? 'the registry could not be reached' : msg };
  }
}

/** Check a set of services, asking the registry once per image. */
async function checkServices(list: Service[]): Promise<void> {
  const remotes = new Map<string, Promise<Remote>>();
  for (const svc of list) {
    if (!checkable(svc) || svc.source.type !== 'image') {
      store(svc.id, null);
      continue;
    }
    const ref = normalizeImageRef(svc.source.image);
    const prev = imageUpdateOf(svc.id);
    const keep = prev?.ref === ref ? { notifiedFor: prev.notifiedFor, autoUpdatedTo: prev.autoUpdatedTo } : {};
    const r = parseRepo(ref);
    const save = (u: Omit<ImageUpdate, 'ref' | 'checkedAt'>) => {
      const next: ImageUpdate = { ref, checkedAt: Date.now(), ...keep, ...u };
      store(svc.id, next);
      return next;
    };
    if (!r) {
      save({ status: 'unknown', reason: 'pinned by digest' });
      continue;
    }
    // What runs now: the deployment's pinned copy, and the registry digests Docker recorded when it was pulled.
    const dep = deploymentsTable.get(svc.activeDeploymentId!);
    const recorded = dep?.repoDigests ?? (dep?.image ? (await dockerFor(nodeOf(svc)).inspectImage(dep.image).catch(() => null))?.RepoDigests : null) ?? [];
    const local: string[] = recorded.filter((d: string) => sameRepo(d.split('@')[0], r)).map((d: string) => d.split('@')[1]);
    if (!local.length) {
      save({ status: 'unknown', reason: 'the running image was not pulled from a registry' });
      continue;
    }
    if (!remotes.has(ref)) remotes.set(ref, remoteFacts(r));
    const remote = await remotes.get(ref)!;
    if ('error' in remote) {
      save({ status: 'unknown', reason: remote.error });
      continue;
    }
    const tags = newerTags(r.tag, remote.tags);
    const u = save({ status: local.includes(remote.digest) ? 'current' : 'changed', remoteDigest: remote.digest, ...tags });
    await act(svc, u, dep?.database ?? null);
  }
}

/** Notify once per new image or tag, and deploy same-tag updates for services that opted in. */
async function act(svc: Service, u: ImageUpdate, database: string | null) {
  const fresh = servicesTable.get(svc.id);
  if (!fresh) return;
  const what = [u.status === 'changed' && `a new ${u.ref} image`, u.newerTag, u.newerMajor].filter(Boolean) as string[];
  const autoOk = fresh.imageAutoUpdate && u.status === 'changed' && !database && !fresh.cluster && !fresh.stopped;
  if (autoOk && u.autoUpdatedTo !== u.remoteDigest) {
    store(svc.id, { ...u, autoUpdatedTo: u.remoteDigest });
    recordActivity(SYSTEM, 'service.deployed', `Updating ${fresh.name}: a new ${u.ref} image was published`, fresh.projectId, fresh.id);
    queueDeployment(fresh, 'update', SYSTEM);
    return; // the deploy notifies on its own
  }
  const key = [u.status === 'changed' ? u.remoteDigest : '', u.newerTag ?? '', u.newerMajor ?? ''].join('|');
  if (what.length && key !== u.notifiedFor) {
    store(svc.id, { ...imageUpdateOf(svc.id)!, notifiedFor: key });
    notify({
      event: 'image.update',
      level: 'info',
      title: `Update available for ${fresh.name}`,
      message: `${what.join(', ')} ${what.length > 1 ? 'are' : 'is'} available (running ${u.ref}).`,
      serviceId: fresh.id,
      projectId: fresh.projectId,
    } as any);
  }
  bus.publish({ type: 'service.updated', service: fresh });
}

export async function checkService(serviceId: string): Promise<ImageUpdate | null> {
  const svc = servicesTable.get(serviceId);
  if (!svc) return null;
  await checkServices([svc]);
  return imageUpdateOf(serviceId);
}

export async function checkAll() {
  const list = servicesTable.all().filter((s) => s.source.type === 'image');
  await checkServices(list);
  for (const id of Object.keys(all())) if (!servicesTable.get(id)) store(id, null);
}

export function startImageChecks() {
  const hours = Number(process.env.SERVIFY_IMAGE_CHECK_HOURS) || 6;
  setTimeout(() => void checkAll().catch((e) => console.error('[image-updates]', e)), 2 * 60_000).unref();
  setInterval(() => void checkAll().catch((e) => console.error('[image-updates]', e)), hours * 3_600_000).unref();
  // After a deploy of an image service, look again so the badge reflects what now runs.
  bus.subscribe((ev) => {
    if (ev.type !== 'deployment.updated' || ev.deployment.status !== 'active' || ev.deployment.builder !== 'image') return;
    if (!imageUpdateOf(ev.deployment.serviceId)) return;
    // Wait until the service points at the new deployment (it switches after the replicas are healthy).
    const { id: depId, serviceId } = ev.deployment;
    let tries = 0;
    const later = () =>
      setTimeout(() => {
        const svc = servicesTable.get(serviceId);
        if (!svc) return;
        if (svc.activeDeploymentId === depId) void checkService(serviceId).catch(() => {});
        else if (++tries < 30) later();
      }, 2000);
    later();
  });
}
