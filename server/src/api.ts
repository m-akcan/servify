import { Hono, type Context } from 'hono';
import { overview } from './overview.ts';
import { streamSSE } from 'hono/streaming';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { ZodError } from 'zod';
import * as ops from './ops.ts';
import { bus, recordActivity } from './events.ts';
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
import { autostartStatus, enableAutostart, disableAutostart } from './autostart.ts';
import { dockerForContainer, listServers, addServer, renameServer, rotateServerToken, upgradeAgent, removeServer } from './nodes.ts';
import { readDeploymentLog } from './deployer.ts';
import type { ServerEvent } from './types.ts';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { replicasOf } from './engine.ts';
import * as settings from './settings.ts';
import { testChannel, recentDeliveries } from './notify.ts';
import { recentHookDeliveries, deployHookToken } from './hooks.ts';
import { listCertificates, retryCertificate, localCaPem } from './certs.ts';
import { restoreBackup, deleteBackup, openBackupStream } from './backups.ts';
import { backupsTable } from './db.ts';
import { s3Test } from './s3.ts';
import { keySource, keyPath } from './crypto.ts';
import { listVolumes, createVolume, attachVolume, detachVolume, updateVolume, deleteVolume, unmanagedDockerVolumes, adoptVolume, shareVolume, removeMount } from './volumes.ts';
import { switchover, rebuildMember } from './pgcluster.ts';
import { environmentsOf, createEnvironment, setPreviews } from './envs.ts';

type Env = { Variables: { principal: Principal } };

/** Parse a JSON body; an empty or invalid body becomes a clean 400 (or {} when optional). */
async function jsonBody<T = any>(c: Context): Promise<T> {
  const text = await c.req.text();
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, 'request body must be JSON');
  }
}

/**
 * Register the abort listener before any await: Hono never calls onAbort listeners added
 * after the client has already gone, which would leak subscriptions and Docker streams.
 */
function abortSignal(stream: { onAbort: (fn: () => void) => void }) {
  let aborted = false;
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  stream.onAbort(() => {
    aborted = true;
    resolve();
  });
  return { done, get aborted() { return aborted; } };
}

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
  const { password } = await jsonBody<{ password: string }>(c);
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
  const { password } = await jsonBody<{ password: string }>(c);
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
    proxy: { host: config.proxyHost, port: config.proxyPort, httpsPort: config.httpsPort, baseDomain: config.baseDomain },
    api: { host: config.host, port: config.port },
    dataDir: config.dataDir,
    masterKey: { source: keySource, path: keySource === 'env' ? null : keyPath },
    binPath: fileURLToPath(new URL('../bin/servify.mjs', import.meta.url)),
    authMode: config.authMode,
    actor: actor(c),
    scope: c.get('principal').scope,
  });
});

// ───────────────────────────── projects ─────────────────────────────

