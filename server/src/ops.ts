/**
 * The service layer. REST handlers, MCP tools and background jobs all call these functions,
 * so every capability is available to humans and agents alike, with the same validation.
 */
import { z } from 'zod';
import { projects as projectsTable, services as servicesTable, deployments as deploymentsTable, activityTable } from './db.ts';
import type { Project, Service, Deployment, Source, Replica } from './types.ts';
import { bus, recordActivity, type Actor } from './events.ts';
import { id, slugify, secret, HttpError, assert } from './util.ts';
import { getTemplate, templates } from './templates.ts';
import { queueDeployment, readDeploymentLog, isDeploying } from './deployer.ts';
import { replicasOf, requestReconcile, drainAndRemove, effectiveReplicas, networkName, deployedSchedule } from './engine.ts';
import { docker, demuxLines } from './docker.ts';
import { referencedServices, publicUrl, resolveEnv, hostUrl } from './vars.ts';
import { certsTable } from './db.ts';
import { isLocalHost } from './certs.ts';
import { getSettings, destinationById } from './settings.ts';
import { backupMethod, backupService, listBackups, isRestoring } from './backups.ts';
import { queryLogs, subscribeLogs, type LogLine } from './logstore.ts';
import { syncServiceVolumes, releaseServiceVolumes, deleteProjectVolumes, listVolumes, hasSharedVolume } from './volumes.ts';
import { planCompose, planToSpec } from './compose.ts';
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
  return all.map((p) => {
    const svcs = servicesTable.all('WHERE project_id = ?', p.id);
    return {
      ...p,
      environments: p.parentId ? 0 : all.filter((x) => x.parentId === p.id).length,
      serviceCount: svcs.length,
      running: svcs.filter((s) => s.status === 'running').length,
      services: svcs.map((s) => ({ id: s.id, name: s.name, icon: s.icon, status: s.status })),
    };
  });
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
    project,
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

export function updateProject(actor: Actor, projectId: string, patch: { name?: string; color?: string }) {
  const p = getProjectOrThrow(projectId);
  if (patch.name?.trim()) p.name = patch.name.trim();
  if (patch.color) p.color = patch.color;
  p.updatedAt = Date.now();
  projectsTable.put(p);
  bus.publish({ type: 'project.updated', project: p });
  recordActivity(actor, 'project.updated', `Updated project ${p.name}`, p.id);
  return p;
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
  setTimeout(() => docker.removeNetwork(networkName(p.id)), 15_000);
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
  port: z.number().int().min(1).max(65535).optional().describe('Port the app listens on inside the container'),
  protocol: z.enum(['http', 'tcp', 'none']).optional().describe('http = routed by domain, tcp = raw TCP, none = background worker'),
  replicas: z.number().int().min(0).max(32).optional(),
  env: z.record(z.string(), z.string()).optional(),
  startCommand: z.string().optional(),
  buildCommand: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  deploy: z.boolean().optional().describe('Deploy immediately (default true)'),
});
export type CreateServiceInput = z.infer<typeof createServiceInput>;

function inferName(input: CreateServiceInput): string {
  if (input.name?.trim()) return input.name.trim();
  if (input.templateId) return getTemplate(input.templateId)?.name.toLowerCase().replace(/\s+/g, '-') ?? input.templateId;
  if (input.image) return input.image.split('/').pop()!.split(':')[0].split('@')[0];
  if (input.repo) return normalizeRepo(input.repo).split('/').pop()!.replace(/\.git$/, '');
  if (input.path) return input.path.replace(/\/+$/, '').split('/').pop() || 'app';
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
  if (input.path) return 'folder';
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
  else throw new HttpError(400, 'provide one of: templateId, image, repo, path');

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
    replicas: tpl?.singleton ? 1 : Math.max(0, input.replicas ?? 1),
    strategy: 'round-robin',
    healthcheck: { path: tpl?.healthPath ?? null, intervalSec: 5, timeoutSec: 3, graceSec: source.type === 'image' ? 90 : 120 },
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
    x: pos.x,
    y: pos.y,
    status: 'idle',
    activeDeploymentId: null,
    stopped: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  if (protocol === 'tcp') svc.publicTcpPort = await allocateTcpPort();
  servicesTable.insert(svc);
  syncServiceVolumes(svc);
  bus.publish({ type: 'service.updated', service: svc });
  recordActivity(actor, 'service.created', `Created ${svc.name} from ${describeSource(source)}`, project.id, svc.id);
  let deployment: Deployment | null = null;
  if (input.deploy !== false) deployment = queueDeployment(svc, 'create', actor);
  return { service: serializeService(servicesTable.get(svc.id)!), deployment: deployment ? serializeDeployment(deployment) : null };
}

