/**
 * Servers: other machines whose Docker runs services for this Servify.
 *
 * Each server runs `servify agent`, which dials OUT to this machine (TLS with a pinned certificate fingerprint and
 * a bearer token), so a server needs no inbound ports. Over one control connection Servify asks the agent to open
 * streams; every stream is its own connection (TCP does the flow control) that the agent pipes to either its Docker
 * socket or a 127.0.0.1 port on that machine. On this side:
 *
 *   - the server's Docker API appears as a private unix socket (mode 0600), so it is an ordinary DockerClient, and
 *     DOCKER_HOST for the docker CLI (pulls, builds, backups) — those run on the server itself;
 *   - a replica's published port (bound to 127.0.0.1 on the server) appears as a 127.0.0.1 forwarder here, so the
 *     router and health probes treat remote replicas exactly like local ones.
 */
import https from 'node:https';
import { handleMeshUpgrade } from './mesh.ts';
import net from 'node:net';
import { readFileSync, mkdirSync, rmSync, mkdtempSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, networkInterfaces, hostname as osHostname } from 'node:os';
import { timingSafeEqual, createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { IncomingMessage } from 'node:http';
import { docker, createDockerClient, type DockerClient } from './docker.ts';
import { nodesTable, services as servicesTable } from './db.ts';
import { agentTlsMaterial } from './certs.ts';
import { config } from './config.ts';
import { recordActivity, type Actor } from './events.ts';
import { notify } from './notify.ts';
import { id as newId, secret, sha256, now, HttpError, assert, sleep } from './util.ts';
import type { ServerNode, ServerInfo, PublicServer, HostStats } from './types.ts';
import { localHostStats } from './hoststats.ts';

export const LOCAL = 'local';
const STREAM_TIMEOUT_MS = 10_000;
const DEAD_AFTER_MS = 35_000;
const OFFLINE_NOTICE_AFTER_MS = 60_000;
export const AGENT_SCRIPT = resolve(import.meta.dirname, '../bin/agent.mjs');
/** The agent version this Servify ships (agents report theirs in hello). */
export const AGENT_VERSION = /const VERSION = '([^']+)'/.exec(readFileSync(AGENT_SCRIPT, 'utf8'))?.[1] ?? '0';

type Pending = { resolve: (s: Duplex) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
type Forward = { server: net.Server; port: number };
type Conn = {
  nodeId: string;
  control: Duplex;
  ready: boolean;
  pending: Map<string, Pending>;
  lastSeen: number;
  connectedAt: number;
  sockPath: string;
  sockServer: net.Server | null;
  client: DockerClient | null;
  forwards: Map<number, Promise<Forward>>;
  /** Live usage the agent reports every 15 s (agents from 0.2.0). */
  stats?: HostStats;
};

const conns = new Map<string, Conn>();
/** Which server each known container lives on (container ids are unique across daemons). */
const containerNode = new Map<string, string>();
const listeners = new Set<(nodeId: string, online: boolean) => void>();
const offlineSince = new Map<string, number>();
const offlineNoticeSent = new Set<string>();

// ───────────────────────────── lookups ─────────────────────────────

export const nodeOf = (x: { nodeId?: string | null } | null | undefined): string => x?.nodeId || LOCAL;

export function isOnline(nodeId?: string | null): boolean {
  const n = nodeId || LOCAL;
  return n === LOCAL || !!conns.get(n)?.ready;
}

/**
 * Since when the server's current connection has been up and answering (0 = this machine), or null when it is offline
 * or its agent has gone quiet (a dead connection is only dropped after DEAD_AFTER_MS). Probes from before that moment,
 * through a previous connection, say nothing about its replicas.
 */
export function onlineSince(nodeId?: string | null): number | null {
  const n = nodeId || LOCAL;
  if (n === LOCAL) return 0;
  const c = conns.get(n);
  if (!c?.ready || now() - c.lastSeen > 20_000) return null;
  return c.connectedAt;
}

export function onlineNodes(): string[] {
  return [LOCAL, ...[...conns.values()].filter((c) => c.ready).map((c) => c.nodeId)];
}

export function nodeName(nodeId?: string | null): string {
  const n = nodeId || LOCAL;
  return n === LOCAL ? 'this machine' : (nodesTable.get(n)?.name ?? n);
}

/** The Docker client for a server. Throws 503 when that server is offline. */
export function dockerFor(nodeId?: string | null): DockerClient {
  const n = nodeId || LOCAL;
  if (n === LOCAL) return docker;
  const c = conns.get(n);
  if (!c?.ready || !c.client) throw new HttpError(503, `server ${nodeName(n)} is offline`);
  return c.client;
}

export function setContainerNode(cid: string, nodeId: string) {
  containerNode.set(cid, nodeId);
}
export function forgetContainer(cid: string) {
  containerNode.delete(cid);
}
export function containerNodeOf(cid: string): string {
  return containerNode.get(cid) ?? LOCAL;
}
/** The Docker client that owns a container. */
export function dockerForContainer(cid: string): DockerClient {
  return dockerFor(containerNodeOf(cid));
}

export function onNodeChange(fn: (nodeId: string, online: boolean) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(nodeId: string, online: boolean) {
  for (const fn of listeners) {
    try {
      fn(nodeId, online);
    } catch (e) {
      console.error('[servers] listener failed:', (e as Error).message);
    }
  }
}

// ───────────────────────────── streams ─────────────────────────────

/** Ask a server's agent for a stream to its Docker socket or one of its 127.0.0.1 ports. */
export function openStream(nodeId: string, target: 'docker' | number): Promise<Duplex> {
  const c = conns.get(nodeId);
  if (!c) return Promise.reject(new Error(`server ${nodeName(nodeId)} is offline`));
  const sid = secret(12);
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      c.pending.delete(sid);
      reject(new Error(`server ${nodeName(nodeId)} did not open a stream in time`));
    }, STREAM_TIMEOUT_MS);
    c.pending.set(sid, { resolve: resolvePromise, reject, timer });
    send(c, { t: 'open', id: sid, target: target === 'docker' ? 'docker' : { port: target } });
  });
}

