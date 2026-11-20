/**
 * Environments and pull-request previews.
 *
 * An environment is a full copy of a project (services, variables, settings — fresh volumes, no custom
 * domains) linked to its base ("production") project. It gets its own URLs: <service>.<project>-<env>.<domain>.
 * Git services can follow a different branch per environment.
 *
 * Previews: with previews enabled on a project, a pull request against one of its git repositories opens a
 * `pr-<n>` environment on the PR branch, redeploys it on every push and deletes it when the PR closes.
 * Only same-repository PRs (never forks), and a close event only ever deletes the preview it created.
 */
import { projects as projectsTable, services as servicesTable } from './db.ts';
import type { Project } from './types.ts';
import { bus, recordActivity, type Actor } from './events.ts';
import { HttpError, KeyedLock, slugify, assert } from './util.ts';
import { exportProject, importProject, deleteProject, deployService, getProjectOrThrow, serializeService } from './ops.ts';
import { onPullRequest, repoKey, type PullRequestEvent } from './hooks.ts';
import { notify } from './notify.ts';

const lock = new KeyedLock();
const PREVIEWS: Actor = { type: 'system', name: 'previews' };

export function baseOf(p: Project): Project {
  return p.parentId ? projectsTable.get(p.parentId) ?? p : p;
}

export function environmentsOf(projectId: string) {
  const base = baseOf(getProjectOrThrow(projectId));
  const all = [base, ...projectsTable.all('ORDER BY created_at ASC').filter((p) => p.parentId === base.id)];
  return all.map((p) => {
    const svcs = servicesTable.all('WHERE project_id = ?', p.id);
    return {
      id: p.id,
      slug: p.slug,
      name: p.parentId ? p.envName ?? p.slug : 'production',
      isBase: !p.parentId,
      preview: p.preview ?? null,
      services: svcs.length,
      running: svcs.filter((s) => s.status === 'running').length,
      failing: svcs.filter((s) => s.status === 'failed' || s.status === 'crashed').length,
      createdAt: p.createdAt,
    };
  });
}

function uniqueSlug(wanted: string): string {
  const taken = new Set(projectsTable.all().map((p) => p.slug));
  let slug = wanted.slice(0, 48);
  for (let i = 2; taken.has(slug); i++) slug = `${wanted.slice(0, 44)}-${i}`;
  return slug;
}

export async function createEnvironment(
  actor: Actor,
  projectId: string,
  input: { name: string; branch?: string; repo?: string; deploy?: boolean; preview?: Project['preview'] },
) {
  const base = baseOf(getProjectOrThrow(projectId));
  const envName = slugify(input.name?.trim() || '');
  assert(envName && envName !== 'production', 400, 'pick a name for the environment, e.g. "staging"');
  const siblings = projectsTable.all().filter((p) => p.parentId === base.id);
  if (siblings.some((p) => p.envName === envName)) throw new HttpError(409, `${base.name} already has an environment called ${envName}`);

  const spec = exportProject(base.id, { secrets: true });
  const branch = input.branch?.trim();
  const repo = input.repo ? repoKey(input.repo) : null;
  for (const s of spec.services) {
    s.domains = [];
    s.backup = null;
    s.publicTcpPort = null;
    // Never shared with production: fixed host ports would collide, host folders and shares are production's data.
    delete s.ports;
    s.volumes = (s.volumes ?? []).filter((m) => !m.hostPath && !m.borrowed);
    if (branch && s.source?.type === 'git' && (!repo || repoKey(s.source.repo) === repo)) s.source = { ...s.source, branch };
  }
  const r = await importProject(actor, spec, { deploy: false, name: base.name });
  const env = projectsTable.get(r.project.id)!;
  Object.assign(env, {
    parentId: base.id,
    envName,
    color: base.color,
    slug: uniqueSlug(`${base.slug}-${envName}`),
    preview: input.preview ?? null,
    updatedAt: Date.now(),
  } satisfies Partial<Project>);
  projectsTable.put(env);
  // Hostnames derive from the project slug; refresh every service so routes and URLs pick it up.
  for (const sid of r.services) {
    const svc = servicesTable.get(sid);
    if (svc) bus.publish({ type: 'service.updated', service: svc });
  }
  bus.publish({ type: 'project.updated', project: env });
  recordActivity(actor, 'environment.created', `Created environment ${envName} of ${base.name}${branch ? ` on branch ${branch}` : ''}`, env.id);
  if (input.deploy !== false) for (const sid of r.services) deployService(actor, sid);
  return env;
}