api.get('/projects', (c) => c.json(ops.listProjects()));
api.post('/projects', async (c) => c.json(ops.createProject(actor(c), await jsonBody(c)), 201));
api.get('/projects/:id', (c) => c.json(ops.projectSnapshot(c.req.param('id'), view(c))));
api.patch('/projects/:id', async (c) => c.json(ops.updateProject(actor(c), c.req.param('id'), await jsonBody(c))));
api.delete('/projects/:id', async (c) => {
  await ops.deleteProject(actor(c), c.req.param('id'));
  return c.json({ ok: true });
});
api.get('/projects/:id/export', (c) => {
  const spec = ops.exportProject(c.req.param('id'), { secrets: c.req.query('secrets') === '1' && view(c).revealSecrets });
  return c.json(spec, 200, { 'content-disposition': `attachment; filename="${spec.name.replace(/[^a-z0-9-_]/gi, '_')}.servify.json"` });
});
api.post('/projects/import', async (c) => {
  const body = await jsonBody<{ spec: ops.ProjectSpec; deploy?: boolean; name?: string }>(c);
  return c.json(await ops.importProject(actor(c), body.spec, { deploy: body.deploy, name: body.name }), 201);
});
api.post('/projects/import-compose', async (c) => {
  const body = await jsonBody<{ yaml: string; env?: string; basePath?: string; name?: string; deploy?: boolean; dryRun?: boolean; adoptVolumes?: boolean }>(c);
  if (!body.yaml?.trim()) throw new HttpError(400, 'paste the contents of your docker-compose.yml');
  if (body.dryRun) {
    const plan = ops.planComposeImport(body);
    if (!body.adoptVolumes) return c.json(plan);
    ops.requireOwner(actor(c), 'Taking over existing Docker volumes');
    return c.json({ ...plan, adopt: await ops.adoptPlan(plan) });
  }
  return c.json(await ops.importCompose(actor(c), body), 201);
});
api.get('/projects/:id/volumes', (c) => c.json(listVolumes(ops.getProjectOrThrow(c.req.param('id')).id)));
api.post('/projects/:id/volumes', async (c) => c.json(await createVolume(actor(c), ops.getProjectOrThrow(c.req.param('id')).id, await jsonBody(c)), 201));
api.patch('/volumes/:id', async (c) => c.json(updateVolume(actor(c), c.req.param('id'), await jsonBody(c))));
api.post('/volumes/:id/attach', async (c) => {
  const { serviceId, mountPath } = await jsonBody<{ serviceId: string; mountPath: string }>(c);
  return c.json(await attachVolume(actor(c), c.req.param('id'), serviceId, mountPath));
});
api.post('/volumes/:id/detach', async (c) => c.json(await detachVolume(actor(c), c.req.param('id'))));
api.delete('/volumes/:id', async (c) => {
  await deleteVolume(actor(c), c.req.param('id'), { keepData: c.req.query('keepData') === '1' });
  return c.json({ ok: true });
});
// Existing Docker volumes Servify doesn't manage yet (owner only: they may hold any app's data).
api.get('/servers/:id/docker-volumes', async (c) => {
  ops.requireOwner(actor(c), 'Listing other Docker volumes');
  const id = c.req.param('id');
  return c.json(await unmanagedDockerVolumes(id === 'local' ? null : id));
});
api.post('/projects/:id/volumes/adopt', async (c) => {
  ops.requireOwner(actor(c), 'Taking over an existing Docker volume');
  return c.json(await adoptVolume(actor(c), ops.getProjectOrThrow(c.req.param('id')).id, await jsonBody(c)), 201);
});
api.post('/volumes/:id/share', async (c) => {
  const { serviceId, mountPath } = await jsonBody<{ serviceId: string; mountPath: string }>(c);
  return c.json(await shareVolume(actor(c), c.req.param('id'), serviceId, mountPath));
});
api.post('/services/:id/unmount', async (c) => {
  const { mountPath } = await jsonBody<{ mountPath: string }>(c);
  return c.json(await removeMount(actor(c), ops.getServiceOrThrow(c.req.param('id')).id, mountPath));
});
api.get('/projects/:id/environments', (c) => c.json(environmentsOf(c.req.param('id'))));
api.post('/projects/:id/environments', async (c) => {
  const body = await jsonBody<{ name: string; branch?: string; deploy?: boolean }>(c);
  return c.json(await createEnvironment(actor(c), c.req.param('id'), body), 201);
});
api.patch('/projects/:id/previews', async (c) => {
  const { enabled } = await jsonBody<{ enabled: boolean }>(c);
  return c.json(setPreviews(actor(c), c.req.param('id'), !!enabled));
});
api.post('/projects/:id/demo', async (c) => c.json(await ops.seedDemo(actor(c), c.req.param('id'))));
api.get('/projects/:id/activity', (c) => {
  const p = ops.getProjectOrThrow(c.req.param('id'));
  return c.json(ops.listActivity({ projectId: p.id, limit: Number(c.req.query('limit') ?? 100) }));
});

// ───────────────────────────── services ─────────────────────────────

