#!/usr/bin/env node
/**
 * End-to-end checks for hosting existing workloads: host folders, read-only shares, adopting Docker volumes,
 * published TCP/UDP ports, external routes and the Compose import that uses them — including the owner-only gates
 * and that backups, restores and deletes never touch data a service doesn't own.
 *
 *   SERVIFY_URL=http://localhost:7840 SERVIFY_PROXY_PORT=8220 SERVIFY_TOKEN=<write token> \
 *   SERVIFY_TEST_HOST_DIR=/tmp/servify-host-test node scripts/acceptance-hosting.mjs
 *
 * The instance must run with SERVIFY_AUTH=none and SERVIFY_HOST_MOUNTS=$SERVIFY_TEST_HOST_DIR/host (the owner);
 * SERVIFY_TOKEN is an agent token (`servify token test`) used to check the gates. Uses host ports 19987-19991,
 * 18998 and 25001.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import dgram from 'node:dgram';
import net from 'node:net';
import http from 'node:http';

const BASE = (process.env.SERVIFY_URL ?? 'http://localhost:7700').replace(/\/$/, '');
const PROXY = Number(process.env.SERVIFY_PROXY_PORT ?? 8080);
const TOKEN = process.env.SERVIFY_TOKEN;
const ROOT = process.env.SERVIFY_TEST_HOST_DIR;
if (!TOKEN || !ROOT) {
  console.error('set SERVIFY_TOKEN (an agent token) and SERVIFY_TEST_HOST_DIR (see the header)');
  process.exit(2);
}
const HOST = `${ROOT}/host`;
const OUTSIDE = `${ROOT}/outside`;
for (const d of [`${HOST}/game`, `${HOST}/cproj/mods`, OUTSIDE]) mkdirSync(d, { recursive: true });
writeFileSync(`${HOST}/game/hello.txt`, 'from-host\n');
writeFileSync(`${HOST}/cproj/mods/a.jar`, 'mod-file\n');

let failed = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra && !ok ? ` — ${extra}` : ''}`);
};
async function call(method, path, body, token) {
  const r = await fetch(BASE + '/api' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = {};
  try {
    j = JSON.parse(t);
  } catch {}
  return r.ok ? j : { __error: `${r.status} ${j.error ?? t.slice(0, 160)}` };
}
const api = (m, p, b) => call(m, p, b);
const asAgent = (m, p, b) => call(m, p, b, TOKEN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 180_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(1500);
  }
  return null;
}
const sh = (c) => execSync(c, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const svc = (id) => api('GET', `/services/${id}`);
const running = (id, ms = 150_000) => waitFor(async () => (await svc(id)).status === 'running', ms);
const ex = (id, command) => api('POST', `/services/${id}/exec`, { command });

async function mounts() {
  console.log('\n▸ Host folders, read-only shares, adopted volumes');
const P = await api('POST', '/projects', { name: `mounts-${Date.now().toString(36)}` });
const box = (name) => api('POST', `/projects/${P.id}/services`, { image: 'alpine:3.20', name, protocol: 'none', startCommand: 'exec sleep 1000000' });

const g = (await box('game')).service;
await running(g.id);
const host = `${HOST}/game`;
let r = await asAgent('PATCH', `/services/${g.id}`, { volumes: [{ name: 'game', mountPath: '/srv', hostPath: host }] });
check('an agent token cannot add a host folder', /owner/.test(r.__error ?? ''), r.__error);
r = await api('PATCH', `/services/${g.id}`, { volumes: [{ name: 'x', mountPath: '/srv', hostPath: `${OUTSIDE}` }] });
check('a folder outside SERVIFY_HOST_MOUNTS is refused', /not under SERVIFY_HOST_MOUNTS/.test(r.__error ?? ''), r.__error);
r = await api('PATCH', `/services/${g.id}`, { volumes: [{ name: 'x', mountPath: '/srv', hostPath: `${HOST}/missing` }] });
check('a missing folder is refused (Docker would create it)', /doesn't exist/.test(r.__error ?? ''), r.__error);
r = await api('PATCH', `/services/${g.id}`, { volumes: [{ name: 'x', mountPath: '/s', hostPath: '/var/run/docker.sock' }] });
check('the Docker socket is refused', !!r.__error, r.__error);
r = await api('PATCH', `/services/${g.id}`, { volumes: [{ name: 'game', mountPath: '/srv', hostPath: host }] });
check('the owner can mount an allowed folder', !r.__error, r.__error);
await api('POST', `/services/${g.id}/deploy`);
await sleep(2000);
await running(g.id);
r = await ex(g.id, 'cat /srv/hello.txt && echo written-in-container > /srv/back.txt && echo ok');
check('the container sees and writes the host folder', /from-host/.test(r.output) && readFileSync(`${host}/back.txt`, 'utf8').includes('written-in-container'), r.output);
const sc = await api('PATCH', `/services/${g.id}`, { replicas: 2 });
check('a writable host folder keeps the service at one replica', /replica|volume/i.test(sc.__error ?? ''), sc.__error ?? 'allowed');
const bk = await api('GET', `/services/${g.id}`);
check('a host folder alone offers no volume backup (never archived)', bk.backupMethod === null, String(bk.backupMethod));

const owner = (await box('owner')).service;
await running(owner.id);
const vol = await api('POST', `/projects/${P.id}/volumes`, { name: 'shared-data', serviceId: owner.id, mountPath: '/data' });
await sleep(1500);
await running(owner.id);
await waitFor(async () => (await ex(owner.id, 'echo owner-data > /data/file && cat /data/file')).output?.includes('owner-data'), 60_000);
const reader = (await box('reader')).service;
await running(reader.id);
const volId = vol.volume?.id ?? vol.id;
r = await api('POST', `/volumes/${volId}/share`, { serviceId: reader.id, mountPath: '/backup-src' });
check('a volume can be shared read-only', !r.__error, r.__error);
await sleep(2000);
await running(reader.id);
const rd = await waitFor(async () => {
  const x = await ex(reader.id, 'cat /backup-src/file');
  return x.output?.includes('owner-data') && x;
}, 60_000);
check('the reader sees the owner’s data', !!rd);
r = await ex(reader.id, 'echo nope > /backup-src/file2 2>&1; echo rc=$?');
check('the reader cannot write to it', /Read-only|rc=1|rc=2/.test(r.output), r.output);
r = await api('PATCH', `/services/${reader.id}`, { replicas: 3 });
check('a read-only share doesn’t force one replica', !r.__error, r.__error);
await api('PATCH', `/services/${reader.id}`, { replicas: 1 });
const rv = await api('GET', `/services/${reader.id}`);
check('the reader has no backup of the shared volume', rv.backupMethod === null, String(rv.backupMethod));
await api('POST', `/volumes/${volId}/detach`);
r = await api('DELETE', `/volumes/${volId}`);
check('a shared volume cannot be deleted while mounted elsewhere', /read-only/.test(r.__error ?? ''), r.__error);
await api('DELETE', `/services/${reader.id}`);
await sleep(1500);
check('deleting the reader leaves the shared volume', !!(await api('GET', `/projects/${P.id}/volumes`)).find((v) => v.id === volId));

const dn = `oldapp_${Date.now().toString(36)}_pgdata`;
sh(`docker volume create ${dn}`);
sh(`docker run --name svf-oldapp-${Date.now().toString(36)} -v ${dn}:/data alpine:3.20 sh -c 'echo legacy-data > /data/legacy.txt'`);
const oldC = sh(`docker ps -aq --filter volume=${dn}`).trim();
const target = (await box('adopter')).service;
await running(target.id);
r = await asAgent('POST', `/projects/${P.id}/volumes/adopt`, { dockerName: dn, serviceId: target.id, mountPath: '/data' });
check('an agent token cannot adopt a volume', /owner/.test(r.__error ?? ''), r.__error);
const list = await api('GET', '/servers/local/docker-volumes');
check('unmanaged Docker volumes are listed with who uses them', !!list.find?.((v) => v.name === dn && v.usedBy.length === 1), JSON.stringify(list.find?.((v) => v.name === dn)));
r = await api('POST', `/projects/${P.id}/volumes/adopt`, { dockerName: dn, serviceId: target.id, mountPath: '/data' });
check('adopting is refused while a stopped outside container references it', /still referenced/.test(r.__error ?? ''), r.__error);
sh(`docker rm ${oldC}`);
r = await api('POST', `/projects/${P.id}/volumes/adopt`, { dockerName: dn, serviceId: target.id, mountPath: '/data' });
check('after removing it, the volume is adopted', !r.__error, r.__error);
await sleep(2000);
await running(target.id);
const ad = await waitFor(async () => (await ex(target.id, 'cat /data/legacy.txt')).output?.includes('legacy-data'), 60_000);
check('the adopted data is there, nothing copied', !!ad && (await api('GET', `/projects/${P.id}/volumes`)).find((v) => v.dockerName === dn)?.adopted === true);

await api('DELETE', `/projects/${P.id}`);
await sleep(4000);
check('deleting the project keeps the adopted Docker volume and its data', sh(`docker volume ls -q`).split('\n').includes(dn) && sh(`docker run --rm -v ${dn}:/d alpine:3.20 cat /d/legacy.txt`).includes('legacy-data'));
check('deleting the project never touches the host folder', readFileSync(`${host}/hello.txt`, 'utf8').includes('from-host'));
sh(`docker volume rm ${dn}`);

}

async function portsAndRoutes() {
  console.log('\n▸ Published ports and external routes');
const udpEcho = (port, msg) => new Promise((resolve) => {
  const s = dgram.createSocket('udp4');
  const t = setTimeout(() => { s.close(); resolve(null); }, 3000);
  s.on('message', (m) => { clearTimeout(t); s.close(); resolve(m.toString()); });
  s.send(msg, port, '127.0.0.1');
});
const curlHost = (host, path = '/') => new Promise((resolve) => {
  http.get({ host: '127.0.0.1', port: PROXY, path, headers: { host } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', (e) => resolve({ status: 0, body: e.message }));
});
const P = await api('POST', '/projects', { name: `ports-${Date.now().toString(36)}` });

const ts = (await api('POST', `/projects/${P.id}/services`, { image: 'alpine/socat:latest', name: 'voice', protocol: 'none', startCommand: 'exec socat UDP-RECVFROM:9987,fork EXEC:cat' })).service;
await running(ts.id);
let r = await asAgent('PATCH', `/services/${ts.id}`, { ports: [{ container: 9987, host: 19987, protocol: 'udp' }] });
check('an agent token cannot publish ports', /owner/.test(r.__error ?? ''), r.__error);
r = await api('PATCH', `/services/${ts.id}`, { ports: [{ container: 9987, host: 19987, protocol: 'udp' }] });
check('the owner publishes a UDP port', !r.__error && r.pendingChanges?.includes('published ports'), r.__error ?? JSON.stringify(r.pendingChanges));
await api('POST', `/services/${ts.id}/deploy`);
await sleep(2000);
await running(ts.id);
const echo = await waitFor(() => udpEcho(19987, 'ping-udp'), 30_000);
check('a UDP packet round-trips through the published port', echo === 'ping-udp', String(echo));
r = await api('PATCH', `/services/${ts.id}`, { replicas: 2 });
check('two replicas are refused with a published port', /one replica/.test(r.__error ?? ''), r.__error);
const web = (await api('POST', `/projects/${P.id}/services`, { image: 'nginx:alpine', name: 'web' })).service;
await running(web.id);
r = await api('PATCH', `/services/${web.id}`, { ports: [{ container: 80, host: 19987, protocol: 'udp' }] });
check('a port another service publishes is refused', /already published by voice/.test(r.__error ?? ''), r.__error);
const blocker = net.createServer().listen(19988, '0.0.0.0');
await sleep(200);
r = await api('PATCH', `/services/${web.id}`, { ports: [{ container: 80, host: 19988, protocol: 'tcp' }] });
check('a port busy on this machine is refused', /busy/.test(r.__error ?? ''), r.__error);
blocker.close();
r = await api('PATCH', `/services/${web.id}`, { ports: [{ container: 80, host: Number(new URL(BASE).port || 7700), protocol: 'tcp' }] });
check('Servify’s own ports are refused', /Servify itself|busy/.test(r.__error ?? ''), r.__error);
r = await api('PATCH', `/services/${web.id}`, { ports: [{ container: 80, host: 19989, protocol: 'tcp' }] });
await api('POST', `/services/${web.id}/deploy`);
await sleep(2000);
await running(web.id);
const direct = await waitFor(() => new Promise((res) => http.get('http://127.0.0.1:19989/', (x) => { x.resume(); res(x.statusCode); }).on('error', () => res(null))), 30_000);
check('a TCP port published straight on the machine answers', direct === 200, String(direct));
const viaRouter = await curlHost(`web.${P.slug}.localhost`);
check('the router still reaches it on its own binding', viaRouter.status === 200, String(viaRouter.status));
await api('POST', `/services/${web.id}/deploy`);
await sleep(3000);
const redeployed = await running(web.id);
const after = await waitFor(() => new Promise((res) => http.get('http://127.0.0.1:19989/', (x) => { x.resume(); res(x.statusCode); }).on('error', () => res(null))), 60_000);
check('a redeploy (stop first) gets the same port back', !!redeployed && after === 200);
const env = await api('POST', `/projects/${P.id}/environments`, { name: 'staging', deploy: false });
const envId = env.project?.id ?? env.id;
const envSvc = (await api('GET', `/projects/${envId}`)).services?.find((s) => s.name === 'voice');
check('environment copies don’t get published ports', envSvc && !envSvc.ports?.length, JSON.stringify(envSvc?.ports));
await api('DELETE', `/projects/${envId}`);

const name = `svf-ext-target-${Date.now().toString(36)}`;
sh(`docker run -d --name ${name} -p 127.0.0.1:18998:80 traefik/whoami:latest`);
r = await asAgent('POST', `/projects/${P.id}/services`, { external: 'http://127.0.0.1:18998', name: 'vault' });
check('an agent token cannot create an external route', /owner/.test(r.__error ?? ''), r.__error);
r = await api('POST', `/projects/${P.id}/services`, { external: 'https://10.0.0.1:443', name: 'x' });
check('https targets are refused with a clear message', /plain HTTP/.test(r.__error ?? ''), r.__error);
const ext = (await api('POST', `/projects/${P.id}/services`, { external: 'http://127.0.0.1:18998', name: 'vault' })).service;
await api('PATCH', `/services/${ext.id}`, { domains: ['vault.example.test'] });
check('the route comes up from probing', !!(await running(ext.id, 30_000)));
const hit = await curlHost('vault.example.test');
check('its domain is routed to the other machine, Host header kept', hit.status === 200 && /Host: vault\.example\.test/.test(hit.body), hit.body.split('\n').slice(0, 3).join(' | '));
const ws = await new Promise((resolve) => {
  const s = net.connect(PROXY, '127.0.0.1', () => s.write('GET /echo HTTP/1.1\r\nHost: vault.example.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'));
  s.once('data', (d) => { resolve(d.toString().split('\r\n')[0]); s.destroy(); });
  s.on('error', (e) => resolve(e.message));
  setTimeout(() => resolve('timeout'), 4000);
});
check('WebSockets pass through', /101/.test(ws), ws);
r = await api('POST', `/services/${ext.id}/deploy`);
check('deploying a route is refused', /nothing to deploy/.test(r.__error ?? ''), r.__error);
r = await api('PATCH', `/services/${ext.id}`, { replicas: 3 });
check('scaling a route is refused', !!r.__error, r.__error);
sh(`docker stop ${name}`);
const down = await waitFor(async () => (await svc(ext.id)).status === 'crashed', 30_000);
check('a dead target shows as down', !!down);
const unavailable = await curlHost('vault.example.test');
check('and the router answers unavailable instead of hanging', unavailable.status >= 500, String(unavailable.status));
sh(`docker start ${name}`);
check('it comes back when the target does', !!(await running(ext.id, 30_000)));
sh(`docker rm -f ${name}`);
await api('DELETE', `/projects/${P.id}`);

}

async function compose() {
  console.log('\n▸ Compose import with host folders, UDP and existing volumes');
const proj = `cproj${Date.now().toString(36)}`;
sh(`docker volume create ${proj}_world`);
sh(`docker run --rm -v ${proj}_world:/d alpine:3.20 sh -c 'echo world-save > /d/level.dat'`);
const yaml = `name: ${proj}
services:
  game:
    image: alpine/socat:latest
    command: ["UDP-RECVFROM:25000,fork", "EXEC:cat"]
    ports: ["25001:25000/udp"]
    volumes:
      - world:/data
      - ${HOST}/cproj/mods:/mods:ro
volumes:
  world: {}
`;
const plan = await api('POST', '/projects/import-compose', { yaml, dryRun: true });
const g = plan.services?.find((s) => s.slug === 'game');
check('the plan keeps the host folder, the UDP port and the Docker volume name', g?.volumes?.some((v) => v.hostPath?.endsWith('/mods') && v.readOnly) && g.volumes.some((v) => v.dockerName === `${proj}_world`) && g.published?.[0]?.host === 25001, JSON.stringify({ v: g?.volumes, p: g?.published }));
const imp = await api('POST', '/projects/import-compose', { yaml, adoptVolumes: true, deploy: true });
check('import with adoptVolumes', !imp.__error && imp.adopted?.includes(`${proj}_world`), imp.__error ?? JSON.stringify(imp.adopted));
const P = imp.project;
const svcId = (await api('GET', `/projects/${P.id}`)).services.find((s) => s.slug === 'game').id;
await waitFor(async () => (await api('GET', `/services/${svcId}`)).status === 'running', 150_000);
const ex = await api('POST', `/services/${svcId}/exec`, { command: 'cat /data/level.dat /mods/a.jar; touch /mods/x 2>/dev/null && echo writable || echo read-only' });
check('the adopted world and the read-only host folder are mounted', /world-save/.test(ex.output) && /mod-file/.test(ex.output) && /read-only/.test(ex.output), ex.output);
check('the volume is the original Docker volume', (await api('GET', `/projects/${P.id}/volumes`)).some((v) => v.dockerName === `${proj}_world` && v.adopted));
const b = await api('POST', `/services/${svcId}/backups`, {});
const done = await waitFor(async () => { const l = await api('GET', `/services/${svcId}/backups`); const x = (Array.isArray(l) ? l : l.backups ?? [])[0]; return x && x.status !== 'running' && x; }, 120_000);
check('a volume backup succeeds', done?.status === 'succeeded', JSON.stringify(done).slice(0, 120));
await api('POST', `/services/${svcId}/exec`, { command: 'echo changed > /data/level.dat' });
await api('POST', `/backups/${done.id}/restore`, {});
const restored = await waitFor(async () => { const s = await api('GET', `/services/${svcId}`); if (s.restoring || s.status !== 'running') return false; const r = await api('POST', `/services/${svcId}/exec`, { command: 'cat /data/level.dat' }); return r.output?.trim(); }, 180_000);
check('restore brings the volume back', restored === 'world-save', String(restored));
check('…and never wipes the host folder', existsSync(`${HOST}/cproj/mods/a.jar`) && readFileSync(`${HOST}/cproj/mods/a.jar`, 'utf8').includes('mod-file'));
await api('DELETE', `/projects/${P.id}`);
await sleep(3000);
check('deleting the project keeps the adopted volume', sh('docker volume ls -q').split('\n').includes(`${proj}_world`));
sh(`docker volume rm ${proj}_world`);

}

try {
  await mounts();
  await portsAndRoutes();
  await compose();
} catch (e) {
  failed++;
  console.log(`  ✗ ${e.message}`);
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall hosting checks passed');
process.exit(failed ? 1 : 0);
