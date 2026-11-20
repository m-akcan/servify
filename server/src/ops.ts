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
import { replicasOf, requestReconcile, drainAndRemove, effectiveReplicas, networkName, volumeName } from './engine.ts';
import { docker, demuxLines } from './docker.ts';
import { referencedServices, publicUrl, resolveEnv } from './vars.ts';
import { allocateTcpPort, tcpPortInUse, portFree } from './proxy.ts';
import { normalizeRepo } from './builder.ts';
import { metricsHistory } from './metrics.ts';
import { config } from './config.ts';

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
  if (JSON.stringify(c.env) !== JSON.stringify(s.env)) out.push('variables');
  if ((c.port ?? null) !== (s.port ?? null) && s.port !== null) out.push('port');
  if ((c.startCommand ?? null) !== (s.startCommand ?? null)) out.push('start command');
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
  return projectsTable.all('ORDER BY created_at ASC').map((p) => {
    const svcs = servicesTable.all('WHERE project_id = ?', p.id);
    return {
      ...p,
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
  for (const s of servicesTable.all('WHERE project_id = ?', p.id)) await deleteService(actor, s.id, { quiet: true });
  projectsTable.delete(p.id);
  bus.publish({ type: 'project.deleted', projectId: p.id });
  recordActivity(actor, 'project.deleted', `Deleted project ${p.name}`);
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

function iconFor(input: CreateServiceInput): string {
  if (input.templateId) return getTemplate(input.templateId)?.icon ?? 'box';
  if (input.repo) return 'git';
  if (input.path) return 'folder';
  const img = (input.image ?? '').toLowerCase();
  for (const k of ['postgres', 'redis', 'mysql', 'mongo', 'nginx', 'node', 'python', 'caddy', 'traefik']) if (img.includes(k)) return k === 'traefik' ? 'wave' : k;
  return 'box';
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
  publicTcpPort: z.number().int().min(1024).max(65535).nullable().optional(),
  volumes: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9_.-]+$/), mountPath: z.string().startsWith('/') })).optional(),
  startCommand: z.string().nullable().optional(),
  buildCommand: z.string().nullable().optional(),
  resources: z.object({ cpus: z.number().positive().max(64).nullable().optional(), memoryMb: z.number().int().min(16).nullable().optional() }).optional(),
  autoDeploy: z.boolean().optional(),
  secretKeys: z.array(z.string()).optional(),
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
  if (patch.volumes !== undefined) set('volumes', patch.volumes, 'volumes');
  if (patch.replicas !== undefined) {
    const tpl = svc.templateId ? getTemplate(svc.templateId) : null;
    if (patch.replicas > 1 && (svc.volumes.length > 0 || tpl?.singleton)) {
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
  if (patch.publicTcpPort !== undefined) {
    if (patch.publicTcpPort !== null) {
      if (tcpPortInUse(patch.publicTcpPort, svc.id)) throw new HttpError(409, `port ${patch.publicTcpPort} is already in use`);
      if (patch.publicTcpPort !== svc.publicTcpPort && !(await portFree(patch.publicTcpPort))) throw new HttpError(409, `port ${patch.publicTcpPort} is busy on this machine`);
    }
    set('publicTcpPort', patch.publicTcpPort, 'TCP proxy');
  }
  if (patch.startCommand !== undefined) set('startCommand', patch.startCommand?.trim() || null, 'start command');
  if (patch.buildCommand !== undefined) set('buildCommand', patch.buildCommand?.trim() || null, 'build command');
  if (patch.resources) set('resources', { ...svc.resources, ...patch.resources } as Service['resources'], 'resources');
  if (patch.autoDeploy !== undefined) set('autoDeploy', patch.autoDeploy, 'auto-deploy');
  if (patch.secretKeys !== undefined) set('secretKeys', patch.secretKeys, 'secrets');
  const moved = patch.x !== undefined || patch.y !== undefined;
  if (patch.x !== undefined) svc.x = Math.round(patch.x);
  if (patch.y !== undefined) svc.y = Math.round(patch.y);
  if (!changes.length && !moved) return serializeService(svc);
  svc.updatedAt = Date.now();
  servicesTable.put(svc);
  bus.publish({ type: 'service.updated', service: svc });
  if (changes.length && !opts.quiet) {
    recordActivity(actor, 'service.updated', `Updated ${svc.name}: ${changes.join(', ')}`, svc.projectId, svc.id);
  }
  if (changes.includes('replicas')) requestReconcile();
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
  const left = await docker.listContainers([`servify.service=${svc.id}`]);
  await Promise.all(left.map((c) => docker.removeContainer(c.Id, true)));
  if (!opts.keepVolumes) for (const v of svc.volumes) await docker.removeVolume(volumeName(svc.id, v.name));
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

export type LogLine = { ts: number; replica: number; deploymentId: string; stream: 'stdout' | 'stderr'; text: string };

function parseTs(line: string): { ts: number; text: string } {
  const sp = line.indexOf(' ');
  const t = Date.parse(line.slice(0, sp));
  if (sp > 0 && Number.isFinite(t)) return { ts: t, text: line.slice(sp + 1) };
  return { ts: Date.now(), text: line };
}

export async function serviceLogs(serviceId: string, opts: { tail?: number; since?: number; search?: string } = {}): Promise<LogLine[]> {
  const svc = getServiceOrThrow(serviceId);
  const reps = replicasOf(svc.id);
  const tail = Math.min(opts.tail ?? 200, 5000);
  const all: LogLine[] = [];
  await Promise.all(
    reps.map(async (r) => {
      try {
        const res = await docker.logs(r.containerId, { tail, since: opts.since ? Math.floor(opts.since / 1000) : undefined });
        for await (const f of demuxLines(res)) {
          const { ts, text } = parseTs(f.text);
          all.push({ ts, replica: r.index, deploymentId: r.deploymentId, stream: f.stream, text });
        }
      } catch {}
    }),
  );
  let out = all.sort((a, b) => a.ts - b.ts);
  if (opts.search) {
    const q = opts.search.toLowerCase();
    out = out.filter((l) => l.text.toLowerCase().includes(q));
  }
  return out.slice(-tail);
}

/** Follow logs of every replica, including ones that appear later. Returns a stop function. */
export function followServiceLogs(serviceId: string, onLine: (l: LogLine) => void): () => void {
  const following = new Map<string, () => void>();
  let stopped = false;
  const attach = (r: Replica) => {
    if (following.has(r.containerId) || stopped) return;
    let res: any = null;
    let dead = false;
    following.set(r.containerId, () => {
      dead = true;
      res?.destroy();
    });
    (async () => {
      try {
        res = await docker.logs(r.containerId, { follow: true, tail: 0 });
        if (dead) return res.destroy();
        for await (const f of demuxLines(res)) {
          const { ts, text } = parseTs(f.text);
          onLine({ ts, replica: r.index, deploymentId: r.deploymentId, stream: f.stream, text });
        }
      } catch {}
      following.delete(r.containerId);
    })();
  };
  const sync = () => {
    const reps = replicasOf(serviceId);
    const ids = new Set(reps.map((r) => r.containerId));
    for (const r of reps) if (r.dockerState === 'running') attach(r);
    for (const [cid, stop] of following) if (!ids.has(cid)) stop();
  };
  sync();
  const unsub = bus.subscribe((ev) => {
    if (ev.type === 'replicas' && ev.serviceId === serviceId) sync();
  });
  return () => {
    stopped = true;
    unsub();
    for (const stop of following.values()) stop();
  };
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