api.post('/projects/:id/services', async (c) => c.json(await ops.createService(actor(c), c.req.param('id'), await jsonBody(c)), 201));
api.get('/services/:id', (c) => c.json(ops.serializeService(ops.getServiceOrThrow(c.req.param('id')), view(c))));
api.patch('/services/:id', async (c) => c.json(await ops.updateService(actor(c), c.req.param('id'), await jsonBody(c))));
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
  const { replicas } = await jsonBody<{ replicas: number }>(c);
  return c.json(await ops.scaleService(actor(c), c.req.param('id'), Number(replicas)));
});
api.post('/services/:id/rollback', async (c) => {
  const { deploymentId } = await jsonBody<{ deploymentId: string }>(c);
  return c.json(ops.rollbackService(actor(c), c.req.param('id'), deploymentId));
});
api.put('/services/:id/variables', async (c) => {
  const body = await jsonBody<{ variables: Record<string, string>; replace?: boolean; secretKeys?: string[] }>(c);
  return c.json(ops.setVariables(actor(c), c.req.param('id'), body.variables ?? {}, { replace: body.replace, secretKeys: body.secretKeys }));
});
api.delete('/services/:id/variables/:key', (c) => c.json(ops.deleteVariable(actor(c), c.req.param('id'), c.req.param('key'))));
api.get('/services/:id/variables/resolved', (c) => {
  // Resolution can pull secrets from other services (e.g. a Postgres password inside DATABASE_URL),
  // so read-only tokens never see resolved values.
  if (!view(c).revealSecrets) throw new HttpError(403, 'read-only tokens cannot view resolved variables');
  return c.json(ops.previewVariables(c.req.param('id')));
});
api.get('/services/:id/deployments', (c) => c.json(ops.listDeployments(c.req.param('id'), Number(c.req.query('limit') ?? 30), view(c))));
api.get('/services/:id/metrics', (c) =>
  c.json(ops.serviceMetrics(c.req.param('id'), Math.max(10, Math.min(7 * 86400, Number(c.req.query('seconds') ?? 300))))),
);
api.get('/services/:id/logs', async (c) => {
  const num = (k: string) => (c.req.query(k) ? Number(c.req.query(k)) : undefined);
  return c.json(
    await ops.serviceLogs(c.req.param('id'), {
      tail: num('tail') ?? 300,
      since: num('since'),
      until: num('until'),
      search: c.req.query('search') || undefined,
      deploymentId: c.req.query('deployment') || undefined,
    }),
  );
});
api.get('/services/:id/volumes/:name/download', async (c) => {
  if (!view(c).revealSecrets) throw new HttpError(403, 'read-only tokens cannot download volume data');
  const svc = ops.getServiceOrThrow(c.req.param('id'));
  const vol = svc.volumes.find((v) => v.name === c.req.param('name'));
  if (!vol) throw new HttpError(404, 'volume not found');
  const rep = replicasOf(svc.id).find((r) => r.dockerState === 'running');
  if (!rep) throw new HttpError(409, 'start the service to download its data');
  const res = await dockerForContainer(rep.containerId).archive(rep.containerId, vol.mountPath);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return new Response(Readable.toWeb(res) as ReadableStream, {
    headers: {
      'content-type': 'application/x-tar',
      'content-disposition': `attachment; filename="${svc.slug}-${vol.name}-${stamp}.tar"`,
    },
  });
});
api.get('/services/:id/backups', (c) => c.json(ops.serviceBackups(c.req.param('id'), Number(c.req.query('limit') ?? 50))));
api.post('/services/:id/backups', async (c) => {
  const body = await jsonBody<{ destinationId?: string }>(c);
  return c.json(await ops.backupNow(actor(c), c.req.param('id'), body.destinationId), 201);
});
api.post('/backups/:id/restore', (c) => c.json(restoreBackup(actor(c), c.req.param('id')), 202));
api.delete('/backups/:id', async (c) => {
  await deleteBackup(actor(c), c.req.param('id'));
  return c.json({ ok: true });
});
api.get('/backups/:id/download', async (c) => {
  if (!view(c).revealSecrets) throw new HttpError(403, 'read-only tokens cannot download backups');
  const b = backupsTable.get(c.req.param('id'));
  if (!b || b.status !== 'succeeded' || !b.key) throw new HttpError(404, 'backup not found');
  const stream = await openBackupStream(b);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${b.key.split('/').pop()}"` },
  });
});
// ─── servers ───
api.get('/servers', (c) => c.json(listServers()));
api.get('/overview', async (c) => c.json(await overview()));
api.post('/servers', async (c) => {
  const { name } = await jsonBody<{ name: string }>(c);
  return c.json(await addServer(actor(c), name ?? ''), 201);
});
api.patch('/servers/:id', async (c) => {
  const { name } = await jsonBody<{ name: string }>(c);
  return c.json(renameServer(actor(c), c.req.param('id'), name ?? ''));
});
api.post('/servers/:id/token', async (c) => c.json(await rotateServerToken(actor(c), c.req.param('id'))));
api.post('/servers/:id/agent/upgrade', async (c) => c.json(await upgradeAgent(actor(c), c.req.param('id'))));
api.delete('/servers/:id', async (c) => {
  await removeServer(actor(c), c.req.param('id'));
  return c.json({ ok: true });
});
api.post('/services/:id/image-check', async (c) => c.json(await ops.checkServiceImage(c.req.param('id'))));
api.post('/services/:id/update-image', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(await ops.updateServiceImage(actor(c), c.req.param('id'), typeof body?.tag === 'string' ? body.tag : null), 202);
});
api.post('/services/:id/move-project', async (c) => {
  const { project } = await jsonBody<{ project: string }>(c);
  return c.json(ops.moveServiceToProject(actor(c), c.req.param('id'), project ?? ''));
});
api.post('/services/:id/move', async (c) => {
  const { server } = await jsonBody<{ server: string }>(c);
  return c.json(await ops.moveService(actor(c), c.req.param('id'), server ?? ''));
});

