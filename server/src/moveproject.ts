/**
 * Moving a service to another project ("Move to project…").
 *
 * The service keeps its id, so everything keyed by it stays as it is: deploy history, variables (sealed ones too),
 * custom domains and routes, volumes (the same Docker volumes, nothing is copied), backup schedule and history, job
 * runs, image tracking, metrics, logs and the access log. Rows that also carry a project id (deployments, volumes,
 * backups, runs) are re-pointed in one transaction. Containers live on their project's private network, so a running
 * service is recreated there (a restart: same image, no pre-deploy command, variables resolved in the new project).
 *
 * What a move can break is worked out first (planMove) and shown before anything happens:
 *  - services left behind that reference it (${{svc.VAR}}, or its name as a host name in a variable), and the services
 *    it references the same way: the private network and ${{…}} references don't cross projects;
 *  - ${{shared.X}} it reads that the new project doesn't define;
 *  - its generated URL (<service>.<project>.<domain>), which follows the project (custom domains don't change).
 * Those are warnings: the move goes ahead with `force`. Blockers are never overridden: environments and previews
 * (copies of their production project, deleted with it or when the pull request closes), database clusters,
 * read-only volume shares (both ways), a name already used in the new project (move it under another name instead),
 * and work in progress on the service (a deploy, a restore, a backup, a job run).
 */
import { projects as projectsTable, services as servicesTable, deployments as deploymentsTable, volumesTable, backupsTable, runsTable, db } from './db.ts';
import type { MoveIssue, MovePlan, Project, Service } from './types.ts';
import { bus, recordActivity, type Actor } from './events.ts';
import { HttpError, slugify } from './util.ts';
import { getServiceOrThrow, getProjectOrThrow, serializeService, restartService, placeNear } from './ops.ts';
import { sharedVariables, publicUrl } from './vars.ts';
import { borrowersOf } from './volumes.ts';
import { isRoute } from './external.ts';
import { deployPending } from './deployer.ts';
import { isRestoring } from './backups.ts';
import { isJobRunning } from './cronjobs.ts';

const REF = /\$\{\{\s*([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_]+))?\s*\}\}/g;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The names a service answers to on its project's private network. */
const hostNames = (s: Service) => [...new Set([s.slug, ...(s.aliases ?? [])].filter(Boolean))];

/** Keys whose whole value being a service name means a host name (DB_HOST=postgres), not a user name or a word. */
const HOST_KEY = /HOST|ADDR|SERVER|URL|URI|DSN|ENDPOINT|BROKER|DOMAIN|UPSTREAM|BACKEND/i;

/**
 * Does this value reach `name` over the private network by name? Recognised: an URL authority (//name, @name),
 * name:port, host=name / server=name, or the whole value under a key that names a host. ${{…}} references are not
 * looked at here (they are counted as references of their own).
 */
function usesHostName(key: string, raw: string, name: string): boolean {
  const v = raw.replace(REF, ' ');
  const e = esc(name);
  if (new RegExp(`(?:\\/\\/|@)${e}(?=$|[:/?#\\s,;'"\\])])`).test(v)) return true;
  if (new RegExp(`(?:^|[\\s,;='"(\\[])${e}:\\d{2,5}(?!\\d)`).test(v)) return true;
  if (new RegExp(`\\b(?:host|hostname|server|addr|address)\\s*=\\s*${e}(?=$|[\\s;,&'"])`, 'i').test(v)) return true;
  return v.trim() === name && HOST_KEY.test(key);
}

/** The variables of `from` (and its start command) that use one of `to`'s names: by ${{to.VAR}}, or as a host name. */
function referencesTo(from: Service, to: Service): { vars: string[]; hosts: string[] } {
  const vars: string[] = [];
  const hosts: string[] = [];
  const names = hostNames(to);
  const fields: [string, string][] = [...Object.entries(from.env), ...(from.startCommand ? [['start command', from.startCommand] as [string, string]] : [])];
  for (const [k, v] of fields) {
    if (typeof v !== 'string') continue;
    if ([...v.matchAll(REF)].some((m) => m[2] && m[1] !== 'shared' && (m[1] === to.slug || m[1] === to.name))) vars.push(k);
    else if (names.some((n) => usesHostName(k, v, n))) hosts.push(k);
  }
  return { vars, hosts };
}

type RefEntry = NonNullable<MoveIssue['services']>[number];
const refEntry = (s: Service, r: { vars: string[]; hosts: string[] }): RefEntry => ({
  id: s.id,
  name: s.name,
  keys: [...r.vars, ...r.hosts],
  how: r.vars.length && r.hosts.length ? 'both' : r.vars.length ? 'variable' : 'hostname',
});