function splice(local: net.Socket, nodeId: string, target: 'docker' | number) {
  local.pause();
  local.on('error', () => {});
  openStream(nodeId, target).then(
    (up) => {
      up.on('error', () => local.destroy());
      local.on('error', () => up.destroy());
      up.on('close', () => local.destroy());
      local.on('close', () => up.destroy());
      local.pipe(up);
      up.pipe(local);
      local.resume();
    },
    () => local.destroy(),
  );
}

let runDirCache: string | null = null;
/** Unix socket paths are limited to ~104 bytes, so long data dirs fall back to a private temp dir. */
function runDir(): string {
  if (runDirCache) return runDirCache;
  const preferred = join(config.dataDir, 'run');
  if (preferred.length < 70) {
    mkdirSync(preferred, { recursive: true, mode: 0o700 });
    chmodSync(preferred, 0o700);
    runDirCache = preferred;
  } else {
    runDirCache = mkdtempSync(join(tmpdir(), 'servify-')); // created 0700
  }
  return runDirCache;
}

function listen(server: net.Server, port: number | string, host?: string): Promise<void> {
  return new Promise((ok, fail) => {
    server.once('error', fail);
    const done = () => {
      server.off('error', fail);
      ok();
    };
    if (typeof port === 'string') server.listen(port, done);
    else server.listen(port, host, done);
  });
}

/** A 127.0.0.1 port here that reaches 127.0.0.1:<remotePort> on the server. */
export function forwardPort(nodeId: string, remotePort: number): Promise<number> {
  const c = conns.get(nodeId);
  if (!c?.ready) return Promise.reject(new Error(`server ${nodeName(nodeId)} is offline`));
  let f = c.forwards.get(remotePort);
  if (!f) {
    f = (async () => {
      const server = net.createServer({ allowHalfOpen: true }, (sock) => splice(sock, nodeId, remotePort));
      await listen(server, 0, '127.0.0.1');
      return { server, port: (server.address() as net.AddressInfo).port };
    })();
    c.forwards.set(remotePort, f);
    f.catch(() => c.forwards.delete(remotePort));
  }
  return f.then((x) => x.port);
}

/** Close forwarders no replica uses any more. */
export function pruneForwards(nodeId: string, keep: Set<number>) {
  const c = conns.get(nodeId);
  if (!c) return;
  for (const [port, f] of c.forwards) {
    if (keep.has(port)) continue;
    c.forwards.delete(port);
    void f.then((x) => x.server.close()).catch(() => {});
  }
}

