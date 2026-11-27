/**
 * Scoped API tokens: enforcing policy.ts for a principal. A token has a scope (read < deploy < write) and, optionally,
 * a list of projects; its reach is those projects plus their environments (pull-request previews included), worked out
 * on every request. The owner (dashboard, signed-in phone, SERVIFY_AUTH=none) reaches everything and passes every
 * level. Tokens without a project list are only ever level-checked here: nothing is resolved for them, so they keep
 * exactly the answers (and status codes) they had before.
 */
import type { Principal } from './auth.ts';
import type { Policy, TargetKind } from './policy.ts';
import type { ServerEvent } from './types.ts';
import { db, deployments as deploymentsTable, backupsTable } from './db.ts';
import { HttpError } from './util.ts';
import { getProjectOrThrow, getServiceOrThrow } from './ops.ts';
import { getVolumeOrThrow } from './volumes.ts';

export const isOwner = (p: Principal) => p.actor.type === 'user';
/** Limited to some projects (an array, possibly with nothing left in it: then it reaches nothing). */
export const isScoped = (p: Principal) => !isOwner(p) && Array.isArray(p.projects);

/** parentId of a project, once known. It is set once (when an environment is made) and never changes. */
const parentCache = new Map<string, string>();
function parentOf(projectId: string): string | null {
  const hit = parentCache.get(projectId);
  if (hit) return hit;
  const r = db.prepare(`SELECT json_extract(data, '$.parentId') AS p FROM projects WHERE id = ?`).get(projectId) as { p: string | null } | undefined;
  if (r?.p) parentCache.set(projectId, r.p);
  return r?.p ?? null;
}

/** Does the principal reach this project? */
export function inReach(p: Principal, projectId: string | null | undefined): boolean {
  if (!isScoped(p)) return true;
  if (!projectId) return false;
  const listed = p.projects!;
  if (listed.includes(projectId)) return true;
  const parent = parentOf(projectId);
  return !!parent && listed.includes(parent);
}

/** The project ids a principal reaches, or null for all. */
export function reachIds(p: Principal): Set<string> | null {
  if (!isScoped(p)) return null;
  const listed = new Set(p.projects!);
  const out = new Set(listed);
  for (const r of db.prepare(`SELECT id, json_extract(data, '$.parentId') AS p FROM projects WHERE json_extract(data, '$.parentId') IS NOT NULL`).all() as { id: string; p: string }[]) {
    if (listed.has(r.p)) out.add(r.id);
  }
  return out;
}

/** Project of a service, straight from its indexed column (no unsealing: used for every log line on a stream). */
function projectOfService(serviceId: string): string | null {
  const r = db.prepare('SELECT project_id AS p FROM services WHERE id = ?').get(serviceId) as { p: string } | undefined;
  return r?.p ?? null;
}

/** Out of reach reads exactly like missing: the same words the lookups use. */
function notFound(kind: TargetKind, ref: string): HttpError {
  return new HttpError(404, kind === 'deployment' || kind === 'backup' ? `${kind} not found` : `${kind} not found: ${ref}`);
}

/** The project a reference names, resolved the way the route's handler resolves it (so both agree on what it is). */
function projectOfTarget(kind: TargetKind, ref: string): string {
  switch (kind) {
    case 'project':
      return getProjectOrThrow(ref).id;
    case 'service':
      return getServiceOrThrow(ref).projectId;
    case 'volume':
      return getVolumeOrThrow(ref).projectId;
    case 'deployment': {
      const d = deploymentsTable.get(ref);
      if (!d) throw new HttpError(404, 'deployment not found');
      return d.projectId;
    }
    case 'backup': {
      // serviceId can be a volume id (the safety backup of a detached volume); projectId is always the project.
      const b = backupsTable.get(ref);
      if (!b) throw new HttpError(404, 'backup not found');
      return b.projectId;
    }
  }
}

/**
 * Check that the principal reaches every target. Only project-limited tokens are checked; for them anything out of
 * reach — or a name that is ambiguous across projects, which would tell them about the others — reads as not found.
 */
export function checkTargets(p: Principal, targets: [TargetKind, unknown][]) {
  if (!isScoped(p)) return;
  for (const [kind, raw] of targets) {
    if (raw === undefined || raw === null || raw === '') continue;
    const ref = String(raw);
    let projectId: string;
    try {
      projectId = projectOfTarget(kind, ref);
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) throw notFound(kind, ref);
      throw e;
    }
    if (!inReach(p, projectId)) throw notFound(kind, ref);
  }
}