api.post('/services/:id/cluster/switchover', async (c) => {
  const { to } = await jsonBody<{ to?: number }>(c);
  return c.json(await switchover(actor(c), ops.getServiceOrThrow(c.req.param('id')).id, to));
});
api.post('/services/:id/cluster/rebuild', async (c) => {
  const { index } = await jsonBody<{ index: number }>(c);
  await rebuildMember(actor(c), ops.getServiceOrThrow(c.req.param('id')).id, Number(index));
  return c.json({ ok: true }, 202);
});
api.post('/services/:id/run', async (c) => {
  const svc = ops.getServiceOrThrow(c.req.param('id'));
  const run = await ops.runServiceJob(actor(c), svc.id);
  return c.json(run, 202);
});
api.get('/services/:id/runs', (c) => c.json(ops.serviceRuns(c.req.param('id'), Number(c.req.query('limit') ?? 30))));
api.post('/services/:id/exec', async (c) => {
  const { command, replica } = await jsonBody<{ command: string; replica?: number }>(c);
  return c.json(await ops.execInService(actor(c), c.req.param('id'), command, replica));
});

api.post('/services/:id/loadtest', async (c) => {
  const { rps, seconds } = await jsonBody<{ rps?: number; seconds?: number }>(c);
  return c.json(ops.loadTest(actor(c), c.req.param('id'), rps ?? 30, seconds ?? 30));
});
api.delete('/services/:id/loadtest', (c) => c.json(ops.stopLoadTest(ops.getServiceOrThrow(c.req.param('id')).id)));

api.get('/services/:id/logs/stream', (c) => {
  const svc = ops.getServiceOrThrow(c.req.param('id'));
  return streamSSE(c, async (stream) => {
    const sig = abortSignal(stream);
    const backlog = await ops.serviceLogs(svc.id, { tail: Number(c.req.query('tail') ?? 300) });
    if (sig.aborted) return;
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
    await sig.done;
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
    const sig = abortSignal(stream);
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
    await sig.done;
    clearInterval(ping);
    unsub();
  });
});

// ───────────────────────────── realtime events ─────────────────────────────

api.get('/events', (c) => {
  const projectId = c.req.query('project');
  const v = view(c);
  return streamSSE(c, async (stream) => {
    const sig = abortSignal(stream);
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
      if (ev.type === 'project.updated') payload = { ...ev, project: ops.publicProject(ev.project, v) };
      void stream.writeSSE({ event: 'message', data: JSON.stringify(payload) });
    });
    const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }), 15000);
    await sig.done;
    clearInterval(ping);
    unsub();
  });
});

api.get('/activity', (c) => c.json(ops.listActivity({ limit: Number(c.req.query('limit') ?? 100) })));
api.get('/templates', (c) => c.json(ops.listTemplates()));

// ───────────────────────────── instance settings ─────────────────────────────

const isOwner = (c: Context<Env>) => c.get('principal').actor.type === 'user';
function ownerOnly(c: Context<Env>) {
  if (!isOwner(c)) throw new HttpError(403, 'only the owner can change instance settings');
}