// ───────────────────────────── agent connections ─────────────────────────────

function send(c: Conn, msg: unknown) {
  if (!c.control.destroyed) c.control.write(JSON.stringify(msg) + '\n');
}

function safeEq(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function authNode(req: IncomingMessage): ServerNode | null {
  const m = /^Bearer (svn_[A-Za-z0-9_-]{20,})$/.exec(String(req.headers.authorization ?? ''));
  if (!m) return null;
  const hash = sha256(m[1]);
  for (const n of nodesTable.all()) if (safeEq(n.tokenHash, hash)) return n;
  return null;
}

function attachControl(node: ServerNode, socket: Duplex, address: string | null) {
  const prev = conns.get(node.id);
  if (prev) dropConn(prev, 'replaced by a new connection', false);
  const c: Conn = {
    nodeId: node.id,
    control: socket,
    ready: false,
    pending: new Map(),
    lastSeen: now(),
    connectedAt: now(),
    sockPath: join(runDir(), `${node.id}.sock`),
    sockServer: null,
    client: null,
    forwards: new Map(),
  };
  conns.set(node.id, c);
  let buf = '';
  const decoder = new StringDecoder('utf8'); // upgraded HTTP sockets refuse setEncoding()
  socket.on('data', (chunk: Buffer) => {
    c.lastSeen = now();
    buf += decoder.write(chunk);
    if (buf.length > 1_000_000) return dropConn(c, 'protocol error', true);
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.t === 'hello') void onHello(c, msg.info ?? {}, address);
      else if (msg.t === 'stats' && msg.stats && typeof msg.stats === 'object') c.stats = cleanStats(msg.stats);
      else if (msg.t === 'fail' && typeof msg.id === 'string') {
        const p = c.pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          c.pending.delete(msg.id);
          p.reject(new Error(String(msg.error ?? 'the agent could not open the stream')));
        }
      }
    }
  });
  socket.on('close', () => dropConn(c, 'disconnected', true));
  socket.on('end', () => socket.destroy()); // half-open is for streams, not the control connection
  socket.on('error', () => {});
}

async function onHello(c: Conn, raw: any, address: string | null) {
  if (c.ready || conns.get(c.nodeId) !== c) return;
  const node = nodesTable.get(c.nodeId);
  if (!node) return dropConn(c, 'server removed', false);
  const info: ServerInfo = {
    hostname: String(raw.hostname ?? '').slice(0, 120),
    os: String(raw.os ?? '').slice(0, 60),
    arch: String(raw.arch ?? '').slice(0, 30),
    cpus: Number(raw.cpus) || 0,
    memBytes: Number(raw.memBytes) || 0,
    dockerVersion: String(raw.dockerVersion ?? '').slice(0, 40),
    agentVersion: String(raw.agentVersion ?? '').slice(0, 40),
    address,
  };
  try {
    rmSync(c.sockPath, { force: true });
    // Half-open: the docker CLI closes its write side after sending (exec, attach, build) and still reads.
    const server = net.createServer({ allowHalfOpen: true }, (sock) => splice(sock, c.nodeId, 'docker'));
    await listen(server, c.sockPath);
    chmodSync(c.sockPath, 0o600);
    c.sockServer = server;
    c.client = createDockerClient({ socketPath: c.sockPath });
    const v = await c.client.init();
    info.dockerVersion = v.version;
    if (conns.get(c.nodeId) !== c) return;
    c.ready = true;
  } catch (e) {
    console.error(`[servers] ${node.name}: could not reach its Docker:`, (e as Error).message);
    return dropConn(c, 'docker unreachable', true);
  }
  node.info = info;
  node.lastSeenAt = now();
  nodesTable.put(node);
  const wasNoticed = offlineNoticeSent.delete(node.id);
  offlineSince.delete(node.id);
  console.log(`[servers] ${node.name} connected (${info.hostname}, docker ${info.dockerVersion})`);
  if (wasNoticed) notify({ event: 'service.recovered', level: 'success', title: `Server ${node.name} is back online`, message: `Servify reconnected to ${node.name}.` });
  emit(node.id, true);
}

