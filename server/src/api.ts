import { Hono, type Context } from 'hono';
import { receiveUpload } from './uploads.ts';
import * as dbb from './dbbrowser.ts';
import { overview } from './overview.ts';
import { diskState } from './diskguard.ts';
import { streamSSE } from 'hono/streaming';
import { cors } from 'hono/cors';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { matchedRoutes } from 'hono/route';
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
  normalizeTokenProjects,
  hostAllowed,
  originOk,
  throttleLogin,
  APP_ORIGINS,
  type Principal,
} from './auth.ts';
import { tokensTable, deployments as deploymentsTable, services as servicesTable } from './db.ts';
import { HttpError } from './util.ts';
import { config } from './config.ts';
import { docker, dockerTarget } from './docker.ts';
import { autostartStatus, enableAutostart, disableAutostart } from './autostart.ts';
import { dockerForContainer, listServers, addServer, renameServer, rotateServerToken, upgradeAgent, removeServer } from './nodes.ts';
import { readDeploymentLog } from './deployer.ts';
import type { BackupRecord, ServerEvent } from './types.ts';
import { Readable } from 'node:stream';
import { X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { replicasOf } from './engine.ts';
import * as settings from './settings.ts';
import * as updater from './updater.ts';
import { testChannel, recentDeliveries } from './notify.ts';
import { recentHookDeliveries, deployHookToken } from './hooks.ts';
import { listCertificates, retryCertificate, localCaPem } from './certs.ts';
import { restoreBackup, deleteBackup, openBackupStream, testRestore, publicBackup } from './backups.ts';
import { backupsTable } from './db.ts';
import { s3Test } from './s3.ts';
import { keySource, keyPath } from './crypto.ts';
import { listVolumes, createVolume, attachVolume, detachVolume, updateVolume, deleteVolume, unmanagedDockerVolumes, adoptVolume, shareVolume, removeMount } from './volumes.ts';
import { switchover, rebuildMember } from './pgcluster.ts';
import { environmentsOf, createEnvironment, setPreviews } from './envs.ts';
import { queryAccessLog, accessSummary, recentAccess, accessTotals } from './accesslog.ts';
import { ROUTE_POLICIES, type Policy, type TargetKind } from './policy.ts';
import { mobileAppInfo, mobileAppFile, openMobileApp, parseRange, refreshMobileApp } from './mobileapp.ts';
import { checkCall, isScoped, inReach, reachIds, eventFor, isUploadService } from './scopes.ts';

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
  if (err instanceof HttpError) return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status as any);
  if (err instanceof ZodError) {
    const msg = err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    return c.json({ error: msg }, 400);
  }
  console.error('[api]', err);
  return c.json({ error: (err as Error).message || 'internal error' }, 500);
});

// The mobile app calls the API from its WebView (http://localhost). It authenticates with a Bearer
// token, never cookies, so CORS is allowed for its origins only and without credentials. This runs
// first so the app can read error responses (like "host not allowed") and preflights skip auth.
api.use(
  '*',
  cors({
    origin: (origin) => (APP_ORIGINS.has(origin) ? origin : null),
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    // X-Servify-App: the app's version (recorded for signed-in phones). Apps only send it to a Servify whose
    // /auth/status lists the 'app-version-header' feature: older ones would refuse the preflight.
    allowHeaders: ['Authorization', 'Content-Type', 'X-Servify-App'],
    maxAge: 600,
  }),
);

// Host / origin validation for everything under /api.
api.use('*', async (c, next) => {
  if (!hostAllowed(c.req.header('host'))) return c.json({ error: 'host not allowed' }, 403);
  const origin = c.req.header('origin');
  // Signing in from the app carries a password, not a cookie, so there is nothing to forge.
  const appSignIn = c.req.path === '/api/auth/device' && c.req.method === 'POST' && !!origin && APP_ORIGINS.has(origin);
  if (!appSignIn && !originOk(origin, c.req.header('host'), c.req.method, c.req.header('authorization'))) return c.json({ error: 'origin not allowed' }, 403);
  await next();
});

