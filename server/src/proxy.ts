/**
 * Built-in edge router + load balancer.
 *  L7: Host-based HTTP routing (<service>.<project>.localhost + custom domains), WebSocket upgrades,
 *      round-robin / least-connections / ip-hash / random, one transparent retry on connect failure.
 *  L4: per-service TCP listeners (databases, raw TCP) balanced across replicas.
 */
import http from 'node:http';
import { touch, wake } from './sleep.ts';
import https from 'node:https';
import net from 'node:net';
import dgram from 'node:dgram';
import { createHash, randomBytes } from 'node:crypto';
import { config } from './config.ts';
import { services as servicesTable, projects as projectsTable } from './db.ts';
import { upstreamsFor, noteConn, anyReplicaStarting } from './engine.ts';
import { redirectLocation } from './external.ts';
import { bus } from './events.ts';
import type { Service } from './types.ts';
import { publicDomain } from './vars.ts';
import { challengeResponse, hasPublicCert, sniCallback, defaultContextOptions } from './certs.ts';
import { getSettings } from './settings.ts';
import { recordAccess } from './accesslog.ts';
import { compiledFor, cachedAccess, httpGate, ipGate, hookGate, hookFailed, compileRules, matches, normalizeIp, isPrivateIp, noteUntrustedProxy, parseRule, type Denial, type IpMatcher, type CompiledAccess } from './access.ts';

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
/** SERVIFY_TRUSTED_PROXIES, compiled once (IPs or CIDRs, IPv4 or IPv6); entries that aren't addresses are skipped. */
const trusted: IpMatcher | null = (() => {
  const rules: string[] = [];
  for (const t of config.trustedProxies) {
    try {
      rules.push(parseRule(t));
    } catch {
      console.warn(`[proxy] SERVIFY_TRUSTED_PROXIES: ignoring ${t} (not an IP address or CIDR)`);
    }
  }
  if (rules.includes('private')) console.warn('[proxy] SERVIFY_TRUSTED_PROXIES: "private" is not accepted here — list the proxy addresses or their networks');
  return compileRules(rules.filter((r) => r !== 'private'));
})();
/** Is the direct peer one of SERVIFY_TRUSTED_PROXIES (e.g. Nginx Proxy Manager in front of Servify)? */
export function fromTrustedProxy(remote: string | undefined): boolean {
  if (!remote || !trusted) return false;
  return matches(trusted, remote);
}

/** The scheme the visitor used: ours, or what a trusted proxy in front says (it terminated HTTPS). */
function visitorProto(req: http.IncomingMessage, proto: 'http' | 'https'): string {
  const said = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
  return said && (said === 'http' || said === 'https') && fromTrustedProxy(req.socket.remoteAddress) ? said : proto;
}

/**
 * The visitor's address: the socket peer, or — when that peer is a trusted proxy — the nearest X-Forwarded-For hop
 * (walking right to left) that isn't one of SERVIFY_TRUSTED_PROXIES. Only ever hashed into the access log's
 * visitor key: never stored, never logged.
 */
export function clientIpOf(req: http.IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? '';
  const xff = req.headers['x-forwarded-for'];
  if (!xff || !fromTrustedProxy(peer)) return ipv4(peer);
  const hops = (Array.isArray(xff) ? xff.join(',') : xff).split(',').map((h) => h.trim().replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1')).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) if (!fromTrustedProxy(hops[i])) return ipv4(hops[i]);
  return ipv4(hops[0] ?? peer);
}

// ───────────────────────────── access log ─────────────────────────────

type Access = { ts: number; t0: number; replica: number | null; bytes: number };
const ACCESS = Symbol('servify.access');
const one = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h) ?? '';

/**
 * Start the access record of a proxied request (once, even when handle() runs again after a wake). It is written when
 * the response closes — finished or abandoned — so every request yields exactly one record.
 */
