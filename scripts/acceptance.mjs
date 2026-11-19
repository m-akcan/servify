#!/usr/bin/env node
/**
 * End-to-end acceptance test against a running Servify (real Docker).
 *   SERVIFY_URL=http://localhost:7700 SERVIFY_TOKEN=svf_... node scripts/acceptance.mjs
 * Exercises: deploy, load balancing, scale up/down, zero-downtime redeploy, self-heal, TCP LB.
 */
import { execSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';

const BASE = process.env.SERVIFY_URL ?? 'http://localhost:7700';
const TOKEN = process.env.SERVIFY_TOKEN;
const PROXY_PORT = Number(process.env.SERVIFY_PROXY_PORT ?? 8080);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

async function api(method, path, body) {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.error ?? ''}`);
  return json;
}

function hit(host) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PROXY_PORT, path: '/', headers: { host }, agent: false, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, replica: res.headers['x-servify-replica'], body }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => req.destroy());
  });
}

function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

async function waitFor(fn, timeoutMs = 90_000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true;
    } catch {}
    await sleep(500);
  }
  console.log(`  … timed out waiting for ${label}`);
  return false;
}

async function waitDeploy(depId) {
  let d;
  await waitFor(async () => {
    d = await api('GET', `/deployments/${depId}`);
    return !['queued', 'building', 'deploying'].includes(d.status);
  }, 300_000, `deployment ${depId}`);
  return d;
}

async function healthyCount(svcId) {
  const s = await api('GET', `/services/${svcId}`);
  const m = await api('GET', `/services/${svcId}/metrics?seconds=1`);
  return m.replicas.filter((r) => r.state === 'healthy' && r.deploymentId === s.activeDeploymentId).length;
}

const project = await api('POST', '/projects', { name: `accept-${Date.now().toString(36)}` });
console.log(`project ${project.slug}`);
try {
  // 1. deploy whoami x3
  console.log('\n▸ deploy + load balancing');
  const { service, deployment } = await api('POST', `/projects/${project.id}/services`, { templateId: 'whoami', replicas: 3, name: 'web' });
  const d1 = await waitDeploy(deployment.id);
  check('first deployment active', d1.status === 'active', d1.error ?? '');
  const host = `${service.slug}.${project.slug}.localhost`;
  const seen = new Map();
  for (let i = 0; i < 30; i++) {
    const r = await hit(host);
    const h = r.body?.match(/Hostname: (\S+)/)?.[1];
    if (h) seen.set(h, (seen.get(h) ?? 0) + 1);
  }
  check('3 distinct replicas answered 30 requests', seen.size === 3, JSON.stringify([...seen]));

  // 2. scale 3 → 5 → 1
  console.log('\n▸ scaling');
  await api('POST', `/services/${service.id}/scale`, { replicas: 5 });
  check('scaled to 5 healthy', await waitFor(async () => (await healthyCount(service.id)) === 5, 60_000, '5 replicas'));
  await api('POST', `/services/${service.id}/scale`, { replicas: 1 });
  check('scaled down to 1 healthy', await waitFor(async () => (await healthyCount(service.id)) === 1, 60_000, '1 replica'));
  await api('POST', `/services/${service.id}/scale`, { replicas: 2 });
  await waitFor(async () => (await healthyCount(service.id)) === 2, 60_000, '2 replicas');

  // 3. zero-downtime redeploy under load
  console.log('\n▸ zero-downtime redeploy under load');
  let stop = false;
  let ok = 0;
  let bad = 0;
  const badCodes = [];
  const loaders = Array.from({ length: 4 }, async () => {
    while (!stop) {
      const r = await hit(host);
      if (r.status === 200) ok++;
      else {
        bad++;
        badCodes.push(r.status || r.error);
      }
    }
  });
  const rd = await api('POST', `/services/${service.id}/restart`);
  const d2 = await waitDeploy(rd.id);
  await sleep(1500);
  stop = true;
  await Promise.all(loaders);
  check('redeploy active', d2.status === 'active', d2.error ?? '');
  check(`no failed requests during redeploy (${ok} ok)`, bad === 0, `${bad} failed: ${[...new Set(badCodes)].join(',')}`);

  // 4. self-heal after docker kill
  console.log('\n▸ self-healing');
  const m = await api('GET', `/services/${service.id}/metrics?seconds=1`);
  const victim = m.replicas.find((r) => r.state === 'healthy');
  execSync(`docker rm -f ${victim.containerId}`, { stdio: 'ignore' });
  check('replica replaced after container removal', await waitFor(async () => (await healthyCount(service.id)) === 2, 60_000, 'self-heal'));

  // 5. TCP load balancing with redis
  console.log('\n▸ TCP proxy (redis)');
  const r = await api('POST', `/projects/${project.id}/services`, { templateId: 'redis' });
  const d3 = await waitDeploy(r.deployment.id);
  check('redis active', d3.status === 'active', d3.error ?? '');
  const svc = await api('GET', `/services/${r.service.id}`);
  const pong = await new Promise((resolve) => {
    const s = net.connect(svc.publicTcpPort, '127.0.0.1', () => s.write(`AUTH ${svc.env.REDIS_PASSWORD}\r\nPING\r\n`));
    let buf = '';
    s.on('data', (c) => {
      buf += c;
      if (buf.includes('PONG')) {
        s.destroy();
        resolve(true);
      }
    });
    s.on('error', () => resolve(false));
    setTimeout(() => resolve(false), 5000);
  });
  check(`redis answers PING through TCP proxy :${svc.publicTcpPort}`, pong);

  // 6. variable references resolve
  const resolved = await api('GET', `/services/${service.id}/variables/resolved`);
  await api('PUT', `/services/${service.id}/variables`, { variables: { REDIS: '${{ redis.REDIS_URL }}' } });
  const resolved2 = await api('GET', `/services/${service.id}/variables/resolved`);
  check('cross-service variable reference resolves', resolved2.env.REDIS?.startsWith('redis://default:') && resolved2.unresolved.length === 0, JSON.stringify(resolved2.unresolved));
  void resolved;
} catch (e) {
  failures++;
  console.error('  ✗ error:', e.message);
} finally {
  if (!process.env.KEEP) {
    await api('DELETE', `/projects/${project.id}`).catch(() => {});
    console.log('\ncleaned up');
  }
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
