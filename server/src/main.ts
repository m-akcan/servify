import { serve } from '@hono/node-server';
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
import { startProxy } from './proxy.ts';
import { startMetrics } from './metrics.ts';
import { startBackgroundJobs } from './jobs.ts';
import { sessionsTable } from './db.ts';

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
  let dockerInfo;
  try {
    dockerInfo = await docker.init();
  } catch (e) {
    const where = 'socketPath' in dockerTarget ? dockerTarget.socketPath : `${dockerTarget.host}:${dockerTarget.port}`;
    console.error(`\n  ✗ Cannot reach Docker at ${where}\n    ${(e as Error).message}\n    Start Docker (Docker Desktop, OrbStack, Colima…) or set DOCKER_HOST.\n`);
    process.exit(1);
  }

  const app = new Hono();
  app.route('/api', api);

  app.all('/mcp', async (c) => {
    if (!hostAllowed(c.req.header('host'))) return c.json({ error: 'host not allowed' }, 403);
    if (!originOk(c.req.header('origin'), c.req.header('host'), c.req.method)) return c.json({ error: 'origin not allowed' }, 403);
    const auth = c.req.header('authorization');
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

  const proxyPort = await startProxy();
  await startEngine();
  startMetrics();
  startBackgroundJobs();
  setInterval(() => sessionsTable.prune(), 3600_000);

  serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
    const dash = `http://localhost:${config.port}`;
    console.log(`
  ╭───────────────────────────────────────────────╮
  │  servify ${config.version.padEnd(37)}│
  ╰───────────────────────────────────────────────╯
  dashboard   ${dash}
  apps        http://<service>.<project>.${config.baseDomain}:${proxyPort}
  mcp         ${dash}/mcp
  docker      ${dockerInfo.version} (${dockerInfo.os})
  data        ${config.dataDir}
  ready in ${Date.now() - t0}ms
`);
  });
}

process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
main();
