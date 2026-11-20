/**
 * Built-in edge router + load balancer.
 *  L7: Host-based HTTP routing (<service>.<project>.localhost + custom domains), WebSocket upgrades,
 *      round-robin / least-connections / ip-hash / random, one transparent retry on connect failure.
 *  L4: per-service TCP listeners (databases, raw TCP) balanced across replicas.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dgram from 'node:dgram';
import { createHash } from 'node:crypto';
import { config } from './config.ts';
import { services as servicesTable, projects as projectsTable } from './db.ts';
import { upstreamsFor, noteConn, anyReplicaStarting } from './engine.ts';
import { redirectLocation } from './external.ts';
import { bus } from './events.ts';
import type { Service } from './types.ts';
import { publicDomain } from './vars.ts';
import { challengeResponse, hasPublicCert, sniCallback, defaultContextOptions } from './certs.ts';
import { getSettings } from './settings.ts';

type Upstream = ReturnType<typeof upstreamsFor>[number];

// ───────────────────────────── traffic accounting ─────────────────────────────

type Counter = { count: number; errors: number; lat: number[]; replicas: Map<string, number> };
let window = new Map<string, Counter>();

function count(serviceId: string, containerId: string | null, ms: number, error: boolean) {
  let c = window.get(serviceId);
  if (!c) window.set(serviceId, (c = { count: 0, errors: 0, lat: [], replicas: new Map() }));
  c.count++;
  if (error) c.errors++;
  if (c.lat.length < 5000) c.lat.push(ms);
  if (containerId) c.replicas.set(containerId, (c.replicas.get(containerId) ?? 0) + 1);
}

/** Swap the counting window and return per-second stats since the previous call. */
export function drainTraffic(elapsedSec: number) {
  const w = window;
  window = new Map();
  const out: Record<string, { rps: number; errors: number; p50: number; p95: number; replicas: Record<string, number> }> = {};
  for (const [sid, c] of w) {
    const sorted = c.lat.sort((a, b) => a - b);
    const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
    const replicas: Record<string, number> = {};
    for (const [cid, n] of c.replicas) replicas[cid] = n / elapsedSec;
    out[sid] = { rps: c.count / elapsedSec, errors: c.errors / elapsedSec, p50: q(0.5), p95: q(0.95), replicas };
  }
  return out;
}

// ───────────────────────────── routing table ─────────────────────────────

let routes = new Map<string, string>(); // host → serviceId
let routesDirty = true;
bus.subscribe((ev) => {
  if (ev.type === 'service.updated' || ev.type === 'service.deleted' || ev.type === 'project.updated' || ev.type === 'project.deleted') {
    routesDirty = true;
    tcpDirty = true;
  }
});

function rebuildRoutes() {
  const next = new Map<string, string>();
  const projects = new Map(projectsTable.all().map((p) => [p.id, p]));
  for (const s of servicesTable.all()) {
    if (s.protocol !== 'http') continue;
    const p = projects.get(s.projectId);
    if (!p) continue;
    if (s.publicHttp) next.set(publicDomain(s, p), s.id);
    for (const d of s.domains) next.set(d.toLowerCase(), s.id);
  }
  routes = next;
  routesDirty = false;
}

function lookup(hostHeader: string | undefined): Service | null {
  if (routesDirty) rebuildRoutes();
  if (!hostHeader) return null;
  const host = hostHeader.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  const sid = routes.get(host);
  return sid ? servicesTable.get(sid) : null;
}

const rr = new Map<string, number>();

export function pickUpstream(svc: Service, clientIp: string, exclude?: Set<string>): Upstream | null {
  let ups = upstreamsFor(svc);
  if (exclude?.size) ups = ups.filter((u) => !exclude.has(u.containerId));
  if (!ups.length) return null;
  switch (svc.strategy) {
    case 'least-conn': {
      let best = ups[0];
      for (const u of ups) if (u.activeConns < best.activeConns) best = u;
      // Tie-break round-robin so idle services still spread load.
      const ties = ups.filter((u) => u.activeConns === best.activeConns);
      const i = (rr.get(svc.id) ?? 0) % ties.length;
      rr.set(svc.id, i + 1);
      return ties[i];
    }
    case 'ip-hash': {
      const h = createHash('md5').update(clientIp).digest().readUInt32BE(0);
      return ups[h % ups.length];
    }
    case 'random':
      return ups[Math.floor(Math.random() * ups.length)];
    default: {
      const i = (rr.get(svc.id) ?? 0) % ups.length;
      rr.set(svc.id, i + 1);
      return ups[i];
    }
  }
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 256, keepAliveMsecs: 5000 });

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate']);