api.get('/settings', (c) => c.json(settings.publicSettings(isOwner(c))));
// ─── start at login ───
api.get('/settings/autostart', (c) => c.json(autostartStatus()));
api.put('/settings/autostart', async (c) => {
  ownerOnly(c);
  const { enabled } = await jsonBody<{ enabled: boolean }>(c);
  try {
    // Takes effect at the next login: this Servify keeps running either way and never stops itself.
    const st = enabled ? enableAutostart() : disableAutostart();
    recordActivity(actor(c), 'settings.autostart', enabled ? 'Servify starts at login' : 'Servify no longer starts at login');
    return c.json(st);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
});
api.patch('/settings/general', async (c) => {
  ownerOnly(c);
  settings.updateGeneral(actor(c), await jsonBody(c));
  return c.json(settings.publicSettings(true));
});
api.patch('/settings/alerts', async (c) => {
  ownerOnly(c);
  settings.updateAlerts(actor(c), await jsonBody(c));
  return c.json(settings.publicSettings(true));
});
api.patch('/settings/https', async (c) => {
  ownerOnly(c);
  settings.updateHttps(actor(c), await jsonBody(c));
  return c.json(settings.publicSettings(true));
});
api.post('/settings/notifications/channels', async (c) => {
  ownerOnly(c);
  return c.json(settings.upsertChannel(actor(c), await jsonBody(c)), 201);
});
api.delete('/settings/notifications/channels/:id', (c) => {
  ownerOnly(c);
  settings.deleteChannel(actor(c), c.req.param('id'));
  return c.json({ ok: true });
});
api.post('/settings/notifications/channels/:id/test', async (c) => {
  ownerOnly(c);
  return c.json(await testChannel(c.req.param('id')));
});
api.get('/settings/notifications/deliveries', (c) => c.json(recentDeliveries(c.req.query('channel') || undefined)));
api.post('/settings/backups/destinations', async (c) => {
  ownerOnly(c);
  return c.json(settings.upsertDestination(actor(c), await jsonBody(c)), 201);
});
api.post('/settings/backups/destinations/:id/test', async (c) => {
  ownerOnly(c);
  const d = settings.destinationById(c.req.param('id'));
  if (!d) throw new HttpError(404, 'destination not found');
  try {
    if (d.type === 's3') await s3Test(d);
    else {
      const { mkdirSync, writeFileSync, unlinkSync } = await import('node:fs');
      mkdirSync(d.path!, { recursive: true });
      const p = `${d.path}/.servify-write-test`;
      writeFileSync(p, 'ok');
      unlinkSync(p);
    }
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message });
  }
});
api.delete('/settings/backups/destinations/:id', (c) => {
  ownerOnly(c);
  settings.deleteDestination(actor(c), c.req.param('id'));
  return c.json({ ok: true });
});
api.get('/settings/webhooks/deliveries', (c) => c.json(recentHookDeliveries()));
api.get('/services/:id/deploy-hook', (c) => {
  if (!view(c).revealSecrets) throw new HttpError(403, 'read-only tokens cannot view deploy hooks');
  const svc = ops.getServiceOrThrow(c.req.param('id'));
  return c.json({ path: `/_servify/hooks/deploy/${svc.id}/${deployHookToken(svc.id)}` });
});
api.get('/certs', (c) => c.json(listCertificates()));
api.post('/certs/:host/retry', async (c) => {
  ownerOnly(c);
  await retryCertificate(c.req.param('host').toLowerCase());
  return c.json({ ok: true }, 202);
});
api.get('/certs/local-ca.pem', async (c) =>
  c.body(await localCaPem(), 200, { 'content-type': 'application/x-pem-file', 'content-disposition': 'attachment; filename="servify-local-ca.pem"' }),
);
api.post('/settings/webhooks/rotate', (c) => {
  ownerOnly(c);
  return c.json({ secret: settings.rotateWebhookSecret(actor(c)) });
});

// ───────────────────────────── tokens ─────────────────────────────

api.get('/tokens', (c) => {
  if (c.get('principal').actor.type !== 'user') throw new HttpError(403, 'only the owner can manage tokens');
  return c.json(tokensTable.list());
});
api.post('/tokens', async (c) => {
  if (c.get('principal').actor.type !== 'user') throw new HttpError(403, 'only the owner can manage tokens');
  const { name, scope } = await jsonBody<{ name: string; scope?: 'read' | 'write' }>(c);
  const { token, record } = createToken(name ?? 'agent', scope === 'read' ? 'read' : 'write');
  return c.json({ token, record }, 201);
});
api.delete('/tokens/:id', (c) => {
  if (c.get('principal').actor.type !== 'user') throw new HttpError(403, 'only the owner can manage tokens');
  tokensTable.delete(c.req.param('id'));
  return c.json({ ok: true });
});
