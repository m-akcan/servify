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
import { restoreBackup, testRestore } from './backups.ts';
import { environmentsOf, createEnvironment, setPreviews } from './envs.ts';
import { listCertificates } from './certs.ts';
import { listVolumes, createVolume, attachVolume, detachVolume, deleteVolume, shareVolume, removeMount } from './volumes.ts';
import { switchover, clusterStatus } from './pgcluster.ts';
import { planMove, moveServiceToProject } from './moveproject.ts';
import { listServers } from './nodes.ts';
import { queryAccessLog, accessSummary } from './accesslog.ts';
import { TOOL_POLICIES, type TargetKind } from './policy.ts';
import { diskState, diskSummary, fmt } from './diskguard.ts';
import { checkCall, inReach, reachIds, isScoped } from './scopes.ts';

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
- Databases and volumes can be backed up (backup_service) and restored (restore_backup). Logs, metrics and the HTTP access log are kept for 7 days.
- A service with a schedule (update_service schedule, then deploy) runs as a cron job: list_runs shows runs, skipped starts (with why) and late catch-up runs. scheduleCatchUp (jobs, default off) and backup.catchUp (default on) run a start missed while Servify was down once, late. A job or backup that keeps failing notifies once, then a reminder now and then, and once when it recovers.
- Access control (update_service access): allow/deny lists of IPs or CIDRs ("private" = LAN/VPN only), basic auth (password stored hashed, shown masked) and a per-client rate limit. get_service lists accessWarnings — e.g. a reverse proxy in front that isn't in SERVIFY_TRUSTED_PROXIES makes every visitor look like the proxy; tell the user.
- get_access_summary / get_access_log answer "how many visitors, from where, which crawlers" for an HTTP service (no IPs are stored).
- import_compose turns a docker-compose.yml into a project (use dry_run first to see the mapping and warnings).
- When a disk runs low, Servify protects it: builds, image pulls and folder backups are refused (error "Low disk space: …") and logs/metrics stop being stored until there is room. overview says so; deleting services, volumes, backups or old deployments frees space and is always allowed.`;

function lowDiskNote(d: ReturnType<typeof diskSummary>): string {
  const low = d.disks.filter((x) => x.level !== 'ok').map((x) => `${x.name}: ${fmt(x.freeBytes ?? 0)} free of ${fmt(x.totalBytes ?? 0)} (${x.level === 'protect' ? `protected below ${fmt(x.protectBytes ?? 0)}` : `warning below ${fmt(x.warnBytes ?? 0)}`})`);
  const fx = [d.paused.length && `Paused: ${d.paused.join('; ')}.`, d.refused.length && `Refused: ${d.refused.join('; ')}.`].filter(Boolean).join(' ');
  return `LOW DISK SPACE (${d.level}) — ${low.join('; ')}. ${fx} ${d.howToFree ?? ''}`.replace(/\s+/g, ' ').trim();
}

function scopeNote(p: Principal): string {
  if (p.actor.type === 'user') return '';
  const what = p.scope === 'read' ? 'read-only' : p.scope === 'deploy' ? 'deploy-only (deploy, restart, roll back, update images; read status and logs; no settings, variables, volumes, domains or deletes; secrets masked)' : 'read and write';
  const where = isScoped(p) ? `, limited to ${p.projects!.length} project(s) and their environments — overview lists them; it cannot create projects` : '';
  return `\n- This token is ${what}${where}. Owner-only actions (servers, instance settings, host folders, published ports…) need the dashboard.`;
}

export function buildMcpServer(principal: Principal): McpServer {
  const server = new McpServer({ name: 'servify', version: config.version }, { instructions: INSTRUCTIONS + scopeNote(principal) });
  const actor = principal.actor;
  const write = principal.scope === 'write';
  const view = { revealSecrets: write };

  /**
   * Every tool goes through its entry in policy.ts before it runs: the token's level, then (for tokens limited to some
   * projects) that the project, service, deployment, volume or backup its arguments name is in reach. A tool missing
   * from the table answers the owner only.
   */
  const register = server.registerTool.bind(server) as (name: string, def: any, cb: (args: any, extra: any) => Promise<ToolResult>) => unknown;
  const tool = (name: string, def: any, cb: (args: any) => Promise<ToolResult>) =>
    register(name, def, async (args: any) => {
      const a = args ?? {};
      try {
        const policy = TOOL_POLICIES[name];
        const targets = Object.entries(policy?.params ?? {}).map(([k, kind]) => [kind, a[k]] as [TargetKind, unknown]);
        checkCall(principal, policy, targets, { skipSafetyBackup: a.skipSafetyBackup });
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
      return cb(a);
    });
  /** Deployments come back with their variables masked unless the token may see secrets. */
  const dep = (d: Parameters<typeof ops.serializeDeployment>[0]) => ops.serializeDeployment(d, view);

  const svcRef = z.string().describe('Service id, slug, or "project/service"');
  const projRef = z.string().describe('Project id or slug');

  tool(
    'overview',
    { title: 'Overview', description: 'List all projects and their services with status, replicas and URLs. Start here.', inputSchema: {} },
    async () => {
      const r = await wrap(() =>
        ops.listProjects().filter((p) => inReach(principal, p.id)).map((p) => ({
          id: p.id,
          name: p.name,
          slug: p.slug,
          services: servicesTable.all('WHERE project_id = ?', p.id).map(ops.serviceSummary),
        })),
      )({});
      // Low disk space: said after the list (its shape stays the same), without host paths.
      const disk = diskSummary();
      if (!r.isError && disk.level !== 'ok') r.content.push({ type: 'text', text: lowDiskNote(disk) });
      return r;
    },
  );

  tool(
    'create_project',
    { description: 'Create a new project (a canvas that groups services sharing a private network).', inputSchema: { name: z.string() } },
    wrap(({ name }: { name: string }) => {
      return ops.createProject(actor, { name });
    }),
  );

  tool(
    'delete_project',
    { description: 'Delete a project and ALL its services, containers and volumes. Irreversible.', inputSchema: { project: projRef }, annotations: { destructiveHint: true } },
    wrap(async ({ project }: { project: string }) => {
      await ops.deleteProject(actor, project);
      return 'deleted';
    }),
  );

  tool(
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

  tool(
    'list_templates',
    { description: 'List one-click templates (databases, caches, tools).', inputSchema: {} },
    wrap(() => ops.listTemplates().map((t) => ({ id: t.id, name: t.name, description: t.description, image: t.image, category: t.category }))),
  );

  tool(
    'create_service',
    {
      description:
        'Create a service in a project from ONE of: templateId, image, repo (git URL or owner/repo), path (local folder), external (route to another machine, owner only) or redirect (a URL its domains redirect to). Deploys immediately unless deploy=false. Returns the service and its first deployment id.',
      inputSchema: { project: projRef, ...ops.createServiceInput.shape },
    },
    wrap(async ({ project, ...input }: { project: string } & ops.CreateServiceInput) => {
      return ops.createService(actor, ops.getProjectOrThrow(project).id, input);
    }),
  );

  tool(
    'get_service',
    { description: 'Get full details of a service: config, variables, replicas, URL, pending changes.', inputSchema: { service: svcRef } },
    wrap(({ service }: { service: string }) => {
      const s = ops.getServiceOrThrow(service);
      return { ...ops.serializeService(s, view), replicas: replicasOf(s.id) };
    }),
  );

  tool(
    'update_service',
    {
      description: 'Update service settings (name, source, port, healthcheck incl. autoRestart/restartAfterSec for hung replicas, strategy, domains, access control (IP allow/deny lists, basic auth, rate limit), autoscale, resources, start command…). Source/env/port changes need deploy_service to take effect; access control applies immediately.',
      inputSchema: { service: svcRef, ...ops.updateServiceInput.omit({ x: true, y: true }).shape },
    },
    wrap(async ({ service, ...patch }: { service: string } & ops.UpdateServiceInput) => {
      return ops.updateService(actor, service, patch);
    }),
  );

  tool(
    'deploy_service',
    {
      description:
        'Build (if needed) and deploy the service with its current settings. Zero-downtime for stateless services. A new image on a service with data first needs a recent backup (reused, or taken first, per its safety backup setting); without one the deployment fails with "no safety backup: …" and nothing changes — tell the user, and pass skipSafetyBackup only if they decide to go ahead anyway. A registry image is pulled when it is `:latest` or not on the server yet; if that pull fails the deployment fails ("pull failed: …") and the running version stays. useCachedImage: true deploys the copy already on the server instead (only when the registry is down and an older image is acceptable).',
      inputSchema: { service: svcRef, useCachedImage: z.boolean().optional(), skipSafetyBackup: z.boolean().optional().describe('Go ahead without the safety backup a new image on a service with data needs (only when the user said so)') },
    },
    wrap(({ service, useCachedImage, skipSafetyBackup }: { service: string; useCachedImage?: boolean; skipSafetyBackup?: boolean }) => {
      ops.assertCanBuild(service);
      return dep(ops.deployService(actor, service, 'agent', { useCachedImage: useCachedImage === true, skipSafetyBackup: skipSafetyBackup === true }));
    }),
  );

  tool(
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

  tool(
    'scale_service',
    { description: 'Set the number of replicas. Traffic is load-balanced across healthy replicas.', inputSchema: { service: svcRef, replicas: z.number().int().min(0).max(32) } },
    wrap(async ({ service, replicas }: { service: string; replicas: number }) => {
      const s = await ops.scaleService(actor, service, replicas);
      return ops.serviceSummary(s);
    }),
  );

  tool(
    'restart_service',
    { description: 'Zero-downtime restart: roll the current image onto fresh replicas.', inputSchema: { service: svcRef, skipSafetyBackup: z.boolean().optional().describe('Go ahead without the safety backup a new image on a service with data needs (only when the user said so)') } },
    wrap(({ service, skipSafetyBackup }: { service: string; skipSafetyBackup?: boolean }) => {
      return dep(ops.restartService(actor, service, { skipSafetyBackup: skipSafetyBackup === true }));
    }),
  );

  tool(
    'stop_service',
    { description: 'Stop all replicas of a service (keeps config and volumes).', inputSchema: { service: svcRef } },
    wrap(async ({ service }: { service: string }) => {
      return ops.serviceSummary(await ops.stopService(actor, service));
    }),
  );

  tool(
    'start_service',
    { description: 'Start a stopped service.', inputSchema: { service: svcRef } },
    wrap(({ service }: { service: string }) => {
      return ops.startService(actor, service);
    }),
  );

  tool(
    'delete_service',
    {
      description:
        'Delete a service, its containers and built images. Its volumes stay as detached volumes with their data, unless deleteVolumes is true (then the data is gone for good — after a recent backup of it is found, or taken first; if that is impossible nothing is deleted and the error says why).',
      inputSchema: {
        service: svcRef,
        deleteVolumes: z.boolean().optional().describe('Also delete the data in its volumes (default false)'),
        keepVolumes: z.boolean().optional().describe('Older name for the default; true always keeps the volumes'),
        skipSafetyBackup: z.boolean().optional().describe('With deleteVolumes: delete the data without a safety backup (only when the user said so)'),
      },
      annotations: { destructiveHint: true },
    },
    wrap(async ({ service, deleteVolumes, keepVolumes, skipSafetyBackup }: { service: string; deleteVolumes?: boolean; keepVolumes?: boolean; skipSafetyBackup?: boolean }) => {
      const wipe = deleteVolumes === true && keepVolumes !== true;
      await ops.deleteService(actor, service, { deleteVolumes: wipe, skipSafetyBackup: skipSafetyBackup === true });
      return wipe ? 'deleted, with its volumes' : 'deleted (its volumes, if any, are kept as detached volumes)';
    }),
  );

  tool(
    'rollback_service',
    { description: 'Redeploy a previous deployment (by id, see list_deployments). An older image on a service with data needs a safety backup like a deploy.', inputSchema: { service: svcRef, deploymentId: z.string(), skipSafetyBackup: z.boolean().optional().describe('Go ahead without the safety backup a new image on a service with data needs (only when the user said so)') } },
    wrap(({ service, deploymentId, skipSafetyBackup }: { service: string; deploymentId: string; skipSafetyBackup?: boolean }) => {
      return dep(ops.rollbackService(actor, service, deploymentId, { skipSafetyBackup: skipSafetyBackup === true }));
    }),
  );

  tool(
    'update_image',
    {
      description:
        "Ship a new version of an image service: switch it to another tag of its image (e.g. the tag CI just pushed) and deploy, or without a tag pull its current tag again and deploy. For a build, rebuild on a freshly pulled base image (a tag sets the build argument the base image's tag comes from). Returns the deployment — follow it with wait_for_deployment. A new image on a service with data first needs a recent safety backup, like deploy_service.",
      inputSchema: {
        service: svcRef,
        tag: z.string().optional().describe('The tag to switch to, e.g. "1.4.2" or "sha-3f2a1c9"; the repository stays the same'),
        skipSafetyBackup: z.boolean().optional().describe('Go ahead without the safety backup a new image on a service with data needs (only when the user said so)'),
      },
    },
    wrap(async ({ service, tag, skipSafetyBackup }: { service: string; tag?: string; skipSafetyBackup?: boolean }) =>
      dep(await ops.updateServiceImage(actor, service, tag?.trim() || null, { skipSafetyBackup: skipSafetyBackup === true })),
    ),
  );

  tool(
    'set_variables',
    {
      description: 'Set environment variables (merged unless replace=true). Values may reference other services: ${{ postgres.DATABASE_URL }}. Redeploy to apply.',
      inputSchema: { service: svcRef, variables: z.record(z.string(), z.string()), replace: z.boolean().optional(), secretKeys: z.array(z.string()).optional() },
    },
    wrap(({ service, variables, replace, secretKeys }: { service: string; variables: Record<string, string>; replace?: boolean; secretKeys?: string[] }) => {
      const s = ops.setVariables(actor, service, variables, { replace, secretKeys });
      return { env: Object.keys(s.env), pendingChanges: s.pendingChanges };
    }),
  );

  tool(
    'delete_variable',
    { description: 'Remove one environment variable.', inputSchema: { service: svcRef, key: z.string() } },
    wrap(({ service, key }: { service: string; key: string }) => {
      return Object.keys(ops.deleteVariable(actor, service, key).env);
    }),
  );

  tool(
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

  tool(
    'get_deployment_logs',
    { description: 'Build + deploy log of a deployment.', inputSchema: { deployment: z.string(), tail: z.number().int().min(1).max(2000).optional() } },
    wrap(({ deployment, tail }: { deployment: string; tail?: number }) => ops.deploymentLogs(deployment).slice(-(tail ?? 200)).map((l) => l.text).join('\n')),
  );

  tool(
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

  tool(
    'get_access_log',
    {
      description:
        'HTTP access log of a service from the router, newest first, kept for 7 days: time, host, method, path+query, status, bytes, ms, referrer, user agent, replica, bot flag and a visitor key (a daily-salted hash; no IPs are stored). Page with `before` = the previous `next`.',
      inputSchema: {
        service: svcRef,
        since: z.string().optional().describe('ISO time or epoch ms'),
        until: z.string().optional().describe('ISO time or epoch ms'),
        since_minutes: z.number().min(1).max(10080).optional().describe('Only requests from the last N minutes'),
        path: z.string().optional().describe('Path prefix ("/blog"), or a glob with * ("*.php")'),
        status: z.string().optional().describe('404, 4xx, or a list like "301,302,5xx"'),
        q: z.string().optional().describe('Substring of path, referrer, user agent or host'),
        bot: z.boolean().optional().describe('true = only bots/crawlers, false = only people'),
        visitor: z.string().optional().describe('Only one visitor key'),
        limit: z.number().int().min(1).max(1000).optional().describe('Default 100'),
        before: z.string().optional().describe('Paging cursor: `next` from the previous call'),
      },
    },
    wrap((a: { service: string; since?: string; until?: string; since_minutes?: number; path?: string; status?: string; q?: string; bot?: boolean; visitor?: string; limit?: number; before?: string }) => {
      const time = (v?: string) => (v ? (/^\d+$/.test(v) ? Number(v) : Date.parse(v)) : undefined);
      const since = a.since_minutes ? Date.now() - a.since_minutes * 60_000 : time(a.since);
      const until = time(a.until);
      if (Number.isNaN(since) || Number.isNaN(until)) throw new Error('since/until must be ISO times or epoch ms');
      return queryAccessLog(ops.getServiceOrThrow(a.service).id, { since, until, path: a.path, status: a.status, q: a.q, bot: a.bot, visitor: a.visitor, limit: a.limit, before: a.before });
    }),
  );

  tool(
    'get_access_summary',
    {
      description:
        'One UTC day of a service’s HTTP traffic: requests and unique visitors with bots/crawlers (GPTBot, ClaudeBot, PerplexityBot, Googlebot…) counted apart from people, status classes, top paths, top referrer hosts, top UTM sources, top user agents and top bots.',
      inputSchema: {
        service: svcRef,
        day: z.string().optional().describe('YYYY-MM-DD in UTC; default today'),
        top: z.number().int().min(1).max(100).optional().describe('Entries per top list (default 20)'),
      },
    },
    wrap(({ service, day, top }: { service: string; day?: string; top?: number }) => accessSummary(ops.getServiceOrThrow(service).id, day, top ?? 20)),
  );

  tool(
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

  tool(
    'exec_command',
    {
      description: 'Run a command inside a running replica and return its output and exit code (e.g. migrations, diagnostics). A string runs through /bin/sh -c; an array is passed as the argv as is (no shell, so no quoting to get right).',
      inputSchema: { service: svcRef, command: z.union([z.string(), z.array(z.string()).min(1)]), replica: z.number().int().min(0).optional() },
    },
    wrap(async ({ service, command, replica }: { service: string; command: string | string[]; replica?: number }) => {
      return ops.execInService(actor, service, command, replica);
    }),
  );

  tool(
    'export_project',
    { description: 'Export a project as a servify.json spec (services, sources, scaling, variables). Secrets are blanked unless includeSecrets.', inputSchema: { project: projRef, includeSecrets: z.boolean().optional() } },
    wrap(({ project, includeSecrets }: { project: string; includeSecrets?: boolean }) => ops.exportProject(project, { secrets: !!includeSecrets && write })),
  );

  tool(
    'import_project',
    {
      description: 'Create a whole project from a servify.json spec in one call: {"servify":1,"name":"…","services":[{"name":"api","source":{"type":"image","image":"nginx:alpine"},"replicas":2,"env":{…}}]}. Deploys everything unless deploy=false.',
      inputSchema: { spec: z.any(), deploy: z.boolean().optional(), name: z.string().optional() },
    },
    wrap(async ({ spec, deploy, name }: { spec: any; deploy?: boolean; name?: string }) => {
      return ops.importProject(actor, typeof spec === 'string' ? JSON.parse(spec) : spec, { deploy, name });
    }),
  );

  tool(
    'run_job',
    { description: 'Run a scheduled (cron) service now as a one-off container. Use list_runs to see the outcome and output.', inputSchema: { service: svcRef } },
    wrap(async ({ service }: { service: string }) => {
      return ops.runServiceJob(actor, service);
    }),
  );

  tool(
    'list_runs',
    {
      description:
        'Recent runs of a scheduled job: status (succeeded, failed, running, or skipped — a start that did not run, with the reason and how many in a row), exit code, output tail; catchUp marks a run made late for a start missed while Servify was down. get_service → cron.failing says since when it keeps failing.',
      inputSchema: { service: svcRef, limit: z.number().int().min(1).max(100).optional() },
    },
    wrap(({ service, limit }: { service: string; limit?: number }) =>
      ops.serviceRuns(service, limit ?? 10).map((r) =>
        r.status === 'skipped'
          ? { id: r.id, status: r.status, reason: r.reason ?? '', count: r.skipCount ?? 1, at: new Date(r.startedAt).toISOString(), lastAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null }
          : {
              id: r.id,
              status: r.status,
              exitCode: r.exitCode,
              trigger: r.trigger,
              ...(r.catchUp ? { catchUp: { dueAt: new Date(r.catchUp.dueAt).toISOString(), missed: r.catchUp.missed } } : {}),
              startedAt: new Date(r.startedAt).toISOString(),
              durationMs: r.finishedAt ? r.finishedAt - r.startedAt : null,
              output: r.output.slice(-2000),
            },
      ),
    ),
  );

  tool(
    'load_test',
    { description: 'Send synthetic HTTP traffic to a service through the load balancer (to verify scaling, balancing or autoscaling).', inputSchema: { service: svcRef, rps: z.number().min(1).max(500).optional(), seconds: z.number().int().min(1).max(300).optional() } },
    wrap(({ service, rps, seconds }: { service: string; rps?: number; seconds?: number }) => {
      return ops.loadTest(actor, service, rps ?? 30, seconds ?? 30);
    }),
  );

  tool(
    'get_activity',
    { description: 'Recent activity (who did what — users, agents, system).', inputSchema: { project: projRef.optional(), limit: z.number().int().min(1).max(200).optional() } },
    wrap(({ project, limit }: { project?: string; limit?: number }) =>
      ops.listActivity({ projectId: project ? ops.getProjectOrThrow(project).id : undefined, limit: limit ?? 30, projectIds: reachIds(principal) }).map((a) => ({
        at: new Date(a.ts).toISOString(),
        actor: `${a.actorType}:${a.actor}`,
        summary: a.summary,
      })),
    ),
  );

  tool(
    'backup_service',
    { description: 'Back up a service now: databases (Postgres/MySQL/MongoDB) are dumped, other volumes archived. Returns the backup record.', inputSchema: { service: svcRef, destination: z.string().optional().describe('"local" (default) or a destination id from settings') } },
    wrap(async ({ service, destination }: { service: string; destination?: string }) => {
      return ops.backupNow(actor, service, destination);
    }),
  );

  tool(
    'list_backups',
    { description: 'Backups of a service, newest first (id, status, size, sha256 checksum — missing on older, unverified backups — destination, when, and the last test restore).', inputSchema: { service: svcRef } },
    wrap(({ service }: { service: string }) => ops.serviceBackups(service, 30)),
  );

  tool(
    'restore_backup',
    {
      description: "Replace a service's data with a backup. The backup is checked end to end first (a damaged or incomplete one is refused and nothing changes), then a safety backup is taken and the data rebuilt; the service restarts. Runs in the background — poll list_backups / get_activity.",
      inputSchema: { backup_id: z.string() },
      annotations: { destructiveHint: true },
    },
    wrap(({ backup_id }: { backup_id: string }) => {
      return restoreBackup(actor, backup_id);
    }),
  );

  tool(
    'test_restore',
    {
      description:
        "Prove a backup restores, without touching the service: the archive is read end to end (checksum, gunzip, tar listing) and restored into a scratch volume, or a dump loaded into a throwaway database container of the same image and queried; everything it created is removed. The result is kept on the backup (list_backups → test) and a failure is notified. wait: true returns the backup record when done (can take long for big backups); otherwise it runs in the background.",
      inputSchema: { backup_id: z.string(), wait: z.boolean().optional() },
    },
    wrap(async ({ backup_id, wait }: { backup_id: string; wait?: boolean }) => {
      return testRestore(actor, backup_id, { wait: wait === true });
    }),
  );

  tool(
    'import_compose',
    {
      description: 'Create a project from a docker-compose.yml. Use dry_run first: it returns the mapped services and warnings (privileged, host networking, the Docker socket… are never honoured; host folders, build: contexts (folders of the server) and taking over existing volumes need the owner in the dashboard).',
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
      // Even a dry run reads files under base_path (env_file, .env): write tokens for all projects only (policy.ts).
      if (dry_run) return ops.planComposeImport({ yaml, env, basePath: base_path, name });
      return ops.importCompose(actor, { yaml, env, basePath: base_path, name, deploy });
    }),
  );

  tool(
    'list_environments',
    { description: 'Environments of a project: production plus copies like staging and pull-request previews, with their slugs (use the slug as the project for other tools).', inputSchema: { project: projRef } },
    wrap(({ project }: { project: string }) => environmentsOf(project)),
  );

  tool(
    'create_environment',
    {
      description: 'Copy a project into a new environment (fresh volumes, no custom domains) with its own URLs. Optionally build git services from another branch.',
      inputSchema: { project: projRef, name: z.string().describe('e.g. staging'), branch: z.string().optional(), deploy: z.boolean().optional() },
    },
    wrap(async ({ project, name, branch, deploy }: { project: string; name: string; branch?: string; deploy?: boolean }) => {
      const env = await createEnvironment(actor, project, { name, branch, deploy });
      return { id: env.id, slug: env.slug, environment: env.envName };
    }),
  );

  tool(
    'set_previews',
    { description: 'Turn pull-request preview environments on or off for a project (needs the git webhook configured on the repository).', inputSchema: { project: projRef, enabled: z.boolean() } },
    wrap(({ project, enabled }: { project: string; enabled: boolean }) => {
      return { previews: setPreviews(actor, project, enabled).previews };
    }),
  );

  tool(
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

  tool(
    'create_volume',
    { description: 'Create a persistent volume in a project, optionally attaching it to a service right away (the service redeploys).', inputSchema: { project: projRef, name: z.string(), service: svcRef.optional(), mount_path: z.string().optional().describe('e.g. /data') } },
    wrap(async ({ project, name, service, mount_path }: { project: string; name: string; service?: string; mount_path?: string }) => {
      const p = ops.getProjectOrThrow(project);
      return createVolume(actor, p.id, { name, serviceId: service ? ops.getServiceOrThrow(service).id : undefined, mountPath: mount_path });
    }),
  );

  tool(
    'attach_volume',
    { description: 'Attach a detached volume to a service at a mount path. The service redeploys with the data; services with a volume run 1 replica.', inputSchema: { volume: z.string().describe('Volume id or "project/volume"'), service: svcRef, mount_path: z.string() } },
    wrap(async ({ volume, service, mount_path }: { volume: string; service: string; mount_path: string }) => {
      return attachVolume(actor, volume, ops.getServiceOrThrow(service).id, mount_path);
    }),
  );

  tool(
    'detach_volume',
    { description: 'Detach a volume from its service. The data is kept; the service redeploys without it (a database would start empty).', inputSchema: { volume: z.string() }, annotations: { destructiveHint: true } },
    wrap(async ({ volume }: { volume: string }) => {
      return detachVolume(actor, volume);
    }),
  );

  tool(
    'delete_volume',
    {
      description:
        'Permanently delete a detached volume and all its data (keep_data: only forget it, the Docker volume stays). A recent backup holding the volume is required, or taken first; if that is impossible nothing is deleted and the error says why.',
      inputSchema: { volume: z.string(), keep_data: z.boolean().optional(), skip_safety_backup: z.boolean().optional().describe('Delete without a safety backup (only when the user said so)') },
      annotations: { destructiveHint: true },
    },
    wrap(async ({ volume, keep_data, skip_safety_backup }: { volume: string; keep_data?: boolean; skip_safety_backup?: boolean }) => {
      const r = await deleteVolume(actor, volume, { keepData: !!keep_data, skipSafetyBackup: skip_safety_backup === true });
      return { ok: true, ...r };
    }),
  );

  tool(
    'share_volume',
    {
      description: 'Mount a volume read-only into another service of the same project (e.g. a backup sidecar reading a game server\'s data). The service redeploys. Remove with unmount.',
      inputSchema: { volume: z.string().describe('Volume id or "project/volume"'), service: svcRef, mount_path: z.string() },
    },
    wrap(async ({ volume, service, mount_path }: { volume: string; service: string; mount_path: string }) => {
      return shareVolume(actor, volume, ops.getServiceOrThrow(service).id, mount_path);
    }),
  );

  tool(
    'unmount',
    { description: 'Remove a read-only share or a host folder from a service (nothing is deleted). The service redeploys.', inputSchema: { service: svcRef, mount_path: z.string() } },
    wrap(async ({ service, mount_path }: { service: string; mount_path: string }) => {
      return removeMount(actor, ops.getServiceOrThrow(service).id, mount_path);
    }),
  );

  tool(
    'cluster_status',
    { description: 'Database cluster status: which replica is the primary, each standby\'s replication lag and sync state, failover settings.', inputSchema: { service: svcRef } },
    wrap(({ service }: { service: string }) => clusterStatus(ops.getServiceOrThrow(service)) ?? 'not a cluster'),
  );

  tool(
    'switchover',
    { description: 'Gracefully move a database cluster\'s primary to a standby (the old primary is rebuilt as a standby). Use before maintenance.', inputSchema: { service: svcRef, to: z.number().int().min(0).optional().describe('Replica index to promote; default: the most up-to-date standby') }, annotations: { destructiveHint: true } },
    wrap(async ({ service, to }: { service: string; to?: number }) => {
      return switchover(actor, ops.getServiceOrThrow(service).id, to);
    }),
  );

  tool(
    'list_servers',
    { description: 'Machines this Servify runs services on: this machine plus servers connected with `servify agent` (status, Docker version, how many services/replicas each runs). Add servers in the dashboard (Servers).', inputSchema: {} },
    wrap(() => {
      const disks = diskState().disks;
      return listServers().map((s) => ({ ...s, disks: disks.filter((d) => (s.local ? !d.nodeId : d.nodeId === s.id)).map((d) => ({ name: d.name, roles: d.roles, level: d.level, freeBytes: d.freeBytes, totalBytes: d.totalBytes, warnBytes: d.warnBytes, protectBytes: d.protectBytes })) }));
    }),
  );

  tool(
    'move_service',
    {
      description: 'Run a service on another server (id or name from list_servers; "local" = this machine). Redeploys there, then retires the old replicas. Services with volumes cannot move (data stays on its server). Private service names keep working across servers (connections to the main port are relayed through Servify).',
      inputSchema: { service: svcRef, server: z.string() },
      annotations: { destructiveHint: true },
    },
    wrap(async ({ service, server: target }: { service: string; server: string }) => {
      return ops.moveService(actor, service, target);
    }),
  );

  tool(
    'move_service_to_project',
    {
      description:
        'Move a service to another project (create_project first for a new one). It keeps its id, deploy history, variables, domains, volumes (same data, no copy), backups, job runs, logs and metrics; a running service restarts briefly on the new project\'s private network. Always call with dry_run: true first and tell the user its warnings: services left behind that reference it (${{svc.VAR}} or its host name) and services it references stop reaching each other, missing shared variables, its generated URL changes. Blockers (environments, clusters, volume shares, a name already taken there, a deploy or backup in progress) are never overridden; for a taken name pass name (it moves under that name). References that would break are refused unless force: true.',
      inputSchema: {
        service: svcRef,
        project: projRef.describe('The project to move it to (id or slug); not an environment or preview'),
        name: z.string().max(64).optional().describe('Move it under this name (when its name is taken there)'),
        dry_run: z.boolean().optional().describe('Only report what would happen'),
        force: z.boolean().optional().describe('Go ahead although references would break (after telling the user)'),
      },
      annotations: { destructiveHint: true },
    },
    wrap(({ service, project, name, dry_run, force }: { service: string; project: string; name?: string; dry_run?: boolean; force?: boolean }) => {
      const id = ops.getServiceOrThrow(service).id;
      if (dry_run) return planMove(id, project, { name });
      const r = moveServiceToProject(actor, id, project, { force: force === true, name });
      return { service: ops.serviceSummary(ops.getServiceOrThrow(id)), restarted: r.restarted, warnings: r.plan?.warnings.map((w) => w.message) ?? [] };
    }),
  );

  tool(
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