const ipv4 = (ip: string) => ip.replace(/^::ffff:/, '');
const ipToInt = (ip: string) => ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
/** Is the direct peer one of SERVIFY_TRUSTED_PROXIES (e.g. Nginx Proxy Manager in front of Servify)? */
export function fromTrustedProxy(remote: string | undefined): boolean {
  if (!remote || !config.trustedProxies.length) return false;
  const ip = ipv4(remote);
  for (const t of config.trustedProxies) {
    if (!t.includes('/')) {
      if (ipv4(t) === ip) return true;
      continue;
    }
    const [base, bits] = t.split('/');
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^\d+\.\d+\.\d+\.\d+$/.test(base)) continue;
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    if ((ipToInt(ip) & mask) === (ipToInt(base) & mask)) return true;
  }
  return false;
}

/** The scheme the visitor used: ours, or what a trusted proxy in front says (it terminated HTTPS). */
function visitorProto(req: http.IncomingMessage, proto: 'http' | 'https'): string {
  const said = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
  return said && (said === 'http' || said === 'https') && fromTrustedProxy(req.socket.remoteAddress) ? said : proto;
}

function forwardHeaders(req: http.IncomingMessage, svc: Service, proto: 'http' | 'https' = 'http') {
  const h: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) h[k] = v;
  const ip = req.socket.remoteAddress ?? '';
  h['x-forwarded-for'] = req.headers['x-forwarded-for'] ? `${req.headers['x-forwarded-for']}, ${ip}` : ip;
  h['x-forwarded-host'] = req.headers.host ?? '';
  h['x-forwarded-proto'] = visitorProto(req, proto);
  h['x-servify-service'] = svc.slug;
  return h;
}