function dropConn(c: Conn, why: string, announce: boolean) {
  if (conns.get(c.nodeId) !== c) return;
  conns.delete(c.nodeId);
  const wasReady = c.ready;
  c.ready = false;
  c.control.destroy();
  for (const p of c.pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error(`server ${nodeName(c.nodeId)} ${why}`));
  }
  c.pending.clear();
  c.sockServer?.close();
  rmSync(c.sockPath, { force: true });
  for (const f of c.forwards.values()) void f.then((x) => x.server.close()).catch(() => {});
  c.forwards.clear();
  const node = nodesTable.get(c.nodeId);
  if (node) {
    node.lastSeenAt = now();
    nodesTable.put(node);
  }
  if (!wasReady) return;
  console.log(`[servers] ${node?.name ?? c.nodeId} ${why}`);
  emit(c.nodeId, false);
  if (!announce || !node) return;
  offlineSince.set(node.id, now());
  setTimeout(() => {
    if (isOnline(node.id) || !nodesTable.get(node.id) || offlineNoticeSent.has(node.id)) return;
    offlineNoticeSent.add(node.id);
    notify({ event: 'service.crashed', level: 'error', title: `Server ${node.name} is offline`, message: `Servify lost its connection to ${node.name}. Its services keep running there; Servify reconnects automatically.` });
  }, OFFLINE_NOTICE_AFTER_MS).unref();
}

function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  socket.on('error', () => {});
  if (req.url?.startsWith('/mesh/') && handleMeshUpgrade(req, socket, head)) return; // relays authenticate per project
  const node = authNode(req);
  if (!node) {
    console.warn(`[servers] rejected an agent connection from ${req.socket.remoteAddress ?? '?'} (bad token)`);
    socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    return;
  }
  const url = req.url ?? '';
  const stream = /^\/agent\/v1\/stream\/([A-Za-z0-9_-]{8,40})$/.exec(url);
  const pending = stream ? conns.get(node.id)?.pending.get(stream[1]) : undefined;
  if (url !== '/agent/v1/control' && !pending) {
    socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    return;
  }
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: servify-agent\r\nConnection: Upgrade\r\n\r\n');
  if (head.length) socket.unshift(head);
  (socket as net.Socket).setNoDelay?.(true);
  (socket as net.Socket).setKeepAlive?.(true, 15_000);
  if (url === '/agent/v1/control') {
    attachControl(node, socket, req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? null);
  } else {
    clearTimeout(pending!.timer);
    conns.get(node.id)!.pending.delete(stream![1]);
    pending!.resolve(socket);
  }
}

// ───────────────────────────── listener ─────────────────────────────

let listener: https.Server | null = null;
let listening: Promise<void> | null = null;

/** The endpoint agents dial. Only started once a server has been added. */
export function startAgentListener(): Promise<void> {
  listening ??= (async () => {
    const tls = await agentTlsMaterial();
    const script = () => readFileSync(AGENT_SCRIPT);
    listener = https.createServer({ key: tls.keyPem, cert: tls.certPem, allowHalfOpen: true } as https.ServerOptions, (req, res) => {
      // The agent script is public code; the join command pins its hash.
      if (req.method === 'GET' && req.url === '/agent.mjs') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(script());
        return;
      }
      res.writeHead(404).end();
    });
    listener.on('upgrade', (req, socket, head) => {
      try {
        handleUpgrade(req, socket, head);
      } catch (e) {
        console.error('[servers] agent connection failed:', (e as Error).message);
        socket.destroy();
      }
    });
    listener.on('tlsClientError', () => {});
    await new Promise<void>((ok, fail) => {
      listener!.once('error', fail);
      listener!.listen(config.agentPort, config.agentHost, () => ok());
    });
    console.log(`[servers] agent endpoint on ${config.agentHost}:${config.agentPort}`);
    setInterval(() => {
      for (const c of conns.values()) {
        if (now() - c.lastSeen > DEAD_AFTER_MS) dropConn(c, 'stopped answering', true);
        else send(c, { t: 'ping' });
      }
    }, 10_000).unref();
  })().catch((e) => {
    listening = null;
    throw e;
  });
  return listening;
}

