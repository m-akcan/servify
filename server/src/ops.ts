/**
 * The service layer. REST handlers, MCP tools and background jobs all call these functions,
 * so every capability is available to humans and agents alike, with the same validation.
 */
import { z } from 'zod';
import { cannotSleep, wake } from './sleep.ts';
import { removeUploads, uploadPath } from './uploads.ts';
import { imageUpdateOf, checkService, parseRepo, remoteDigestOf, sameRepo } from './imageupdates.ts';
import { projects as projectsTable, services as servicesTable, deployments as deploymentsTable, activityTable, db, volumesTable, backupsTable } from './db.ts';
import type { Project, Service, Deployment, Source, SourceUpload, Replica } from './types.ts';
import { bus, recordActivity, type Actor } from './events.ts';
import { id, slugify, secret, HttpError, assert } from './util.ts';
import { getTemplate, templates } from './templates.ts';
import { queueDeployment, readDeploymentLog, isDeploying } from './deployer.ts';
import { replicasOf, requestReconcile, drainAndRemove, effectiveReplicas, networkName, deployedSchedule } from './engine.ts';
import { demuxLines, normalizeImageRef, splitImageRef } from './docker.ts';
import { dockerFor, dockerForContainer, nodeOf, nodeName, onlineNodes, isOnline, LOCAL } from './nodes.ts';
import { nodesTable } from './db.ts';
import { referencedServices, publicUrl, resolveEnv, hostUrl } from './vars.ts';
import { certsTable } from './db.ts';
import { isLocalHost } from './certs.ts';
import { getSettings, destinationById } from './settings.ts';
import { backupMethod, backupService, listBackups, isRestoring } from './backups.ts';
import { queryLogs, subscribeLogs, type LogLine } from './logstore.ts';
import { syncServiceVolumes, releaseServiceVolumes, deleteProjectVolumes, listVolumes, hasSharedVolume, checkHostPath, adoptable, adoptVolume, borrowersOf } from './volumes.ts';
import { planCompose, planToSpec } from './compose.ts';
import { clusterStatus } from './pgcluster.ts';
import { isExternal, isRoute, parseExternalUrl, parseRedirect, externalTarget } from './external.ts';
import { allocateTcpPort, tcpPortInUse, portFree } from './proxy.ts';
import { normalizeRepo } from './builder.ts';
import { metricsHistory } from './metrics.ts';
import { config } from './config.ts';
import { validateCron, nextRun } from './cron.ts';
import { runJob, listRuns, isJobRunning, killJobs } from './cronjobs.ts';

const PROJECT_COLORS = ['#d4f25a', '#7ce0c3', '#f2a65a', '#9fb4ff', '#f27a9b', '#c9a7ff', '#5ad1f2'];

// ───────────────────────────── serialization ─────────────────────────────

export type View = { revealSecrets: boolean };

export function serializeService(s: Service, view: View = { revealSecrets: true }) {
  const out: any = structuredClone(s);
  if (out.source?.type === 'git' && out.source.token) out.source.token = '••••••••';
  if (!view.revealSecrets) for (const k of s.secretKeys) if (k in out.env) out.env[k] = '••••••••';
  const project = projectsTable.get(s.projectId);
  out.url = project && s.protocol === 'http' && s.publicHttp ? publicUrl(s, project) : null;
  out.tcpAddress = s.publicTcpPort ? `${config.proxyHost === '0.0.0.0' ? 'localhost' : config.proxyHost}:${s.publicTcpPort}` : null;
  out.pendingChanges = pendingChanges(s);
  out.accessLog = s.accessLog !== false;
  const iu = imageUpdateOf(s.id);
  out.imageUpdate = iu && s.source.type === 'image' && iu.ref === normalizeImageRef(s.source.image) ? iu : null; // stale once the image changes
  const httpsOn = getSettings().https.enabled;
  out.domainInfo = s.domains.map((d) => {
    const c = certsTable.get(d);
    return {
      domain: d,
      url: hostUrl(d),
      tls: isLocalHost(d) ? 'local' : !httpsOn ? 'off' : c?.status ?? 'pending',
      expiresAt: c?.expiresAt ?? null,
      error: c?.status === 'issued' ? null : c?.error ?? null,
    };
  });
  const live = deployedSchedule(s);
  out.deployedSchedule = live;
  out.nextRunAt = live && !s.stopped ? nextRun(live)?.getTime() ?? null : null;
  out.jobRunning = isJobRunning(s.id);
  out.backupMethod = backupMethod(s);
  out.clusterStatus = clusterStatus(s);
  const node = nodeOf(s);
  out.server = { id: node, name: node === LOCAL ? 'This machine' : nodeName(node), online: isOnline(node) };
  // Private names work across servers through mesh relays (main port only); the panel says so.
  out.crossServerRefs = referencedServicesOn(s);
  out.external = externalTarget(s);
  out.restoring = isRestoring(s.id);
  return out as Service & { url: string | null; tcpAddress: string | null; pendingChanges: string[] };
}

export function serializeDeployment(d: Deployment, view: View = { revealSecrets: true }) {
  const { resolvedEnv, ...rest } = d as any;
  const out = structuredClone(rest);
  if (out.config?.source?.type === 'git' && out.config.source.token) out.config.source.token = '••••••••';
  if (!view.revealSecrets) out.config.env = Object.fromEntries(Object.keys(out.config.env).map((k) => [k, '••••••••']));
  return out as Deployment;
}

/** Which settings differ from what is currently deployed (→ "Deploy changes" banner). */
export function pendingChanges(s: Service): string[] {
  if (!s.activeDeploymentId) return [];
  const d = deploymentsTable.get(s.activeDeploymentId);
  if (!d) return [];
  const out: string[] = [];
  const c = d.config;
  if ((c as any).schedule !== undefined && ((c as any).schedule ?? null) !== (s.schedule ?? null)) out.push('schedule');
  if (JSON.stringify(c.env) !== JSON.stringify(s.env)) out.push('variables');
  if ((c.port ?? null) !== (s.port ?? null) && s.port !== null) out.push('port');
  if ((c.startCommand ?? null) !== (s.startCommand ?? null)) out.push('start command');
  if (JSON.stringify(c.cmd ?? null) !== JSON.stringify(s.cmd ?? null) || JSON.stringify(c.entrypoint ?? null) !== JSON.stringify(s.entrypoint ?? null)) out.push('command');
  if (JSON.stringify(c.volumes) !== JSON.stringify(s.volumes)) out.push('volumes');
  if (JSON.stringify(c.ports ?? []) !== JSON.stringify(s.ports ?? [])) out.push('published ports');
  if (JSON.stringify(c.resources) !== JSON.stringify(s.resources)) out.push('resources');
  if (c.protocol !== s.protocol) out.push('networking');
  const a = { ...c.source, token: undefined } as any;
  const b = { ...s.source, token: undefined } as any;
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push('source');
  return out;
}

// ───────────────────────────── projects ─────────────────────────────

export function listProjects() {
  const all = projectsTable.all('ORDER BY created_at ASC');
  const lastDeploy = new Map((db.prepare('SELECT project_id AS p, MAX(created_at) AS t FROM deployments GROUP BY project_id').all() as { p: string; t: number }[]).map((r) => [r.p, r.t]));
  return all.map((p) => {
    const svcs = servicesTable.all('WHERE project_id = ?', p.id);
    const serverIds = [...new Set(svcs.map((s) => nodeOf(s)))];
    const { variables: _v, secretKeys: _s, ...rest } = p; // shared variables only travel in a project's own snapshot
    return {
      ...rest,
      environments: p.parentId ? 0 : all.filter((x) => x.parentId === p.id).length,
      serviceCount: svcs.length,
      running: svcs.filter((s) => s.status === 'running').length,
      lastDeployAt: lastDeploy.get(p.id) ?? null,
      servers: serverIds.map((id) => ({ id, name: id === LOCAL ? 'This machine' : nodeName(id) })),
      services: svcs.map((s) => ({ id: s.id, name: s.name, icon: s.icon, status: s.status, server: nodeOf(s) })),
    };
  });
}

/** 'i:<line icon>', 'b:<brand logo>' or 'e:<emoji>'; empty clears it. */
function projectIcon(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const v = String(raw).trim();
  assert(v.length <= 40 && /^(i:[a-zA-Z]{1,32}|b:[a-z0-9-]{1,32}|e:\S.{0,15})$/u.test(v), 400, 'icon must be i:<icon>, b:<logo> or e:<emoji>');
  return v;
}

export function getProjectOrThrow(projectId: string): Project {
  const p = projectsTable.get(projectId) ?? projectsTable.all(`WHERE json_extract(data, '$.slug') = ?`, projectId)[0];
  if (!p) throw new HttpError(404, `project not found: ${projectId}`);
  return p;
}

export function projectSnapshot(projectId: string, view: View = { revealSecrets: true }) {
  const project = getProjectOrThrow(projectId);
  const svcs = servicesTable.all('WHERE project_id = ? ORDER BY created_at ASC', project.id);
  const deps = deploymentsTable.all('WHERE project_id = ? ORDER BY created_at DESC LIMIT 400', project.id);
  const replicas: Record<string, Replica[]> = {};
  for (const s of svcs) replicas[s.id] = replicasOf(s.id);
  const edges: { from: string; to: string }[] = [];
  for (const s of svcs) for (const t of referencedServices(s, svcs)) edges.push({ from: s.id, to: t });
  return {
    project: publicProject(project, view),
    services: svcs.map((s) => serializeService(s, view)),
    deployments: deps.map((d) => serializeDeployment(d, view)),
    replicas,
    edges,
    volumes: listVolumes(project.id),
    proxyPort: config.proxyPort,
  };
}