const RANK = { read: 0, deploy: 1, write: 2 } as const;
const DEPLOY_ONLY = 'this token can only deploy: deploy, restart, roll back and update images, and read status and logs';

/**
 * The level check, before anything is resolved. `uploadTarget` (for deployOnUploads) is only asked for deploy tokens.
 * Throws a 403 with the message the route always had.
 */
export function checkLevel(p: Principal, policy: Policy | undefined, ctx: { method?: string; uploadTarget?: () => boolean } = {}) {
  // Read tokens have never been able to change anything: kept first, whatever the table says.
  if (p.scope === 'read' && ctx.method && ctx.method !== 'GET' && !isOwner(p)) throw new HttpError(403, 'this token is read-only');
  if (!policy) {
    // Not classified: the owner only, until someone decides.
    if (!isOwner(p)) throw new HttpError(403, 'only the owner can do this, not an API token');
    return;
  }
  if (policy.level === 'public' || isOwner(p)) return;
  if (policy.level === 'owner') throw new HttpError(403, policy.ownerMessage ?? 'only the owner can do this, not an API token');
  const need = RANK[policy.level];
  const have = RANK[p.scope] ?? 0;
  if (have < need) {
    if (p.scope === 'read') throw new HttpError(403, 'this token is read-only');
    if (p.scope === 'deploy' && policy.deployOnUploads && ctx.uploadTarget?.()) return;
    throw new HttpError(403, p.scope === 'deploy' ? DEPLOY_ONLY : 'this token cannot do that');
  }
}

/** Everything about a call that doesn't need its arguments' meaning: level, then project context. */
export function checkCall(p: Principal, policy: Policy | undefined, targets: [TargetKind, unknown][], ctx: { method?: string; uploadTarget?: () => boolean; skipSafetyBackup?: unknown } = {}) {
  checkLevel(p, policy, ctx);
  if (!policy || isOwner(p)) return;
  if (policy.noSkip && p.scope === 'deploy' && ctx.skipSafetyBackup === true) throw new HttpError(403, 'deploy tokens cannot skip the safety backup — ask the owner, or use a write token');
  if (!isScoped(p)) return;
  const named = targets.filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!named.length && !policy.filtered) throw new HttpError(403, 'this token is limited to some projects, and this is not about one of them');
  checkTargets(p, named);
}

/**
 * Can a deploy token upload to this service? Only where the source already is an upload: the upload is the deploy.
 * A service out of a limited token's reach answers true here, so the reach check that follows says "not found"
 * (instead of a refusal that would tell what kind of service it is).
 */
export function isUploadService(p: Principal, ref: string): boolean {
  try {
    const svc = getServiceOrThrow(ref);
    if (!inReach(p, svc.projectId)) return true;
    return svc.source.type === 'upload';
  } catch {
    return isScoped(p); // unknown: let the reach check answer "not found"
  }
}

/**
 * An event as a principal may see it: unchanged, trimmed (traffic of reachable services only), or null. Every event
 * type says which project it belongs to; anything that belongs to none (settings, certificates, activity without a
 * project) is for the owner and unscoped tokens only.
 */
export function eventFor(p: Principal, ev: ServerEvent): ServerEvent | null {
  if (!isScoped(p)) return ev;
  switch (ev.type) {
    case 'hello':
      return ev;
    case 'auth.pairing':
      return null;
    case 'project.updated':
      return inReach(p, ev.project.id) ? ev : null;
    case 'project.deleted':
    case 'service.deleted':
    case 'replicas':
    case 'volume.deleted':
      return inReach(p, ev.projectId) ? ev : null;
    case 'service.updated':
      return inReach(p, ev.service.projectId) ? ev : null;
    case 'deployment.updated':
      return inReach(p, ev.deployment.projectId) ? ev : null;
    case 'deployment.log':
      return inReach(p, projectOfService(ev.serviceId)) ? ev : null;
    case 'activity':
      return inReach(p, ev.entry.projectId) ? ev : null;
    case 'job.run':
      return inReach(p, ev.run.projectId) ? ev : null;
    case 'backup.updated':
      return inReach(p, ev.backup.projectId) ? ev : null;
    case 'volume.updated':
      return inReach(p, ev.volume.projectId) ? ev : null;
    case 'traffic': {
      const services = Object.fromEntries(Object.entries(ev.services).filter(([sid]) => inReach(p, projectOfService(sid))));
      return { ...ev, services };
    }
    case 'cert.updated':
    case 'settings.updated':
    // Instance-wide (host paths, every server's disks): like GET /system, not for project-limited tokens.
    case 'disk.updated':
      return null;
    default: {
      const never: never = ev;
      void never;
      return null;
    }
  }
}