function trackAccess(req: http.IncomingMessage, res: http.ServerResponse, svc: Service): Access | null {
  const prev = (req as any)[ACCESS] as Access | undefined;
  if (prev !== undefined) return prev;
  if (svc.accessLog === false) return ((req as any)[ACCESS] = null);
  const a: Access = { ts: Date.now(), t0: performance.now(), replica: null, bytes: 0 };
  (req as any)[ACCESS] = a;
  (res as any)[ACCESS] = a;
  res.once('close', () =>
    recordAccess({
      serviceId: svc.id,
      ts: a.ts,
      host: hostOnly(req.headers.host),
      method: req.method ?? '',
      path: req.url ?? '',
      status: res.headersSent ? res.statusCode : 499, // 499: the client left before an answer (as in Nginx)
      bytes: a.bytes,
      ms: performance.now() - a.t0,
      referrer: one(req.headers.referer),
      userAgent: one(req.headers['user-agent']),
      replica: a.replica,
      ip: clientIpOf(req),
    }),
  );
  return a;
}

/** A page Servify answers itself (404/502/503): sized, so the access log knows its bytes. */
function sendHtml(res: http.ServerResponse, status: number, headers: http.OutgoingHttpHeaders, html: string) {
  const len = Buffer.byteLength(html);
  const a = (res as any)[ACCESS] as Access | undefined;
  if (a) a.bytes += len;
  res.writeHead(status, { ...headers, 'content-length': len });
  res.end(html);
}

function forwardHeaders(req: http.IncomingMessage, svc: Service, proto: 'http' | 'https' = 'http') {
  const h: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && k !== INTERNAL_HEADER) h[k] = v;
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
    sendHtml(res, 404, { 'content-type': 'text/html; charset=utf-8' }, page(404, 'No service here', `Nothing is routed to <code>${escapeHtml(host)}</code>. Check the domain in the Servify dashboard.`));
    return;
  }
  const starting = anyReplicaStarting(svc) || svc.status === 'building' || svc.status === 'deploying';
  const h = { 'content-type': 'text/html; charset=utf-8', 'retry-after': '3', 'cache-control': 'no-store' };
  if (svc.stopped) sendHtml(res, 503, h, page(503, `${escapeHtml(svc.name)} is stopped`, 'Start it from the dashboard to bring it back online.'));
  else if (svc.sleeping) sendHtml(res, 503, h, page(503, `${escapeHtml(svc.name)} is waking up`, 'It was asleep after a while without visitors. This page refreshes automatically.', true));
  else if (starting) sendHtml(res, 503, h, page(503, `${escapeHtml(svc.name)} is starting`, 'A deploy is in progress. This page refreshes automatically.', true));
  else sendHtml(res, 503, h, page(503, `${escapeHtml(svc.name)} has no healthy replicas`, 'All replicas are failing their health checks. Check the logs in the dashboard.', true));
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// ───────────────────────────── access control (access.ts) ─────────────────────────────

/** Servify's own requests through the router (load tests): a per-process key, honoured from loopback only. */
const INTERNAL_HEADER = 'x-servify-internal';
const INTERNAL_KEY = randomBytes(18).toString('base64url');
export const internalHeaders = () => ({ [INTERNAL_HEADER]: INTERNAL_KEY });
function internalRequest(req: http.IncomingMessage): boolean {
  if (req.headers[INTERNAL_HEADER] !== INTERNAL_KEY) return false;
  const peer = normalizeIp(req.socket.remoteAddress);
  return peer === '127.0.0.1' || peer === '::1';
}

/** A private peer that isn't a trusted proxy sent X-Forwarded-For: a proxy Servify doesn't believe is in front. */
function untrustedForwarder(req: http.IncomingMessage): string | null {
  if (!req.headers['x-forwarded-for']) return null;
  const peer = normalizeIp(req.socket.remoteAddress);
  return peer && isPrivateIp(peer) && !fromTrustedProxy(peer) ? peer : null;
}

const GATED = Symbol('servify.gated');

/**
 * A service's access rules for one HTTP request or WebSocket handshake: null to go ahead, a denial, or a promise of
 * one (basic auth is checked off the main thread). Runs once per request, also when handle() runs again after a wake.
 */
function guard(req: http.IncomingMessage, svc: Service): Denial | null | Promise<Denial | null> {
  if ((req as any)[GATED]) return null;
  (req as any)[GATED] = true;
  const c = compiledFor(svc);
  if (!c || internalRequest(req)) return null;
  const url = req.url ?? '/';
  // ACME HTTP-01 must always pass (Servify's own tokens were answered already; these are the app's).
  if (url.startsWith('/.well-known/acme-challenge/')) return null;
  noticeProxy(svc, c, req);
  return httpGate(svc.id, c, clientIpOf(req), requestPath(url), one(req.headers.authorization) || undefined);
}