function describeSource(s: Source) {
  if (s.type === 'image') return s.image;
  if (s.type === 'git') return s.repo.replace(/^https:\/\/github\.com\//, '');
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
    .array(z.object({ name: z.string().regex(/^[a-zA-Z0-9_.-]+$/), mountPath: z.string().startsWith('/'), volumeId: z.string().optional(), perReplica: z.boolean().optional() }))
    .optional()
    .describe('Mounts. New entries (no volumeId) create a fresh volume. To remove one, use detach_volume.'),
  startCommand: z.string().nullable().optional(),
  cmd: z.array(z.string()).nullable().optional().describe('Override only the image CMD (argv array). Ignored when startCommand is set.'),
  entrypoint: z.array(z.string()).nullable().optional().describe('Override only the image ENTRYPOINT (argv array).'),
  buildCommand: z.string().nullable().optional(),
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
    // Removing a mount here would leave its data mounted until the next deploy; detaching is explicit.
    const keep = new Set(patch.volumes.map((v) => v.volumeId).filter(Boolean));
    const dropped = svc.volumes.filter((v) => v.volumeId && !keep.has(v.volumeId));
    if (dropped.length) throw new HttpError(400, `detach ${dropped.map((d) => d.name).join(', ')} instead (detach_volume / the volume's menu) — its data is kept`);
    for (const v of patch.volumes) if (!v.volumeId && svc.volumes.some((x) => x.mountPath === v.mountPath)) throw new HttpError(409, `${v.mountPath} is already in use`);
    set('volumes', patch.volumes.map((v) => ({ ...v, name: v.volumeId ? svc.volumes.find((x) => x.volumeId === v.volumeId)?.name ?? v.name : v.name })), 'volumes');
  }
  if (patch.replicas !== undefined) {
    const tpl = svc.templateId ? getTemplate(svc.templateId) : null;
    const deployedShared = svc.activeDeploymentId ? hasSharedVolume(deploymentsTable.get(svc.activeDeploymentId)?.config.volumes) : false;
    if (patch.replicas > 1 && (hasSharedVolume(svc.volumes) || deployedShared || tpl?.singleton)) {
      throw new HttpError(400, `${svc.name} has a persistent volume; replicas would corrupt its data. Stateful services run as a single replica.`);
    }
    set('replicas', patch.replicas, 'replicas');
  }
  if (patch.strategy !== undefined) set('strategy', patch.strategy, 'load balancing');
  if (patch.healthcheck) set('healthcheck', { ...svc.healthcheck, ...patch.healthcheck, path: patch.healthcheck.path === undefined ? svc.healthcheck.path : patch.healthcheck.path || null }, 'health check');
  if (patch.autoscale) {
    const a = { ...svc.autoscale, ...patch.autoscale };
    if (a.max < a.min) a.max = a.min;
    if (a.enabled && svc.volumes.length) throw new HttpError(400, 'autoscaling is not available for services with volumes');
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

export async function scaleService(actor: Actor, serviceId: string, replicas: number) {
  const svc = getServiceOrThrow(serviceId);
  const before = svc.replicas;
  const out = await updateService(actor, svc.id, { replicas }, { quiet: true });
  if (before !== replicas) recordActivity(actor, 'service.scaled', `Scaled ${svc.name} ${before} → ${replicas}`, svc.projectId, svc.id);
  return out;
}

export function deployService(actor: Actor, serviceId: string, trigger: 'manual' | 'agent' | 'git' | 'config' = actor.type === 'agent' ? 'agent' : 'manual') {
  const svc = getServiceOrThrow(serviceId);
  if (svc.stopped) {
    svc.stopped = false;
    servicesTable.put(svc);
  }
  return serializeDeployment(queueDeployment(svc, trigger, actor));
}

/** Zero-downtime restart: roll the current image onto fresh replicas. */
export function restartService(actor: Actor, serviceId: string) {
  const svc = getServiceOrThrow(serviceId);
  const active = svc.activeDeploymentId ? deploymentsTable.get(svc.activeDeploymentId) : null;
  if (!active?.image) return deployService(actor, serviceId);
  return serializeDeployment(queueDeployment(svc, 'restart', actor, { image: active.image, port: active.port, fromDeployment: active }));
}

export function rollbackService(actor: Actor, serviceId: string, deploymentId: string) {
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
  if (!svc.activeDeploymentId) return { service: serializeService(svc), deployment: deployService(actor, svc.id) };
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
  servicesTable.delete(svc.id);
  bus.publish({ type: 'service.deleted', serviceId: svc.id, projectId: svc.projectId });
  if (!opts.quiet) recordActivity(actor, 'service.deleted', `Deleted ${svc.name}`, svc.projectId, null);
  const cids = replicasOf(svc.id).map((r) => r.containerId);
  await drainAndRemove(cids, 1000);
  // Remove any stragglers by label, then volumes and built images.
  const left = await docker.listContainers([`servify.service=${svc.id}`]); // service ids are globally unique
  await Promise.all(left.map((c) => docker.removeContainer(c.Id, true)));
  await releaseServiceVolumes(svc, !!opts.keepVolumes);
  for (const d of deploymentsTable.all('WHERE service_id = ?', svc.id)) {
    if (d.image?.startsWith('servify/')) await docker.removeImage(d.image);
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
  return docker.exec(target.containerId, ['/bin/sh', '-c', command]);
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
import { existsSync } from 'node:fs';
import httpMod from 'node:http';

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
  else Object.assign(input, { path: s.path, dockerfile: s.dockerfile });
  const r = await createService(actor, src.projectId, input);
  await updateService(actor, r.service.id, { volumes: src.volumes.map(({ volumeId, ...v }) => v), healthcheck: src.healthcheck, strategy: src.strategy, secretKeys: src.secretKeys, resources: src.resources, schedule: src.schedule ?? null, cmd: src.cmd ?? null, entrypoint: src.entrypoint ?? null }, { quiet: true });
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
  services: Array<Partial<Service> & { name: string; source?: Source }>;
};

const SPEC_KEYS = [
  'name', 'icon', 'templateId', 'source', 'protocol', 'port', 'replicas', 'strategy', 'healthcheck', 'autoscale',
  'publicHttp', 'domains', 'publicTcpPort', 'volumes', 'env', 'secretKeys', 'startCommand', 'buildCommand', 'resources', 'autoDeploy', 'schedule', 'backup', 'aliases', 'cmd', 'entrypoint', 'x', 'y',
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
  for (const raw of spec.services) {
    const tpl = raw.templateId ? tpls.get(raw.templateId) : null;
    const src = raw.source ?? (tpl ? { type: 'image' as const, image: tpl.image } : undefined);
    assert(src && ['image', 'git', 'local'].includes(src.type), 400, `service ${raw.name}: invalid source`);
    // Start from the template (all its variables, volumes, port…) when there is one; the spec overrides.
    const input: CreateServiceInput = { name: raw.name, deploy: false, x: raw.x, y: raw.y };
    if (tpl) input.templateId = tpl.id;
    else if (src.type === 'image') input.image = src.image;
    else if (src.type === 'git') Object.assign(input, { repo: src.repo, branch: src.branch, rootDir: src.rootDir, dockerfile: src.dockerfile, token: src.token });
    else Object.assign(input, { path: src.path, dockerfile: src.dockerfile });
    if (raw.protocol) input.protocol = raw.protocol;
    if (raw.port) input.port = raw.port;
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
      volumes: def(raw.volumes, svc.volumes).map(({ volumeId, ...v }: any) => v),
      env,
      secretKeys: [...new Set([...svc.secretKeys, ...(raw.secretKeys ?? [])])],
      startCommand: raw.startCommand === undefined ? svc.startCommand : raw.startCommand,
      buildCommand: raw.buildCommand === undefined ? svc.buildCommand : raw.buildCommand,
      resources: { ...svc.resources, ...(raw.resources ?? {}) },
      autoDeploy: def(raw.autoDeploy, svc.autoDeploy),
      schedule: raw.schedule ?? null,
      backup: raw.backup ?? null,
      aliases: (raw.aliases ?? []).filter((a) => /^[a-z0-9]([a-z0-9_.-]*[a-z0-9])?$/.test(a)),
      cmd: raw.cmd ?? null,
      entrypoint: raw.entrypoint ?? null,
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
  recordActivity(actor, 'project.imported', `Imported ${created.length} services into ${project.name}`, project.id);
  return { project, services: created.map((s) => s.id) };
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

export async function importCompose(actor: Actor, input: { yaml: string; env?: string; basePath?: string; name?: string; deploy?: boolean }) {
  const plan = planCompose(input);
  const r = await importProject(actor, planToSpec(plan), { deploy: false, name: plan.name });
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
  return { ...r, warnings: plan.warnings };
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
