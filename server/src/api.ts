import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { ZodError } from 'zod';
import * as ops from './ops.ts';
import { bus } from './events.ts';
import {
  SESSION_COOKIE,
  isSetUp,
  setPassword,
  checkPassword,
  createSession,
  destroySession,
  principalFor,
  createToken,
  hostAllowed,
  originOk,
  type Principal,
} from './auth.ts';
import { tokensTable, deployments as deploymentsTable } from './db.ts';
import { HttpError } from './util.ts';
import { config } from './config.ts';
import { docker, dockerTarget } from './docker.ts';
import { readDeploymentLog } from './deployer.ts';
import type { ServerEvent } from './types.ts';

type Env = { Variables: { principal: Principal } };

export const api = new Hono<Env>();

api.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as any);
  if (err instanceof ZodError) {
    const msg = err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    return c.json({ error: msg }, 400);
  }
  console.error('[api]', err);
  return c.json({ error: (err as Error).message || 'internal error' }, 500);
});

// Host / origin validation for everything under /api.
api.use('*', async (c, next) => {
  if (!hostAllowed(c.req.header('host'))) return c.json({ error: 'host not allowed' }, 403);
  if (!originOk(c.req.header('origin'), c.req.header('host'), c.req.method)) return c.json({ error: 'origin not allowed' }, 403);
  await next();
});

// ───────────────────────────── auth ─────────────────────────────

api.get('/auth/status', (c) => {
  const p = principalFor({ cookie: getCookie(c, SESSION_COOKIE), bearer: bearer(c) });
  return c.json({ setUp: isSetUp(), authenticated: !!p, authMode: config.authMode, version: config.version });
});

api.post('/auth/setup', async (c) => {
  if (isSetUp()) throw new HttpError(409, 'already set up');
  const { password } = await c.req.json<{ password: string }>();
  setPassword(password);
  const s = createSession();
  setCookie(c, SESSION_COOKIE, s.id, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: s.maxAge });
  return c.json({ ok: true });
});

const loginAttempts: number[] = [];
api.post('/auth/login', async (c) => {
  const nowTs = Date.now();
  while (loginAttempts.length && nowTs - loginAttempts[0] > 60_000) loginAttempts.shift();
  if (loginAttempts.length > 10) throw new HttpError(429, 'too many attempts, wait a minute');
  loginAttempts.push(nowTs);
  const { password } = await c.req.json<{ password: string }>();
  if (!checkPassword(password ?? '')) throw new HttpError(401, 'wrong password');
  const s = createSession();
  setCookie(c, SESSION_COOKIE, s.id, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: s.maxAge });
  return c.json({ ok: true });
});