/** The path as the app will see it (dot segments resolved), for basic-auth exemptions; encoded slashes never match. */
function requestPath(url: string): string {
  if (/%2f|%5c|\\/i.test(url)) return '\0';
  try {
    return new URL(url, 'http://x').pathname;
  } catch {
    return '\0';
  }
}

function noticeProxy(svc: Service, c: CompiledAccess, req: http.IncomingMessage) {
  if (!c.byAddress) return;
  const peer = untrustedForwarder(req);
  if (peer && noteUntrustedProxy(svc.id, peer)) {
    console.warn(`[proxy] ${svc.name}: a proxy at ${peer} sends X-Forwarded-For but isn't in SERVIFY_TRUSTED_PROXIES — address rules see every visitor as ${peer}`);
    const fresh = servicesTable.get(svc.id);
    if (fresh) bus.publish({ type: 'service.updated', service: fresh });
  }
}

function deny(req: http.IncomingMessage, res: http.ServerResponse, d: Denial) {
  req.resume(); // drain the body so the connection can be reused
  sendHtml(res, d.status, { 'content-type': 'text/html; charset=utf-8', ...d.headers }, page(d.status, escapeHtml(d.title), escapeHtml(d.message)));
}

const REASONS: Record<number, string> = { 401: 'Unauthorized', 403: 'Forbidden', 429: 'Too Many Requests' };
function denyRaw(socket: net.Socket, d: Denial) {
  const body = `${d.title}: ${d.message}\n`;
  let head = `HTTP/1.1 ${d.status} ${REASONS[d.status] ?? 'Error'}\r\n`;
  for (const [k, v] of Object.entries(d.headers)) head += `${k}: ${v}\r\n`;
  socket.end(`${head}Content-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

/** Rules of a TCP/UDP service by id, for connections and datagrams (only the IP lists apply there). */
function tcpDenied(sid: string, address: string | undefined): boolean {
  let c = cachedAccess(sid);
  if (c === undefined) {
    const svc = servicesTable.get(sid);
    c = svc ? compiledFor(svc) : null;
  }
  return !!c && !!ipGate(c, address ?? null);
}

// ───────────────────────────── the dashboard on its own domain ─────────────────────────────

let dash: { domain: string | null; allow: IpMatcher | null } | null = null;
bus.subscribe((ev) => {
  if (ev.type === 'settings.updated') dash = null;
});
function dashboardSite() {
  if (!dash) {
    const s = getSettings();
    let allow: IpMatcher | null = null;
    try {
      allow = compileRules(s.dashboardAllow);
    } catch {
      allow = new net.BlockList(); // unreadable rules: nobody
    }
    // Never without sign-in: a domain stored earlier is not served while SERVIFY_AUTH=none.
    dash = { domain: config.authMode === 'none' ? null : s.dashboardDomain || null, allow };
  }
  return dash;
}
const dashboardTarget = () => (config.host === '0.0.0.0' || config.host === '::' || !config.host ? '127.0.0.1' : config.host);

/**
 * Settings → HTTPS → Dashboard domain: the router serves the dashboard, /api and /mcp for that host over HTTPS (plain
 * HTTP is redirected), behind its own address allowlist (private networks by default). Requests go to the dashboard
 * port unchanged — Host included, so the dashboard's host, origin and cookie checks see what the browser sent.
 */
function handleDashboard(req: http.IncomingMessage, res: http.ServerResponse, proto: 'http' | 'https', host: string) {
  if (visitorProto(req, proto) === 'http') {
    const port = config.httpsPort === 443 ? '' : `:${config.httpsPort}`;
    res.writeHead(308, { location: `https://${host}${port}${req.url ?? '/'}`, 'content-length': '0' });
    return res.end();
  }
  const d = dashboardDenied(req);
  if (d) return deny(req, res, d);
  const headers: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && k !== INTERNAL_HEADER) headers[k] = v;
  const peer = req.socket.remoteAddress ?? '';
  headers['x-forwarded-for'] = req.headers['x-forwarded-for'] ? `${req.headers['x-forwarded-for']}, ${peer}` : peer;
  headers['x-forwarded-proto'] = visitorProto(req, proto);
  let finished = false;
  const preq = http.request({ host: dashboardTarget(), port: config.port, method: req.method, path: req.url, headers }, (pres) => {
    const out = { ...pres.headers };
    for (const k of Object.keys(out)) if (HOP.has(k)) delete out[k];
    res.writeHead(pres.statusCode ?? 502, out);
    res.flushHeaders(); // event streams (SSE, MCP) start right away
    pres.pipe(res);
    pres.on('end', () => (finished = true));
  });
  res.once('close', () => {
    if (!finished && !preq.destroyed) preq.destroy();
  });
  preq.on('error', (err: NodeJS.ErrnoException) => {
    if (res.destroyed || res.writableEnded) return;
    if (!res.headersSent) sendHtml(res, 502, { 'content-type': 'text/html; charset=utf-8' }, page(502, 'Bad gateway', `The Servify dashboard did not respond (${escapeHtml(err.code ?? err.message)}).`));
    else res.destroy();
  });
  req.pipe(preq);
}