// ───────────────────────────── auth ─────────────────────────────

/** What the phone app may use on this Servify (it checks before relying on it). */
const APP_FEATURES = ['app-version-header', 'mobile-app'];

api.get('/auth/status', (c) => {
  const p = principalFor({ cookie: getCookie(c, SESSION_COOKIE), bearer: bearer(c), app: c.req.header('x-servify-app') });
  return c.json({ app: 'servify', setUp: isSetUp(), authenticated: !!p, authMode: config.authMode, version: config.version, features: APP_FEATURES });
});

api.post('/auth/setup', async (c) => {
  if (isSetUp()) throw new HttpError(409, 'already set up');
  const { password } = await jsonBody<{ password: string }>(c);
  setPassword(password);
  const s = createSession();
  setCookie(c, SESSION_COOKIE, s.id, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: s.maxAge });
  return c.json({ ok: true });
});

api.post('/auth/login', async (c) => {
  throttleLogin();
  const { password } = await jsonBody<{ password: string }>(c);
  if (!checkPassword(password ?? '')) throw new HttpError(401, 'wrong password');
  const s = createSession();
  setCookie(c, SESSION_COOKIE, s.id, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: s.maxAge });
  return c.json({ ok: true });
});

/** Sign in from the mobile app: the owner password buys a device token (shown once, revocable in Settings → Security). */
api.post('/auth/device', async (c) => {
  if (config.authMode === 'none') throw new HttpError(400, 'sign-in is turned off on this Servify (SERVIFY_AUTH=none); the app needs an owner password');
  if (!isSetUp()) throw new HttpError(409, 'this Servify has no owner password yet: open the dashboard once to set it');
  throttleLogin();
  const { password, name } = await jsonBody<{ password: string; name?: string }>(c);
  if (!checkPassword(password ?? '')) throw new HttpError(401, 'wrong password');
  const { token, record } = createToken(name || 'Phone', 'write', 'device');
  recordActivity({ type: 'user', name: 'you' }, 'device.signin', `Signed in on ${record.name}`);
  return c.json({ token, device: record }, 201);
});

