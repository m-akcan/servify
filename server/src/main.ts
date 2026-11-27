import { serve } from '@hono/node-server';
import { startMesh } from './mesh.ts';
import { startSleeper } from './sleep.ts';
import { startAutoRestart } from './autorestart.ts';
import { startImageChecks } from './imageupdates.ts';
import { startMobileMirror } from './mobileapp.ts';
import { startUsageAlerts } from './alerts.ts';
import { startHostStats } from './hoststats.ts';
import { startDiskGuard, onProtectCleanup } from './diskguard.ts';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { config } from './config.ts';
import { docker, dockerTarget } from './docker.ts';
import { api } from './api.ts';
import { handleMcp } from './mcp.ts';
import { principalFor, hostAllowed, originOk, SESSION_COOKIE } from './auth.ts';
import { startEngine } from './engine.ts';
import { startProxy, clientIpOf } from './proxy.ts';
import { hookGate, hookFailed } from './access.ts';
import type { Context } from 'hono';
import { startMetrics, pruneMetrics } from './metrics.ts';
import { startBackgroundJobs, imageGc, removeStaleBuildDirs } from './jobs.ts';
import { sessionsTable, migrateSealing, migrateAccessLog, migrateSessions, migrateRepoCredentials } from './db.ts';
import { SealError, keySource, keyPath } from './crypto.ts';
import { recoverInterrupted } from './deployer.ts';
import { startScheduler } from './cronjobs.ts';
import { handleGitWebhook, handleDeployHook, MAX_HOOK_BODY } from './hooks.ts';
import { startCertificates } from './certs.ts';
import { startBackups } from './backups.ts';
import { startLogCollector, flushLogs, pruneLogs } from './logstore.ts';
import { startAccessLog, flushAccessLog, pruneAccessLog } from './accesslog.ts';
import { startEnvironments } from './envs.ts';
import { acquireLock } from './lock.ts';
import { settleUpdate, uncountUpdateAttempt } from './updater.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

