/**
 * MCP server: every Servify capability as a tool, attributed to the calling agent's token.
 * Transport: Streamable HTTP (stateless) at /mcp. `servify mcp` bridges stdio → HTTP.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import * as ops from './ops.ts';
import { deployments as deploymentsTable, services as servicesTable } from './db.ts';
import { config } from './config.ts';
import type { Principal } from './auth.ts';
import { sleep } from './util.ts';
import { replicasOf } from './engine.ts';
import { restoreBackup } from './backups.ts';
import { environmentsOf, createEnvironment, setPreviews } from './envs.ts';
import { listCertificates } from './certs.ts';
import { listVolumes, createVolume, attachVolume, detachVolume, deleteVolume, shareVolume, removeMount } from './volumes.ts';
import { switchover, clusterStatus } from './pgcluster.ts';
import { listServers } from './nodes.ts';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function wrap<A>(fn: (args: A) => Promise<unknown> | unknown) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  };
}

const INSTRUCTIONS = `Servify is a local-first PaaS running on this machine. It hosts services from Docker images, git repositories, local folders or templates (postgres, redis, …) inside projects.
- HTTP services get a URL like http://<service>.<project>.localhost:${config.proxyPort} served by a built-in load balancer.
- Scale with scale_service; replicas sit behind the load balancer (strategy configurable). Services with volumes are single-replica.
- Variables can reference other services: \${{ postgres.DATABASE_URL }}. Variable/config changes take effect on the next deploy.
- Deploys are async: call wait_for_deployment after create_service/deploy_service to get the outcome and build log tail.
- Services can be referred to by id, slug, or "project/service".
- Projects can have environments (staging, pr-12 previews…): full copies with their own URLs and data. Use list_environments / create_environment.
- Databases and volumes can be backed up (backup_service) and restored (restore_backup). Logs and metrics are kept for 7 days.
- import_compose turns a docker-compose.yml into a project (use dry_run first to see the mapping and warnings).`;

export function buildMcpServer(principal: Principal): McpServer {
  const server = new McpServer({ name: 'servify', version: config.version }, { instructions: INSTRUCTIONS });
  const actor = principal.actor;
  const write = principal.scope === 'write';
  const view = { revealSecrets: write };
  const guard = () => {
    if (!write) throw new Error('this token is read-only');
  };

  const svcRef = z.string().describe('Service id, slug, or "project/service"');
  const projRef = z.string().describe('Project id or slug');

  server.registerTool(
    'overview',
    { title: 'Overview', description: 'List all projects and their services with status, replicas and URLs. Start here.', inputSchema: {} },
    wrap(() =>
      ops.listProjects().map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        services: servicesTable.all('WHERE project_id = ?', p.id).map(ops.serviceSummary),
      })),
    ),
  );

  server.registerTool(
    'create_project',
    { description: 'Create a new project (a canvas that groups services sharing a private network).', inputSchema: { name: z.string() } },
    wrap(({ name }: { name: string }) => {
      guard();
      return ops.createProject(actor, { name });
    }),
  );

  server.registerTool(
    'delete_project',
    { description: 'Delete a project and ALL its services, containers and volumes. Irreversible.', inputSchema: { project: projRef }, annotations: { destructiveHint: true } },
    wrap(async ({ project }: { project: string }) => {
      guard();
      await ops.deleteProject(actor, project);
      return 'deleted';
    }),
  );

  server.registerTool(
    'get_project',
    { description: 'Get a project with its services, replicas and service-to-service references.', inputSchema: { project: projRef } },
    wrap(({ project }: { project: string }) => {
      const snap = ops.projectSnapshot(project, view);
      return {
        project: snap.project,
        services: snap.services.map((s) => ({ ...ops.serviceSummary(s), env: s.env, pendingChanges: s.pendingChanges, strategy: s.strategy, port: s.port, protocol: s.protocol })),
        references: snap.edges,
      };
    }),
  );

  server.registerTool(
    'list_templates',
    { description: 'List one-click templates (databases, caches, tools).', inputSchema: {} },
    wrap(() => ops.listTemplates().map((t) => ({ id: t.id, name: t.name, description: t.description, image: t.image, category: t.category }))),
  );

  server.registerTool(
    'create_service',
    {
      description:
        'Create a service in a project from ONE of: templateId, image, repo (git URL or owner/repo), or path (local folder). Deploys immediately unless deploy=false. Returns the service and its first deployment id.',
      inputSchema: { project: projRef, ...ops.createServiceInput.shape },
    },
    wrap(async ({ project, ...input }: { project: string } & ops.CreateServiceInput) => {
      guard();
      return ops.createService(actor, ops.getProjectOrThrow(project).id, input);
    }),
  );

  server.registerTool(
    'get_service',
    { description: 'Get full details of a service: config, variables, replicas, URL, pending changes.', inputSchema: { service: svcRef } },
    wrap(({ service }: { service: string }) => {
      const s = ops.getServiceOrThrow(service);
      return { ...ops.serializeService(s, view), replicas: replicasOf(s.id) };
    }),
  );

  server.registerTool(
    'update_service',
    {
      description: 'Update service settings (name, source, port, healthcheck, strategy, domains, autoscale, resources, start command…). Source/env/port changes need deploy_service to take effect.',
      inputSchema: { service: svcRef, ...ops.updateServiceInput.omit({ x: true, y: true }).shape },
    },
    wrap(async ({ service, ...patch }: { service: string } & ops.UpdateServiceInput) => {
      guard();
      return ops.updateService(actor, service, patch);
    }),
  );

  server.registerTool(
    'deploy_service',
    { description: 'Build (if needed) and deploy the service with its current settings. Zero-downtime for stateless services.', inputSchema: { service: svcRef } },
    wrap(({ service }: { service: string }) => {
      guard();
      return ops.deployService(actor, service, 'agent');
    }),
  );

  server.registerTool(
    'wait_for_deployment',
    {
      description: 'Wait until a deployment finishes (active/failed/cancelled) and return its status plus the tail of its build/deploy log.',
      inputSchema: { deployment: z.string(), timeoutSec: z.number().int().min(1).max(900).optional().describe('default 300') },
    },
    wrap(async ({ deployment, timeoutSec }: { deployment: string; timeoutSec?: number }) => {
      const deadline = Date.now() + (timeoutSec ?? 300) * 1000;
      let d = deploymentsTable.get(deployment);
      if (!d) throw new Error('deployment not found');
      while (Date.now() < deadline && ['queued', 'building', 'deploying'].includes(d!.status)) {
        await sleep(1000);
        d = deploymentsTable.get(deployment);
      }
      const logs = ops.deploymentLogs(deployment).slice(-40).map((l) => l.text);
      return { status: d!.status, error: d!.error, image: d!.image, finished: !['queued', 'building', 'deploying'].includes(d!.status), logTail: logs };
    }),
  );

  server.registerTool(
    'scale_service',
    { description: 'Set the number of replicas. Traffic is load-balanced across healthy replicas.', inputSchema: { service: svcRef, replicas: z.number().int().min(0).max(32) } },
    wrap(async ({ service, replicas }: { service: string; replicas: number }) => {
      guard();
      const s = await ops.scaleService(actor, service, replicas);
      return ops.serviceSummary(s);
    }),
  );

  server.registerTool(
    'restart_service',
    { description: 'Zero-downtime restart: roll the current image onto fresh replicas.', inputSchema: { service: svcRef } },
    wrap(({ service }: { service: string }) => {
      guard();
      return ops.restartService(actor, service);
    }),
  );

  server.registerTool(
    'stop_service',
    { description: 'Stop all replicas of a service (keeps config and volumes).', inputSchema: { service: svcRef } },
    wrap(async ({ service }: { service: string }) => {
      guard();
      return ops.serviceSummary(await ops.stopService(actor, service));
    }),
  );

  server.registerTool(
    'start_service',
    { description: 'Start a stopped service.', inputSchema: { service: svcRef } },
    wrap(({ service }: { service: string }) => {
      guard();
      return ops.startService(actor, service);
    }),
  );

  server.registerTool(
    'delete_service',
    { description: 'Delete a service, its containers, images and volumes. Irreversible.', inputSchema: { service: svcRef, keepVolumes: z.boolean().optional() }, annotations: { destructiveHint: true } },
    wrap(async ({ service, keepVolumes }: { service: string; keepVolumes?: boolean }) => {
      guard();
      await ops.deleteService(actor, service, { keepVolumes });
      return 'deleted';
    }),
  );

  server.registerTool(
    'rollback_service',
    { description: 'Redeploy a previous deployment (by id, see list_deployments).', inputSchema: { service: svcRef, deploymentId: z.string() } },
    wrap(({ service, deploymentId }: { service: string; deploymentId: string }) => {
      guard();
      return ops.rollbackService(actor, service, deploymentId);
    }),
  );

  server.registerTool(
    'set_variables',
    {
      description: 'Set environment variables (merged unless replace=true). Values may reference other services: ${{ postgres.DATABASE_URL }}. Redeploy to apply.',
      inputSchema: { service: svcRef, variables: z.record(z.string(), z.string()), replace: z.boolean().optional(), secretKeys: z.array(z.string()).optional() },
    },
    wrap(({ service, variables, replace, secretKeys }: { service: string; variables: Record<string, string>; replace?: boolean; secretKeys?: string[] }) => {
      guard();
      const s = ops.setVariables(actor, service, variables, { replace, secretKeys });
      return { env: Object.keys(s.env), pendingChanges: s.pendingChanges };
    }),
  );

  server.registerTool(
    'delete_variable',
    { description: 'Remove one environment variable.', inputSchema: { service: svcRef, key: z.string() } },
    wrap(({ service, key }: { service: string; key: string }) => {
      guard();
      return Object.keys(ops.deleteVariable(actor, service, key).env);
    }),
  );

  server.registerTool(
    'list_deployments',
    { description: 'Recent deployments of a service, newest first.', inputSchema: { service: svcRef, limit: z.number().int().min(1).max(100).optional() } },
    wrap(({ service, limit }: { service: string; limit?: number }) =>
      ops.listDeployments(service, limit ?? 10, view).map((d) => ({
        id: d.id,
        status: d.status,
        trigger: d.trigger,
        actor: d.actor,
        source: d.sourceLabel,
        image: d.image,
        error: d.error,
        createdAt: new Date(d.createdAt).toISOString(),
      })),
    ),
  );

  server.registerTool(
    'get_deployment_logs',
    { description: 'Build + deploy log of a deployment.', inputSchema: { deployment: z.string(), tail: z.number().int().min(1).max(2000).optional() } },
    wrap(({ deployment, tail }: { deployment: string; tail?: number }) => ops.deploymentLogs(deployment).slice(-(tail ?? 200)).map((l) => l.text).join('\n')),
  );

  server.registerTool(
    'get_service_logs',
    {
      description: 'Runtime logs across all replicas, kept for 7 days (prefixed with replica index). Survive redeploys and restarts.',
      inputSchema: {
        service: svcRef,
        tail: z.number().int().min(1).max(2000).optional(),
        search: z.string().optional(),
        since_minutes: z.number().min(1).max(10080).optional().describe('Only lines from the last N minutes'),
        deployment_id: z.string().optional().describe('Only lines from one deployment (e.g. the previous one)'),
      },
    },
    wrap(async ({ service, tail, search, since_minutes, deployment_id }: { service: string; tail?: number; search?: string; since_minutes?: number; deployment_id?: string }) => {
      const lines = await ops.serviceLogs(service, { tail: tail ?? 100, search, since: since_minutes ? Date.now() - since_minutes * 60_000 : undefined, deploymentId: deployment_id });
      return lines.map((l) => `[#${l.replica}] ${new Date(l.ts).toISOString()} ${l.text}`).join('\n') || '(no logs)';
    }),
  );

  server.registerTool(
    'get_metrics',
    { description: 'Current and recent metrics: requests/s, p95 latency, errors, CPU, memory, per-replica state.', inputSchema: { service: svcRef, seconds: z.number().int().min(10).max(604800).optional().describe('Window; up to 7 days (longer windows are averaged)') } },
    wrap(({ service, seconds }: { service: string; seconds?: number }) => {
      const m = ops.serviceMetrics(service, seconds ?? 60);
      const pts = m.points;
      const avg = (k: 'rps' | 'cpu' | 'memMb' | 'p95' | 'errors') => (pts.length ? pts.reduce((a, p) => a + p[k], 0) / pts.length : 0);
      return {
        windowSec: pts.length,
        avg: { rps: avg('rps'), p95ms: avg('p95'), errorsPerSec: avg('errors'), cpuPercent: avg('cpu'), memMb: avg('memMb') },
        replicas: m.replicas.map((r) => ({ index: r.index, state: r.state, cpu: r.cpu, memMb: r.memMb, rps: r.rps, restarts: r.restarts })),
      };
    }),
  );

  server.registerTool(
    'exec_command',
    { description: 'Run a shell command inside a running replica and return its output (e.g. migrations, diagnostics).', inputSchema: { service: svcRef, command: z.string(), replica: z.number().int().min(0).optional() } },
    wrap(async ({ service, command, replica }: { service: string; command: string; replica?: number }) => {
      guard();
      return ops.execInService(actor, service, command, replica);
    }),
  );

  server.registerTool(
    'export_project',
    { description: 'Export a project as a servify.json spec (services, sources, scaling, variables). Secrets are blanked unless includeSecrets.', inputSchema: { project: projRef, includeSecrets: z.boolean().optional() } },
    wrap(({ project, includeSecrets }: { project: string; includeSecrets?: boolean }) => ops.exportProject(project, { secrets: !!includeSecrets && write })),
  );

  server.registerTool(
    'import_project',
    {
      description: 'Create a whole project from a servify.json spec in one call: {"servify":1,"name":"…","services":[{"name":"api","source":{"type":"image","image":"nginx:alpine"},"replicas":2,"env":{…}}]}. Deploys everything unless deploy=false.',
      inputSchema: { spec: z.any(), deploy: z.boolean().optional(), name: z.string().optional() },
    },
    wrap(async ({ spec, deploy, name }: { spec: any; deploy?: boolean; name?: string }) => {
      guard();
      return ops.importProject(actor, typeof spec === 'string' ? JSON.parse(spec) : spec, { deploy, name });
    }),
  );

  server.registerTool(
    'run_job',
    { description: 'Run a scheduled (cron) service now as a one-off container. Use list_runs to see the outcome and output.', inputSchema: { service: svcRef } },
    wrap(async ({ service }: { service: string }) => {
      guard();
      return ops.runServiceJob(actor, service);
    }),
  );

  server.registerTool(
    'list_runs',
    { description: 'Recent runs of a scheduled job: status, exit code, output tail.', inputSchema: { service: svcRef, limit: z.number().int().min(1).max(100).optional() } },
    wrap(({ service, limit }: { service: string; limit?: number }) =>
      ops.serviceRuns(service, limit ?? 10).map((r) => ({ id: r.id, status: r.status, exitCode: r.exitCode, trigger: r.trigger, startedAt: new Date(r.startedAt).toISOString(), durationMs: r.finishedAt ? r.finishedAt - r.startedAt : null, output: r.output.slice(-2000) })),
    ),
  );

  server.registerTool(
    'load_test',
    { description: 'Send synthetic HTTP traffic to a service through the load balancer (to verify scaling, balancing or autoscaling).', inputSchema: { service: svcRef, rps: z.number().min(1).max(500).optional(), seconds: z.number().int().min(1).max(300).optional() } },
    wrap(({ service, rps, seconds }: { service: string; rps?: number; seconds?: number }) => {
      guard();
      return ops.loadTest(actor, service, rps ?? 30, seconds ?? 30);
    }),
  );

  server.registerTool(
    'get_activity',
    { description: 'Recent activity (who did what — users, agents, system).', inputSchema: { project: projRef.optional(), limit: z.number().int().min(1).max(200).optional() } },
    wrap(({ project, limit }: { project?: string; limit?: number }) =>
      ops.listActivity({ projectId: project ? ops.getProjectOrThrow(project).id : undefined, limit: limit ?? 30 }).map((a) => ({
        at: new Date(a.ts).toISOString(),
        actor: `${a.actorType}:${a.actor}`,
        summary: a.summary,
      })),
    ),
  );

  server.registerTool(
    'backup_service',
    { description: 'Back up a service now: databases (Postgres/MySQL/MongoDB) are dumped, other volumes archived. Returns the backup record.', inputSchema: { service: svcRef, destination: z.string().optional().describe('"local" (default) or a destination id from settings') } },
    wrap(async ({ service, destination }: { service: string; destination?: string }) => {
      guard();
      return ops.backupNow(actor, service, destination);
    }),
  );

  server.registerTool(
    'list_backups',
    { description: 'Backups of a service, newest first (id, status, size, destination, when).', inputSchema: { service: svcRef } },
    wrap(({ service }: { service: string }) => ops.serviceBackups(service, 30)),
  );

  server.registerTool(
    'restore_backup',
    {
      description: "Replace a service's data with a backup. Takes a safety backup first, then rebuilds the data; the service restarts. Runs in the background — poll list_backups / get_activity.",
      inputSchema: { backup_id: z.string() },
      annotations: { destructiveHint: true },
    },
    wrap(({ backup_id }: { backup_id: string }) => {
      guard();
      return restoreBackup(actor, backup_id);
    }),
  );

  server.registerTool(
    'import_compose',
    {
      description: 'Create a project from a docker-compose.yml. Use dry_run first: it returns the mapped services and warnings (privileged, host networking, the Docker socket… are never honoured; host folders and taking over existing volumes need the owner in the dashboard).',
      inputSchema: {
        yaml: z.string().describe('Contents of docker-compose.yml'),
        env: z.string().optional().describe('Contents of the .env file used for ${VAR} interpolation'),
        base_path: z.string().optional().describe('Absolute folder of the compose file (needed for build: contexts and env_file)'),
        name: z.string().optional(),
        dry_run: z.boolean().optional(),
        deploy: z.boolean().optional().describe('Deploy right away (default true)'),
      },
    },
    wrap(async ({ yaml, env, base_path, name, dry_run, deploy }: { yaml: string; env?: string; base_path?: string; name?: string; dry_run?: boolean; deploy?: boolean }) => {
      // Even a dry run reads files under base_path (env_file, .env): write tokens only.
      guard();
      if (dry_run) return ops.planComposeImport({ yaml, env, basePath: base_path, name });
      return ops.importCompose(actor, { yaml, env, basePath: base_path, name, deploy });
    }),
  );

  server.registerTool(
    'list_environments',
    { description: 'Environments of a project: production plus copies like staging and pull-request previews, with their slugs (use the slug as the project for other tools).', inputSchema: { project: projRef } },
    wrap(({ project }: { project: string }) => environmentsOf(project)),
  );

  server.registerTool(
    'create_environment',
    {
      description: 'Copy a project into a new environment (fresh volumes, no custom domains) with its own URLs. Optionally build git services from another branch.',
      inputSchema: { project: projRef, name: z.string().describe('e.g. staging'), branch: z.string().optional(), deploy: z.boolean().optional() },
    },
    wrap(async ({ project, name, branch, deploy }: { project: string; name: string; branch?: string; deploy?: boolean }) => {
      guard();
      const env = await createEnvironment(actor, project, { name, branch, deploy });
      return { id: env.id, slug: env.slug, environment: env.envName };
    }),
  );

  server.registerTool(
    'set_previews',
    { description: 'Turn pull-request preview environments on or off for a project (needs the git webhook configured on the repository).', inputSchema: { project: projRef, enabled: z.boolean() } },
    wrap(({ project, enabled }: { project: string; enabled: boolean }) => {
      guard();
      return { previews: setPreviews(actor, project, enabled).previews };
    }),
  );

  server.registerTool(
    'list_volumes',
    { description: 'Volumes of a project: name, size, which service they are attached to (or detached) and where they are mounted.', inputSchema: { project: projRef } },
    wrap(({ project }: { project: string }) =>
      listVolumes(ops.getProjectOrThrow(project).id).map((v) => ({
        id: v.id,
        name: v.name,
        attachedTo: v.serviceId ? servicesTable.get(v.serviceId)?.name ?? v.serviceId : null,
        mountPath: v.mountPath,
        sizeBytes: v.sizeBytes,
      })),
    ),
  );

  server.registerTool(
    'create_volume',
    { description: 'Create a persistent volume in a project, optionally attaching it to a service right away (the service redeploys).', inputSchema: { project: projRef, name: z.string(), service: svcRef.optional(), mount_path: z.string().optional().describe('e.g. /data') } },
    wrap(async ({ project, name, service, mount_path }: { project: string; name: string; service?: string; mount_path?: string }) => {
      guard();
      const p = ops.getProjectOrThrow(project);
      return createVolume(actor, p.id, { name, serviceId: service ? ops.getServiceOrThrow(service).id : undefined, mountPath: mount_path });
    }),
  );

  server.registerTool(
    'attach_volume',
    { description: 'Attach a detached volume to a service at a mount path. The service redeploys with the data; services with a volume run 1 replica.', inputSchema: { volume: z.string().describe('Volume id or "project/volume"'), service: svcRef, mount_path: z.string() } },
    wrap(async ({ volume, service, mount_path }: { volume: string; service: string; mount_path: string }) => {
      guard();
      return attachVolume(actor, volume, ops.getServiceOrThrow(service).id, mount_path);
    }),
  );

  server.registerTool(
    'detach_volume',
    { description: 'Detach a volume from its service. The data is kept; the service redeploys without it (a database would start empty).', inputSchema: { volume: z.string() }, annotations: { destructiveHint: true } },
    wrap(async ({ volume }: { volume: string }) => {
      guard();
      return detachVolume(actor, volume);
    }),
  );

  server.registerTool(
    'delete_volume',
    { description: 'Permanently delete a detached volume and all its data (keep_data: only forget it, the Docker volume stays).', inputSchema: { volume: z.string(), keep_data: z.boolean().optional() }, annotations: { destructiveHint: true } },
    wrap(async ({ volume, keep_data }: { volume: string; keep_data?: boolean }) => {
      guard();
      await deleteVolume(actor, volume, { keepData: !!keep_data });
      return { ok: true };
    }),
  );

  server.registerTool(
    'share_volume',
    {
      description: 'Mount a volume read-only into another service of the same project (e.g. a backup sidecar reading a game server\'s data). The service redeploys. Remove with unmount.',
      inputSchema: { volume: z.string().describe('Volume id or "project/volume"'), service: svcRef, mount_path: z.string() },
    },
    wrap(async ({ volume, service, mount_path }: { volume: string; service: string; mount_path: string }) => {
      guard();
      return shareVolume(actor, volume, ops.getServiceOrThrow(service).id, mount_path);
    }),
  );

  server.registerTool(
    'unmount',
    { description: 'Remove a read-only share or a host folder from a service (nothing is deleted). The service redeploys.', inputSchema: { service: svcRef, mount_path: z.string() } },
    wrap(async ({ service, mount_path }: { service: string; mount_path: string }) => {
      guard();
      return removeMount(actor, ops.getServiceOrThrow(service).id, mount_path);
    }),
  );

  server.registerTool(
    'cluster_status',
    { description: 'Database cluster status: which replica is the primary, each standby\'s replication lag and sync state, failover settings.', inputSchema: { service: svcRef } },
    wrap(({ service }: { service: string }) => clusterStatus(ops.getServiceOrThrow(service)) ?? 'not a cluster'),
  );

  server.registerTool(
    'switchover',
    { description: 'Gracefully move a database cluster\'s primary to a standby (the old primary is rebuilt as a standby). Use before maintenance.', inputSchema: { service: svcRef, to: z.number().int().min(0).optional().describe('Replica index to promote; default: the most up-to-date standby') }, annotations: { destructiveHint: true } },
    wrap(async ({ service, to }: { service: string; to?: number }) => {
      guard();
      return switchover(actor, ops.getServiceOrThrow(service).id, to);
    }),
  );

  server.registerTool(
    'list_servers',
    { description: 'Machines this Servify runs services on: this machine plus servers connected with `servify agent` (status, Docker version, how many services/replicas each runs). Add servers in the dashboard (Servers).', inputSchema: {} },
    wrap(() => listServers()),
  );

  server.registerTool(
    'move_service',
    {
      description: 'Run a service on another server (id or name from list_servers; "local" = this machine). Redeploys there, then retires the old replicas. Services with volumes cannot move (data stays on its server). Private service names only resolve between services on the same server.',
      inputSchema: { service: svcRef, server: z.string() },
      annotations: { destructiveHint: true },
    },
    wrap(async ({ service, server: target }: { service: string; server: string }) => {
      guard();
      return ops.moveService(actor, service, target);
    }),
  );

  server.registerTool(
    'list_certificates',
    { description: 'TLS certificates for custom domains: status (issued / pending / failed), expiry and last error.', inputSchema: {} },
    wrap(() => listCertificates()),
  );

  return server;
}

export async function handleMcp(req: Request, principal: Principal): Promise<Response> {
  const server = buildMcpServer(principal);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const res = await transport.handleRequest(req);
  // Stateless: tear down after the response body is produced.
  void res
    .clone()
    .text()
    .catch(() => {})
    .finally(() => {
      void transport.close();
      void server.close();
    });
  return res;
}