api.post('/auth/logout', (c) => {
  destroySession(getCookie(c, SESSION_COOKIE));
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

function bearer(c: Context): string | undefined {
  const h = c.req.header('authorization');
  // Only the header: a token in the URL would end up in proxy logs and browser history.
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  return undefined;
}

/**
 * The route that will answer this request (`METHOD /path` as registered, e.g. `GET /services/:id`) and its path
 * params, seen from a middleware. Null when nothing matches (a 404 follows).
 */
function handlerRoute(c: Context): { key: string; params: Record<string, string>; undecodable?: true } | null {
  // Routes of this router only: the dashboard's catch-all (main.ts) answers anything else, as it always did.
  const r = matchedRoutes(c).find((m) => m.method !== 'ALL' && /^\/api\//.test(m.path));
  if (!r) return null;
  const pattern = r.path.replace(/^\/api(?=\/)/, '');
  const pat = pattern.split('/');
  const got = c.req.path.replace(/^\/api(?=\/)/, '').split('/');
  const params: Record<string, string> = {};
  let undecodable = false;
  pat.forEach((seg, i) => {
    if (!seg.startsWith(':') || got[i] === undefined) return;
    try {
      params[seg.slice(1)] = decodeURIComponent(got[i]);
    } catch {
      // Malformed escapes: the handler might read this differently, so limited tokens are refused (below).
      params[seg.slice(1)] = got[i];
      undecodable = true;
    }
  });
  return { key: `${r.method} ${pattern}`, params, ...(undecodable ? { undecodable: true as const } : {}) };
}

/**
 * Everything below requires a principal, and every route is checked against its entry in policy.ts — in this one
 * place: the token's level, then (for tokens limited to some projects) that what the route names is in reach. Routes
 * without an entry are the owner's. Tokens for all projects are level-checked only, exactly as before.
 */
api.use('*', async (c, next) => {
  const p = principalFor({ cookie: getCookie(c, SESSION_COOKIE), bearer: bearer(c), app: c.req.header('x-servify-app') });
  if (!p) return c.json({ error: 'unauthorized' }, 401);
  c.set('principal', p);
  // As it always was: a read-only token changes nothing, whatever the path (even one that doesn't exist).
  if (p.scope === 'read' && p.actor.type !== 'user' && c.req.method !== 'GET') return c.json({ error: 'this token is read-only' }, 403);
  const route = handlerRoute(c);
  if (route?.undecodable && isScoped(p)) throw new HttpError(400, 'malformed path');
  if (route) {
    const policy: Policy | undefined = ROUTE_POLICIES[route.key];
    const targets: [TargetKind, unknown][] = [];
    // The body is only read where the policy needs it (never on uploads, which stream it).
    const needBody = !!policy && ((isScoped(p) && !!policy.body) || (p.scope === 'deploy' && !!policy.noSkip && p.actor.type !== 'user'));
    const body: any = needBody ? await c.req.json().catch(() => ({})) : {};
    if (policy) {
      for (const [k, kind] of Object.entries(policy.params ?? {})) targets.push([kind, route.params[k]]);
      for (const [k, kind] of Object.entries(policy.body ?? {})) targets.push([kind, body?.[k]]);
      for (const [k, kind] of Object.entries(policy.query ?? {})) targets.push([kind, c.req.query(k)]);
    }
    checkCall(p, policy, targets, {
      method: c.req.method,
      skipSafetyBackup: body?.skipSafetyBackup,
      uploadTarget: () => !!route.params.id && isUploadService(p, route.params.id),
    });
  }
  await next();
});

/** The app signs itself out: its own device token stops working. */
api.delete('/auth/device', (c) => {
  const { tokenId } = c.get('principal');
  const rec = tokenId ? tokensTable.list().find((t) => t.id === tokenId) : null;
  if (!rec || rec.kind !== 'device') throw new HttpError(400, 'not signed in with a device token');
  tokensTable.delete(rec.id);
  recordActivity({ type: 'user', name: 'you' }, 'device.signout', `Signed out on ${rec.name}`);
  return c.json({ ok: true });
});

const actor = (c: Context<Env>) => c.get('principal').actor;
const view = (c: Context<Env>) => ({ revealSecrets: c.get('principal').scope === 'write' });
/** Secrets (resolved variables, data, deploy hook URLs) are for write tokens and the owner. */
function noSecrets(c: Context<Env>, what: string) {
  if (view(c).revealSecrets) return;
  throw new HttpError(403, `${c.get('principal').scope === 'deploy' ? 'deploy' : 'read-only'} tokens cannot ${what}`);
}
/** A deployment as the caller may see it: deploy tokens get its variables masked, like read tokens. */
const dep = (c: Context<Env>, d: Parameters<typeof ops.serializeDeployment>[0]) => ops.serializeDeployment(d, view(c));

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
    /** Low disk space protection: the disks Servify writes to, their lines, and what is paused or refused. */
    disk: diskState(),
    actor: actor(c),
    scope: c.get('principal').scope,
  });
});

// ───────────────────────────── projects ─────────────────────────────