async function main() {
  const t0 = Date.now();
  const other = acquireLock();
  if (other) {
    console.log(`  Servify is already running for ${config.dataDir} (pid ${other}) — not starting a second copy.`);
    process.exit(0);
  }
  let dockerInfo;
  try {
    dockerInfo = await docker.init();
  } catch (e) {
    const where = 'socketPath' in dockerTarget ? dockerTarget.socketPath : `${dockerTarget.host}:${dockerTarget.port}`;
    console.error(`\n  ✗ Cannot reach Docker at ${where}\n    ${(e as Error).message}\n    Start Docker (Docker Desktop, OrbStack, Colima…) or set DOCKER_HOST.\n`);
    uncountUpdateAttempt(); // right after an update: not a reason to roll it back
    process.exit(1);
  }

  try {
    const sealed = migrateSealing();
    (await import('./volumes.ts')).migrateVolumes();
    migrateAccessLog();
    migrateSessions();
    const moved = migrateRepoCredentials();
    if (moved) console.log(`  [secrets] moved credentials out of ${moved} git URL record(s) into the encrypted token`);
    if (sealed) console.log(`  [secrets] encrypted ${sealed} stored record(s) at rest`);
    if (keySource === 'created') console.log(`  [secrets] created master key ${keyPath} — back it up; secrets can't be recovered without it`);
  } catch (e) {
    if (e instanceof SealError) {
      console.error(`\n  ✗ ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  const app = new Hono();
  // Unauthenticated liveness probe (no data exposed).
  app.get('/api/health', async (c) => c.json({ ok: true, docker: await docker.ping(), version: config.version }));
  // Git webhooks authenticate by signature, so they sit in front of the host check and session auth. The same rate
  // limits as on the router's /_servify/hooks/ apply (per client, and stricter for failed ones).
  const hookIp = (c: Context) => {
    const incoming = (c.env as { incoming?: import('node:http').IncomingMessage } | undefined)?.incoming;
    return incoming ? clientIpOf(incoming) : null;
  };
  const hookReply = (c: Context, ip: string | null, r: { status: number; body: unknown }) => {
    if (r.status === 401 || r.status === 403 || r.status === 404) hookFailed(ip);
    return c.json(r.body as any, r.status as any);
  };
  app.post('/api/hooks/*', async (c, next) => {
    const d = hookGate(hookIp(c));
    if (d) return c.json({ error: d.message }, 429, d.headers);
    await next();
  });
  app.post('/api/hooks/git', async (c) => {
    if (Number(c.req.header('content-length') ?? 0) > MAX_HOOK_BODY) return c.json({ error: 'payload too large' }, 413);
    const raw = Buffer.from(await c.req.arrayBuffer());
    return hookReply(c, hookIp(c), await handleGitWebhook(Object.fromEntries(c.req.raw.headers), raw));
  });
  app.post('/api/hooks/deploy/:id/:token', (c) => hookReply(c, hookIp(c), handleDeployHook(c.req.param('id'), c.req.param('token'))));
  app.route('/api', api);

  app.all('/mcp', async (c) => {
    if (!hostAllowed(c.req.header('host'))) return c.json({ error: 'host not allowed' }, 403);
    const auth = c.req.header('authorization');
    if (!originOk(c.req.header('origin'), c.req.header('host'), c.req.method, auth)) return c.json({ error: 'origin not allowed' }, 403);
    const p = principalFor({ bearer: auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined, cookie: getCookie(c, SESSION_COOKIE) });
    if (!p) {
      return c.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: create an API token in Servify → Agents and send it as a Bearer token' }, id: null }, 401);
    }
    return handleMcp(c.req.raw, p);
  });

  // Static dashboard with SPA fallback.
  app.get('*', async (c) => {
    if (!hostAllowed(c.req.header('host'))) return c.text('host not allowed', 403);
    const urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    let file = join(config.webDist, safe);
    if (!file.startsWith(config.webDist)) return c.text('not found', 404);
    try {
      const st = await stat(file);
      if (st.isDirectory()) file = join(file, 'index.html');
    } catch {
      file = join(config.webDist, 'index.html');
    }
    try {
      const body = await readFile(file);
      const headers: Record<string, string> = { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' };
      if (file.includes('/assets/')) headers['cache-control'] = 'public, max-age=31536000, immutable';
      else headers['cache-control'] = 'no-cache';
      return c.body(body, 200, headers);
    } catch {
      return c.html(
        '<body style="font-family:system-ui;background:#0c0d0b;color:#e9e8e1;padding:40px">Dashboard not built yet. Run <code>pnpm build</code>, or use <code>pnpm dev</code>.</body>',
        200,
      );
    }
  });

  recoverInterrupted();
  (await import('./ops.ts')).upgradeIcons();
  const proxyPort = await startProxy();
  await startEngine();
  startMetrics();
  startHostStats();
  startUsageAlerts();
  // Entering low-disk protection runs the clean-ups that are always safe, once: built images beyond the ones kept for
  // rollbacks, leftover build checkouts, and log/metric/access-log rows past their retention. Never volumes or backups.
  onProtectCleanup(async () => {
    const steps: string[] = [];
    const rows = (fn: () => number, what: string) => {
      try {
        const n = fn();
        if (n) steps.push(`${n.toLocaleString('en')} ${what} past retention deleted`);
      } catch (e) {
        steps.push(`${what}: ${(e as Error).message}`);
      }
    };
    rows(pruneLogs, 'log lines');
    rows(pruneMetrics, 'metric rows');
    rows(pruneAccessLog, 'access-log rows');
    try {
      const freed = removeStaleBuildDirs();
      if (freed) steps.push(`${Math.round(freed / 1024 ** 2)} MB of leftover build checkouts removed`);
    } catch {}
    try {
      const n = await imageGc();
      if (n) steps.push(`${n} old built image${n === 1 ? '' : 's'} removed (the newest 5 per service stay for rollbacks)`);
    } catch (e) {
      steps.push(`image clean-up: ${(e as Error).message}`);
    }
    return steps;
  });
  startDiskGuard();
  startImageChecks();
  startMobileMirror();
  startSleeper();
  startAutoRestart();
  startMesh();
  startBackgroundJobs();
  startScheduler();
  startCertificates();
  startBackups();
  startLogCollector();
  startAccessLog();
  startEnvironments();
  (await import('./volumes.ts')).startVolumes();
  (await import('./pgcluster.ts')).startClusters();
  (await import('./nodes.ts')).startServers();
  (await import('./external.ts')).startExternal();
  setInterval(() => sessionsTable.prune(), 3600_000);

  serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
    void docker.ping().then((ok) => settleUpdate({ docker: !!ok }), () => settleUpdate({ docker: false }));
    const dash = `http://localhost:${config.port}`;
    console.log(`
  ╭───────────────────────────────────────────────╮
  │  servify ${config.version.padEnd(37)}│
  ╰───────────────────────────────────────────────╯
  dashboard   ${dash}
  apps        http://<service>.<project>.${config.baseDomain}:${proxyPort}
  https       https://<service>.<project>.${config.baseDomain}:${config.httpsPort}
  mcp         ${dash}/mcp
  docker      ${dockerInfo.version} (${dockerInfo.os})
  data        ${config.dataDir}
  ready in ${Date.now() - t0}ms
`);
  });
}

process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

// A connection that a visitor, an app or an agent drops at the wrong moment surfaces as an 'error' on a socket; where
// no listener was attached, Node turns that into an uncaught exception. That must never take the router (and every
// site behind it) down: log it and carry on. Anything else is a real bug in an unknown state: log it clearly and
// exit, so the service manager starts a clean process.
const SOCKET_ERRORS = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTCONN', 'ERR_SOCKET_CLOSED']);
function isSocketError(e: unknown): boolean {
  const code = String((e as NodeJS.ErrnoException | null)?.code ?? '');
  // TLS: a broken handshake or record sent by a client.
  return SOCKET_ERRORS.has(code) || code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_');
}
process.on('uncaughtException', (e, origin) => {
  if (isSocketError(e)) {
    console.error(`[socket] ignored a dropped connection that nothing was listening for: ${(e as NodeJS.ErrnoException).code} ${(e as Error).message}`);
    return;
  }
  console.error(`\n  ✗ Servify hit an unexpected error (${origin}) and is exiting so it can be restarted cleanly:\n`, e);
  try {
    flushLogs();
    flushAccessLog();
  } catch {}
  process.exit(1);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    try {
      flushLogs();
      flushAccessLog();
    } catch {}
    process.exit(0);
  });
}
main().catch((e) => {
  // A half-started Servify (router up, dashboard not) would only confuse: fail loudly instead.
  console.error('servify failed to start:', e);
  process.exit(1);
});
