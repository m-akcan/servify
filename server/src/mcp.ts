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
- Services can be referred to by id, slug, or "project/service".`;

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
    { description: 'Recent runtime logs across all replicas (prefixed with replica index).', inputSchema: { service: svcRef, tail: z.number().int().min(1).max(2000).optional(), search: z.string().optional() } },
    wrap(async ({ service, tail, search }: { service: string; tail?: number; search?: string }) => {
      const lines = await ops.serviceLogs(service, { tail: tail ?? 100, search });
      return lines.map((l) => `[#${l.replica}] ${new Date(l.ts).toISOString()} ${l.text}`).join('\n') || '(no logs)';
    }),
  );

  server.registerTool(
    'get_metrics',
    { description: 'Current and recent metrics: requests/s, p95 latency, errors, CPU, memory, per-replica state.', inputSchema: { service: svcRef, seconds: z.number().int().min(10).max(900).optional() } },
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