export async function deleteEnvironment(actor: Actor, projectId: string) {
  const env = getProjectOrThrow(projectId);
  if (!env.parentId) throw new HttpError(400, 'that is the production environment — delete the project instead');
  await deleteProject(actor, env.id);
}

export function setPreviews(actor: Actor, projectId: string, enabled: boolean) {
  const base = baseOf(getProjectOrThrow(projectId));
  base.previews = { enabled };
  base.updatedAt = Date.now();
  projectsTable.put(base);
  bus.publish({ type: 'project.updated', project: base });
  recordActivity(actor, 'project.previews', `${enabled ? 'Enabled' : 'Disabled'} pull-request previews for ${base.name}`, base.id);
  return base;
}

// ───────────────────────────── pull-request previews ─────────────────────────────

function previewEnvs(baseId: string, pr: { repo: string; number: number }) {
  return projectsTable.all().filter((p) => p.parentId === baseId && p.preview && p.preview.repo === pr.repo && p.preview.number === pr.number);
}

/** Tell subscribers once every service of a fresh preview is up. */
function announceWhenReady(envId: string, pr: PullRequestEvent) {
  const deadline = Date.now() + 20 * 60_000;
  const t = setInterval(() => {
    const env = projectsTable.get(envId);
    const svcs = env ? servicesTable.all('WHERE project_id = ?', envId) : [];
    if (!env || Date.now() > deadline) return clearInterval(t);
    if (svcs.some((s) => s.status === 'building' || s.status === 'deploying' || s.status === 'idle')) return;
    clearInterval(t);
    const failed = svcs.filter((s) => s.status === 'failed' || s.status === 'crashed');
    const links = svcs.map((s) => serializeService(s)).filter((s) => s.url).map((s) => ({ label: s.name, url: s.url! }));
    notify({
      event: 'preview.ready',
      level: failed.length ? 'error' : 'success',
      title: `Preview for #${pr.number} ${failed.length ? 'has failures' : 'is ready'}`,
      message: `${pr.title || pr.branch} (${pr.branch})${failed.length ? `\nFailing: ${failed.map((s) => s.name).join(', ')}` : ''}`,
      projectId: envId,
      links: pr.url ? [{ label: `PR #${pr.number}`, url: pr.url }, ...links] : links,
    });
  }, 5000);
}

async function handlePr(pr: PullRequestEvent): Promise<string> {
  return lock.run(`${pr.repo}#${pr.number}`, async () => {
    const bases = projectsTable
      .all()
      .filter((p) => !p.parentId && p.previews?.enabled)
      .filter((p) => servicesTable.all('WHERE project_id = ?', p.id).some((s) => s.source.type === 'git' && repoKey(s.source.repo) === pr.repo));
    if (!bases.length) return 'no project with previews enabled uses this repository';
    if (!pr.sameRepo) return 'pull requests from forks never get previews';
    const results: string[] = [];
    for (const base of bases) {
      const existing = previewEnvs(base.id, pr);
      if (pr.action === 'closed') {
        for (const env of existing) {
          await deleteProject(PREVIEWS, env.id);
          results.push(`deleted ${env.slug}`);
        }
        continue;
      }
      if (existing.length) {
        for (const env of existing) {
          env.preview = { ...env.preview!, branch: pr.branch, title: pr.title, url: pr.url };
          projectsTable.put(env);
          for (const s of servicesTable.all('WHERE project_id = ?', env.id)) {
            if (s.source.type === 'git' && repoKey(s.source.repo) === pr.repo) deployService(PREVIEWS, s.id, 'git');
          }
          results.push(`redeploying ${env.slug}`);
        }
        continue;
      }
      const env = await createEnvironment(PREVIEWS, base.id, {
        name: `pr-${pr.number}`,
        branch: pr.branch,
        repo: pr.repo,
        preview: { provider: pr.provider, repo: pr.repo, number: pr.number, branch: pr.branch, title: pr.title, url: pr.url },
      });
      announceWhenReady(env.id, pr);
      results.push(`created ${env.slug}`);
    }
    return results.join('; ') || 'nothing to do';
  });
}

export function startEnvironments() {
  onPullRequest(handlePr);
}