/** The ${{shared.X}} names a service reads. */
function sharedNames(s: Service): string[] {
  const out = new Set<string>();
  for (const v of Object.values(s.env)) for (const m of String(v).matchAll(REF)) if (m[1] === 'shared' && m[2]) out.add(m[2]);
  return [...out];
}

const brief = (p: Project) => ({ id: p.id, name: p.name, slug: p.slug });
const list = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** A name (and the slug it gets) that is free in the project. */
function nameTaken(project: Project, name: string, slug: string, aliases: string[], exceptId?: string): Service | null {
  const lower = name.toLowerCase();
  const mine = new Set([slug, ...aliases]);
  return (
    servicesTable
      .all('WHERE project_id = ?', project.id)
      .filter((s) => s.id !== exceptId)
      .find((s) => s.slug === slug || s.name.toLowerCase() === lower || hostNames(s).some((n) => mine.has(n))) ?? null
  );
}

function suggestName(project: Project, svc: Service): string {
  for (let i = 2; i < 100; i++) {
    const n = `${svc.name}-${i}`;
    if (!nameTaken(project, n, slugify(n), svc.aliases ?? [])) return n;
  }
  return `${svc.name}-${Date.now().toString(36)}`;
}

/**
 * What moving `serviceId` to `targetRef` would do. Without a target (a project to be created for it), only what does
 * not depend on the target is checked, and every ${{shared.…}} it reads counts as missing.
 */