export function startServers() {
  if (nodesTable.all().length || process.env.SERVIFY_AGENT_PORT) {
    startAgentListener().catch((e) => console.error(`[servers] agent endpoint failed to start: ${(e as Error).message}`));
  }
}

// ───────────────────────────── management ─────────────────────────────

/** The address servers use to reach this machine (agents and mesh relays). */
export const hubAddress = () => guessAddress();

function guessAddress(): string {
  if (config.agentPublicHost) return config.agentPublicHost;
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return osHostname();
}

async function joinCommand(token: string) {
  const tls = await agentTlsMaterial();
  const url = `https://${guessAddress()}:${config.agentPort}`;
  const hash = hashBytes(readFileSync(AGENT_SCRIPT));
  const args = `--join ${url} --token ${token} --fingerprint ${tls.fingerprint}`;
  return {
    url,
    fingerprint: tls.fingerprint,
    // Needs only Docker on the server. The script is fetched from this Servify and checked against its hash.
    docker: [
      'docker run -d --name servify-agent --restart unless-stopped --network host',
      '-v /var/run/docker.sock:/var/run/docker.sock node:22-alpine sh -c',
      // Downloaded and verified once; container restarts reuse the verified copy (re-run the command to upgrade).
      `'test -f /agent.mjs || { wget -q --no-check-certificate -O /tmp/agent.mjs ${url}/agent.mjs && echo "${hash}  /tmp/agent.mjs" | sha256sum -c -s && mv /tmp/agent.mjs /agent.mjs; } && exec node /agent.mjs ${args}'`,
    ].join(' \\\n  '),
    node: `node server/bin/agent.mjs ${args}`,
  };
}

const hashBytes = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** Agent-reported numbers, kept only if they are numbers. */
function cleanStats(raw: any): HostStats {
  const load = Array.isArray(raw.load) ? raw.load.slice(0, 3).map((v: unknown) => num(v) ?? 0) : [0, 0, 0];
  return { cpuPct: num(raw.cpuPct), load: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0], memTotal: num(raw.memTotal) ?? 0, memAvailable: num(raw.memAvailable) ?? 0, diskTotal: num(raw.diskTotal), diskFree: num(raw.diskFree), uptimeSec: num(raw.uptimeSec) ?? 0, at: Date.now() };
}

export function publicServer(n: ServerNode | null): PublicServer {
  const nodeId = n?.id ?? LOCAL;
  const services = servicesTable.all().filter((s) => nodeOf(s) === nodeId).length;
  let replicas = 0;
  for (const v of containerNode.values()) if (v === nodeId) replicas++;
  const c = n ? conns.get(n.id) : null;
  return {
    id: nodeId,
    name: n?.name ?? 'This machine',
    local: !n,
    status: !n || c?.ready ? 'online' : n.lastSeenAt ? 'offline' : 'pending',
    lastSeenAt: n ? n.lastSeenAt : now(),
    connectedAt: n ? (c?.ready ? c.connectedAt : null) : null,
    info: n?.info ?? null,
    services,
    replicas,
    // Remote figures older than a minute are stale (an old agent, or a dropped connection).
    stats: !n ? localHostStats() : c?.ready && c.stats && Date.now() - c.stats.at < 60_000 ? c.stats : null,
    agentOutdated: !!n && !!n.info?.agentVersion && n.info.agentVersion !== AGENT_VERSION,
  };
}

export function listServers(): PublicServer[] {
  return [publicServer(null), ...nodesTable.all().sort((a, b) => a.createdAt - b.createdAt).map(publicServer)];
}

/**
 * Update a server's agent in place, through that server's own Docker: write the verified current script into the
 * agent's container and restart it (the container keeps the file, its start command runs whatever /agent.mjs holds).
 * Only agents started with the join command's `docker run` can be updated this way.
 */