api.get('/projects', (c) => c.json(ops.listProjects().filter((p) => inReach(c.get('principal'), p.id))));
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
// Deleting the data needs a recent backup of it, or takes one first (409 with code "safety_backup" when it can't);
// ?skipSafetyBackup=1 deletes without one.
api.delete('/volumes/:id', async (c) => {
  const r = await deleteVolume(actor(c), c.req.param('id'), { keepData: c.req.query('keepData') === '1', skipSafetyBackup: c.req.query('skipSafetyBackup') === '1' });
  return c.json({ ok: true, ...r });
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
  // Volumes stay (as detached volumes) unless the caller asks for their data to go: ?deleteVolumes=1.
  // ?keepVolumes=1 from older clients still means keep, and wins if both are sent. Deleting them needs a recent
  // backup (or takes one first); ?skipSafetyBackup=1 goes without — it never deletes volumes by itself.
  await ops.deleteService(actor(c), c.req.param('id'), {
    deleteVolumes: c.req.query('deleteVolumes') === '1' && c.req.query('keepVolumes') !== '1',
    skipSafetyBackup: c.req.query('skipSafetyBackup') === '1',
  });
  return c.json({ ok: true });
});
api.post('/services/:id/duplicate', async (c) => c.json(await ops.duplicateService(actor(c), c.req.param('id')), 201));
// skipSafetyBackup: a new image on a service with data starts without the safety backup it would otherwise need.
api.post('/services/:id/deploy', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  ops.assertCanBuild(c.req.param('id'));
  return c.json(dep(c, ops.deployService(actor(c), c.req.param('id'), undefined, { useCachedImage: body?.useCachedImage === true, skipSafetyBackup: body?.skipSafetyBackup === true })));
});
api.post('/services/:id/restart', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(dep(c, ops.restartService(actor(c), c.req.param('id'), { skipSafetyBackup: body?.skipSafetyBackup === true })));
});
api.post('/services/:id/stop', async (c) => c.json(await ops.stopService(actor(c), c.req.param('id'))));
api.post('/services/:id/start', (c) => c.json(ops.startService(actor(c), c.req.param('id'))));
api.post('/services/:id/scale', async (c) => {
  const { replicas } = await jsonBody<{ replicas: number }>(c);
  return c.json(await ops.scaleService(actor(c), c.req.param('id'), Number(replicas)));
});
api.post('/services/:id/rollback', async (c) => {
  const { deploymentId, skipSafetyBackup } = await jsonBody<{ deploymentId: string; skipSafetyBackup?: boolean }>(c);
  return c.json(dep(c, ops.rollbackService(actor(c), c.req.param('id'), deploymentId, { skipSafetyBackup: skipSafetyBackup === true })));
});
api.put('/services/:id/variables', async (c) => {
  const body = await jsonBody<{ variables: Record<string, string>; replace?: boolean; secretKeys?: string[] }>(c);
  return c.json(ops.setVariables(actor(c), c.req.param('id'), body.variables ?? {}, { replace: body.replace, secretKeys: body.secretKeys }));
});
api.delete('/services/:id/variables/:key', (c) => c.json(ops.deleteVariable(actor(c), c.req.param('id'), c.req.param('key'))));
api.get('/services/:id/variables/resolved', (c) => {
  // Resolution can pull secrets from other services (e.g. a Postgres password inside DATABASE_URL),
  // so read-only tokens never see resolved values.
  noSecrets(c, 'view resolved variables');
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
/** A time filter: epoch milliseconds, or anything Date.parse understands (ISO 8601). */
function timeParam(v: string | undefined, name: string): number | undefined {
  if (!v) return undefined;
  const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(n)) throw new HttpError(400, `${name} must be epoch milliseconds or an ISO date`);
  return n;
}
// Router access log (no IPs: a daily-salted visitor key). Read-only tokens may read it.
api.get('/services/:id/access-log', (c) => {
  const q = (k: string) => c.req.query(k) || undefined;
  const bot = q('bot');
  return c.json(
    queryAccessLog(ops.getServiceOrThrow(c.req.param('id')).id, {
      since: timeParam(q('since'), 'since'),
      until: timeParam(q('until'), 'until'),
      path: q('path'),
      status: q('status'),
      q: q('q'),
      bot: bot === undefined ? undefined : bot === 'true' || bot === '1',
      visitor: q('visitor'),
      limit: q('limit') ? Number(q('limit')) : undefined,
      before: q('before'),
    }),
  );
});
api.get('/services/:id/access-log/summary', (c) =>
  c.json(accessSummary(ops.getServiceOrThrow(c.req.param('id')).id, c.req.query('day') || undefined, Number(c.req.query('top') ?? 20) || 20)),
);
// The traffic board: newest requests across all services, and per-service totals. Read-only tokens may read them;
// tokens limited to some projects see their services only.
const reachServices = (c: Context<Env>): Set<string> | null => {
  const ids = reachIds(c.get('principal'));
  if (!ids) return null;
  return new Set(servicesTable.all().filter((s) => ids.has(s.projectId)).map((s) => s.id));
};
api.get('/access-log/recent', (c) => {
  const after = c.req.query('after');
  return c.json(recentAccess(after ? Number(after) : undefined, Number(c.req.query('limit') ?? 50) || 50, reachServices(c)));
});
api.get('/access-log/totals', (c) => {
  const t = accessTotals(Number(c.req.query('hours') ?? 24) || 24);
  const only = reachServices(c);
  return c.json(only ? { ...t, services: Object.fromEntries(Object.entries(t.services).filter(([sid]) => only.has(sid))) } : t);
});
api.get('/services/:id/volumes/:name/download', async (c) => {
  noSecrets(c, 'download volume data');
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
// Waits for the backup and returns its record (status succeeded or failed). wait: false answers 202 once it has
// started — { started: true, backup } with the running record — or with the error if it can't start at all.
api.post('/services/:id/backups', async (c) => {
  const body = await jsonBody<{ destinationId?: string; wait?: boolean }>(c);
  const svc = ops.getServiceOrThrow(c.req.param('id'));
  const t0 = Date.now();
  const job = ops.backupNow(actor(c), svc.id, body.destinationId);
  if (body.wait !== false) return c.json(await job, 201);
  const settled: { done?: BackupRecord; error?: unknown; failed?: boolean } = {};
  job.then(
    (done) => (settled.done = done),
    (error) => Object.assign(settled, { error, failed: true }),
  );
  for (let i = 0; i < 30; i++) {
    if (settled.failed) throw settled.error;
    if (settled.done) return c.json(settled.done, 201);
    const started = backupsTable.all(`WHERE service_id = ? AND json_extract(data, '$.status') = 'running'`, svc.id).find((b) => b.createdAt >= t0);
    if (started) return c.json({ started: true, backup: started }, 202);
    await new Promise((r) => setTimeout(r, 100));
  }
  return c.json({ started: true, backup: null }, 202); // queued behind another backup or restore of the service
});
api.get('/backups/:id', (c) => {
  const b = backupsTable.get(c.req.param('id'));
  if (!b) throw new HttpError(404, 'backup not found');
  return c.json(publicBackup(b));
});
api.post('/backups/:id/restore', (c) => c.json(restoreBackup(actor(c), c.req.param('id')), 202));
// Test restore: the archive read end to end, then restored into a scratch volume / throwaway database (never the live
// one). In the background (202; the result lands on the backup's `test`), or ?wait=1 for the updated backup record.
api.post('/backups/:id/test', async (c) => {
  if (c.req.query('wait') === '1') return c.json(await testRestore(actor(c), c.req.param('id'), { wait: true }));
  return c.json(testRestore(actor(c), c.req.param('id')), 202);
});
api.delete('/backups/:id', async (c) => {
  await deleteBackup(actor(c), c.req.param('id'));
  return c.json({ ok: true });
});
api.get('/backups/:id/download', async (c) => {
  noSecrets(c, 'download backups');
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
// Adding, re-keying, upgrading and removing servers hands out (or takes away) control over machines: owner only.
const serverOwner = (c: Context<Env>) => ops.requireOwner(actor(c), 'Managing servers');
api.post('/servers', async (c) => {
  serverOwner(c);
  const { name } = await jsonBody<{ name: string }>(c);
  return c.json(await addServer(actor(c), name ?? ''), 201);
});
api.patch('/servers/:id', async (c) => {
  serverOwner(c);
  const { name } = await jsonBody<{ name: string }>(c);
  return c.json(renameServer(actor(c), c.req.param('id'), name ?? ''));
});
api.post('/servers/:id/token', async (c) => {
  serverOwner(c);
  return c.json(await rotateServerToken(actor(c), c.req.param('id')));
});
api.post('/servers/:id/agent/upgrade', async (c) => {
  serverOwner(c);
  return c.json(await upgradeAgent(actor(c), c.req.param('id')));
});
api.delete('/servers/:id', async (c) => {
  serverOwner(c);
  await removeServer(actor(c), c.req.param('id'));
  return c.json({ ok: true });
});
api.post('/services/:id/upload', async (c) => {
  const svc = ops.getServiceOrThrow(c.req.param('id'));
  if (!c.req.raw.body) throw new HttpError(400, 'send the folder as a gzipped tar');
  const h = (k: string) => {
    const v = c.req.header(k);
    try {
      return v ? decodeURIComponent(v) : null;
    } catch {
      return v ?? null;
    }
  };
  const { Readable } = await import('node:stream');
  const r = await receiveUpload(actor(c), svc, Readable.fromWeb(c.req.raw.body as any), { label: h('x-servify-label'), commitSha: h('x-servify-commit'), commitMessage: h('x-servify-message'), deploy: c.req.query('deploy') !== '0' });
  return c.json({ source: r.source, deployment: r.deployment ? dep(c, r.deployment) : null, skipped: r.skipped }, 201);
});
api.post('/services/:id/image-check', async (c) => c.json(await ops.checkServiceImage(c.req.param('id'))));
api.post('/services/:id/add-connected', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(await ops.addAndConnect(actor(c), c.req.param('id'), { templateId: body?.templateId, x: typeof body?.x === 'number' ? body.x : undefined, y: typeof body?.y === 'number' ? body.y : undefined }), 201);
});
api.post('/services/:id/track-image', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(await ops.trackServiceImage(actor(c), c.req.param('id'), body?.image, { allowMoved: body?.allowMoved === true }));
});
api.post('/services/:id/update-image', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(dep(c, await ops.updateServiceImage(actor(c), c.req.param('id'), typeof body?.tag === 'string' ? body.tag : null, { skipSafetyBackup: body?.skipSafetyBackup === true })), 202);
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
const dbView = (c: Context<Env>) => {
  noSecrets(c, 'read database contents');
};
api.get('/services/:id/db', async (c) => {
  dbView(c);
  return c.json(await dbb.databases(c.req.param('id')));
});
api.get('/services/:id/db/tables', async (c) => {
  dbView(c);
  return c.json(await dbb.tables(c.req.param('id'), c.req.query('db') || null));
});
api.get('/services/:id/db/rows', async (c) => {
  dbView(c);
  const q = c.req.query();
  return c.json(await dbb.rows(c.req.param('id'), { db: q.db || null, schema: q.schema || null, table: q.table ?? '', limit: Number(q.limit ?? 100), offset: Number(q.offset ?? 0), order: q.order || null, dir: q.dir || null }));
});
api.post('/services/:id/db/query', async (c) => {
  const { sql, db, write } = await jsonBody<{ sql: string; db?: string | null; write?: boolean }>(c);
  const svc = ops.getServiceOrThrow(c.req.param('id'));
  recordActivity(actor(c), 'service.exec', `Ran ${write ? 'a' : 'a read-only'} query in ${svc.name}${db ? `/${db}` : ''}: ${String(sql ?? '').replace(/\s+/g, ' ').slice(0, 80)}`, svc.projectId, svc.id);
  return c.json(await dbb.query(svc.id, String(sql ?? ''), { db: db ?? null, write: !!write }));
});
api.post('/services/:id/exec', async (c) => {
  // command: a string (run by /bin/sh -c) or an argv array (passed as is: `servify exec -- sh -c 'echo "a b"'`).
  const { command, replica } = await jsonBody<{ command: string | string[]; replica?: number }>(c);
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
api.post('/deployments/:id/cancel', (c) => c.json(dep(c, ops.cancelDeployment(actor(c), c.req.param('id')))));
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
  const p = c.get('principal');
  return streamSSE(c, async (stream) => {
    const sig = abortSignal(stream);
    await stream.writeSSE({ event: 'message', data: JSON.stringify({ type: 'hello', version: config.version } satisfies ServerEvent) });
    const unsub = bus.subscribe((raw) => {
      // Tokens limited to some projects get those projects' events only.
      const ev = eventFor(p, raw);
      if (!ev) return;
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

api.get('/activity', (c) => c.json(ops.listActivity({ limit: Number(c.req.query('limit') ?? 100), projectIds: reachIds(c.get('principal')) })));
api.get('/templates', (c) => c.json(ops.listTemplates()));

// ───────────────────────────── instance settings ─────────────────────────────

const isOwner = (c: Context<Env>) => c.get('principal').actor.type === 'user';
function ownerOnly(c: Context<Env>) {
  if (!isOwner(c)) throw new HttpError(403, 'only the owner can change instance settings');
}

api.get('/settings', (c) => c.json(settings.publicSettings(isOwner(c))));
// Servify's own updates (owner only; nothing is checked until asked).
api.get('/system/update', (c) => {
  ownerOnly(c);
  return c.json(updater.updateStatus());
});
api.post('/system/update/check', async (c) => {
  ownerOnly(c);
  return c.json(await updater.checkForUpdate());
});
api.post('/system/update', async (c) => {
  ownerOnly(c);
  const body = await c.req.json().catch(() => ({}));
  return c.json(await updater.installUpdate(actor(c), typeof body?.version === 'string' ? body.version : null), 202);
});
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
api.patch('/settings/disk', async (c) => {
  ownerOnly(c);
  settings.updateDisk(actor(c), await jsonBody(c));
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
api.get('/settings/notifications/deliveries', (c) => {
  ownerOnly(c); // answers of the notification services, which can quote what was sent to them
  return c.json(recentDeliveries(c.req.query('channel') || undefined));
});
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
api.get('/settings/webhooks/deliveries', (c) => {
  ownerOnly(c);
  return c.json(recentHookDeliveries());
});
api.get('/services/:id/deploy-hook', (c) => {
  noSecrets(c, 'view deploy hooks');
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
// The local CA and its SHA-256 fingerprint (what the phone app pins and shows to compare).
api.get('/certs/local-ca', async (c) => {
  const pem = await localCaPem();
  return c.json({ pem, fingerprint256: new X509Certificate(pem).fingerprint256 });
});
api.post('/settings/webhooks/rotate', (c) => {
  ownerOnly(c);
  return c.json({ secret: settings.rotateWebhookSecret(actor(c)) });
});

// ───────────────────────────── phone app ─────────────────────────────

/** The Android app this Servify mirrored from its signed release (mobileapp.ts), for its phones to update from. */
api.get('/mobile/app', (c) => c.json(mobileAppInfo()));
api.get('/mobile/app.apk', (c) => {
  const f = mobileAppFile();
  if (!f) throw new HttpError(409, mobileAppInfo().reason ?? 'no phone app is available', 'no_app');
  const range = parseRange(c.req.header('range'), f.size);
  const headers: Record<string, string> = {
    'content-type': 'application/vnd.android.package-archive',
    'content-disposition': `attachment; filename="servify-android-${f.versionName.replace(/[^0-9A-Za-z.+-]/g, '')}.apk"`,
    'accept-ranges': 'bytes',
    etag: `"${f.sha256}"`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-cache',
  };
  if (range === 'invalid') return c.body(null, 416, { ...headers, 'content-range': `bytes */${f.size}` });
  if (range && c.req.header('if-range') && c.req.header('if-range') !== headers.etag) {
    // A resumed download of another file: send all of it.
    return new Response(Readable.toWeb(openMobileApp(f.path)) as ReadableStream, { status: 200, headers: { ...headers, 'content-length': String(f.size) } });
  }
  if (range) {
    return new Response(Readable.toWeb(openMobileApp(f.path, range)) as ReadableStream, {
      status: 206,
      headers: { ...headers, 'content-length': String(range[1] - range[0] + 1), 'content-range': `bytes ${range[0]}-${range[1]}/${f.size}` },
    });
  }
  return new Response(Readable.toWeb(openMobileApp(f.path)) as ReadableStream, { status: 200, headers: { ...headers, 'content-length': String(f.size) } });
});
/** Check the running version's release for a newer app now (it waits for the check). */
api.post('/mobile/app/check', async (c) => {
  ownerOnly(c);
  await refreshMobileApp();
  return c.json(mobileAppInfo());
});

// ───────────────────────────── tokens ─────────────────────────────

api.get('/tokens', (c) => {
  if (c.get('principal').actor.type !== 'user') throw new HttpError(403, 'only the owner can manage tokens');
  return c.json(tokensTable.list().filter((t) => t.kind !== 'device'));
});
/** Phones signed in with the mobile app. */
api.get('/devices', (c) => {
  if (c.get('principal').actor.type !== 'user') throw new HttpError(403, 'only the owner can manage devices');
  const current = c.get('principal').tokenId;
  return c.json(tokensTable.list().filter((t) => t.kind === 'device').map((t) => ({ ...t, current: t.id === current })));
});
api.delete('/devices/:id', (c) => {
  if (c.get('principal').actor.type !== 'user') throw new HttpError(403, 'only the owner can manage devices');
  const rec = tokensTable.list().find((t) => t.id === c.req.param('id') && t.kind === 'device');
  if (!rec) throw new HttpError(404, 'no such device');
  tokensTable.delete(rec.id);
  recordActivity(actor(c), 'device.signout', `Signed out ${rec.name}`);
  return c.json({ ok: true });
});
api.post('/tokens', async (c) => {
  if (c.get('principal').actor.type !== 'user') throw new HttpError(403, 'only the owner can manage tokens');
  // scope: read, deploy or write (the default); projects: ids or slugs of the projects it is limited to (left out: all).
  const { name, scope, projects } = await jsonBody<{ name: string; scope?: string; projects?: string[] | null }>(c);
  if (scope !== undefined && scope !== null && !['read', 'deploy', 'write'].includes(scope)) throw new HttpError(400, 'scope must be read, deploy or write');
  const { token, record } = createToken(typeof name === 'string' ? name : 'agent', (scope as 'read' | 'deploy' | 'write' | undefined) ?? 'write', 'agent', normalizeTokenProjects(projects));
  return c.json({ token, record }, 201);
});
api.delete('/tokens/:id', (c) => {
  if (c.get('principal').actor.type !== 'user') throw new HttpError(403, 'only the owner can manage tokens');
  tokensTable.delete(c.req.param('id'));
  return c.json({ ok: true });
});

/** Routes registered here that policy.ts doesn't classify (they answer the owner only). Logged once at startup. */
export function unclassifiedRoutes(): string[] {
  return [...new Set(api.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method} ${r.path}`))].filter((k) => !ROUTE_POLICIES[k]);
}
{
  const missing = unclassifiedRoutes();
  if (missing.length) console.warn(`[api] routes without a token policy (owner only until classified in policy.ts): ${missing.join(', ')}`);
}