api.post('/auth/logout', (c) => {
  destroySession(getCookie(c, SESSION_COOKIE));
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

function bearer(c: Context): string | undefined {
  const h = c.req.header('authorization');
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  return c.req.query('token') || undefined;
}

// Everything below requires a principal.
api.use('*', async (c, next) => {
  const p = principalFor({ cookie: getCookie(c, SESSION_COOKIE), bearer: bearer(c) });
  if (!p) return c.json({ error: 'unauthorized' }, 401);
  if (p.scope === 'read' && c.req.method !== 'GET') return c.json({ error: 'this token is read-only' }, 403);
  c.set('principal', p);
  await next();
});

const actor = (c: Context<Env>) => c.get('principal').actor;
const view = (c: Context<Env>) => ({ revealSecrets: c.get('principal').scope === 'write' });

// ───────────────────────────── system ─────────────────────────────

api.get('/system', async (c) => {
  let dockerInfo: any = null;
  try {
    const info = await docker.info();
    dockerInfo = {
      ok: true,
      version: info.ServerVersion,
      os: info.OperatingSystem,
      cpus: info.NCPU,
      memGb: Math.round((info.MemTotal / 1024 ** 3) * 10) / 10,
      containers: info.ContainersRunning,
      endpoint: 'socketPath' in dockerTarget ? dockerTarget.socketPath : `${dockerTarget.host}:${dockerTarget.port}`,
    };
  } catch (e) {
    dockerInfo = { ok: false, error: (e as Error).message };
  }
  return c.json({
    version: config.version,
    docker: dockerInfo,
    proxy: { host: config.proxyHost, port: config.proxyPort, baseDomain: config.baseDomain },
    api: { host: config.host, port: config.port },
    dataDir: config.dataDir,
    authMode: config.authMode,
    actor: actor(c),
    scope: c.get('principal').scope,
  });
});

// ───────────────────────────── projects ─────────────────────────────

api.get('/projects', (c) => c.json(ops.listProjects()));
api.post('/projects', async (c) => c.json(ops.createProject(actor(c), await c.req.json()), 201));
api.get('/projects/:id', (c) => c.json(ops.projectSnapshot(c.req.param('id'), view(c))));
api.patch('/projects/:id', async (c) => c.json(ops.updateProject(actor(c), c.req.param('id'), await c.req.json())));
api.delete('/projects/:id', async (c) => {
  await ops.deleteProject(actor(c), c.req.param('id'));
  return c.json({ ok: true });
});
api.post('/projects/:id/demo', async (c) => c.json(await ops.seedDemo(actor(c), c.req.param('id'))));
api.get('/projects/:id/activity', (c) => {
  const p = ops.getProjectOrThrow(c.req.param('id'));
  return c.json(ops.listActivity({ projectId: p.id, limit: Number(c.req.query('limit') ?? 100) }));
});

// ───────────────────────────── services ─────────────────────────────

api.post('/projects/:id/services', async (c) => c.json(await ops.createService(actor(c), c.req.param('id'), await c.req.json()), 201));
api.get('/services/:id', (c) => c.json(ops.serializeService(ops.getServiceOrThrow(c.req.param('id')), view(c))));
api.patch('/services/:id', async (c) => c.json(await ops.updateService(actor(c), c.req.param('id'), await c.req.json())));
api.delete('/services/:id', async (c) => {
  await ops.deleteService(actor(c), c.req.param('id'), { keepVolumes: c.req.query('keepVolumes') === '1' });
  return c.json({ ok: true });
});
api.post('/services/:id/duplicate', async (c) => c.json(await ops.duplicateService(actor(c), c.req.param('id')), 201));
api.post('/services/:id/deploy', (c) => c.json(ops.deployService(actor(c), c.req.param('id'))));
api.post('/services/:id/restart', (c) => c.json(ops.restartService(actor(c), c.req.param('id'))));
api.post('/services/:id/stop', async (c) => c.json(await ops.stopService(actor(c), c.req.param('id'))));
api.post('/services/:id/start', (c) => c.json(ops.startService(actor(c), c.req.param('id'))));
api.post('/services/:id/scale', async (c) => {
  const { replicas } = await c.req.json<{ replicas: number }>();
  return c.json(await ops.scaleService(actor(c), c.req.param('id'), Number(replicas)));
});
api.post('/services/:id/rollback', async (c) => {
  const { deploymentId } = await c.req.json<{ deploymentId: string }>();
  return c.json(ops.rollbackService(actor(c), c.req.param('id'), deploymentId));
});
api.put('/services/:id/variables', async (c) => {
  const body = await c.req.json<{ variables: Record<string, string>; replace?: boolean; secretKeys?: string[] }>();
  return c.json(ops.setVariables(actor(c), c.req.param('id'), body.variables ?? {}, { replace: body.replace, secretKeys: body.secretKeys }));
});
api.delete('/services/:id/variables/:key', (c) => c.json(ops.deleteVariable(actor(c), c.req.param('id'), c.req.param('key'))));
api.get('/services/:id/variables/resolved', (c) => {
  const r = ops.previewVariables(c.req.param('id'));
  if (!view(c).revealSecrets) {
    const svc = ops.getServiceOrThrow(c.req.param('id'));
    for (const k of svc.secretKeys) if (k in r.env) r.env[k] = '••••••••';
  }
  return c.json(r);
});
api.get('/services/:id/deployments', (c) => c.json(ops.listDeployments(c.req.param('id'), Number(c.req.query('limit') ?? 30), view(c))));
api.get('/services/:id/metrics', (c) => c.json(ops.serviceMetrics(c.req.param('id'), Number(c.req.query('seconds') ?? 300))));
api.get('/services/:id/logs', async (c) =>
  c.json(await ops.serviceLogs(c.req.param('id'), { tail: Number(c.req.query('tail') ?? 300), search: c.req.query('search') })),
);
api.post('/services/:id/exec', async (c) => {
  const { command, replica } = await c.req.json<{ command: string; replica?: number }>();
  return c.json(await ops.execInService(actor(c), c.req.param('id'), command, replica));
});

api.post('/services/:id/loadtest', async (c) => {
  const { rps, seconds } = await c.req.json<{ rps?: number; seconds?: number }>();
  return c.json(ops.loadTest(actor(c), c.req.param('id'), rps ?? 30, seconds ?? 30));
});
api.delete('/services/:id/loadtest', (c) => c.json(ops.stopLoadTest(ops.getServiceOrThrow(c.req.param('id')).id)));

api.get('/services/:id/logs/stream', (c) => {
  const svc = ops.getServiceOrThrow(c.req.param('id'));
  return streamSSE(c, async (stream) => {
    const backlog = await ops.serviceLogs(svc.id, { tail: Number(c.req.query('tail') ?? 300) });
    await stream.writeSSE({ event: 'backlog', data: JSON.stringify(backlog) });
    const queue: ops.LogLine[] = [];
    let flushTimer: NodeJS.Timeout | null = null;
    const flush = () => {
      flushTimer = null;
      if (!queue.length) return;
      const batch = queue.splice(0, queue.length);
      void stream.writeSSE({ event: 'lines', data: JSON.stringify(batch) });
    };
    const stop = ops.followServiceLogs(svc.id, (l) => {
      queue.push(l);
      if (!flushTimer) flushTimer = setTimeout(flush, 80);
    });
    const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }), 15000);
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    clearInterval(ping);
    stop();
  });
});