function page(status: number, title: string, body: string, refresh = false) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${refresh ? '<meta http-equiv="refresh" content="3">' : ''}
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{color-scheme:dark}body{margin:0;height:100vh;display:grid;place-items:center;background:#0c0d0b;color:#e9e8e1;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
.c{max-width:460px;padding:32px}.k{font:600 11px/1 ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:#d4f25a;display:flex;gap:8px;align-items:center}
.k i{width:8px;height:8px;border-radius:50%;background:#d4f25a;box-shadow:0 0 0 4px #d4f25a22;animation:p 1.4s ease-in-out infinite}
@keyframes p{50%{opacity:.35}}h1{font-size:28px;letter-spacing:-.02em;margin:14px 0 6px;font-weight:600}p{color:#9a998f;margin:0}code{color:#e9e8e1;background:#1b1c18;padding:2px 6px;border-radius:5px}</style></head>
<body><div class="c"><div class="k"><i></i>servify · ${status}</div><h1>${title}</h1><p>${body}</p></div></body></html>`;
}

function unavailable(res: http.ServerResponse, svc: Service | null, host: string) {
  if (!svc) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page(404, 'No service here', `Nothing is routed to <code>${escapeHtml(host)}</code>. Check the domain in the Servify dashboard.`));
    return;
  }
  const starting = anyReplicaStarting(svc) || svc.status === 'building' || svc.status === 'deploying';
  res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '3', 'cache-control': 'no-store' });
  if (svc.stopped) res.end(page(503, `${escapeHtml(svc.name)} is stopped`, 'Start it from the dashboard to bring it back online.'));
  else if (starting) res.end(page(503, `${escapeHtml(svc.name)} is starting`, 'A deploy is in progress. This page refreshes automatically.', true));
  else res.end(page(503, `${escapeHtml(svc.name)} has no healthy replicas`, 'All replicas are failing their health checks. Check the logs in the dashboard.', true));
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** `/_servify/hooks/…` on any host: git webhooks and deploy hooks (signature-authenticated). */
function handleHook(req: http.IncomingMessage, res: http.ServerResponse) {
  const reply = (status: number, body: unknown) => {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });
  const chunks: Buffer[] = [];
  let size = 0;
  let tooBig = false;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > 2 * 1024 * 1024) {
      tooBig = true;
      reply(413, { error: 'payload too large' });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', async () => {
    if (tooBig) return;
    try {
      const hooks = await import('./hooks.ts');
      const path = (req.url ?? '').split('?')[0];
      const m = path.match(/^\/_servify\/hooks\/deploy\/([^/]+)\/([^/]+)$/);
      const r = m ? hooks.handleDeployHook(m[1], m[2]) : path === '/_servify/hooks/git' ? await hooks.handleGitWebhook(req.headers, Buffer.concat(chunks)) : { status: 404, body: { error: 'unknown hook' } };
      reply(r.status, r.body);
    } catch (e) {
      reply(500, { error: (e as Error).message });
    }
  });
}

function hostOnly(h: string | undefined) {
  return (h ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

function handle(req: http.IncomingMessage, res: http.ServerResponse, proto: 'http' | 'https' = 'http') {
  if (req.url?.startsWith('/_servify/hooks/')) return handleHook(req, res);
  const isChallenge = !!req.url?.startsWith('/.well-known/acme-challenge/');
  if (isChallenge) {
    const answer = challengeResponse(req.url!.slice('/.well-known/acme-challenge/'.length).split('?')[0]);
    if (answer) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(answer);
    }
    // Unknown token: it may be the app's own (e.g. its own ACME client) — route it, just never redirect it.
  }
  // Hosts with a trusted certificate are served over HTTPS only.
  if (visitorProto(req, proto) === 'http' && !isChallenge && getSettings().https.enabled && getSettings().https.redirectHttp && hasPublicCert(hostOnly(req.headers.host))) {
    const port = config.httpsPort === 443 ? '' : `:${config.httpsPort}`;
    res.writeHead(308, { location: `https://${hostOnly(req.headers.host)}${port}${req.url ?? '/'}` });
    return res.end();
  }
  const svc = lookup(req.headers.host);
  const clientIp = req.socket.remoteAddress ?? '';
  if (!svc) return unavailable(res, null, req.headers.host ?? '');
  if (svc.source.type === 'redirect') {
    count(svc.id, null, 0, false);
    res.writeHead(svc.source.code, { location: redirectLocation(svc, req.url), 'content-length': '0' });
    return res.end();
  }
  const t0 = performance.now();
  const tried = new Set<string>();

  const attempt = (retry: boolean) => {
    const up = pickUpstream(svc, clientIp, tried);
    if (!up) {
      count(svc.id, null, performance.now() - t0, true);
      return unavailable(res, svc, req.headers.host ?? '');
    }
    tried.add(up.containerId);
    noteConn(up.containerId, 1);
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        noteConn(up.containerId, -1);
      }
    };
    let finished = false;
    const preq = http.request(
      { host: up.host!, port: up.port!, method: req.method, path: req.url, headers: forwardHeaders(req, svc, proto), agent },
      (pres) => {
        const headers = { ...pres.headers };
        for (const k of Object.keys(headers)) if (HOP.has(k)) delete headers[k];
        headers['x-servify-replica'] = String(up.index);
        res.writeHead(pres.statusCode ?? 502, headers);
        pres.pipe(res);
        pres.on('end', () => {
          finished = true;
          release();
          count(svc.id, up.containerId, performance.now() - t0, (pres.statusCode ?? 502) >= 500);
        });
        pres.on('error', release);
      },
    );
    // Client went away (or the response finished): never leave the upstream or the counter dangling.
    res.once('close', () => {
      if (!finished && !preq.destroyed) preq.destroy();
      release();
    });
    // Idle upstream timeout — a hung replica must not pin connections forever.
    preq.setTimeout(120_000, () => preq.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' })));
    let sentBody = false;
    preq.on('error', (err: NodeJS.ErrnoException) => {
      release();
      if (res.destroyed || res.writableEnded) return; // client already gone — nothing to retry or report
      const connectFail = err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'EHOSTUNREACH';
      if (retry && connectFail && !sentBody && !res.headersSent) return attempt(false);
      count(svc.id, up.containerId, performance.now() - t0, true);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page(502, 'Bad gateway', `Replica ${up.index} of ${escapeHtml(svc.name)} did not respond (${err.code ?? err.message}).`));
      } else res.destroy();
    });
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      // Bodyless requests can be retried safely.
      req.resume();
      preq.end();
    } else {
      sentBody = true;
      req.pipe(preq);
    }
  };
  attempt(true);
}

function handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer, proto: 'http' | 'https' = 'http') {
  const svc = lookup(req.headers.host);
  if (!svc) return socket.destroy();
  if (svc.source.type === 'redirect') {
    socket.end(`HTTP/1.1 ${svc.source.code} Redirect\r\nLocation: ${redirectLocation(svc, req.url)}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    return;
  }
  const up = pickUpstream(svc, socket.remoteAddress ?? '');
  if (!up) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    return;
  }
  let counted = false;
  const upstream = net.connect(up.port!, up.host!, () => {
    counted = true;
    noteConn(up.containerId, 1);
    const headers = forwardHeaders(req, svc, proto);
    headers.connection = 'Upgrade';
    headers.upgrade = req.headers.upgrade;
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) continue;
      for (const vv of Array.isArray(v) ? v : [v]) raw += `${k}: ${vv}\r\n`;
    }
    upstream.write(raw + '\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
    count(svc.id, up.containerId, 0, false);
  });
  const close = () => {
    upstream.destroy();
    socket.destroy();
  };
  let closed = false;
  const onClose = () => {
    if (closed) return;
    closed = true;
    if (counted) noteConn(up.containerId, -1);
    close();
  };
  upstream.on('error', onClose);
  socket.on('error', onClose);
  upstream.on('close', onClose);
  socket.on('close', onClose);
}

// ───────────────────────────── TCP (L4) listeners ─────────────────────────────

const tcpServers = new Map<string, { port: number; server: net.Server }>();
let tcpDirty = true;

function syncTcp() {
  if (!tcpDirty) return;
  tcpDirty = false;
  const want = new Map<string, number>();
  for (const s of servicesTable.all()) if (s.publicTcpPort && s.protocol !== 'none') want.set(s.id, s.publicTcpPort);
  for (const [sid, entry] of tcpServers) {
    if (want.get(sid) !== entry.port) {
      entry.server.close();
      tcpServers.delete(sid);
    }
  }
  for (const [sid, port] of want) {
    if (tcpServers.has(sid)) continue;
    const server = net.createServer((client) => {
      const svc = servicesTable.get(sid);
      if (!svc) return client.destroy();
      const up = pickUpstream({ ...svc, strategy: svc.strategy === 'ip-hash' ? 'ip-hash' : 'least-conn' }, client.remoteAddress ?? '');
      if (!up) return client.destroy();
      noteConn(up.containerId, 1);
      count(sid, up.containerId, 0, false);
      const upstream = net.connect(up.port!, up.host!);
      client.pipe(upstream);
      upstream.pipe(client);
      let done = false;
      const end = () => {
        if (done) return;
        done = true;
        noteConn(up.containerId, -1);
        client.destroy();
        upstream.destroy();
      };
      client.on('error', end);
      upstream.on('error', end);
      client.on('close', end);
      upstream.on('close', end);
    });
    server.on('error', (e) => {
      console.error(`[proxy] tcp listener for ${sid} on :${port} failed: ${(e as Error).message} — retrying`);
      tcpServers.delete(sid);
      setTimeout(() => (tcpDirty = true), 5000);
    });
    server.listen(port, config.proxyHost);
    tcpServers.set(sid, { port, server });
  }
}

// ───────────── UDP for external TCP routes (same port number, e.g. a game server's query + game traffic) ─────────────

type UdpRelay = { port: number; socket: dgram.Socket; clients: Map<string, { up: dgram.Socket; last: number }> };
const udpRelays = new Map<string, UdpRelay>();
const udpRetryAt = new Map<string, number>();
const UDP_IDLE_MS = 120_000;

function syncUdp() {
  const want = new Map<string, { port: number; host: string; target: number }>();
  for (const s of servicesTable.all()) {
    if (s.source.type === 'external' && s.source.udp && s.publicTcpPort && !s.stopped) want.set(s.id, { port: s.publicTcpPort, host: s.source.host, target: s.source.port });
  }
  for (const [sid, r] of udpRelays) {
    const w = want.get(sid);
    if (!w || w.port !== r.port) {
      for (const c of r.clients.values()) c.up.close();
      r.socket.close();
      udpRelays.delete(sid);
    }
  }
  for (const [sid, w] of want) {
    if (udpRelays.has(sid) || (udpRetryAt.get(sid) ?? 0) > Date.now()) continue;
    const socket = dgram.createSocket('udp4');
    const r: UdpRelay = { port: w.port, socket, clients: new Map() };
    // One upstream socket per client address, so replies find their way back; idle ones are closed.
    socket.on('message', (msg, rinfo) => {
      const key = `${rinfo.address}:${rinfo.port}`;
      let c = r.clients.get(key);
      if (!c) {
        const up = dgram.createSocket(w.host.includes(':') ? 'udp6' : 'udp4');
        up.on('message', (reply) => {
          const cc = r.clients.get(key);
          if (cc) cc.last = Date.now();
          socket.send(reply, rinfo.port, rinfo.address);
        });
        up.on('error', () => {
          up.close();
          r.clients.delete(key);
        });
        c = { up, last: Date.now() };
        r.clients.set(key, c);
      }
      c.last = Date.now();
      c.up.send(msg, w.target, w.host);
    });
    socket.on('error', (e) => {
      console.error(`[proxy] udp listener for ${sid} on :${w.port} failed: ${e.message} — retrying`);
      udpRelays.delete(sid);
      udpRetryAt.set(sid, Date.now() + 5000);
      try {
        socket.close();
      } catch {}
    });
    socket.bind(w.port, config.proxyHost);
    udpRelays.set(sid, r);
  }
  const now = Date.now();
  for (const r of udpRelays.values()) {
    for (const [key, c] of r.clients) {
      if (now - c.last > UDP_IDLE_MS) {
        c.up.close();
        r.clients.delete(key);
      }
    }
  }
}

export function tcpPortInUse(port: number, exceptServiceId?: string): boolean {
  for (const s of servicesTable.all()) if (s.publicTcpPort === port && s.id !== exceptServiceId) return true;
  return port === config.port || port === config.proxyPort || port === config.httpsPort;
}

export async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, config.proxyHost, () => s.close(() => resolve(true)));
  });
}

export async function allocateTcpPort(): Promise<number> {
  for (let p = config.tcpPortStart; p < config.tcpPortStart + 2000; p++) {
    if (tcpPortInUse(p)) continue;
    if (await portFree(p)) return p;
  }
  throw new Error('no free TCP port available');
}

/** HTTPS listener: same routing, certificates picked per SNI name. Never fatal if the port is taken. */
async function startHttps() {
  const server = https.createServer({ ...(await defaultContextOptions()), SNICallback: sniCallback }, (req, res) => handle(req, res, 'https'));
  server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket as net.Socket, head, 'https'));
  server.keepAliveTimeout = 65_000;
  // No overall request deadline (Node's default is 5 minutes): big uploads and long downloads must finish.
  server.requestTimeout = 0;
  let port = config.httpsPort;
  const tryListen = (attempts: number) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE' && attempts > 0) {
        console.warn(`[proxy] https port ${port} in use, trying ${port + 1}`);
        port++;
        tryListen(attempts - 1);
      } else console.error(`[proxy] HTTPS router disabled: ${e.message}`);
    });
    server.listen(port, config.proxyHost, () => {
      config.httpsPort = port;
    });
  };
  tryListen(10);
}

export function startProxy(): Promise<number> {
  void startHttps().catch((e) => console.error('[proxy] HTTPS router failed to start:', (e as Error).message));
  const server = http.createServer((req, res) => handle(req, res, 'http'));
  server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket as net.Socket, head, 'http'));
  server.keepAliveTimeout = 65_000;
  server.requestTimeout = 0; // see startHttps
  setInterval(() => {
    syncTcp();
    syncUdp();
  }, 1000);
  syncTcp();
  syncUdp();
  return new Promise((resolve, reject) => {
    let port = config.proxyPort;
    const tryListen = (attempts: number) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && attempts > 0) {
          console.warn(`[proxy] port ${port} in use, trying ${port + 1}`);
          port++;
          tryListen(attempts - 1);
        } else reject(e);
      });
      server.listen(port, config.proxyHost, () => {
        config.proxyPort = port;
        resolve(port);
      });
    };
    tryListen(10);
  });
}