export async function upgradeAgent(actor: Actor, nodeId: string) {
  const node = nodesTable.get(nodeId);
  assert(node, 404, 'server not found');
  const c = conns.get(nodeId);
  assert(c?.ready && c.client, 409, `${node.name} is offline`);
  const from = node.info?.agentVersion || 'unknown';
  if (from === AGENT_VERSION) return { server: publicServer(node), upgraded: false, version: AGENT_VERSION };
  const d = c.client;
  const running = (await d.listContainers([], false)).filter((x) => x.State === 'running');
  let agent = running.find((x) => x.Names.includes('/servify-agent'));
  if (!agent) {
    for (const x of running) {
      const cmd = ((await d.inspectContainer(x.Id).catch(() => null))?.Config?.Cmd ?? []).join(' ');
      if (cmd.includes('/agent.mjs') && cmd.includes('--join')) {
        agent = x;
        break;
      }
    }
  }
  assert(agent, 409, `no agent container on ${node.name}: this agent runs outside Docker — update it by running the join command again`);
  const url = `https://${guessAddress()}:${config.agentPort}`;
  const hash = hashBytes(readFileSync(AGENT_SCRIPT));
  const r = await d.exec(agent.Id, ['sh', '-c', `wget -q --no-check-certificate -O /tmp/agent.new ${url}/agent.mjs && echo "${hash}  /tmp/agent.new" | sha256sum -c -s && mv /tmp/agent.new /agent.mjs && echo installed`], 60_000);
  assert(r.exitCode === 0 && r.output.includes('installed'), 502, `could not install the new agent on ${node.name}: ${r.output.trim().slice(-200) || `exit ${r.exitCode}`}`);
  // The restart cuts this very connection, so its answer never arrives; Docker carries it out regardless.
  await d.restartContainer(agent.Id, 2).catch(() => {});
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 1000));
    if (conns.get(nodeId)?.ready && nodesTable.get(nodeId)?.info?.agentVersion === AGENT_VERSION) {
      recordActivity(actor, 'server.agent', `Updated the agent on ${node.name} from ${from} to ${AGENT_VERSION}`);
      return { server: publicServer(nodesTable.get(nodeId)!), upgraded: true, version: AGENT_VERSION };
    }
  }
  throw new HttpError(504, `the new agent is installed on ${node.name} but hasn't reconnected within a minute — check the servify-agent container there`);
}

export async function addServer(actor: Actor, name: string) {
  const clean = name.trim().slice(0, 60);
  assert(clean, 400, 'give the server a name');
  assert(!nodesTable.all().some((n) => n.name.toLowerCase() === clean.toLowerCase()), 409, `a server named "${clean}" already exists`);
  const token = `svn_${secret(24)}`;
  const node: ServerNode = { id: newId('srv'), name: clean, tokenHash: sha256(token), tokenPrefix: token.slice(0, 10), createdAt: now(), lastSeenAt: null, info: null };
  nodesTable.insert(node);
  await startAgentListener();
  recordActivity(actor, 'server.added', `Added server ${clean}`);
  return { server: publicServer(node), token, join: await joinCommand(token) };
}

/** A new token (the old one stops working; a connected agent is disconnected). */
export async function rotateServerToken(actor: Actor, nodeId: string) {
  const node = nodesTable.get(nodeId);
  assert(node, 404, 'server not found');
  const token = `svn_${secret(24)}`;
  node.tokenHash = sha256(token);
  node.tokenPrefix = token.slice(0, 10);
  nodesTable.put(node);
  const c = conns.get(nodeId);
  if (c) dropConn(c, 'token rotated', false);
  recordActivity(actor, 'server.token', `New agent token for ${node.name}`);
  return { server: publicServer(node), token, join: await joinCommand(token) };
}

export function renameServer(actor: Actor, nodeId: string, name: string) {
  const node = nodesTable.get(nodeId);
  assert(node, 404, 'server not found');
  const clean = name.trim().slice(0, 60);
  assert(clean, 400, 'give the server a name');
  node.name = clean;
  nodesTable.put(node);
  recordActivity(actor, 'server.renamed', `Renamed server to ${clean}`);
  return publicServer(node);
}

export async function removeServer(actor: Actor, nodeId: string) {
  const node = nodesTable.get(nodeId);
  assert(node, 404, 'server not found');
  const placed = servicesTable.all().filter((s) => nodeOf(s) === nodeId);
  assert(!placed.length, 409, `move or delete its services first: ${placed.map((s) => s.name).slice(0, 5).join(', ')}`);
  const c = conns.get(nodeId);
  if (c) {
    send(c, { t: 'bye' });
    await sleep(100);
    dropConn(c, 'removed', false);
  }
  nodesTable.delete(nodeId);
  recordActivity(actor, 'server.removed', `Removed server ${node.name}`);
}