function dashboardDenied(req: http.IncomingMessage): Denial | null {
  const { allow } = dashboardSite();
  if (!allow) return null;
  // Behind a proxy Servify doesn't trust every visitor would look like that (private) proxy and pass a private-only
  // list: refuse instead, and say why in the dashboard (Settings → HTTPS).
  const peer = untrustedForwarder(req);
  if (peer) {
    if (noteUntrustedProxy('dashboard', peer)) console.warn(`[proxy] dashboard domain: a proxy at ${peer} sends X-Forwarded-For but isn't in SERVIFY_TRUSTED_PROXIES — refusing (set SERVIFY_TRUSTED_PROXIES)`);
    return { status: 403, title: 'Access denied', message: "Servify can't tell where this request comes from: the proxy in front of it isn't in SERVIFY_TRUSTED_PROXIES.", headers: { 'cache-control': 'no-store' } };
  }
  if (!matches(allow, clientIpOf(req))) return { status: 403, title: 'Access denied', message: 'The Servify dashboard is not available from your network.', headers: { 'cache-control': 'no-store' } };
  return null;
}

/** `/_servify/hooks/…` on any host: git webhooks and deploy hooks (signature-authenticated). */
function handleHook(req: http.IncomingMessage, res: http.ServerResponse) {
  const reply = (status: number, body: unknown) => {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const ip = clientIpOf(req);
  const limited = hookGate(ip);
  if (limited) {
    req.resume();
    res.writeHead(429, { 'content-type': 'application/json', ...limited.headers });
    return res.end(JSON.stringify({ error: limited.message }));
  }
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
      if (r.status === 401 || r.status === 403 || r.status === 404) hookFailed(ip);
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
  const dd = dashboardSite().domain;
  if (dd && !isChallenge && hostOnly(req.headers.host) === dd) return handleDashboard(req, res, proto, dd);
  // Hosts with a trusted certificate are served over HTTPS only.
  if (visitorProto(req, proto) === 'http' && !isChallenge && getSettings().https.enabled && getSettings().https.redirectHttp && hasPublicCert(hostOnly(req.headers.host))) {
    const port = config.httpsPort === 443 ? '' : `:${config.httpsPort}`;
    res.writeHead(308, { location: `https://${hostOnly(req.headers.host)}${port}${req.url ?? '/'}` });
    return res.end();
  }
  const svc = lookup(req.headers.host);
  const clientIp = req.socket.remoteAddress ?? '';
  if (!svc) return unavailable(res, null, req.headers.host ?? '');
  const access = trackAccess(req, res, svc);
  // Access rules come before anything else the service does: a refused visitor never wakes it or follows a redirect.
  const gate = guard(req, svc);
  if (gate) {
    if (gate instanceof Promise) {
      req.pause();
      void gate.then((d) => (d ? deny(req, res, d) : handle(req, res, proto)));
      return;
    }
    return deny(req, res, gate);
  }
  if (svc.source.type === 'redirect') {
    count(svc.id, null, 0, false);
    res.writeHead(svc.source.code, { location: redirectLocation(svc, req.url), 'content-length': '0' });
    return res.end();
  }
  touch(svc.id);
  if (svc.sleeping) {
    // Hold the request while the service wakes up; the body stays unread until then.
    req.pause();
    void wake(svc.id).then((ok) => {
      const fresh = lookup(req.headers.host);
      if (!ok || !fresh) return unavailable(res, fresh ?? svc, req.headers.host ?? '');
      req.resume();
      handle(req, res, proto);
    });
    return;
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
    if (access) access.replica = up.index;
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
        if (access) pres.on('data', (c: Buffer) => (access.bytes += c.length));
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
      if (!res.headersSent) sendHtml(res, 502, { 'content-type': 'text/html; charset=utf-8' }, page(502, 'Bad gateway', `Replica ${up.index} of ${escapeHtml(svc.name)} did not respond (${err.code ?? err.message}).`));
      else res.destroy();
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

type UpgradeAccess = { replica: number | null; done: (status: number) => void };

/**
 * Access record of a WebSocket (or other) upgrade, written once the handshake is answered — by the upstream (101
 * normally) or by Servify (redirect, 503) — or when the socket closes before that. Not at the end of the
 * connection: sockets can stay open for hours, and a restart would lose them. `ms` is the time to the answer.
 */
function trackUpgrade(req: http.IncomingMessage, socket: net.Socket, svc: Service): UpgradeAccess | null {
  const prev = (req as any)[ACCESS] as UpgradeAccess | undefined;
  if (prev !== undefined) return prev;
  if (svc.accessLog === false) return ((req as any)[ACCESS] = null);
  const ts = Date.now();
  const t0 = performance.now();
  let written = false;
  const a: UpgradeAccess = {
    replica: null,
    done(status) {
      if (written) return;
      written = true;
      recordAccess({
        serviceId: svc.id,
        ts,
        host: hostOnly(req.headers.host),
        method: req.method ?? '',
        path: req.url ?? '',
        status,
        bytes: 0,
        ms: performance.now() - t0,
        referrer: one(req.headers.referer),
        userAgent: one(req.headers['user-agent']),
        replica: a.replica,
        ip: clientIpOf(req),
      });
    },
  };
  (req as any)[ACCESS] = a;
  socket.once('close', () => a.done(499)); // the client left before any answer
  return a;
}

function handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer, proto: 'http' | 'https' = 'http') {
  // Node hands over upgraded sockets without an error listener: a client that resets the connection while we
  // answer (redirect, 503, a service waking up) would otherwise crash the whole process.
  if (!socket.listenerCount('error')) socket.on('error', () => socket.destroy());
  const dd = dashboardSite().domain;
  if (dd && hostOnly(req.headers.host) === dd) return socket.destroy(); // the dashboard has no WebSockets
  const svc = lookup(req.headers.host);
  if (!svc) return socket.destroy();
  const access = trackUpgrade(req, socket, svc);
  const gate = guard(req, svc);
  if (gate) {
    const refuse = (d: Denial) => {
      access?.done(d.status);
      denyRaw(socket, d);
    };
    if (gate instanceof Promise) {
      socket.pause();
      void gate.then((d) => (d ? refuse(d) : handleUpgrade(req, socket, head, proto)));
      return;
    }
    return refuse(gate);
  }
  if (svc.source.type === 'redirect') {
    access?.done(svc.source.code);
    socket.end(`HTTP/1.1 ${svc.source.code} Redirect\r\nLocation: ${redirectLocation(svc, req.url)}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    return;
  }
  touch(svc.id);
  if (svc.sleeping) {
    socket.pause();
    void wake(svc.id).then((ok) => {
      if (ok) return handleUpgrade(req, socket, head, proto);
      access?.done(503);
      socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    });
    return;
  }
  const up = pickUpstream(svc, socket.remoteAddress ?? '');
  if (!up) {
    access?.done(503);
    socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    return;
  }
  if (access) access.replica = up.index;
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
    if (access) upstream.once('data', (c: Buffer) => access.done(Number(/^HTTP\/\d(?:\.\d)? (\d{3})/.exec(c.toString('latin1', 0, 16))?.[1]) || 502));
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
    access?.done(counted ? 499 : 502); // no answer yet: the client left first / the upstream was unreachable
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
      // IP allow/deny at accept time (basic auth and rate limits are HTTP-only).
      const c = compiledFor(svc);
      if (c && ipGate(c, client.remoteAddress ?? null)) return client.destroy();
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
        if (tcpDenied(sid, rinfo.address)) return; // the route's IP lists apply to UDP clients too
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
