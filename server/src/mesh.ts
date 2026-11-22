/**
 * The private network across servers. Each project has its own Docker network per server; when a project's
 * services run on more than one server, every server gets a small relay container per service that lives
 * elsewhere, joined to the project network under that service's names (`api`, its aliases) and listening on its
 * port. A connection to it goes to Servify over TLS (the same pinned certificate agents use) and on to a healthy
 * replica wherever it runs. So `postgres:5432` works from any server, with no ports opened between servers.
 *
 * Only the service's main port is relayed, and each relay may only reach services of its own project (its token is
 * derived from the project id). Connections take a detour through this machine, so keep chatty services together.
 */
import net from 'node:net';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { kv, projects as projectsTable, services as servicesTable } from './db.ts';
import { dockerFor, isOnline, nodeOf, onlineNodes, onNodeChange, hubAddress } from './nodes.ts';
import { networkName, LABEL, INSTANCE_ID, noteConn } from './engine.ts';
import { agentTlsMaterial } from './certs.ts';
import { config } from './config.ts';
import { open, seal } from './crypto.ts';
import { pickUpstream } from './proxy.ts';
import { touch, wake } from './sleep.ts';
import type { Service } from './types.ts';

const IMAGE = 'node:22-alpine'; // what agents run, so servers already have it
const MESH = 'servify.mesh';

// ─── tokens ───

let secretCache: Buffer | null = null;
function meshSecret(): Buffer {
  if (secretCache) return secretCache;
  const stored = kv.get('mesh_secret');
  if (stored) secretCache = Buffer.from(open(stored), 'hex');
  else {
    secretCache = randomBytes(32);
    kv.set('mesh_secret', seal(secretCache.toString('hex')));
  }
  return secretCache;
}
const tokenFor = (projectId: string) => createHmac('sha256', meshSecret()).update(`mesh:${projectId}`).digest('hex');

// ─── the relay inside each container ───

/** Kept tiny and dependency-free: it runs as `node -e` in the stock image. */
const RELAY = `
const net=require('net'),tls=require('tls');
const E=process.env,[H,P]=[E.HUB.replace(/:\\d+$/,''),+E.HUB.split(':').pop()];
net.createServer({allowHalfOpen:true},c=>{
  c.pause();c.on('error',()=>{});
  const s=tls.connect({host:H,port:P,servername:net.isIP(H)?undefined:H,rejectUnauthorized:false,allowHalfOpen:true});
  const bye=()=>{s.destroy();c.destroy()};
  s.on('error',bye);c.on('close',()=>s.destroy());s.setTimeout(15000,bye);
  s.once('secureConnect',()=>{
    if((s.getPeerCertificate().fingerprint256||'').toUpperCase()!==E.FP)return bye();
    s.write('GET /mesh/v1/relay/'+E.SVC+' HTTP/1.1\\r\\nHost: '+H+'\\r\\nAuthorization: Bearer '+E.TOKEN+'\\r\\nUpgrade: servify-mesh\\r\\nConnection: Upgrade\\r\\n\\r\\n');
    let b=Buffer.alloc(0);
    const on=d=>{b=Buffer.concat([b,d]);const e=b.indexOf('\\r\\n\\r\\n');if(e<0)return;
      s.pause();s.off('data',on);s.setTimeout(0);
      if(!/^HTTP\\/1\\.1 101/.test(b.toString('latin1',0,b.indexOf('\\r\\n'))))return bye();
      const r=b.subarray(e+4);if(r.length)s.unshift(r);
      s.on('close',()=>c.destroy());s.pipe(c);c.pipe(s);c.resume();s.resume()};
    s.on('data',on)})
}).listen(+E.PORT,'0.0.0.0',()=>console.log('relaying :'+E.PORT+' to '+E.NAME));
`.trim();

// ─── the hub side ───

