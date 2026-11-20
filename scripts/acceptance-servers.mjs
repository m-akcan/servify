#!/usr/bin/env node
/**
 * End-to-end checks for multi-server: a second Docker daemon (docker-in-docker) joins through `servify agent`,
 * and services are deployed, routed, built, exec'd, backed up, clustered and moved across servers.
 *
 *   SERVIFY_URL=http://localhost:7820 SERVIFY_PROXY_PORT=8200 node scripts/acceptance-servers.mjs
 *
 * The instance must run with SERVIFY_AUTH=none (or pass SERVIFY_COOKIE) and with an agent endpoint the test
 * container can reach, e.g. on Docker Desktop / OrbStack:
 *   SERVIFY_AGENT_HOST=127.0.0.1 SERVIFY_AGENT_PUBLIC_HOST=host.docker.internal
 * The script creates (and removes) the containers svf-test-node / svf-test-agent and the volume svf-test-node-run.
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';

const BASE = process.env.SERVIFY_URL ?? 'http://localhost:7700';
const PROXY = Number(process.env.SERVIFY_PROXY_PORT ?? 8080);
const COOKIE = process.env.SERVIFY_COOKIE;
const NODE = 'svf-test-node';
const AGENT = 'svf-test-agent';
const RUNVOL = 'svf-test-node-run';
let failed = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra && !ok ? ` — ${extra}` : ''}`);
};
async function api(method, path, body) {
  const r = await fetch(BASE + '/api' + path, { method, headers: { 'content-type': 'application/json', ...(COOKIE ? { cookie: COOKIE } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = {};
  try {
    j = JSON.parse(t);
  } catch {}
  if (!r.ok) return { __error: `${r.status} ${j.error ?? t.slice(0, 160)}` };
  return j;
}
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
const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const onNode = (cmd) => sh(`docker exec ${NODE} ${cmd}`);
const curl = (host) => sh(`curl -s -m 5 -H "Host: ${host}" http://127.0.0.1:${PROXY}/`);
const svc = (id) => api('GET', `/services/${id}`);
const projects = [];
let serverId = null;
const tmp = mkdtempSync(join(tmpdir(), 'servify-servers-'));

function cleanupContainers() {
  try {
    sh(`docker rm -f ${AGENT} ${NODE} 2>/dev/null || true`);
    sh(`docker volume rm ${RUNVOL} 2>/dev/null || true`);
  } catch {}
}

try {
  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ Joining a server');
  cleanupContainers();
  sh(`docker volume create ${RUNVOL}`);
  sh(`docker run -d --privileged --name ${NODE} -e DOCKER_TLS_CERTDIR= -v ${RUNVOL}:/var/run docker:27-dind`);
  check('a second Docker daemon starts', !!(await waitFor(async () => onNode('docker version --format {{.Server.Version}}').trim(), 60_000)));
  const added = await api('POST', '/servers', { name: `test-node-${Date.now().toString(36)}` });
  serverId = added.server?.id;
  check('a server can be added (token + join command)', !!serverId && added.token?.startsWith('svn_') && /sha256sum -c/.test(added.join?.docker ?? ''), added.__error);
  // The real one-liner, inside the test daemon's network namespace instead of --network host.
  const inner = added.join.docker.match(/sh -c \\\n {2}'([\s\S]*)'$/)[1];
  sh(`docker run -d --name ${AGENT} --network container:${NODE} -v ${RUNVOL}:/var/run node:22-alpine sh -c '${inner.replace(/'/g, `'\\''`)}'`);
  const online = await waitFor(async () => (await api('GET', '/servers')).find((s) => s.id === serverId && s.status === 'online'), 60_000);
  check('the agent downloads, verifies and connects', !!online, sh(`docker logs ${AGENT} 2>&1 | tail -3`));
  check('the server reports its Docker version', !!online?.info?.dockerVersion);
  const bad = await new Promise((resolve) => {
    const u = new URL(added.join.url);
    const s = tls.connect({ host: '127.0.0.1', port: Number(u.port), rejectUnauthorized: false }, () =>
      s.write('GET /agent/v1/control HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer svn_wrongwrongwrongwrongwrongwrong\r\nUpgrade: servify-agent\r\nConnection: Upgrade\r\n\r\n'),
    );
    s.on('data', (d) => resolve(d.toString().split('\r\n')[0]));
    s.on('error', (e) => resolve(e.message));
  });
  check('a wrong agent token is refused', /401/.test(bad), bad);

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ Services on the server');
  const P = await api('POST', '/projects', { name: `servers-${Date.now().toString(36)}` });
  projects.push(P.id);
  const who = (await api('POST', `/projects/${P.id}/services`, { image: 'traefik/whoami:latest', name: 'who', port: 80, replicas: 2, server: serverId })).service;
  const web = (await api('POST', `/projects/${P.id}/services`, { image: 'nginx:alpine', name: 'web', server: serverId })).service;
  writeFileSync(join(tmp, 'Dockerfile'), "FROM nginx:alpine\nRUN printf 'built\\n' > /usr/share/nginx/html/index.html && sed -i 's/listen  *80;/listen 8080;/' /etc/nginx/conf.d/default.conf\nEXPOSE 8080\n");
  const built = (await api('POST', `/projects/${P.id}/services`, { path: tmp, name: 'built', port: 8080, server: serverId })).service;
  const up = await waitFor(async () => (await Promise.all([who, web, built].map((s) => svc(s.id)))).every((s) => s.status === 'running'), 300_000);
  check('image and folder-build services run on the server', !!up);
  check('their containers live in the server’s Docker', /who/.test(onNode('docker ps --format {{.Names}}')));
  check('the folder was built on the server', /servify\//.test(onNode('docker images --format {{.Repository}}')));
  const hits = new Set();
  for (let i = 0; i < 10; i++) hits.add(curl(`who.${P.slug}.localhost`).match(/Hostname: (\S+)/)?.[1]);
  hits.delete(undefined);
  check('the router balances across both remote replicas', hits.size === 2, [...hits].join(','));
  check('a remote build answers through the router', curl(`built.${P.slug}.localhost`).trim() === 'built');
  const ex = await api('POST', `/services/${web.id}/exec`, { command: 'nginx -v 2>&1' });
  check('exec runs in the remote container', ex.exitCode === 0 && /nginx/.test(ex.output ?? ''), JSON.stringify(ex).slice(0, 160));
  check('cpu/memory stats arrive from the server', !!(await waitFor(async () => (await api('GET', `/projects/${P.id}`)).replicas?.[web.id]?.some((r) => r.memMb > 0), 40_000)));
  await sleep(2000);
  const logs = await api('GET', `/services/${who.id}/logs?limit=20`);
  check('runtime logs stream back', (Array.isArray(logs) ? logs : logs.lines ?? []).length > 0);

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ Data stays on its server');
  const db = (await api('POST', `/projects/${P.id}/services`, { templateId: 'postgres', name: 'db', server: serverId })).service;
  await waitFor(async () => (await svc(db.id)).status === 'running', 240_000);
  const vol = (await api('GET', `/projects/${P.id}/volumes`)).find((v) => v.serviceId === db.id);
  check('its volume is created on the server', vol?.nodeId === serverId && onNode('docker volume ls -q').includes(vol.dockerName));
  await waitFor(async () => (await api('POST', `/services/${db.id}/exec`, { command: 'pg_isready -q -U postgres' })).exitCode === 0, 60_000);
  await api('POST', `/services/${db.id}/exec`, { command: `psql -U postgres -d app -qc "create table t(x int); insert into t values (7)"` });
  const mv = await api('POST', `/services/${db.id}/move`, { server: 'local' });
  check('a service with volumes refuses to move', /data can't move/.test(mv.__error ?? ''), mv.__error);
  await api('POST', `/services/${db.id}/backups`, {});
  const bak = await waitFor(async () => {
    const list = await api('GET', `/services/${db.id}/backups`);
    const b = (Array.isArray(list) ? list : list.backups ?? [])[0];
    return b && b.status !== 'running' && b;
  }, 120_000);
  check('a database backup is taken on the server and stored here', bak?.status === 'succeeded' && bak.sizeBytes > 100, JSON.stringify(bak).slice(0, 160));
  await api('POST', `/services/${db.id}/exec`, { command: `psql -U postgres -d app -qc "insert into t values (8)"` });
  await api('POST', `/backups/${bak.id}/restore`, {});
  const restored = await waitFor(async () => {
    const s = await svc(db.id);
    if (s.restoring || s.status !== 'running') return false;
    const r = await api('POST', `/services/${db.id}/exec`, { command: `psql -U postgres -d app -tAc "select string_agg(x::text, ',' order by x) from t"` });
    return r.exitCode === 0 && r.output.trim();
  }, 240_000);
  check('a restore streams the backup back to the server', restored === '7', `got ${restored}`);

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ A lost server changes nothing');
  const before = onNode('docker ps -q --no-trunc').trim().split('\n').sort().join();
  sh(`docker stop ${AGENT}`);
  await waitFor(async () => (await api('GET', '/servers')).find((s) => s.id === serverId)?.status === 'offline', 60_000);
  await sleep(40_000);
  const st = await svc(web.id);
  check('services on an offline server are not marked crashed', st.status === 'running' && st.server?.online === false, `${st.status} online=${st.server?.online}`);
  check('deleting one is refused while it is offline', /offline/.test((await api('DELETE', `/services/${web.id}`)).__error ?? ''));
  sh(`docker start ${AGENT}`);
  check('the agent reconnects by itself', !!(await waitFor(async () => (await api('GET', '/servers')).find((s) => s.id === serverId)?.status === 'online', 90_000)));
  await sleep(6000);
  check('the same containers are adopted, none recreated', onNode('docker ps -q --no-trunc').trim().split('\n').sort().join() === before);
  check('routing works again', curl(`built.${P.slug}.localhost`).trim() === 'built');

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ Moving between servers');
  const moved = await api('POST', `/services/${who.id}/move`, { server: 'local' });
  check('a stateless service can move to this machine', moved.server?.id === 'local', moved.__error);
  let down = 0;
  const done = await waitFor(async () => {
    if (!/Hostname/.test(curl(`who.${P.slug}.localhost`))) down++;
    return (await svc(who.id)).status === 'running' && !/who/.test(onNode('docker ps --format {{.Names}}')) && sh('docker ps --format {{.Names}}').includes(`${P.slug}-who`);
  }, 240_000);
  check('it runs here and the old replicas are gone from the server', !!done);
  check('no failed requests during the move', down === 0, `${down} failed`);

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ Built images follow the service');
  await api('POST', `/services/${built.id}/move`, { server: 'local' });
  const builtHere = await waitFor(async () => (await svc(built.id)).status === 'running' && (await svc(built.id)).server?.id === 'local' && !/built/.test(onNode('docker ps --format {{.Names}}')), 240_000);
  const deps = await api('GET', `/services/${built.id}/deployments`);
  const lastLog = ((await api('GET', `/deployments/${deps[0]?.id}/logs`)) || []).map?.((l) => l.text).join('\n') ?? '';
  check('moving a built service copies its exact image (no rebuild)', !!builtHere && /Copying/.test(lastLog) && !/Commit|Building|docker build/i.test(lastLog), lastLog.split('\n').slice(0, 4).join(' | '));
  check('it answers from this machine', curl(`built.${P.slug}.localhost`).trim() === 'built');
  await api('POST', `/services/${built.id}/stop`);
  await waitFor(async () => (await svc(built.id)).status === 'stopped', 60_000);
  await api('POST', `/services/${built.id}/move`, { server: serverId });
  onNode(`sh -c "docker images --format '{{.Repository}}:{{.Tag}}' | grep servify/ | xargs -r docker rmi -f"`);
  await api('POST', `/services/${built.id}/start`);
  const startedThere = await waitFor(async () => (await svc(built.id)).status === 'running' && /built/.test(onNode('docker ps --format {{.Names}}')) && curl(`built.${P.slug}.localhost`).trim() === 'built', 240_000);
  check('a service moved while stopped starts on its new server (image copied back)', !!startedThere);

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ Environments keep their servers');
  const env = await api('POST', `/projects/${P.id}/environments`, { name: 'staging', deploy: false });
  const envId = env.project?.id ?? env.id;
  if (envId) projects.unshift(envId);
  const envSnap = envId ? await api('GET', `/projects/${envId}`) : { services: [] };
  const copy = envSnap.services?.find((s) => s.name === 'web');
  check('a copied service lands on the same server as the original', copy?.server?.id === serverId, JSON.stringify(copy?.server ?? env.__error ?? env).slice(0, 160));

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ PostgreSQL cluster on the server');
  const pgc = (await api('POST', `/projects/${P.id}/services`, { templateId: 'postgres-cluster', name: 'pgc', server: serverId })).service;
  const formed = await waitFor(async () => {
    const c = (await svc(pgc.id)).clusterStatus;
    return c.members.filter((m) => m.role === 'primary').length === 1 && c.members.filter((m) => m.syncState === 'quorum').length === 2 && c;
  }, 600_000);
  check('3 members form on the server', !!formed);
  if (formed) {
    onNode(`docker pause ${formed.members.find((m) => m.index === formed.primary).containerId}`);
    check('a hung primary fails over', !!(await waitFor(async () => (await svc(pgc.id)).clusterStatus.primary !== formed.primary, 150_000)));
    const healed = await waitFor(async () => {
      const c = (await svc(pgc.id)).clusterStatus;
      return c.members.filter((m) => m.syncState === 'quorum').length === 2 && c;
    }, 600_000);
    check('the old primary is rebuilt as a standby', !!healed);
  }
} catch (e) {
  failed++;
  console.log(`  ✗ ${e.message}`);
} finally {
  for (const p of projects) await api('DELETE', `/projects/${p}`);
  await sleep(3000);
  if (serverId) await api('DELETE', `/servers/${serverId}`);
  cleanupContainers();
  rmSync(tmp, { recursive: true, force: true });
  console.log('\ncleaned up');
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall server checks passed');
process.exit(failed ? 1 : 0);