export function createProject(actor: Actor, input: { name: string; color?: string }): Project {
  const name = input.name?.trim();
  assert(name, 400, 'project name is required');
  const existing = new Set(projectsTable.all().map((p) => p.slug));
  let slug = slugify(name);
  for (let i = 2; existing.has(slug); i++) slug = `${slugify(name)}-${i}`;
  const p: Project = {
    id: id('prj'),
    name,
    slug,
    color: input.color ?? PROJECT_COLORS[existing.size % PROJECT_COLORS.length],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  projectsTable.insert(p);
  bus.publish({ type: 'project.updated', project: p });
  recordActivity(actor, 'project.created', `Created project ${p.name}`, p.id);
  return p;
}

export function updateProject(actor: Actor, projectId: string, patch: { name?: string; color?: string; icon?: string | null; variables?: Record<string, string> | null; secretKeys?: string[] | null }) {
  const p = getProjectOrThrow(projectId);
  if (patch.name?.trim()) p.name = patch.name.trim();
  if (patch.color) p.color = patch.color;
  if (patch.icon !== undefined) p.icon = projectIcon(patch.icon);
  let sharedChanged = false;
  if (patch.variables !== undefined) {
    const vars = patch.variables ?? {};
    assert(typeof vars === 'object' && !Array.isArray(vars), 400, 'variables must be an object');
    const entries = Object.entries(vars);
    assert(entries.length <= 200, 400, 'at most 200 shared variables');
    for (const [k, v] of entries) assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string' && v.length <= 32_768, 400, `invalid shared variable ${k}`);
    // A masked value sent back unchanged keeps the stored secret.
    const prev = p.variables ?? {};
    p.variables = Object.fromEntries(entries.map(([k, v]) => [k, v === '••••••••' && k in prev ? prev[k] : v]));
    sharedChanged = true;
  }
  if (patch.secretKeys !== undefined) p.secretKeys = (patch.secretKeys ?? []).filter((k) => typeof k === 'string' && k in (p.variables ?? {}));
  p.updatedAt = Date.now();
  projectsTable.put(p);
  bus.publish({ type: 'project.updated', project: p });
  recordActivity(actor, 'project.updated', sharedChanged ? `Updated the shared variables of ${p.name}` : `Updated project ${p.name}`, p.id);
  // Services that read shared variables pick changes up on their next deploy; tell the caller which.
  const scope = [p.id, ...projectsTable.all().filter((x) => x.parentId === p.id).map((x) => x.id)];
  const usesShared = sharedChanged
    ? servicesTable.all().filter((s) => scope.includes(s.projectId) && Object.values(s.env).some((v) => v.includes('{{') && /\$\{\{\s*shared\./.test(v))).map((s) => ({ id: s.id, name: s.name, projectId: s.projectId }))
    : [];
  return { ...p, usesShared };
}

/** A project for the API: secret shared variables masked for read-only access. */
export function publicProject(p: Project, view: View = { revealSecrets: true }): Project {
  if (view.revealSecrets || !p.variables) return p;
  const secret = new Set(p.secretKeys ?? []);
  return { ...p, variables: Object.fromEntries(Object.entries(p.variables).map(([k, v]) => [k, secret.has(k) ? '••••••••' : v])) };
}

export async function deleteProject(actor: Actor, projectId: string) {
  const p = getProjectOrThrow(projectId);
  // A base project takes its environments (and previews) with it.
  if (!p.parentId) for (const env of projectsTable.all().filter((x) => x.parentId === p.id)) await deleteProject(actor, env.id);
  for (const s of servicesTable.all('WHERE project_id = ?', p.id)) await deleteService(actor, s.id, { quiet: true });
  await deleteProjectVolumes(p.id);
  projectsTable.delete(p.id);
  bus.publish({ type: 'project.deleted', projectId: p.id });
  recordActivity(actor, 'project.deleted', p.parentId ? `Deleted environment ${p.envName ?? p.slug} of ${p.name}` : `Deleted project ${p.name}`);
  setTimeout(() => {
    for (const n of onlineNodes()) void dockerFor(n).removeNetwork(networkName(p.id)).catch(() => {});
  }, 15_000);
}

// ───────────────────────────── services ─────────────────────────────

export function getServiceOrThrow(serviceId: string): Service {
  const s = servicesTable.get(serviceId);
  if (s) return s;
  // Allow "project/service" or bare slug lookups for agents.
  const [a, b] = serviceId.includes('/') ? serviceId.split('/') : [null, serviceId];
  const candidates = servicesTable.all().filter((x) => x.slug === b || x.name === b);
  const filtered = a ? candidates.filter((x) => {
    const p = projectsTable.get(x.projectId);
    return p && (p.slug === a || p.id === a || p.name === a);
  }) : candidates;
  if (filtered.length === 1) return filtered[0];
  if (filtered.length > 1) throw new HttpError(409, `ambiguous service "${serviceId}" — use its id or "project/service"`);
  throw new HttpError(404, `service not found: ${serviceId}`);
}

export const createServiceInput = z.object({
  name: z.string().max(48).optional().describe('Display name. Defaults to one derived from the source.'),
  templateId: z.string().optional().describe('Template id (see list_templates), e.g. postgres, redis, whoami'),
  image: z.string().optional().describe('Docker image, e.g. nginx:alpine or ghcr.io/org/app:1.2'),
  repo: z.string().optional().describe('Git repository URL or GitHub owner/repo'),
  branch: z.string().optional(),
  rootDir: z.string().optional().describe('Subdirectory inside the repo/folder to build from'),
  dockerfile: z.string().optional().describe('Path to a Dockerfile relative to the root dir'),
  token: z.string().optional().describe('Access token for private git repositories'),
  path: z.string().optional().describe('Absolute path of a local folder to build (local-first!)'),
  upload: z.boolean().optional().describe('Code comes from `servify up` (the service waits for the first upload)'),
  port: z.number().int().min(1).max(65535).optional().describe('Port the app listens on inside the container'),
  protocol: z.enum(['http', 'tcp', 'none']).optional().describe('http = routed by domain, tcp = raw TCP, none = background worker'),
  replicas: z.number().int().min(0).max(32).optional(),
  env: z.record(z.string(), z.string()).optional(),
  startCommand: z.string().optional(),
  buildCommand: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  deploy: z.boolean().optional().describe('Deploy immediately (default true)'),
  server: z.string().optional().describe('Server to run on (id or name from list_servers). Default: this machine.'),
  external: z.string().optional().describe('Route to an address on another machine instead of running anything, e.g. http://192.168.1.20:8080 (owner only)'),
  udp: z.boolean().optional().describe('External TCP routes: forward UDP on the same proxy port too'),
  redirect: z.string().optional().describe('Make this a redirect: its domains answer with a redirect to this URL (e.g. https://www.example.com)'),
  redirectCode: z.number().int().optional().describe('301, 302, 307 or 308 (default 308, permanent)'),
  keepPath: z.boolean().optional().describe('Redirects: append the requested path (default true)'),
});
export type CreateServiceInput = z.infer<typeof createServiceInput>;

function inferName(input: CreateServiceInput): string {
  if (input.name?.trim()) return input.name.trim();
  if (input.templateId) return getTemplate(input.templateId)?.name.toLowerCase().replace(/\s+/g, '-') ?? input.templateId;
  if (input.image) return input.image.split('/').pop()!.split(':')[0].split('@')[0];
  if (input.repo) return normalizeRepo(input.repo).split('/').pop()!.replace(/\.git$/, '');
  if (input.path) return input.path.replace(/\/+$/, '').split('/').pop() || 'app';
  if (input.redirect) return (input.redirect.replace(/^[a-z]+:\/\//i, '').split(/[/:]/)[0] || 'redirect').replace(/\./g, '-');
  if (input.external) return input.external.replace(/^[a-z]+:\/\//i, '').split(/[:/]/)[0].replace(/\./g, '-') || 'external';
  return 'service';
}

/** Icon key for a Docker image (matched against the brand logo set in the dashboard). */
export function iconForImage(image: string): string | null {
  const img = image.toLowerCase().split('@')[0];
  const rules: [RegExp, string][] = [
    [/postgres|postgis|timescale|pgvector|supabase\/postgres/, 'postgres'],
    [/mariadb/, 'mariadb'],
    [/mysql|percona/, 'mysql'],
    [/mongo/, 'mongo'],
    [/redis|valkey|keydb|dragonfly/, 'redis'],
    [/minio/, 'bucket'],
    [/n8n/, 'flow'],
    [/uptime-kuma/, 'pulse'],
    [/ollama/, 'spark'],
    [/traefik/, 'wave'],
    [/nginx/, 'nginx'],
    [/caddy/, 'caddy'],
    [/adminer/, 'table'],
    [/grafana/, 'grafana'],
    [/prometheus/, 'prometheus'],
    [/rabbitmq/, 'rabbitmq'],
    [/elasticsearch|opensearch/, 'elasticsearch'],
    [/kafka|redpanda/, 'kafka'],
    [/meilisearch/, 'meilisearch'],
    [/clickhouse/, 'clickhouse'],
    [/keycloak/, 'keycloak'],
    [/gitea|forgejo/, 'gitea'],
    [/gitlab/, 'gitlab'],
    [/oven\/bun|(^|\/)bun(:|$)/, 'bun'],
    [/deno/, 'deno'],
    [/(^|\/)node(:|$)/, 'node'],
    [/(^|\/)python(:|$)/, 'python'],
    [/golang|(^|\/)go(:|$)/, 'go'],
    [/(^|\/)rust(:|$)/, 'rust'],
    [/(^|\/)ruby(:|$)/, 'ruby'],
    [/(^|\/)php(:|$)/, 'php'],
    [/(^|\/)alpine(:|$)/, 'alpine'],
    [/(^|\/)ubuntu(:|$)/, 'ubuntu'],
    [/(^|\/)debian(:|$)/, 'debian'],
  ];
  for (const [re, key] of rules) if (re.test(img)) return key;
  return null;
}

/** Icon key for a zero-config build ("node (pnpm, next.js)", "python", …). */
export function iconForStack(stack: string | null | undefined): string | null {
  const s = (stack ?? '').toLowerCase();
  if (s.includes('next.js')) return 'next';
  if (s.startsWith('node')) return 'node';
  if (s.startsWith('static site')) return 'vite';
  if (s.startsWith('static')) return 'static';
  for (const k of ['python', 'go', 'rust', 'deno', 'php', 'ruby']) if (s.startsWith(k)) return k;
  return null;
}

/** Boot: give services created before the logo set existed a recognisable icon. */
export function upgradeIcons() {
  for (const svc of servicesTable.all()) {
    if (svc.icon !== 'box') continue;
    const next = svc.source.type === 'image' ? iconForImage(svc.source.image) : null;
    if (next) {
      svc.icon = next;
      servicesTable.put(svc);
    }
  }
}

function iconFor(input: CreateServiceInput): string {
  if (input.templateId) return getTemplate(input.templateId)?.icon ?? 'box';
  if (input.repo) return 'git';
  if (input.path || input.upload) return 'folder';
  return iconForImage(input.image ?? '') ?? 'box';
}

/** First free grid slot spiralling out from (ox, oy). */
function placeNear(projectId: string, ox: number, oy: number): { x: number; y: number } {
  const svcs = servicesTable.all('WHERE project_id = ?', projectId);
  const W = 300;
  const H = 220;
  for (let ring = 1; ring < 12; ring++) {
    for (const [gx, gy] of [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const x = ox + gx * W * ring;
      const y = oy + gy * H * ring;
      if (svcs.every((s) => Math.abs(s.x - x) > W * 0.85 || Math.abs(s.y - y) > H * 0.8)) return { x, y };
    }
  }
  return { x: ox + 40, y: oy + 40 };
}

function placeNew(projectId: string): { x: number; y: number } {
  const svcs = servicesTable.all('WHERE project_id = ?', projectId);
  if (!svcs.length) return { x: 0, y: 0 };
  // Find a free grid slot near the existing cluster.
  const W = 300;
  const H = 200;
  for (let ring = 0; ring < 12; ring++) {
    for (let gx = -ring; gx <= ring; gx++) {
      for (let gy = -ring; gy <= ring; gy++) {
        if (Math.max(Math.abs(gx), Math.abs(gy)) !== ring) continue;
        const x = gx * W;
        const y = gy * H;
        if (svcs.every((s) => Math.abs(s.x - x) > W * 0.8 || Math.abs(s.y - y) > H * 0.8)) return { x, y };
      }
    }
  }
  return { x: svcs.length * 40, y: svcs.length * 40 };
}

export async function createService(actor: Actor, projectId: string, raw: CreateServiceInput) {
  const input = createServiceInput.parse(raw);
  const project = getProjectOrThrow(projectId);
  const tpl = input.templateId ? getTemplate(input.templateId) : null;
  if (input.templateId) assert(tpl, 400, `unknown template: ${input.templateId}`);
  let source: Source;
  if (tpl) source = { type: 'image', image: tpl.image };
  else if (input.image) source = { type: 'image', image: input.image.trim() };
  else if (input.repo)
    source = {
      type: 'git',
      repo: normalizeRepo(input.repo),
      branch: input.branch?.trim() || undefined,
      rootDir: input.rootDir?.trim() || undefined,
      dockerfile: input.dockerfile?.trim() || undefined,
      token: input.token?.trim() || undefined,
    };
  else if (input.path) source = { type: 'local', path: input.path.trim(), dockerfile: input.dockerfile?.trim() || undefined };
  else if (input.upload) source = { type: 'upload', uploadId: null, uploadedAt: null, files: 0, bytes: 0 };
  else if (input.external) {
    // The router can reach anything this machine can: pointing it somewhere is the owner's call.
    requireOwner(actor, 'External routes');
    source = { type: 'external', ...parseExternalUrl(input.external, input.protocol ?? 'http'), ...(input.udp ? { udp: true } : {}) };
    if (input.udp && (input.protocol ?? 'http') !== 'tcp') throw new HttpError(400, 'UDP forwarding needs a TCP route (protocol tcp)');
  } else if (input.redirect) source = parseRedirect(input.redirect, input.redirectCode, input.keepPath);
  else throw new HttpError(400, 'provide one of: templateId, image, repo, path, upload, external, redirect');

  // A GitHub "tree" URL carries branch and subdirectory.
  if (input.repo) {
    const m = input.repo.match(/github\.com\/[^/]+\/[^/]+\/tree\/([^/]+)(?:\/(.+))?$/);
    if (m && source.type === 'git') {
      source.branch ??= m[1];
      source.rootDir ??= m[2];
    }
  }

  const siblings = servicesTable.all('WHERE project_id = ?', project.id);
  const name = inferName(input);
  let slug = slugify(name);
  for (let i = 2; siblings.some((s) => s.slug === slug); i++) slug = `${slugify(name)}-${i}`;

  const env: Record<string, string> = {};
  if (tpl) for (const [k, v] of Object.entries(tpl.env)) env[k] = v.replace(/\{\{secret\}\}/g, () => secret(18));
  Object.assign(env, input.env ?? {});
  const protocol = input.protocol ?? tpl?.protocol ?? 'http';
  const pos = input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : placeNew(project.id);
  const nodeId = resolveServer(input.server);

  const svc: Service = {
    id: id('svc'),
    projectId: project.id,
    name: siblings.some((s) => s.name === name) ? slug : name,
    slug,
    icon: iconFor(input),
    templateId: tpl?.id ?? null,
    source,
    protocol,
    port: input.port ?? tpl?.port ?? null,
    replicas: tpl?.singleton ? 1 : Math.max(0, input.replicas ?? tpl?.replicas ?? 1),
    strategy: 'round-robin',
    healthcheck: { path: tpl?.healthPath ?? null, intervalSec: 5, timeoutSec: 3, graceSec: tpl?.graceSec ?? (source.type === 'image' ? 90 : 120) },
    cluster: tpl?.cluster ? { ...tpl.cluster, primary: 0 } : null,
    autoscale: { enabled: false, min: 1, max: 5, metric: 'rps', target: 50 },
    publicHttp: protocol === 'http',
    domains: [],
    publicTcpPort: null,
    volumes: tpl ? structuredClone(tpl.volumes) : [],
    env,
    secretKeys: tpl ? [...tpl.secretKeys] : Object.keys(env).filter((k) => /SECRET|PASSWORD|TOKEN|KEY/i.test(k)),
    startCommand: input.startCommand ?? tpl?.startCommand ?? null,
    buildCommand: input.buildCommand ?? null,
    resources: { cpus: null, memoryMb: null },
    autoDeploy: source.type === 'git',
    accessLog: true,
    nodeId: nodeId === LOCAL ? null : nodeId,
    x: pos.x,
    y: pos.y,
    status: 'idle',
    activeDeploymentId: null,
    stopped: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  if (protocol === 'tcp') svc.publicTcpPort = await allocateTcpPort();
  if (source.type === 'external' || source.type === 'redirect') {
    svc.replicas = 1;
    svc.autoDeploy = false;
    svc.status = source.type === 'redirect' ? 'running' : 'deploying'; // a route is up once its first probe answers
    if (source.type === 'redirect') {
      svc.protocol = 'http';
      svc.publicTcpPort = null;
    }
    if (svc.nodeId) throw new HttpError(400, 'routes run on this machine’s router — no server to pick');
  }
  servicesTable.insert(svc);
  syncServiceVolumes(svc);
  bus.publish({ type: 'service.updated', service: svc });
  recordActivity(actor, 'service.created', `Created ${svc.name} from ${describeSource(source)}`, project.id, svc.id);
  let deployment: Deployment | null = null;
  if (input.deploy !== false && source.type !== 'external' && source.type !== 'redirect') deployment = queueDeployment(svc, 'create', actor);
  return { service: serializeService(servicesTable.get(svc.id)!), deployment: deployment ? serializeDeployment(deployment) : null };
}

/** A duplicate (or an environment's copy) of an uploaded service starts from the same files. */
function copyUpload(fromId: string, toId: string, s: SourceUpload) {
  const from = uploadPath(fromId, s.uploadId!);
  if (!existsSync(from)) return;
  cpSync(from, uploadPath(toId, s.uploadId!), { recursive: true });
  const svc = servicesTable.get(toId);
  if (!svc) return;
  svc.source = { ...s };
  servicesTable.put(svc);
}

function describeSource(s: Source) {
  if (s.type === 'external') return s.url;
  if (s.type === 'redirect') return `a redirect to ${s.to}`;
  if (s.type === 'image') return s.image;
  if (s.type === 'git') return s.repo.replace(/^https:\/\/github\.com\//, '');
  if (s.type === 'upload') return 'an upload';
  return s.path;
}

export const updateServiceInput = z.object({
  name: z.string().min(1).max(48).optional(),
  icon: z.string().max(24).optional(),
  image: z.string().optional().describe('Switch to (or update) a Docker image source'),
  repo: z.string().optional(),
  branch: z.string().optional(),
  rootDir: z.string().optional(),
  dockerfile: z.string().optional(),
  token: z.string().optional(),
  path: z.string().optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  protocol: z.enum(['http', 'tcp', 'none']).optional(),
  replicas: z.number().int().min(0).max(32).optional(),
  strategy: z.enum(['round-robin', 'least-conn', 'ip-hash', 'random']).optional(),
  healthcheck: z
    .object({
      path: z.string().nullable().optional(),
      intervalSec: z.number().min(1).max(300).optional(),
      timeoutSec: z.number().min(1).max(60).optional(),
      graceSec: z.number().min(5).max(1800).optional(),
    })
    .optional(),
  autoscale: z
    .object({
      enabled: z.boolean().optional(),
      min: z.number().int().min(1).max(32).optional(),
      max: z.number().int().min(1).max(32).optional(),
      metric: z.enum(['cpu', 'rps']).optional(),
      target: z.number().positive().optional(),
    })
    .optional(),
  publicHttp: z.boolean().optional(),
  domains: z.array(z.string()).optional(),
  publicTcpPort: z.number().int().min(0).max(65535).nullable().optional().describe('Host port for the TCP proxy; 0 = pick a free one; null = off'),
  volumes: z
    .array(
      z.object({
        name: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
        mountPath: z.string().startsWith('/'),
        volumeId: z.string().optional(),
        perReplica: z.boolean().optional(),
        hostPath: z.string().optional(),
        selinux: z.enum(['z', 'Z']).nullable().optional(),
        readOnly: z.boolean().optional(),
        borrowed: z.boolean().optional(),
      }),
    )
    .optional()
    .describe('Mounts. New entries (no volumeId) create a fresh volume. To remove one, use detach_volume. hostPath (owner only) mounts a folder of the server.'),
  startCommand: z.string().nullable().optional(),
  cmd: z.array(z.string()).nullable().optional().describe('Override only the image CMD (argv array). Ignored when startCommand is set.'),
  entrypoint: z.array(z.string()).nullable().optional().describe('Override only the image ENTRYPOINT (argv array).'),
  buildCommand: z.string().nullable().optional(),
  buildArgs: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'build arg names are letters, digits and _'), z.string()).nullable().optional().describe('Docker build arguments; values may use ${VAR} from the service variables'),
  buildTarget: z.string().max(64).nullable().optional().describe('Multi-stage build target'),
  sleepAfterMinutes: z.number().int().min(1).max(1440).nullable().optional().describe('HTTP services: stop after this many idle minutes; the next request starts it again (takes a few seconds)'),
  accessLog: z.boolean().optional().describe('HTTP services: record the router access log (requests, referrers, user agents; no IPs). On by default; takes effect immediately'),
  imageAutoUpdate: z.boolean().optional().describe('Image services: redeploy automatically when a new image is published under the same tag (not for databases or clusters)'),
  watchPaths: z.array(z.string().min(1).max(200)).max(50).nullable().optional().describe('Git: deploy only when a push changes files matching these globs (e.g. apps/web/**, !**/*.md)'),
  preDeployCommand: z.string().max(2000).nullable().optional().describe('Runs once per new deploy (e.g. migrations) in a one-off container from the new image; a failure stops the deploy'),
  resources: z.object({ cpus: z.number().positive().max(64).nullable().optional(), memoryMb: z.number().int().min(16).nullable().optional() }).optional(),
  autoDeploy: z.boolean().optional(),
  secretKeys: z.array(z.string()).optional(),
  backup: z
    .object({
      enabled: z.boolean().optional(),
      schedule: z.string().optional().describe('Cron expression, e.g. "0 3 * * *" for 03:00 daily'),
      retention: z.number().int().min(1).max(365).optional().describe('How many backups to keep'),
      destinationId: z.string().optional().describe('"local" or a destination id from settings'),
    })
    .nullable()
    .optional()
    .describe('Scheduled backups of the service data (databases are dumped, other volumes archived)'),
  external: z.string().optional().describe('New address of an external route (owner only)'),
  udp: z.boolean().optional().describe('External TCP routes: also forward UDP on the proxy port'),
  redirect: z.string().optional().describe('Redirects: new target URL'),
  redirectCode: z.number().int().optional(),
  keepPath: z.boolean().optional(),
  ports: z
    .array(z.object({ container: z.number().int().min(1).max(65535), host: z.number().int().min(1).max(65535), protocol: z.enum(['tcp', 'udp']), hostIp: z.string().nullable().optional() }))
    .optional()
    .describe('Publish container ports straight on the server, TCP or UDP (game servers, voice…). Owner only. Forces one replica.'),
  cluster: z
    .object({ failoverAfterSec: z.number().int().min(0).max(3600).optional(), synchronous: z.boolean().optional() })
    .optional()
    .describe('Database cluster settings: failoverAfterSec (0 = manual only), synchronous replication. Use switchover to change the primary.'),
  schedule: z.string().nullable().optional().describe('Cron expression (e.g. "*/15 * * * *", "@daily"). Turns the service into a scheduled job; null to clear.'),
  x: z.number().optional(),
  y: z.number().optional(),
});
export type UpdateServiceInput = z.infer<typeof updateServiceInput>;

export async function updateService(actor: Actor, serviceId: string, raw: UpdateServiceInput, opts: { quiet?: boolean } = {}) {
  const patch = updateServiceInput.parse(raw);
  const svc = getServiceOrThrow(serviceId);
  const changes: string[] = [];
  const set = <K extends keyof Service>(k: K, v: Service[K], label: string = k) => {
    if (JSON.stringify(svc[k]) !== JSON.stringify(v)) {
      svc[k] = v;
      changes.push(label);
    }
  };
  if (svc.source.type === 'redirect') {
    if (patch.redirect !== undefined || patch.redirectCode !== undefined || patch.keepPath !== undefined) {
      const cur = svc.source;
      set('source', parseRedirect(patch.redirect ?? cur.to, patch.redirectCode ?? cur.code, patch.keepPath ?? cur.keepPath), 'redirect');
    }
    if (patch.protocol && patch.protocol !== 'http') throw new HttpError(400, 'a redirect answers HTTP');
  } else if (patch.redirect !== undefined) throw new HttpError(400, 'create a new redirect service instead');
  if (isRoute(svc)) {
    if ((patch.replicas !== undefined && patch.replicas !== 1) || patch.volumes?.length || patch.ports?.length || patch.autoscale?.enabled || patch.image || patch.repo || patch.path)
      throw new HttpError(400, `${svc.name} is a route to another machine: no replicas, volumes, ports or builds`);
    if (svc.source.type === 'external' && (patch.external !== undefined || patch.udp !== undefined)) {
      requireOwner(actor, 'External routes');
      const udp = patch.udp ?? svc.source.udp ?? false;
      const proto = patch.protocol ?? svc.protocol;
      if (udp && proto !== 'tcp') throw new HttpError(400, 'UDP forwarding needs a TCP route');
      set('source', { type: 'external', ...parseExternalUrl(patch.external ?? svc.source.url, proto), ...(udp ? { udp: true } : {}) }, 'address');
    }
  } else if (patch.external !== undefined) throw new HttpError(400, 'only a route can change its address; create a new external service instead');
  if (patch.name !== undefined) set('name', patch.name.trim(), 'name');
  if (patch.icon !== undefined) set('icon', patch.icon);
  if (patch.image !== undefined) set('source', { type: 'image', image: patch.image.trim() }, 'source');
  if (patch.repo !== undefined || (svc.source.type === 'git' && (patch.branch !== undefined || patch.rootDir !== undefined || patch.dockerfile !== undefined || patch.token !== undefined))) {
    const prev = svc.source.type === 'git' ? svc.source : null;
    set(
      'source',
      {
        type: 'git',
        repo: patch.repo ? normalizeRepo(patch.repo) : prev?.repo ?? '',
        branch: (patch.branch ?? prev?.branch) || undefined,
        rootDir: (patch.rootDir ?? prev?.rootDir) || undefined,
        dockerfile: (patch.dockerfile ?? prev?.dockerfile) || undefined,
        token: patch.token === '••••••••' ? prev?.token : (patch.token ?? prev?.token) || undefined,
      },
      'source',
    );
  }
  if (patch.path !== undefined) set('source', { type: 'local', path: patch.path.trim(), dockerfile: patch.dockerfile || undefined }, 'source');
  if (patch.port !== undefined) set('port', patch.port, 'port');
  if (patch.protocol !== undefined) {
    set('protocol', patch.protocol, 'protocol');
    if (patch.protocol === 'tcp' && !svc.publicTcpPort && patch.publicTcpPort === undefined) svc.publicTcpPort = await allocateTcpPort();
    if (patch.protocol === 'http' && patch.publicHttp === undefined) svc.publicHttp = true;
  }
  if (patch.volumes !== undefined) {
    patch.volumes = checkMounts(actor, svc, patch.volumes);
    // Removing a mount here would leave its data mounted until the next deploy; detaching is explicit.
    const keep = new Set(patch.volumes.map((v) => v.volumeId).filter(Boolean));
    const dropped = svc.volumes.filter((v) => v.volumeId && !v.borrowed && !keep.has(v.volumeId));
    if (dropped.length) throw new HttpError(400, `detach ${dropped.map((d) => d.name).join(', ')} instead (detach_volume / the volume's menu) — its data is kept`);
    for (const v of patch.volumes) if (!v.volumeId && svc.volumes.some((x) => x.mountPath === v.mountPath)) throw new HttpError(409, `${v.mountPath} is already in use`);
    set('volumes', patch.volumes.map((v) => ({ ...v, name: v.volumeId ? svc.volumes.find((x) => x.volumeId === v.volumeId)?.name ?? v.name : v.name })), 'volumes');
  }
  if (patch.replicas !== undefined) {
    const tpl = svc.templateId ? getTemplate(svc.templateId) : null;
    const deployedShared = svc.activeDeploymentId ? hasSharedVolume(deploymentsTable.get(svc.activeDeploymentId)?.config.volumes) : false;
    if (patch.replicas > 1 && (svc.ports?.length || patch.ports?.length)) throw new HttpError(400, `${svc.name} publishes ports on the server; two replicas can't hold the same port. Services with published ports run as one replica.`);
    if (patch.replicas > 1 && (hasSharedVolume(svc.volumes) || deployedShared || tpl?.singleton)) {
      throw new HttpError(400, `${svc.name} has a persistent volume; replicas would corrupt its data. Stateful services run as a single replica.`);
    }
    if (svc.cluster && patch.replicas <= svc.cluster.primary) throw new HttpError(400, `the primary is replica #${svc.cluster.primary} — switch the primary to a lower replica before scaling below ${svc.cluster.primary + 1}`);
    if (svc.cluster && patch.replicas < 1) throw new HttpError(400, 'a cluster needs at least one replica (stop it instead)');
    set('replicas', patch.replicas, 'replicas');
  }
  if (patch.strategy !== undefined) set('strategy', patch.strategy, 'load balancing');
  if (patch.healthcheck) set('healthcheck', { ...svc.healthcheck, ...patch.healthcheck, path: patch.healthcheck.path === undefined ? svc.healthcheck.path : patch.healthcheck.path || null }, 'health check');
  if (patch.autoscale) {
    const a = { ...svc.autoscale, ...patch.autoscale };
    if (a.max < a.min) a.max = a.min;
    if (a.enabled && svc.volumes.length) throw new HttpError(400, 'autoscaling is not available for services with volumes');
    if (a.enabled && svc.ports?.length) throw new HttpError(400, 'autoscaling is not available for services with published ports (they run as one replica)');
    set('autoscale', a, 'autoscaling');
  }
  if (patch.publicHttp !== undefined) set('publicHttp', patch.publicHttp, 'public networking');
  if (patch.domains !== undefined) {
    const clean = [...new Set(patch.domains.map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean))];
    for (const d of clean) {
      const clash = servicesTable.all().find((s) => s.id !== svc.id && s.domains.includes(d));
      if (clash) throw new HttpError(409, `domain ${d} is already used by ${clash.name}`);
    }
    set('domains', clean, 'domains');
  }
  if (patch.publicTcpPort === 0) patch.publicTcpPort = svc.publicTcpPort ?? (await allocateTcpPort());
  if (patch.publicTcpPort !== undefined && patch.publicTcpPort !== null && patch.publicTcpPort < 1024) throw new HttpError(400, 'TCP proxy ports must be 1024 or higher');
  if (patch.publicTcpPort !== undefined) {
    if (patch.publicTcpPort !== null) {
      if (tcpPortInUse(patch.publicTcpPort, svc.id)) throw new HttpError(409, `port ${patch.publicTcpPort} is already in use`);
      if (patch.publicTcpPort !== svc.publicTcpPort && !(await portFree(patch.publicTcpPort))) throw new HttpError(409, `port ${patch.publicTcpPort} is busy on this machine`);
    }
    set('publicTcpPort', patch.publicTcpPort, 'TCP proxy');
  }
  if (patch.startCommand !== undefined) set('startCommand', patch.startCommand?.trim() || null, 'start command');
  if (patch.cmd !== undefined) set('cmd', patch.cmd?.length ? patch.cmd : null, 'command');
  if (patch.entrypoint !== undefined) set('entrypoint', patch.entrypoint?.length ? patch.entrypoint : null, 'entrypoint');
  if (patch.buildCommand !== undefined) set('buildCommand', patch.buildCommand?.trim() || null, 'build command');
  if (patch.buildArgs !== undefined) set('buildArgs', patch.buildArgs && Object.keys(patch.buildArgs).length ? patch.buildArgs : null, 'build arguments');
  if (patch.buildTarget !== undefined) set('buildTarget', patch.buildTarget?.trim() || null, 'build target');
  if (patch.sleepAfterMinutes !== undefined) {
    if (patch.sleepAfterMinutes) {
      const why = cannotSleep({ ...svc, protocol: patch.protocol ?? svc.protocol });
      if (why) throw new HttpError(400, `${svc.name} can’t sleep: ${why}`);
    }
    set('sleepAfterMinutes', patch.sleepAfterMinutes || null, 'sleep when idle');
    if (!patch.sleepAfterMinutes && svc.sleeping) void wake(svc.id, 'sleeping being turned off');
  }
  if (patch.imageAutoUpdate !== undefined) set('imageAutoUpdate', patch.imageAutoUpdate, 'image auto-update');
  if (patch.accessLog !== undefined) set('accessLog', patch.accessLog, 'access log');
  if (patch.watchPaths !== undefined) set('watchPaths', patch.watchPaths?.map((p) => p.trim()).filter(Boolean).length ? patch.watchPaths.map((p) => p.trim()).filter(Boolean) : null, 'watch paths');
  if (patch.preDeployCommand !== undefined) set('preDeployCommand', patch.preDeployCommand?.trim() || null, 'pre-deploy command');
  if (patch.resources) set('resources', { ...svc.resources, ...patch.resources } as Service['resources'], 'resources');
  if (patch.autoDeploy !== undefined) set('autoDeploy', patch.autoDeploy, 'auto-deploy');
  if (patch.secretKeys !== undefined) set('secretKeys', patch.secretKeys, 'secrets');
  if (patch.backup !== undefined) {
    if (patch.backup === null) set('backup', null, 'backups');
    else {
      const b = { enabled: false, schedule: '0 3 * * *', retention: 7, destinationId: 'local', ...(svc.backup ?? {}), ...patch.backup };
      const err = validateCron(b.schedule);
      if (err) throw new HttpError(400, `invalid backup schedule: ${err}`);
      if (!destinationById(b.destinationId)) throw new HttpError(400, `unknown backup destination: ${b.destinationId}`);
      set('backup', b, 'backups');
    }
  }
  if (patch.cluster !== undefined) {
    if (!svc.cluster) throw new HttpError(400, `${svc.name} is not a database cluster`);
    set('cluster', { ...svc.cluster, ...patch.cluster }, 'cluster settings');
  }
  if (patch.ports !== undefined) {
    const next = await checkPorts(actor, svc, patch.ports);
    set('ports', next.length ? next : undefined, 'published ports');
  }
  if (patch.schedule !== undefined) {
    const sched = patch.schedule?.trim() || null;
    if (sched) {
      // Only validated here; it takes effect (replacing replicas with scheduled runs) on the next deploy.
      const err = validateCron(sched);
      if (err) throw new HttpError(400, `invalid schedule: ${err}`);
    }
    set('schedule', sched, 'schedule');
  }
  const moved = patch.x !== undefined || patch.y !== undefined;
  if (patch.x !== undefined) svc.x = Math.round(patch.x);
  if (patch.y !== undefined) svc.y = Math.round(patch.y);
  if (!changes.length && !moved) return serializeService(svc);
  svc.updatedAt = Date.now();
  servicesTable.put(svc);
  if (changes.includes('volumes')) syncServiceVolumes(svc);
  bus.publish({ type: 'service.updated', service: svc });
  if (changes.length && !opts.quiet) {
    recordActivity(actor, 'service.updated', `Updated ${svc.name}: ${changes.join(', ')}`, svc.projectId, svc.id);
  }
  if (changes.includes('replicas') || changes.includes('schedule')) requestReconcile();
  return serializeService(svc);
}

function notExternal(svc: Service, what: string) {
  if (isRoute(svc)) throw new HttpError(400, `${svc.name} is ${svc.source.type === 'redirect' ? `a redirect to ${(svc.source as any).to}` : `a route to ${(svc.source as any).url}`} — there's nothing to ${what} here`);
}

/** Host folders, published ports and external routes reach outside the container sandbox: the owner decides. */
export function requireOwner(actor: Actor, what: string) {
  if (actor.type !== 'user') throw new HttpError(403, `${what} can only be set by the owner in the dashboard, not with an agent token`);
}

/**
 * Validate a service's mount list. Host folders: owner only, allowlisted, existing. Read-only shares can only be
 * kept (add them with share_volume). Throws on anything invalid.
 */
function checkMounts(actor: Actor, svc: Service, mounts: NonNullable<UpdateServiceInput['volumes']>) {
  return mounts.map((m) => {
    if (m.hostPath) {
      const had = svc.volumes.find((x) => x.hostPath === m.hostPath && x.mountPath === m.mountPath && (x.selinux ?? null) === (m.selinux ?? null) && !!x.readOnly === !!m.readOnly);
      if (!had) requireOwner(actor, 'Host folders');
      if (m.perReplica || m.volumeId || m.borrowed) throw new HttpError(400, 'a host folder is just a path: no volume, per-replica or share options');
      const hostPath = checkHostPath(m.hostPath, nodeOf(svc) === LOCAL);
      return { name: m.name, mountPath: m.mountPath, hostPath, ...(m.selinux ? { selinux: m.selinux } : {}), ...(m.readOnly ? { readOnly: true } : {}) };
    }
    if (m.borrowed) {
      const had = svc.volumes.find((x) => x.borrowed && x.volumeId === m.volumeId);
      if (!had) throw new HttpError(400, 'add read-only shares with share_volume (or the volume’s “Share read-only”)');
      return had;
    }
    if (m.selinux) throw new HttpError(400, 'SELinux relabelling only applies to host folders');
    return m;
  });
}

/** Published ports: owner only; no clashes with other services on that server or with Servify's own ports; free. */
async function checkPorts(actor: Actor, svc: Service, ports: NonNullable<UpdateServiceInput['ports']>) {
  const same = (a: { host: number; protocol: string; hostIp?: string | null }, b: { host: number; protocol: string; hostIp?: string | null }) => a.host === b.host && a.protocol === b.protocol;
  const had = svc.ports ?? [];
  const fresh = ports.filter((p) => !had.some((h) => same(h, p) && h.container === p.container && (h.hostIp ?? null) === (p.hostIp ?? null)));
  if (fresh.length) requireOwner(actor, 'Published ports');
  for (let i = 0; i < ports.length; i++) if (ports.slice(0, i).some((q) => same(q, ports[i]))) throw new HttpError(400, `${ports[i].host}/${ports[i].protocol} is listed twice`);
  if (ports.length && svc.replicas > 1) throw new HttpError(400, `scale ${svc.name} to one replica first: two replicas can't hold the same host port`);
  if (ports.length && svc.autoscale.enabled) throw new HttpError(400, 'turn autoscaling off first: services with published ports run as one replica');
  const node = nodeOf(svc);
  for (const p of fresh) {
    if (p.hostIp && !/^[0-9.]+$|^[0-9a-f:]+$/i.test(p.hostIp)) throw new HttpError(400, `${p.hostIp} is not an IP address`);
    const clash = servicesTable.all().find((o) => o.id !== svc.id && nodeOf(o) === node && (o.ports ?? []).some((q) => same(q, p)));
    if (clash) throw new HttpError(409, `${p.host}/${p.protocol} is already published by ${clash.name}`);
    if (node === LOCAL) {
      const own = [config.port, config.proxyPort, config.httpsPort, config.agentPort];
      // Its own TCP proxy may be on that port — fine if this same update turns it off (svc already holds the new value).
      if (p.protocol === 'tcp' && (own.includes(p.host) || tcpPortInUse(p.host, svc.id) || svc.publicTcpPort === p.host)) throw new HttpError(409, `${p.host} is used by Servify itself (dashboard, router or a TCP proxy)`);
      if (!(await hostPortFree(p.host, p.protocol, p.hostIp || '0.0.0.0'))) throw new HttpError(409, `${p.host}/${p.protocol} is busy on this machine`);
    }
  }
  return ports.map((p) => ({ container: p.container, host: p.host, protocol: p.protocol, ...(p.hostIp ? { hostIp: p.hostIp } : {}) }));
}

function hostPortFree(port: number, protocol: 'tcp' | 'udp', host: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (protocol === 'udp') {
      const s = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
      s.once('error', () => resolve(false));
      s.bind(port, host, () => s.close(() => resolve(true)));
      return;
    }
    const s = netMod.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

/** Imports: published ports only when the owner imports (a busy port shows up as a failed deploy). */
function portablePorts(actor: Actor, ports: Service['ports'], dropped: string[]) {
  if (!ports?.length) return undefined;
  if (actor.type !== 'user') {
    dropped.push(`published ports ${ports.map((p) => `${p.host}/${p.protocol}`).join(', ')} (owner only)`);
    return undefined;
  }
  return ports;
}

/** Imports and copies: keep host folders only for the owner and when still allowed; never carry shares over. */
function portableMounts(actor: Actor, nodeId: string | null | undefined, mounts: Service['volumes'], dropped: string[]) {
  return (mounts ?? []).filter((m) => {
    if (m.borrowed) {
      dropped.push(`read-only share ${m.mountPath}`);
      return false;
    }
    if (!m.hostPath) return true;
    try {
      requireOwner(actor, 'Host folders');
      m.hostPath = checkHostPath(m.hostPath, !nodeId || nodeId === LOCAL);
      return true;
    } catch (e) {
      dropped.push(`host folder ${m.hostPath} (${(e as Error).message})`);
      return false;
    }
  });
}

/** A server reference (id or name) → node id. */
export function resolveServer(ref: string | null | undefined): string {
  if (!ref || ref === LOCAL || /^this machine$/i.test(ref)) return LOCAL;
  const n = nodesTable.get(ref) ?? nodesTable.all().find((x) => x.name.toLowerCase() === ref.toLowerCase());
  assert(n, 404, `server not found: ${ref}`);
  return n.id;
}

/** Siblings this service references by variable that run on another server (reached through mesh relays). */
export function referencedServicesOn(s: Service): string[] {
  const siblings = servicesTable.all('WHERE project_id = ?', s.projectId);
  return referencedServices(s, siblings)
    .map((sid) => siblings.find((x) => x.id === sid))
    .filter((x): x is Service => !!x && nodeOf(x) !== nodeOf(s))
    .map((x) => x.name);
}

/** Run a service on another server: redeploy there (zero downtime for stateless services), then retire the old replicas. */
export async function moveService(actor: Actor, serviceId: string, serverRef: string) {
  const svc = getServiceOrThrow(serviceId);
  notExternal(svc, 'move');
  const target = resolveServer(serverRef);
  const from = nodeOf(svc);
  if (target === from) return serializeService(svc);
  assert(!svc.volumes.length, 409, `${svc.name} has volumes, and data can't move between servers — back it up, detach the volumes, then move it (or restore the backup on the new server)`);
  assert(isOnline(target), 409, `${nodeName(target)} is offline`);
  svc.nodeId = target === LOCAL ? null : target;
  svc.updatedAt = Date.now();
  servicesTable.put(svc);
  bus.publish({ type: 'service.updated', service: svc });
  recordActivity(actor, 'service.moved', `Moved ${svc.name} from ${nodeName(from)} to ${nodeName(target)}`, svc.projectId, svc.id);
  const active = svc.activeDeploymentId ? deploymentsTable.get(svc.activeDeploymentId) : null;
  if (active?.image && !svc.stopped) queueDeployment(svc, 'config', actor, { image: active.image, port: active.port, fromDeployment: active });
  else requestReconcile();
  return serializeService(servicesTable.get(svc.id)!);
}

export async function scaleService(actor: Actor, serviceId: string, replicas: number) {
  const svc = getServiceOrThrow(serviceId);
  const before = svc.replicas;
  const out = await updateService(actor, svc.id, { replicas }, { quiet: true });
  if (before !== replicas) recordActivity(actor, 'service.scaled', `Scaled ${svc.name} ${before} → ${replicas}`, svc.projectId, svc.id);
  return out;
}

export function deployService(actor: Actor, serviceId: string, trigger: 'manual' | 'agent' | 'git' | 'config' = actor.type === 'agent' ? 'agent' : 'manual') {
  const svc = getServiceOrThrow(serviceId);
  notExternal(svc, 'deploy');
  if (svc.stopped) {
    svc.stopped = false;
    servicesTable.put(svc);
  }
  return serializeDeployment(queueDeployment(svc, trigger, actor));
}

/**
 * Update an image service: pull its image again (a new image under the same tag) or switch to another tag first,
 * then deploy. Unlike a normal deploy, a failed pull fails the deployment instead of falling back to the cache.
 */
export async function updateServiceImage(actor: Actor, serviceId: string, tag?: string | null) {
  const svc = getServiceOrThrow(serviceId);
  notExternal(svc, 'update');
  if (svc.source.type !== 'image') throw new HttpError(400, `${svc.name} doesn't run a registry image`);
  if (tag) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) throw new HttpError(400, 'not a valid tag');
    // A newer version may upgrade the data in place, after which the old image may not start on it: back up first.
    if (backupMethod(svc)) {
      const b = await backupService(svc, actor.type === 'agent' ? 'agent' : 'manual', actor);
      if (b.status !== 'succeeded') throw new HttpError(409, `the safety backup ${b.status}${b.error ? ` (${b.error})` : ''} — ${svc.name} was not switched`);
    }
    const [image] = splitImageRef(normalizeImageRef(svc.source.image));
    await updateService(actor, svc.id, { image: `${image}:${tag}` }, { quiet: true });
    recordActivity(actor, 'service.updated', `Updating ${svc.name} to ${image}:${tag}`, svc.projectId, svc.id);
  } else recordActivity(actor, 'service.updated', `Updating ${svc.name}: pulling ${svc.source.image} again`, svc.projectId, svc.id);
  const fresh = getServiceOrThrow(serviceId);
  if (fresh.stopped) {
    fresh.stopped = false;
    servicesTable.put(fresh);
  }
  return serializeDeployment(queueDeployment(fresh, 'update', actor));
}

/**
 * The variables a service gets to use another one: the template's connection variables (DATABASE_URL for Postgres,
 * AMQP_URL for RabbitMQ…), else the provider's own *_URL variables. Names the consumer already uses get the
 * provider's name as a prefix (POSTGRES_DATABASE_URL), so nothing is overwritten.
 */
export function connectionVariables(provider: Service, consumerEnv: Record<string, string>): Record<string, string> {
  const tpl = provider.templateId ? getTemplate(provider.templateId) : null;
  const ref = (k: string) => `\${{ ${provider.slug}.${k} }}`;
  const pairs: [string, string][] = tpl?.connect
    ? Object.entries(tpl.connect).map(([k, v]) => [k, v.includes('${{') ? v.replaceAll('{svc}', provider.slug) : ref(v)])
    : Object.keys(provider.env)
        .filter((k) => /_URL$/.test(k) && !/PUBLIC/.test(k))
        .map((k) => [k, ref(k)]);
  const prefix = provider.slug.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  if (!pairs.length) pairs.push([`${prefix}_HOST`, ref('SERVIFY_PRIVATE_DOMAIN')]); // nothing better known: its private name
  const out: Record<string, string> = {};
  for (const [k, v] of pairs) out[k in consumerEnv && consumerEnv[k] !== v ? `${prefix}_${k}` : k] = v;
  return out;
}

/**
 * Create a service from a template next to an app and connect the app to it (a drop of the app's ⊕ on empty canvas):
 * the app gets the connection variables, and once the new service runs the app is redeployed to pick them up.
 */
export async function addAndConnect(actor: Actor, fromId: string, raw: { templateId?: string; x?: number; y?: number }) {
  const from = getServiceOrThrow(fromId);
  const tpl = raw.templateId ? getTemplate(raw.templateId) : null;
  assert(tpl?.connect, 400, 'pick a template that apps can connect to (a database, cache, queue or storage)');
  assert(from.source.type !== 'external' && from.source.type !== 'redirect', 400, `${from.name} doesn't run anything that could use it`);
  const made = await createService(actor, from.projectId, { templateId: tpl!.id, x: raw.x, y: raw.y });
  const provider = servicesTable.get(made.service.id)!;
  const vars = connectionVariables(provider, getServiceOrThrow(from.id).env);
  setVariables(actor, from.id, vars);
  const redeploy = !!from.activeDeploymentId && !from.stopped;
  if (redeploy) {
    // Deploy the app once the new service is up, so it doesn't start against a database that isn't there yet.
    const done = (why?: string) => {
      off();
      clearTimeout(timer);
      if (why) {
        recordActivity(actor, 'service.updated', `${provider.name} isn't running (${why}): deploy ${from.name} yourself to use it`, from.projectId, from.id);
        return;
      }
      const fresh = servicesTable.get(from.id);
      if (fresh && !fresh.stopped) queueDeployment(fresh, 'config', actor);
    };
    const off = bus.subscribe((ev) => {
      if (ev.type === 'service.updated' && ev.service.id === provider.id) {
        if (ev.service.status === 'running') done();
        else if (ev.service.status === 'failed' || ev.service.status === 'crashed') done(ev.service.status);
      }
    });
    const timer = setTimeout(() => done('it took longer than 10 minutes'), 10 * 60_000);
    timer.unref?.();
  }
  recordActivity(actor, 'service.updated', `Added ${provider.name} and connected ${from.name} to it (${Object.keys(vars).join(', ')})`, from.projectId, from.id);
  return { service: serializeService(provider), deployment: made.deployment, variables: vars, redeploys: redeploy };
}

/**
 * Point a service at a registry image without redeploying: for a copy that runs under a local name (a pinned or
 * migrated image), so update checks can follow the registry. Allowed only when the running image provably came from
 * that repository (Docker recorded its digest when it was pulled) and the tag resolves to exactly that image. With
 * `allowMoved`, also the tag it was pulled as after it moved on (the check then reports the newer image) — careful
 * with `:latest`: a normal deploy pulls it again. Nothing restarts: the containers keep running the local copy.
 */
export async function trackServiceImage(actor: Actor, serviceId: string, image: string, opts: { allowMoved?: boolean } = {}) {
  const svc = getServiceOrThrow(serviceId);
  if (svc.source.type !== 'image') throw new HttpError(400, `${svc.name} doesn't run an image`);
  const ref = normalizeImageRef(String(image ?? ''));
  const r = parseRepo(ref);
  if (!r) throw new HttpError(400, 'give the image as repository:tag');
  const dep = svc.activeDeploymentId ? deploymentsTable.get(svc.activeDeploymentId) : null;
  if (!dep?.image) throw new HttpError(409, `${svc.name} has no running deployment to compare with`);
  const info = await dockerFor(nodeOf(svc))
    .inspectImage(dep.image)
    .catch(() => null);
  if (!info) throw new HttpError(409, `the running image (${dep.image}) is no longer on the server`);
  const recorded: string[] = [...new Set([...(dep.repoDigests ?? []), ...((info.RepoDigests as string[] | undefined) ?? [])])];
  const digests = recorded.filter((d) => sameRepo(d.split('@')[0], r));
  if (!digests.length) throw new HttpError(409, `the running image wasn't pulled from ${r.registry === 'docker.io' ? r.repo.replace(/^library\//, '') : `${r.registry}/${r.repo}`}`);
  const remote = await remoteDigestOf(r);
  const same = !('error' in remote) && digests.some((d) => d.endsWith(`@${remote.digest}`));
  const pulledAs = ((info.RepoTags as string[] | undefined) ?? []).some((t) => {
    const tr = parseRepo(t);
    return !!tr && tr.registry === r.registry && tr.repo === r.repo && tr.tag === r.tag;
  });
  if (!same && !(opts.allowMoved && pulledAs)) {
    if ('error' in remote) throw new HttpError(409, `couldn't check ${ref}: ${remote.error}`);
    throw new HttpError(409, pulledAs ? `${ref} has moved on since ${svc.name}'s image was pulled (pass allowMoved to track it anyway)` : `${ref} is a different image from the one ${svc.name} runs`);
  }
  const before = svc.source.image;
  svc.source = { type: 'image', image: ref };
  svc.updatedAt = Date.now();
  servicesTable.put(svc);
  // The running deployment now names the same image, so this isn't a pending change.
  dep.config = { ...dep.config, source: { type: 'image', image: ref } };
  dep.repoDigests = [...new Set([...(dep.repoDigests ?? []), ...digests])];
  dep.sourceLabel = ref;
  deploymentsTable.put(dep);
  recordActivity(actor, 'service.updated', `${svc.name} now follows ${ref} (was ${before}; ${same ? 'the same image' : 'pulled under that tag'}, nothing restarted)`, svc.projectId, svc.id);
  bus.publish({ type: 'service.updated', service: svc });
  const update = await checkService(svc.id).catch(() => null);
  return { service: serializeService(svc), sameImage: same, imageUpdate: update };
}

export async function checkServiceImage(serviceId: string) {
  const svc = getServiceOrThrow(serviceId);
  if (svc.source.type !== 'image') throw new HttpError(400, `${svc.name} doesn't run a registry image`);
  return checkService(svc.id);
}

/** Zero-downtime restart: roll the current image onto fresh replicas. */
/**
 * Move a service to another project: its volumes, deploy history and backups go with it, and its containers are
 * recreated on the new project's private network. Refused when the move would break something (references either
 * way, shared volumes, a cluster, a name already taken there).
 */
export function moveServiceToProject(actor: Actor, serviceId: string, targetRef: string) {
  const svc = getServiceOrThrow(serviceId);
  const target = getProjectOrThrow(targetRef);
  if (target.id === svc.projectId) return serializeService(svc);
  const from = getProjectOrThrow(svc.projectId);
  assert(!svc.cluster, 409, `${svc.name} is a database cluster — clusters stay in their project`);
  assert(!svc.volumes.some((m) => m.borrowed), 409, `${svc.name} reads another service's volume — remove that share first`);
  const siblings = servicesTable.all('WHERE project_id = ?', svc.projectId);
  const usedBy = siblings.filter((s) => s.id !== svc.id && referencedServices(s, siblings).includes(svc.id));
  assert(!usedBy.length, 409, `${usedBy.map((s) => s.name).join(', ')} use${usedBy.length === 1 ? 's' : ''} ${svc.name}'s variables (\${{${svc.slug}.…}}) — that would break after the move; change those references first`);
  const uses = referencedServices(svc, siblings).map((id) => siblings.find((s) => s.id === id)?.name ?? id);
  assert(!uses.length, 409, `${svc.name} uses variables of ${uses.join(', ')}, which stay in ${from.name} — change those references first`);
  const vols = volumesTable.all('WHERE project_id = ?', from.id).filter((v) => v.serviceId === svc.id);
  const shared = vols.flatMap((v) => borrowersOf(v).filter((s) => s.id !== svc.id).map((s) => s.name));
  assert(!shared.length, 409, `${shared.join(', ')} read${shared.length === 1 ? 's' : ''} ${svc.name}'s volume — remove that share first`);
  const taken = servicesTable.all('WHERE project_id = ?', target.id).find((s) => s.slug === svc.slug || s.name.toLowerCase() === svc.name.toLowerCase());
  assert(!taken, 409, `${target.name} already has a service called ${taken?.name} — rename one of them first`);

  for (const v of vols) volumesTable.put({ ...v, projectId: target.id, updatedAt: Date.now() });
  for (const d of deploymentsTable.all('WHERE service_id = ?', svc.id)) deploymentsTable.put({ ...d, projectId: target.id });
  for (const b of backupsTable.all('WHERE service_id = ?', svc.id)) backupsTable.put({ ...b, projectId: target.id });
  const pos = placeNear(target.id, 0, 0);
  const moved: Service = { ...svc, projectId: target.id, x: pos.x, y: pos.y, updatedAt: Date.now() };
  servicesTable.put(moved);
  bus.publish({ type: 'service.deleted', serviceId: svc.id, projectId: from.id });
  bus.publish({ type: 'service.updated', service: moved });
  recordActivity(actor, 'service.moved', `Moved ${svc.name} from ${from.name} to ${target.name}`, target.id, svc.id);
  recordActivity(actor, 'service.moved', `Moved ${svc.name} to ${target.name}`, from.id, null);
  // Containers live on their project's network: recreate them there (the image is unchanged, no pre-deploy).
  if (!isRoute(moved) && moved.activeDeploymentId && !moved.stopped) restartService(actor, moved.id);
  return serializeService(moved);
}

export function restartService(actor: Actor, serviceId: string) {
  const svc = getServiceOrThrow(serviceId);
  notExternal(svc, 'restart');
  const active = svc.activeDeploymentId ? deploymentsTable.get(svc.activeDeploymentId) : null;
  if (!active?.image) return deployService(actor, serviceId);
  return serializeDeployment(queueDeployment(svc, 'restart', actor, { image: active.image, port: active.port, fromDeployment: active }));
}

export function rollbackService(actor: Actor, serviceId: string, deploymentId: string) {
  notExternal(getServiceOrThrow(serviceId), 'roll back');
  const svc = getServiceOrThrow(serviceId);
  const target = deploymentsTable.get(deploymentId);
  assert(target && target.serviceId === svc.id, 404, 'deployment not found for this service');
  assert(target.image, 400, 'that deployment has no image to roll back to');
  return serializeDeployment(queueDeployment(svc, 'rollback', actor, { image: target.image, port: target.port, fromDeployment: target }));
}

export function cancelDeployment(actor: Actor, deploymentId: string) {
  const d = deploymentsTable.get(deploymentId);
  assert(d, 404, 'deployment not found');
  assert(d.status === 'queued', 400, 'only queued deployments can be cancelled');
  d.status = 'cancelled';
  d.finishedAt = Date.now();
  deploymentsTable.put(d);
  bus.publish({ type: 'deployment.updated', deployment: d });
  recordActivity(actor, 'deployment.cancelled', `Cancelled a queued deploy`, d.projectId, d.serviceId);
  return serializeDeployment(d);
}

export async function stopService(actor: Actor, serviceId: string) {
  const svc = getServiceOrThrow(serviceId);
  svc.stopped = true;
  svc.sleeping = false;
  svc.status = 'stopped';
  svc.updatedAt = Date.now();
  servicesTable.put(svc);
  bus.publish({ type: 'service.updated', service: svc });
  recordActivity(actor, 'service.stopped', `Stopped ${svc.name}`, svc.projectId, svc.id);
  const cids = replicasOf(svc.id).map((r) => r.containerId);
  await drainAndRemove(cids, 3000);
  await killJobs(svc.id);
  return serializeService(svc);
}

export function startService(actor: Actor, serviceId: string) {
  const svc = getServiceOrThrow(serviceId);
  svc.stopped = false;
  svc.sleeping = false;
  if (isRoute(svc)) {
    svc.status = svc.source.type === 'redirect' ? 'running' : 'deploying';
    servicesTable.put(svc);
    bus.publish({ type: 'service.updated', service: svc });
    recordActivity(actor, 'service.started', `Routing to ${svc.name} again`, svc.projectId, svc.id);
    return { service: serializeService(svc), deployment: null };
  }
  if (!svc.activeDeploymentId) return { service: serializeService(svc), deployment: deployService(actor, svc.id) };
  const active = deploymentsTable.get(svc.activeDeploymentId);
  if (active && (active.nodeId ?? null) !== (svc.nodeId ?? null)) {
    // Moved while stopped: roll the same version out on the new server (its image may need copying there).
    servicesTable.put(svc);
    recordActivity(actor, 'service.started', `Started ${svc.name} on ${nodeName(nodeOf(svc))}`, svc.projectId, svc.id);
    return { service: serializeService(svc), deployment: restartService(actor, svc.id) };
  }
  svc.status = 'deploying';
  svc.updatedAt = Date.now();
  servicesTable.put(svc);
  bus.publish({ type: 'service.updated', service: svc });
  recordActivity(actor, 'service.started', `Started ${svc.name}`, svc.projectId, svc.id);
  requestReconcile();
  return { service: serializeService(svc), deployment: null };
}

export async function deleteService(actor: Actor, serviceId: string, opts: { quiet?: boolean; keepVolumes?: boolean } = {}) {
  const svc = getServiceOrThrow(serviceId);
  assert(isOnline(nodeOf(svc)), 409, `${svc.name} runs on ${nodeName(nodeOf(svc))}, which is offline — bring it back online before deleting`);
  servicesTable.delete(svc.id);
  removeUploads(svc.id);
  bus.publish({ type: 'service.deleted', serviceId: svc.id, projectId: svc.projectId });
  if (!opts.quiet) recordActivity(actor, 'service.deleted', `Deleted ${svc.name}`, svc.projectId, null);
  const cids = replicasOf(svc.id).map((r) => r.containerId);
  await drainAndRemove(cids, 1000);
  // Remove any stragglers by label, then volumes and built images.
  for (const n of onlineNodes()) {
    const d = dockerFor(n);
    const left = await d.listContainers([`servify.service=${svc.id}`]).catch(() => []); // service ids are globally unique
    await Promise.all(left.map((c) => d.removeContainer(c.Id, true)));
  }
  await releaseServiceVolumes(svc, !!opts.keepVolumes);
  for (const d of deploymentsTable.all('WHERE service_id = ?', svc.id)) {
    if (d.image?.startsWith('servify/') && isOnline(nodeOf(svc))) await dockerFor(nodeOf(svc)).removeImage(d.image);
    deploymentsTable.delete(d.id);
  }
}

// ───────────────────────────── variables ─────────────────────────────

export function setVariables(actor: Actor, serviceId: string, vars: Record<string, string>, opts: { replace?: boolean; secretKeys?: string[] } = {}) {
  const svc = getServiceOrThrow(serviceId);
  for (const k of Object.keys(vars)) assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(k), 400, `invalid variable name: ${k}`);
  const next = opts.replace ? { ...vars } : { ...svc.env, ...vars };
  // Masked values coming back from a read-only view must not overwrite real secrets.
  for (const [k, v] of Object.entries(next)) if (v === '••••••••' && k in svc.env) next[k] = svc.env[k];
  svc.env = next;
  if (opts.secretKeys) svc.secretKeys = [...new Set(opts.secretKeys)];
  svc.secretKeys = svc.secretKeys.filter((k) => k in svc.env);
  svc.updatedAt = Date.now();
  servicesTable.put(svc);
  bus.publish({ type: 'service.updated', service: svc });
  recordActivity(actor, 'variables.updated', `Updated variables on ${svc.name}: ${Object.keys(vars).slice(0, 6).join(', ') || '(cleared)'}`, svc.projectId, svc.id);
  return serializeService(svc);
}

export function deleteVariable(actor: Actor, serviceId: string, key: string) {
  const svc = getServiceOrThrow(serviceId);
  delete svc.env[key];
  svc.secretKeys = svc.secretKeys.filter((k) => k !== key);
  svc.updatedAt = Date.now();
  servicesTable.put(svc);
  bus.publish({ type: 'service.updated', service: svc });
  recordActivity(actor, 'variables.deleted', `Removed ${key} from ${svc.name}`, svc.projectId, svc.id);
  return serializeService(svc);
}

export function previewVariables(serviceId: string) {
  const svc = getServiceOrThrow(serviceId);
  const project = getProjectOrThrow(svc.projectId);
  const siblings = servicesTable.all('WHERE project_id = ?', svc.projectId);
  const active = svc.activeDeploymentId ? deploymentsTable.get(svc.activeDeploymentId) : null;
  return resolveEnv(svc, svc.env, project, siblings, svc.port ?? active?.port ?? null);
}

// ───────────────────────────── logs, exec, metrics ─────────────────────────────

export type { LogLine } from './logstore.ts';

/** Runtime logs from the persistent store: survive redeploys, scaling and restarts. */
export async function serviceLogs(
  serviceId: string,
  opts: { tail?: number; since?: number; until?: number; search?: string; deploymentId?: string } = {},
): Promise<LogLine[]> {
  const svc = getServiceOrThrow(serviceId);
  return queryLogs(svc.id, opts);
}

/** Follow logs of every replica, including ones that appear later. Returns a stop function. */
export function followServiceLogs(serviceId: string, onLine: (l: LogLine) => void): () => void {
  return subscribeLogs(serviceId, onLine);
}

export async function execInService(actor: Actor, serviceId: string, command: string, replica?: number) {
  const svc = getServiceOrThrow(serviceId);
  const reps = replicasOf(svc.id).filter((r) => r.dockerState === 'running' && r.deploymentId === svc.activeDeploymentId);
  const target = replica !== undefined ? reps.find((r) => r.index === replica) : reps[0];
  assert(target, 400, `${svc.name} has no running replica${replica !== undefined ? ` #${replica}` : ''}`);
  recordActivity(actor, 'service.exec', `Ran \`${command.slice(0, 80)}\` in ${svc.name}#${target.index}`, svc.projectId, svc.id);
  // Long enough for migrations and one-off scripts; the deadline only stops a command that never exits.
  return dockerForContainer(target.containerId).exec(target.containerId, ['/bin/sh', '-c', command], 10 * 60_000);
}

export function serviceMetrics(serviceId: string, seconds = 300) {
  const svc = getServiceOrThrow(serviceId);
  return { serviceId: svc.id, points: metricsHistory(svc.id, seconds), replicas: replicasOf(svc.id) };
}

export function listDeployments(serviceId: string, limit = 30, view?: View) {
  const svc = getServiceOrThrow(serviceId);
  return deploymentsTable.all('WHERE service_id = ? ORDER BY created_at DESC LIMIT ?', svc.id, limit).map((d) => serializeDeployment(d, view));
}

export function deploymentLogs(deploymentId: string) {
  const d = deploymentsTable.get(deploymentId);
  assert(d, 404, 'deployment not found');
  return readDeploymentLog(d.id).map((l) => {
    const sp = l.indexOf(' ');
    return { ts: Number(l.slice(0, sp)), text: l.slice(sp + 1) };
  });
}

export function listActivity(opts: { projectId?: string; limit?: number } = {}) {
  const limit = Math.min(opts.limit ?? 100, 500);
  if (opts.projectId) return activityTable.all('WHERE project_id = ? ORDER BY created_at DESC LIMIT ?', opts.projectId, limit);
  return activityTable.all('ORDER BY created_at DESC LIMIT ?', limit);
}

export function listTemplates() {
  return templates;
}

export function serviceSummary(s: Service) {
  const project = projectsTable.get(s.projectId);
  const reps = replicasOf(s.id);
  return {
    id: s.id,
    name: s.name,
    project: project?.name,
    status: s.status,
    source: describeSource(s.source),
    replicas: { desired: effectiveReplicas(s), healthy: reps.filter((r) => r.state === 'healthy' && r.deploymentId === s.activeDeploymentId).length },
    url: project && s.protocol === 'http' && s.publicHttp ? publicUrl(s, project) : null,
    tcp: s.publicTcpPort ? `localhost:${s.publicTcpPort}` : null,
    deploying: isDeploying(s.id),
  };
}

// ───────────────────────────── demo & load test ─────────────────────────────

import { fileURLToPath } from 'node:url';
import { dirname, join as pjoin } from 'node:path';
import { cpSync, existsSync } from 'node:fs';
import httpMod from 'node:http';
import dgram from 'node:dgram';
import netMod from 'node:net';

/** Populate a project with a small, realistic stack so new users see everything working. */
export async function seedDemo(actor: Actor, projectId: string) {
  const project = getProjectOrThrow(projectId);
  const examples = pjoin(dirname(fileURLToPath(import.meta.url)), '../../examples/node-api');
  const created: string[] = [];
  const web = await createService(actor, project.id, { templateId: 'whoami', name: 'web', replicas: 3, x: 0, y: -40 });
  created.push(web.service.id);
  const redis = await createService(actor, project.id, { templateId: 'redis', x: 380, y: 200 });
  created.push(redis.service.id);
  if (existsSync(examples)) {
    const api = await createService(actor, project.id, { path: examples, name: 'api', replicas: 2, x: 0, y: 200, env: { REDIS_URL: '${{ redis.REDIS_URL }}' } });
    created.push(api.service.id);
    await updateService(actor, api.service.id, { healthcheck: { path: '/healthz' } }, { quiet: true });
  }
  const pg = await createService(actor, project.id, { templateId: 'postgres', x: 380, y: -40 });
  created.push(pg.service.id);
  recordActivity(actor, 'project.demo', `Seeded demo stack in ${project.name}`, project.id);
  return { services: created };
}

const loadTests = new Map<string, NodeJS.Timeout>();

/** Fire synthetic requests at a service through the edge router (to watch LB / autoscaling). */
export function loadTest(actor: Actor, serviceId: string, rps: number, seconds: number) {
  const svc = getServiceOrThrow(serviceId);
  const project = getProjectOrThrow(svc.projectId);
  assert(svc.protocol === 'http', 400, 'load tests are for HTTP services');
  rps = Math.max(1, Math.min(500, Math.round(rps)));
  seconds = Math.max(1, Math.min(300, Math.round(seconds)));
  const prev = loadTests.get(svc.id);
  if (prev) clearInterval(prev);
  const host = `${svc.slug}.${project.slug}.${config.baseDomain}`;
  const agent = new httpMod.Agent({ keepAlive: true, maxSockets: 64 });
  const end = Date.now() + seconds * 1000;
  const perTick = rps / 20;
  let carry = 0;
  const timer = setInterval(() => {
    if (Date.now() > end) {
      clearInterval(timer);
      loadTests.delete(svc.id);
      agent.destroy();
      return;
    }
    carry += perTick;
    while (carry >= 1) {
      carry -= 1;
      const req = httpMod.get({ host: '127.0.0.1', port: config.proxyPort, path: '/', headers: { host, 'user-agent': 'servify-loadtest' }, agent }, (res) => res.resume());
      req.on('error', () => {});
      req.setTimeout(5000, () => req.destroy());
    }
  }, 50);
  loadTests.set(svc.id, timer);
  recordActivity(actor, 'service.loadtest', `Load test on ${svc.name}: ${rps} req/s for ${seconds}s`, svc.projectId, svc.id);
  return { rps, seconds, until: end };
}

export function stopLoadTest(serviceId: string) {
  const t = loadTests.get(serviceId);
  if (t) clearInterval(t);
  loadTests.delete(serviceId);
  return { stopped: !!t };
}

/** Copy a service's configuration into a new service next to it (volumes get fresh, empty storage). */
export async function duplicateService(actor: Actor, serviceId: string) {
  const src = getServiceOrThrow(serviceId);
  const s = src.source;
  const input: CreateServiceInput = {
    name: `${src.name}-copy`,
    port: src.port ?? undefined,
    protocol: src.protocol,
    replicas: src.replicas,
    env: { ...src.env },
    startCommand: src.startCommand ?? undefined,
    buildCommand: src.buildCommand ?? undefined,
    ...placeNear(src.projectId, src.x, src.y),
    deploy: false,
  };
  if (s.type === 'image') input.image = s.image;
  else if (s.type === 'git') Object.assign(input, { repo: s.repo, branch: s.branch, rootDir: s.rootDir, dockerfile: s.dockerfile, token: s.token });
  else if (s.type === 'external') Object.assign(input, { external: s.url, udp: s.udp });
  else if (s.type === 'redirect') Object.assign(input, { redirect: s.to, redirectCode: s.code, keepPath: s.keepPath });
  else if (s.type === 'upload') input.upload = true;
  else Object.assign(input, { path: s.path, dockerfile: s.dockerfile });
  const r = await createService(actor, src.projectId, input);
  if (s.type === 'upload' && s.uploadId) copyUpload(src.id, r.service.id, s);
  await updateService(actor, r.service.id, { volumes: portableMounts(actor, src.nodeId, structuredClone(src.volumes), []).map(({ volumeId, ...v }) => v), healthcheck: src.healthcheck, strategy: src.strategy, secretKeys: src.secretKeys, resources: src.resources, schedule: src.schedule ?? null, cmd: src.cmd ?? null, entrypoint: src.entrypoint ?? null, buildArgs: src.buildArgs ?? null, buildTarget: src.buildTarget ?? null, watchPaths: src.watchPaths ?? null, preDeployCommand: src.preDeployCommand ?? null, imageAutoUpdate: src.imageAutoUpdate ?? false, accessLog: src.accessLog !== false, ...(src.sleepAfterMinutes ? { sleepAfterMinutes: src.sleepAfterMinutes } : {}) }, { quiet: true });
  const svc = servicesTable.get(r.service.id)!;
  if (src.templateId) {
    svc.templateId = src.templateId;
    svc.icon = src.icon;
    servicesTable.put(svc);
  }
  const deployment = deployService(actor, svc.id);
  return { service: serializeService(servicesTable.get(svc.id)!), deployment };
}

// ───────────────────────────── export / import (servify.json) ─────────────────────────────

export type ProjectSpec = {
  servify: 1;
  name: string;
  color?: string;
  services: Array<Partial<Service> & { name: string; source?: Source; server?: string }>;
};

const SPEC_KEYS = [
  'name', 'icon', 'templateId', 'source', 'protocol', 'port', 'replicas', 'strategy', 'healthcheck', 'autoscale',
  'publicHttp', 'domains', 'publicTcpPort', 'volumes', 'ports', 'env', 'secretKeys', 'startCommand', 'preDeployCommand', 'buildCommand', 'buildArgs', 'buildTarget', 'watchPaths', 'imageAutoUpdate', 'accessLog', 'sleepAfterMinutes', 'resources', 'autoDeploy', 'schedule', 'backup', 'aliases', 'cmd', 'entrypoint', 'cluster', 'x', 'y',
] as const;

export function exportProject(projectId: string, opts: { secrets?: boolean } = {}): ProjectSpec {
  const p = getProjectOrThrow(projectId);
  const svcs = servicesTable.all('WHERE project_id = ? ORDER BY created_at ASC', p.id);
  return {
    servify: 1,
    name: p.name,
    color: p.color,
    services: svcs.map((s) => {
      const out: any = {};
      for (const k of SPEC_KEYS) out[k] = structuredClone((s as any)[k]);
      out.volumes = (out.volumes ?? []).map(({ volumeId, ...v }: any) => v);
      // Which server it runs on (by name, so a spec stays readable); imports keep it when that server exists.
      if (s.nodeId) out.server = nodesTable.get(s.nodeId)?.name ?? s.nodeId;
      if (!opts.secrets) {
        for (const k of s.secretKeys) if (k in out.env && !/\$\{\{/.test(out.env[k])) out.env[k] = '';
        if (out.source?.type === 'git') delete out.source.token;
      }
      return out;
    }),
  };
}

export async function importProject(actor: Actor, spec: ProjectSpec, opts: { deploy?: boolean; name?: string } = {}) {
  assert(spec && spec.servify === 1 && Array.isArray(spec.services), 400, 'not a servify project spec (expected {"servify":1, "services":[…]})');
  const project = createProject(actor, { name: opts.name ?? spec.name ?? 'imported', color: spec.color });
  const tpls = new Map(templates.map((t) => [t.id, t]));
  const created: Service[] = [];
  const droppedMounts: string[] = [];
  for (const raw of spec.services) {
    const tpl = raw.templateId ? tpls.get(raw.templateId) : null;
    const src = raw.source ?? (tpl ? { type: 'image' as const, image: tpl.image } : undefined);
    assert(src && ['image', 'git', 'local', 'upload', 'external', 'redirect'].includes(src.type), 400, `service ${raw.name}: invalid source`);
    // Start from the template (all its variables, volumes, port…) when there is one; the spec overrides.
    const input: CreateServiceInput = { name: raw.name, deploy: false, x: raw.x, y: raw.y };
    if (tpl) input.templateId = tpl.id;
    else if (src.type === 'image') input.image = src.image;
    else if (src.type === 'git') Object.assign(input, { repo: src.repo, branch: src.branch, rootDir: src.rootDir, dockerfile: src.dockerfile, token: src.token });
    else if (src.type === 'external') Object.assign(input, { external: src.url, udp: src.udp });
    else if (src.type === 'redirect') Object.assign(input, { redirect: src.to, redirectCode: src.code, keepPath: src.keepPath });
    else if (src.type === 'upload') input.upload = true;
    else Object.assign(input, { path: src.path, dockerfile: src.dockerfile });
    if (raw.protocol) input.protocol = raw.protocol;
    if (raw.port) input.port = raw.port;
    // Same server as the original when it exists here (environments keep services together); otherwise this machine.
    const server = (raw as any).server as string | undefined;
    if (server && (nodesTable.get(server) || nodesTable.all().some((n) => n.name.toLowerCase() === server.toLowerCase()))) input.server = server;
    const r = await createService(actor, project.id, input);
    const svc = servicesTable.get(r.service.id)!;
    if (tpl && src.type === 'image' && src.image !== tpl.image) svc.source = { type: 'image', image: src.image };
    // Spec values win, except blanked secrets (exports strip them): keep the freshly generated ones.
    const env = { ...svc.env };
    for (const [k, v] of Object.entries(raw.env ?? {})) if (v !== '' || !(k in env)) env[k] = v;
    const def = <T,>(v: T | undefined | null, fallback: T): T => (v === undefined || v === null ? fallback : v);
    Object.assign(svc, {
      icon: def(raw.icon, svc.icon),
      replicas: tpl?.singleton ? 1 : def(raw.replicas, svc.replicas),
      strategy: def(raw.strategy, svc.strategy),
      healthcheck: { ...svc.healthcheck, ...(raw.healthcheck ?? {}) },
      autoscale: { ...svc.autoscale, ...(raw.autoscale ?? {}) },
      publicHttp: def(raw.publicHttp, svc.publicHttp),
      domains: [],
      volumes: portableMounts(actor, svc.nodeId, def(raw.volumes, svc.volumes), droppedMounts).map(({ volumeId, ...v }: any) => v),
      env,
      secretKeys: [...new Set([...svc.secretKeys, ...(raw.secretKeys ?? [])])],
      startCommand: raw.startCommand === undefined ? svc.startCommand : raw.startCommand,
      buildCommand: raw.buildCommand === undefined ? svc.buildCommand : raw.buildCommand,
      buildArgs: raw.buildArgs ?? null,
      buildTarget: raw.buildTarget ?? null,
      watchPaths: raw.watchPaths ?? null,
      imageAutoUpdate: raw.imageAutoUpdate ?? false,
      accessLog: raw.accessLog !== false,
      sleepAfterMinutes: raw.sleepAfterMinutes ?? null,
      preDeployCommand: raw.preDeployCommand ?? null,
      resources: { ...svc.resources, ...(raw.resources ?? {}) },
      autoDeploy: def(raw.autoDeploy, svc.autoDeploy),
      schedule: raw.schedule ?? null,
      backup: raw.backup ?? null,
      aliases: (raw.aliases ?? []).filter((a) => /^[a-z0-9]([a-z0-9_.-]*[a-z0-9])?$/.test(a)),
      cmd: raw.cmd ?? null,
      entrypoint: raw.entrypoint ?? null,
      ports: portablePorts(actor, raw.ports, droppedMounts),
      // A copy starts a fresh cluster: replica 0 initialises as the primary.
      cluster: raw.cluster ? { ...raw.cluster, primary: 0 } : svc.cluster ?? null,
    } satisfies Partial<Service>);
    if (svc.protocol === 'tcp' && !svc.publicTcpPort) svc.publicTcpPort = await allocateTcpPort();
    // Keep the template's fresh volume where the spec mounts the same path; drop the ones it doesn't use.
    const prevMounts = servicesTable.get(svc.id)!.volumes;
    svc.volumes = svc.volumes.map((v) => {
      const p = prevMounts.find((x) => x.mountPath === v.mountPath);
      return p ? { ...v, name: p.name, volumeId: p.volumeId } : v;
    });
    await releaseServiceVolumes({ ...svc, volumes: prevMounts.filter((m) => !svc.volumes.some((x) => x.volumeId === m.volumeId)) }, false);
    servicesTable.put(svc);
    syncServiceVolumes(svc);
    bus.publish({ type: 'service.updated', service: svc });
    created.push(svc);
  }
  if (opts.deploy !== false) for (const s of created) deployService(actor, s.id);
  recordActivity(actor, 'project.imported', `Imported ${created.length} services into ${project.name}${droppedMounts.length ? ` — left out: ${droppedMounts.join('; ')}` : ''}`, project.id);
  return { project, services: created.map((s) => s.id), dropped: droppedMounts };
}

export async function backupNow(actor: Actor, serviceId: string, destinationId?: string) {
  const svc = getServiceOrThrow(serviceId);
  if (!backupMethod(svc)) throw new HttpError(400, `${svc.name} has no data to back up (no volumes and not a known database)`);
  return backupService(svc, actor.type === 'agent' ? 'agent' : 'manual', actor, destinationId);
}

export function serviceBackups(serviceId: string, limit = 50) {
  return listBackups(getServiceOrThrow(serviceId).id, limit);
}

export function planComposeImport(input: { yaml: string; env?: string; basePath?: string; name?: string }) {
  return planCompose(input);
}

/** For each named volume of a Compose plan: which existing Docker volume it would take over, and whether it can. */
export async function adoptPlan(plan: ReturnType<typeof planCompose>) {
  const out: { service: string; slug: string; mountPath: string; name: string; dockerName: string; status: 'ok' | 'missing' | 'claimed' | 'in use'; users: string[] }[] = [];
  for (const cs of plan.services) {
    for (const m of cs.volumes) {
      if (!m.dockerName || m.hostPath) continue;
      const a = await adoptable(null, m.dockerName, m.composeVolume ? { project: plan.composeProject, volume: m.composeVolume } : undefined);
      out.push({ service: cs.name, slug: cs.slug, mountPath: m.mountPath, name: m.name, dockerName: a.dockerName, users: a.users, status: !a.exists ? 'missing' : a.claimed ? 'claimed' : a.users.length ? 'in use' : 'ok' });
    }
  }
  return out;
}

export async function importCompose(actor: Actor, input: { yaml: string; env?: string; basePath?: string; name?: string; deploy?: boolean; adoptVolumes?: boolean }) {
  const plan = planCompose(input);
  // Take over the Docker volumes Compose already created, instead of starting empty. Checked up front, so a volume
  // still in use stops the import before anything is created.
  const adopt: { slug: string; mountPath: string; dockerName: string; name: string }[] = [];
  if (input.adoptVolumes) {
    requireOwner(actor, 'Taking over existing Docker volumes');
    const check = await adoptPlan(plan);
    const busyOnes = check.filter((c) => c.status === 'in use');
    const missing = check.filter((c) => c.status === 'missing' || c.status === 'claimed');
    if (busyOnes.length) throw new HttpError(409, `these volumes are still referenced by Compose containers: ${busyOnes.map((c) => `${c.dockerName} ← ${c.users.join(', ')}`).join('; ')} — run \`docker compose down\` (without -v; the data stays), then import again`);
    // A miss would silently start that database empty: stop instead, the user decides.
    if (missing.length) throw new HttpError(409, `no existing Docker volume found for ${missing.map((c) => `${c.service}:${c.mountPath} (looked for ${c.dockerName}${c.status === 'claimed' ? ', already a Servify volume' : ''})`).join('; ')} — check the base folder / compose project name, or import without taking over volumes`);
    for (const c of check) adopt.push({ slug: c.slug, mountPath: c.mountPath, dockerName: c.dockerName, name: c.name });
  }
  const spec = planToSpec(plan);
  for (const sv of spec.services) sv.volumes = (sv.volumes ?? []).filter((m) => !adopt.some((a) => a.slug === sv.name && a.mountPath === m.mountPath));
  const r = await importProject(actor, spec, { deploy: false, name: plan.name });
  for (const a of adopt) {
    const svc = servicesTable.all('WHERE project_id = ?', r.project.id).find((x) => x.slug === a.slug);
    if (svc) await adoptVolume(actor, r.project.id, { dockerName: a.dockerName, serviceId: svc.id, mountPath: a.mountPath, name: `${svc.slug}-${a.name}`.slice(0, 48) });
  }
  // Keep the published host port for TCP services when it's free (e.g. 5432:5432).
  for (const sid of r.services) {
    const svc = servicesTable.get(sid)!;
    const cs = plan.services.find((x) => x.slug === svc.slug);
    if (svc.protocol === 'tcp' && cs?.publishedPort && cs.publishedPort >= 1024 && !tcpPortInUse(cs.publishedPort, svc.id) && (await portFree(cs.publishedPort))) {
      await updateService(actor, svc.id, { publicTcpPort: cs.publishedPort }, { quiet: true }).catch(() => {});
    }
  }
  if (input.deploy !== false) for (const sid of r.services) deployService(actor, sid);
  recordActivity(actor, 'project.compose', `Imported ${r.services.length} services from docker-compose${plan.warnings.length ? ` (${plan.warnings.length} warnings)` : ''}`, r.project.id);
  return { ...r, warnings: [...plan.warnings, ...(r.dropped ?? []).map((d) => `left out: ${d}`)], adopted: adopt.map((a) => a.dockerName) };
}

export async function runServiceJob(actor: Actor, serviceId: string) {
  const svc = getServiceOrThrow(serviceId);
  if (isJobRunning(svc.id)) throw new HttpError(409, `${svc.name} is already running — wait for the current run to finish`);
  // Fire and return the run immediately; completion arrives as a job.run event.
  const p = runJob(svc, actor.type === 'agent' ? 'agent' : 'manual', actor);
  p.catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  return listRuns(svc.id, 1)[0] ?? null;
}

export function serviceRuns(serviceId: string, limit = 30) {
  return listRuns(getServiceOrThrow(serviceId).id, limit);
}