/** `GET /mesh/v1/relay/<serviceId>` on the agent endpoint: splice the caller to a healthy replica. */
export function handleMeshUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const m = /^\/mesh\/v1\/relay\/([A-Za-z0-9_-]{4,40})$/.exec(req.url ?? '');
  if (!m) return false;
  const deny = (code: string) => socket.end(`HTTP/1.1 ${code}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  const svc = servicesTable.get(m[1]);
  const given = Buffer.from(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '');
  const want = svc ? Buffer.from(tokenFor(svc.projectId)) : Buffer.alloc(0);
  if (!svc || given.length !== want.length || !timingSafeEqual(given, want)) {
    deny('401 Unauthorized');
    return true;
  }
  socket.pause();
  touch(svc.id);
  void (async () => {
    if (svc.sleeping) await wake(svc.id, 'a connection from another server');
    let up = pickUpstream(servicesTable.get(svc.id) ?? svc, '');
    for (let i = 0; !up && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500)); // starting or redeploying: give it a moment
      up = pickUpstream(servicesTable.get(svc.id) ?? svc, '');
    }
    if (!up?.port) return deny('503 Service Unavailable');
    const target = net.connect({ host: up.host ?? '127.0.0.1', port: up.port, allowHalfOpen: true });
    target.once('error', () => deny('502 Bad Gateway'));
    target.once('connect', () => {
      target.removeAllListeners('error');
      noteConn(up!.containerId, 1); // counts for least-connections, draining and sleeping, like router traffic
      let done = false;
      target.once('close', () => {
        if (done) return;
        done = true;
        noteConn(up!.containerId, -1);
        touch(svc.id);
      });
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: servify-mesh\r\nConnection: Upgrade\r\n\r\n');
      if (head.length) target.write(head);
      for (const [a, b] of [
        [socket, target],
        [target, socket],
      ] as [Duplex, Duplex][]) {
        a.on('error', () => b.destroy());
        a.on('close', () => b.destroy());
        a.pipe(b);
      }
      socket.resume();
    });
  })().catch(() => deny('500 Internal Server Error'));
  return true;
}

// ─── keeping the relays in place ───

type Want = { node: string; svc: Service; name: string; aliases: string[]; hash: string };

/** Services reachable on the private network: something listening on a port. */
const relayable = (s: Service) => s.protocol !== 'none' && !!s.port && s.source.type !== 'external' && s.source.type !== 'redirect' && !s.stopped;

async function desired(): Promise<Want[]> {
  const out: Want[] = [];
  const hub = `${hubAddress()}:${config.agentPort}`;
  const fp = (await agentTlsMaterial()).fingerprint.toUpperCase();
  const byProject = new Map<string, Service[]>();
  for (const s of servicesTable.all()) {
    (byProject.get(s.projectId) ?? byProject.set(s.projectId, []).get(s.projectId)!).push(s);
  }
  for (const [projectId, list] of byProject) {
    const project = projectsTable.get(projectId);
    if (!project) continue;
    const nodes = new Set(list.filter((s) => s.activeDeploymentId && !s.stopped && s.source.type !== 'external' && s.source.type !== 'redirect').map(nodeOf));
    if (nodes.size < 2) continue;
    for (const node of nodes) {
      for (const svc of list) {
        if (!relayable(svc) || nodeOf(svc) === node) continue;
        const aliases = [...new Set([svc.slug, ...(svc.aliases ?? [])])];
        const name = `svf-mesh-${project.slug}-${svc.slug}`.slice(0, 120);
        out.push({ node, svc, name, aliases, hash: [hub, fp, svc.port, aliases.join(','), IMAGE, RELAY.length].join('|') });
      }
    }
  }
  return out;
}

async function ensureImage(node: string) {
  const d = dockerFor(node);
  if (await d.inspectImage(IMAGE).catch(() => null)) return;
  await d.pullImage(IMAGE);
}

async function create(w: Want, fp: string) {
  const d = dockerFor(w.node);
  await ensureImage(w.node);
  const network = networkName(w.svc.projectId);
  await d.ensureNetwork(network, { [LABEL.managed]: 'true', [LABEL.instance]: INSTANCE_ID, [LABEL.project]: w.svc.projectId });
  const id = await d.createContainer(w.name, {
    Image: IMAGE,
    Cmd: ['node', '-e', RELAY],
    Env: [`HUB=${hubAddress()}:${config.agentPort}`, `FP=${fp}`, `TOKEN=${tokenFor(w.svc.projectId)}`, `SVC=${w.svc.id}`, `PORT=${w.svc.port}`, `NAME=${w.svc.name}`],
    Labels: { [MESH]: 'true', [`${MESH}.hash`]: w.hash, [LABEL.instance]: INSTANCE_ID, [LABEL.project]: w.svc.projectId, [LABEL.service]: w.svc.id },
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, Memory: 64 * 1024 * 1024, ExtraHosts: ['host.docker.internal:host-gateway'] },
    NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: w.aliases } } },
  });
  await d.startContainer(id);
}

let running = false;
export async function reconcileMesh() {
  if (running) return;
  running = true;
  try {
    const want = await desired();
    const fp = (await agentTlsMaterial()).fingerprint.toUpperCase();
    for (const node of onlineNodes()) {
      const have = await dockerFor(node)
        .listContainers([`${MESH}=true`, `${LABEL.instance}=${INSTANCE_ID}`])
        .catch(() => null);
      if (!have) continue;
      const mine = want.filter((w) => w.node === node);
      for (const c of have) {
        const name = (c.Names?.[0] ?? '').replace(/^\//, '');
        const w = mine.find((x) => x.name === name);
        if (!w || c.Labels[`${MESH}.hash`] !== w.hash) await dockerFor(node).removeContainer(c.Id, true).catch(() => {});
        else if (c.State !== 'running') await dockerFor(node).startContainer(c.Id).catch(() => {});
      }
      for (const w of mine) {
        const exists = have.some((c) => (c.Names?.[0] ?? '').replace(/^\//, '') === w.name && c.Labels[`${MESH}.hash`] === w.hash);
        if (!exists && isOnline(node)) await create(w, fp).catch((e) => console.error(`[mesh] ${w.name} on ${node}:`, (e as Error).message));
      }
    }
  } finally {
    running = false;
  }
}

export function startMesh() {
  const tick = () => void reconcileMesh().catch((e) => console.error('[mesh]', (e as Error).message));
  setTimeout(tick, 5000).unref();
  setInterval(tick, Number(process.env.SERVIFY_MESH_INTERVAL_MS) || 20_000).unref();
  onNodeChange(() => setTimeout(tick, 2000));
}