export function planMove(serviceId: string, targetRef?: string | null, opts: { name?: string | null } = {}): MovePlan {
  const svc = getServiceOrThrow(serviceId);
  const from = getProjectOrThrow(svc.projectId);
  const target = targetRef ? getProjectOrThrow(targetRef) : null;
  const blockers: MoveIssue[] = [];
  const warnings: MoveIssue[] = [];
  const newName = opts.name?.trim() || svc.name;
  const newSlug = newName === svc.name ? svc.slug : slugify(newName);

  if (target && target.id === from.id) blockers.push({ code: 'same_project', message: `${svc.name} is already in ${from.name}` });
  if (from.parentId) {
    const base = projectsTable.get(from.parentId);
    blockers.push({
      code: 'environment',
      message: `${svc.name} is in ${from.preview ? 'a pull-request preview' : `the ${from.envName ?? from.slug} environment`} of ${base?.name ?? 'another project'}. Environments are copies of their production project (deleted with it${from.preview ? ', or when the pull request closes' : ''}): move the production service instead.`,
    });
  }
  if (target?.parentId) {
    const base = projectsTable.get(target.parentId);
    blockers.push({
      code: 'environment_target',
      message: `${target.preview ? 'That is a pull-request preview' : `${target.envName ?? target.slug} is an environment`} of ${base?.name ?? 'another project'}: environments are copies of their production project, deleted with it${target.preview ? ' or when the pull request closes' : ''}. Move it to ${base?.name ?? 'the production project'} instead.`,
    });
  }
  if (svc.cluster) blockers.push({ code: 'cluster', message: `${svc.name} is a database cluster: clusters stay in their project` });
  const borrowed = svc.volumes.filter((m) => m.borrowed);
  if (borrowed.length) blockers.push({ code: 'borrows_volume', message: `${svc.name} reads another service's volume (${borrowed.map((m) => m.mountPath).join(', ')}): remove that share first` });
  const vols = volumesTable.all('WHERE project_id = ?', from.id).filter((v) => v.serviceId === svc.id);
  const readers = [...new Set(vols.flatMap((v) => borrowersOf(v).filter((s) => s.id !== svc.id).map((s) => s.name)))];
  if (readers.length) blockers.push({ code: 'shared_volume', message: `${list(readers)} read${readers.length === 1 ? 's' : ''} ${svc.name}'s volume: remove ${readers.length === 1 ? 'that share' : 'those shares'} first` });

  const busy: string[] = [];
  if (deployPending(svc.id)) busy.push('a deploy is running');
  if (isRestoring(svc.id)) busy.push('a restore is running');
  if (isJobRunning(svc.id)) busy.push('a job run is in progress');
  if (backupsTable.all(`WHERE service_id = ? AND json_extract(data, '$.status') = 'running'`, svc.id).length) busy.push('a backup is running');
  if (busy.length) blockers.push({ code: 'busy', message: `${busy.join(', ').replace(/^./, (c) => c.toUpperCase())}: wait for it to finish, then move ${svc.name}` });

  let suggestedName: string | null = null;
  if (target && target.id !== from.id) {
    const clash = nameTaken(target, newName, newSlug, svc.aliases ?? []);
    if (clash) {
      suggestedName = suggestName(target, svc);
      const why = clash.slug === newSlug || clash.name.toLowerCase() === newName.toLowerCase() ? `a service called ${clash.name}` : `${clash.name}, which answers to the same private host name`;
      blockers.push({ code: 'name_taken', message: `${target.name} already has ${why}: move it under another name (e.g. ${suggestedName})` });
    }
  }

  // References that stop working: the private network and ${{…}} only reach services of the same project.
  const siblings = servicesTable.all('WHERE project_id = ?', from.id).filter((s) => s.id !== svc.id);
  const inbound = siblings
    .map((s) => ({ s, r: referencesTo(s, svc) }))
    .filter(({ r }) => r.vars.length || r.hosts.length)
    .map(({ s, r }) => refEntry(s, r));
  if (inbound.length)
    warnings.push({
      code: 'used_by',
      message: `${list(inbound.map((x) => x.name))} ${inbound.length === 1 ? 'uses' : 'use'} ${svc.name} (${inbound.map((x) => `${x.name}: ${x.keys.join(', ')}`).join('; ')}) and stay${inbound.length === 1 ? 's' : ''} in ${from.name}: ${inbound.length === 1 ? 'it' : 'they'} can't reach ${svc.name} after the move (\${{${svc.slug}.…}} references and the host name ${svc.slug} only work inside one project)`,
      services: inbound,
    });
  const outbound = siblings
    .map((s) => ({ s, r: referencesTo(svc, s) }))
    .filter(({ r }) => r.vars.length || r.hosts.length)
    .map(({ s, r }) => refEntry(s, r));
  if (outbound.length) {
    const same = target ? servicesTable.all('WHERE project_id = ?', target.id).filter((t) => outbound.some((o) => siblings.find((s) => s.id === o.id)?.slug === t.slug)) : [];
    warnings.push({
      code: 'uses',
      message: `${svc.name} uses ${list(outbound.map((x) => x.name))} (${outbound.map((x) => `${x.keys.join(', ')} → ${x.name}`).join('; ')}), which stay${outbound.length === 1 ? 's' : ''} in ${from.name}: those references stop working after the move${same.length ? ` — or point at ${target!.name}'s own ${list(same.map((t) => t.name))} instead` : ''}`,
      services: outbound,
    });
  }
  const shared = sharedNames(svc);
  if (shared.length) {
    const have = target ? sharedVariables(target) : {};
    const missing = shared.filter((k) => !(k in have));
    if (missing.length) warnings.push({ code: 'shared_missing', message: `${svc.name} reads the shared variable${missing.length === 1 ? '' : 's'} ${missing.join(', ')}, which ${target ? `${target.name} doesn't define` : 'the new project won\'t have'}: add ${missing.length === 1 ? 'it' : 'them'} to ${target ? target.name : 'the new project'}'s shared variables` });
  }

  // The generated URL follows the project (custom domains, routes and the TCP port stay the same).
  let url: MovePlan['url'] = null;
  if (svc.protocol === 'http' && svc.publicHttp && !isRoute(svc)) {
    const before = publicUrl(svc, from);
    const after = target ? publicUrl({ ...svc, slug: newSlug }, target) : null;
    url = { before, after };
    if (before !== after) warnings.push({ code: 'url_changes', message: `Its generated address changes from ${before} to ${after ?? `one under the new project's name`}${svc.domains.length ? ` (its domain${svc.domains.length === 1 ? '' : 's'} ${svc.domains.join(', ')} stay${svc.domains.length === 1 ? 's' : ''} as ${svc.domains.length === 1 ? 'it is' : 'they are'})` : ''}` });
  }
  if (newSlug !== svc.slug) warnings.push({ code: 'renamed', message: `Under its new name its private host name becomes ${newSlug} (was ${svc.slug})` });

  // Environments are copies made from the production project: theirs stays where it is.
  const envs = !from.parentId ? projectsTable.all().filter((p) => p.parentId === from.id && servicesTable.all('WHERE project_id = ?', p.id).some((s) => s.slug === svc.slug)) : [];
  if (envs.length) warnings.push({ code: 'environments', message: `${from.name}'s ${list(envs.map((p) => p.envName ?? p.slug))} environment${envs.length === 1 ? '' : 's'} keep${envs.length === 1 ? 's' : ''} ${envs.length === 1 ? 'its' : 'their'} own copy of ${svc.name}: environments are copies and don't follow the move` });

  const restart = !isRoute(svc) && !!svc.activeDeploymentId && !svc.stopped;
  return {
    service: { id: svc.id, name: svc.name, slug: svc.slug },
    from: brief(from),
    target: target ? brief(target) : null,
    name: newName,
    slug: newSlug,
    suggestedName,
    blockers,
    warnings,
    restart,
    url,
    volumes: vols.filter((v) => !v.setId || v.setId === v.id).map((v) => v.name),
    deployments: (db.prepare('SELECT COUNT(*) AS n FROM deployments WHERE service_id = ?').get(svc.id) as { n: number }).n,
    backups: (db.prepare('SELECT COUNT(*) AS n FROM backups WHERE service_id = ?').get(svc.id) as { n: number }).n,
  };
}

/** Warnings that mean something stops working (refused unless forced); the rest are only said. */
const BREAKING = new Set(['used_by', 'uses', 'shared_missing']);

/**
 * Move a service to another project (see the top of this file). Refused (409) on any blocker; references that would
 * break are refused too unless `force` (code "move_breaks_references", the message lists them).
 */
export function moveServiceToProject(actor: Actor, serviceId: string, targetRef: string, opts: { force?: boolean; name?: string | null } = {}) {
  if (!String(targetRef ?? '').trim()) throw new HttpError(400, 'name the project to move it to');
  const svc = getServiceOrThrow(serviceId);
  const target = getProjectOrThrow(targetRef);
  const from = getProjectOrThrow(svc.projectId);
  if (target.id === from.id) return { service: serializeService(svc), plan: null, restarted: false };
  const plan = planMove(serviceId, target.id, { name: opts.name });
  const blocker = plan.blockers[0];
  if (blocker) throw new HttpError(409, blocker.message, blocker.code === 'name_taken' ? 'name_taken' : 'move_refused');
  const breaking = plan.warnings.filter((w) => BREAKING.has(w.code));
  if (breaking.length && !opts.force) throw new HttpError(409, `${breaking.map((w) => w.message).join('. ')}. Change those references first, or move it anyway (force)`, 'move_breaks_references');

  const now = Date.now();
  const vols = volumesTable.all('WHERE project_id = ?', from.id).filter((v) => v.serviceId === svc.id);
  const pos = placeNear(target.id, 0, 0);
  const renamed = plan.slug !== svc.slug || plan.name !== svc.name;
  const env = { ...svc.env };
  if (plan.slug !== svc.slug) {
    // Its own ${{oldname.VAR}} references follow the new name (references from others are reported above).
    const self = new RegExp(`\\$\\{\\{(\\s*)(?:${esc(svc.slug)}|${esc(svc.name)})\\.`, 'g');
    for (const [k, v] of Object.entries(env)) env[k] = v.replace(self, (_w, sp: string) => `\${{${sp}${plan.slug}.`);
  }
  const moved: Service = { ...svc, env, name: plan.name, slug: plan.slug, projectId: target.id, x: pos.x, y: pos.y, updatedAt: now };
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const v of vols) volumesTable.put({ ...v, projectId: target.id, updatedAt: now });
    for (const d of deploymentsTable.all('WHERE service_id = ?', svc.id)) deploymentsTable.put({ ...d, projectId: target.id });
    for (const b of backupsTable.all('WHERE service_id = ?', svc.id)) backupsTable.put({ ...b, projectId: target.id });
    for (const r of runsTable.all('WHERE service_id = ?', svc.id)) runsTable.put({ ...r, projectId: target.id });
    servicesTable.put(moved);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // Not service.deleted: that event drops the service's logs, metrics and access log. Clients see the new project id.
  bus.publish({ type: 'service.updated', service: moved });
  for (const v of vols) bus.publish({ type: 'volume.updated', volume: { ...v, projectId: target.id, updatedAt: now } });
  const as = renamed ? ` as ${plan.name}` : '';
  recordActivity(actor, 'service.moved', `Moved ${svc.name} from ${from.name} to ${target.name}${as}${breaking.length ? ' (references left behind)' : ''}`, target.id, svc.id);
  recordActivity(actor, 'service.moved', `Moved ${svc.name} to ${target.name}${as}`, from.id, null);
  // Containers live on their project's network: recreate them on the new one (same image, no pre-deploy command).
  // Its old containers leave the old network as they are retired.
  let restarted = false;
  if (!isRoute(moved) && moved.activeDeploymentId && !moved.stopped) {
    restartService(actor, moved.id);
    restarted = true;
  }
  return { service: serializeService(getServiceOrThrow(moved.id)), plan, restarted };
}