// ───────────────────────────── deployments ─────────────────────────────

api.get('/deployments/:id', (c) => {
  const d = deploymentsTable.get(c.req.param('id'));
  if (!d) throw new HttpError(404, 'deployment not found');
  return c.json(ops.serializeDeployment(d, view(c)));
});
api.get('/deployments/:id/logs', (c) => c.json(ops.deploymentLogs(c.req.param('id'))));
api.post('/deployments/:id/cancel', (c) => c.json(ops.cancelDeployment(actor(c), c.req.param('id'))));
api.get('/deployments/:id/logs/stream', (c) => {
  const depId = c.req.param('id');
  return streamSSE(c, async (stream) => {
    const lines = readDeploymentLog(depId).map((l) => {
      const sp = l.indexOf(' ');
      return { ts: Number(l.slice(0, sp)), text: l.slice(sp + 1) };
    });
    await stream.writeSSE({ event: 'backlog', data: JSON.stringify(lines) });
    const unsub = bus.subscribe((ev) => {
      if (ev.type === 'deployment.log' && ev.deploymentId === depId) void stream.writeSSE({ event: 'line', data: JSON.stringify({ ts: ev.ts, text: ev.line }) });
      if (ev.type === 'deployment.updated' && ev.deployment.id === depId) void stream.writeSSE({ event: 'status', data: ev.deployment.status });
    });
    const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }), 15000);
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    clearInterval(ping);
    unsub();
  });
});

// ───────────────────────────── realtime events ─────────────────────────────

api.get('/events', (c) => {
  const projectId = c.req.query('project');
  const v = view(c);
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'message', data: JSON.stringify({ type: 'hello', version: config.version } satisfies ServerEvent) });
    const unsub = bus.subscribe((ev) => {
      if (projectId) {
        if (ev.type === 'service.updated' && ev.service.projectId !== projectId) return;
        if (ev.type === 'deployment.updated' && ev.deployment.projectId !== projectId) return;
        if (ev.type === 'replicas' && ev.projectId !== projectId) return;
        if (ev.type === 'deployment.log') return; // per-deployment stream handles these
      }
      let payload: unknown = ev;
      if (ev.type === 'service.updated') payload = { ...ev, service: ops.serializeService(ev.service, v) };
      if (ev.type === 'deployment.updated') payload = { ...ev, deployment: ops.serializeDeployment(ev.deployment, v) };
      void stream.writeSSE({ event: 'message', data: JSON.stringify(payload) });
    });
    const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }), 15000);
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    clearInterval(ping);
    unsub();
  });
});

api.get('/activity', (c) => c.json(ops.listActivity({ limit: Number(c.req.query('limit') ?? 100) })));
api.get('/templates', (c) => c.json(ops.listTemplates()));

// ───────────────────────────── tokens ─────────────────────────────

api.get('/tokens', (c) => {
  if (c.get('principal').actor.type !== 'user') throw new HttpError(403, 'only the owner can manage tokens');
  return c.json(tokensTable.list());
});
api.post('/tokens', async (c) => {
  if (c.get('principal').actor.type !== 'user') throw new HttpError(403, 'only the owner can manage tokens');
  const { name, scope } = await c.req.json<{ name: string; scope?: 'read' | 'write' }>();
  const { token, record } = createToken(name ?? 'agent', scope === 'read' ? 'read' : 'write');
  return c.json({ token, record }, 201);
});
api.delete('/tokens/:id', (c) => {
  if (c.get('principal').actor.type !== 'user') throw new HttpError(403, 'only the owner can manage tokens');
  tokensTable.delete(c.req.param('id'));
  return c.json({ ok: true });
});
