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

  // 7. failed deploy (stateless) keeps the old version serving
  console.log('\n▸ failure safety');
  await api('PATCH', `/services/${service.id}`, { startCommand: 'exit 3' });
  const bad1 = await api('POST', `/services/${service.id}/deploy`);
  const bd1 = await waitDeploy(bad1.id);
  check('broken stateless deploy fails', bd1.status === 'failed', bd1.status);
  check('old version still serves after failed deploy', (await hit(host)).status === 200);
  await api('PATCH', `/services/${service.id}`, { startCommand: null });

  // 8. volume service: data persists across redeploy, survives a failed deploy
  const redisCmd = async (cmd) =>
    new Promise((resolve) => {
      const s = net.connect(svc.publicTcpPort, '127.0.0.1', () => s.write(`AUTH ${svc.env.REDIS_PASSWORD}\r\n${cmd}\r\n`));
      let buf = '';
      s.on('data', (c) => (buf += c));
      setTimeout(() => (s.destroy(), resolve(buf)), 700);
      s.on('error', () => resolve(''));
    });
  await redisCmd('SET servify-test persisted');
  await redisCmd('SAVE');
  const rr = await api('POST', `/services/${r.service.id}/restart`);
  await waitDeploy(rr.id);
  await waitFor(async () => (await healthyCount(r.service.id)) === 1, 60_000, 'redis healthy');
  check('redis data survives a redeploy', (await redisCmd('GET servify-test')).includes('persisted'));
  const origStart = svc.startCommand;
  await api('PATCH', `/services/${r.service.id}`, { startCommand: 'exit 4' });
  const bad2 = await api('POST', `/services/${r.service.id}/deploy`);
  const bd2 = await waitDeploy(bad2.id);
  check('broken stateful deploy fails', bd2.status === 'failed', bd2.status);
  check('stateful service recovers old version', await waitFor(async () => (await healthyCount(r.service.id)) === 1, 60_000, 'redis recovery'));
  check('redis data intact after failed deploy', (await redisCmd('GET servify-test')).includes('persisted'));
  await api('PATCH', `/services/${r.service.id}`, { startCommand: origStart });

  // 9. rollback
  console.log('\n▸ rollback, stop/start, kill');
  const rb = await api('POST', `/services/${service.id}/rollback`, { deploymentId: deployment.id });
  const rbd = await waitDeploy(rb.id);
  check('rollback deploy active', rbd.status === 'active', rbd.error ?? '');

  // 10. stop / start
  await api('POST', `/services/${service.id}/stop`);
  check('stopped service returns 503', (await hit(host)).status === 503);
  await api('POST', `/services/${service.id}/start`);
  check('started service serves again', await waitFor(async () => (await hit(host)).status === 200, 60_000, 'start'));
  await waitFor(async () => (await healthyCount(service.id)) === 2, 60_000, '2 healthy');

  // 11. docker kill (not rm)
  const m2 = await api('GET', `/services/${service.id}/metrics?seconds=1`);
  const v2 = m2.replicas.find((x) => x.state === 'healthy');
  execSync(`docker kill ${v2.containerId}`, { stdio: 'ignore' });
  await sleep(1500);
  check('killed replica comes back', await waitFor(async () => (await healthyCount(service.id)) === 2, 60_000, 'kill recovery'));

  // 12. autoscale up under load
  console.log('\n▸ autoscaling');
  await api('POST', `/services/${service.id}/scale`, { replicas: 1 });
  await api('PATCH', `/services/${service.id}`, { autoscale: { enabled: true, metric: 'rps', target: 10, min: 1, max: 4 } });
  let stopLoad = false;
  const load = (async () => {
    while (!stopLoad) {
      await hit(host);
      await sleep(15);
    }
  })();
  const scaled = await waitFor(async () => (await api('GET', `/services/${service.id}`)).replicas >= 2, 60_000, 'autoscale up');
  stopLoad = true;
  await load;
  check('autoscaler adds replicas under load', scaled);
  await api('PATCH', `/services/${service.id}`, { autoscale: { enabled: false } });

  // 13. cron job: setting a schedule must not touch a serving service until it is deployed
  console.log('\n▸ cron jobs');
  await waitFor(async () => (await healthyCount(service.id)) >= 1, 60_000, 'web healthy');
  await api('PATCH', `/services/${service.id}`, { schedule: '*/5 * * * *' });
  await sleep(7000);
  const still = await hit(host);
  const pendingSched = (await api('GET', `/services/${service.id}`)).pendingChanges.includes('schedule');
  check('schedule edit is staged, service keeps serving', still.status === 200 && pendingSched, `status ${still.status}, pending ${pendingSched}`);
  await api('PATCH', `/services/${service.id}`, { schedule: null });

  const job = await api('POST', `/projects/${project.id}/services`, { image: 'alpine:3.20', name: 'cronjob', protocol: 'none', startCommand: 'echo hello-from-cron-$SERVIFY_JOB_RUN_ID', deploy: false });
  await api('PATCH', `/services/${job.service.id}`, { schedule: '* * * * *' });
  const jd = await api('POST', `/services/${job.service.id}/deploy`);
  const jdd = await waitDeploy(jd.id);
  check('cron service armed', jdd.status === 'active', jdd.error ?? '');
  // The schedule fires every minute; retry if a scheduled run is in progress (409).
  await waitFor(async () => {
    try {
      await api('POST', `/services/${job.service.id}/run`);
      return true;
    } catch {
      return false;
    }
  }, 30_000, 'manual run accepted');
  let runs = [];
  const manualOk = await waitFor(async () => {
    runs = await api('GET', `/services/${job.service.id}/runs`);
    return runs.some((r) => r.trigger === 'manual' && r.status === 'succeeded' && r.output.includes('hello-from-cron'));
  }, 60_000, 'manual run');
  check('manual run succeeds with output', manualOk, JSON.stringify(runs[0] ?? {}).slice(0, 200));
  const schedOk = await waitFor(async () => (await api('GET', `/services/${job.service.id}/runs`)).some((r) => r.trigger === 'schedule' && r.status === 'succeeded'), 75_000, 'scheduled run');
  check('scheduled run fires', schedOk);
  const jobContainers = execSync(`docker ps -aq --filter label=servify.job=true --filter label=servify.service=${job.service.id}`).toString().trim();
  check('job containers are cleaned up', jobContainers === '', jobContainers);

  // 14. git auto-deploy from a local bare repository
  if (!process.env.SKIP_GIT) {
    console.log('\n▸ git auto-deploy (local bare repo, up to ~90s)');
    const { mkdtempSync, cpSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = mkdtempSync(join(tmpdir(), 'servify-git-'));
    const work = join(root, 'work');
    const bare = join(root, 'repo.git');
    cpSync(join(dirname(fileURLToPath(import.meta.url)), '../examples/node-api'), work, { recursive: true });
    const g = (cmd, cwd = work) => execSync(cmd, { cwd, stdio: 'ignore' });
    g(`git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm first`);
    g(`git clone -q --bare ${work} ${bare}`, root);
    const gs = await api('POST', `/projects/${project.id}/services`, { repo: `file://${bare}`, branch: 'main', name: 'gitapp' });
    const gd = await waitDeploy(gs.deployment.id);
    check('git service deployed', gd.status === 'active', gd.error ?? '');
    writeFileSync(join(work, 'VERSION'), '2');
    g(`git add -A && git -c user.email=t@t -c user.name=t commit -qm second && git push -q ${bare} main`);
    const auto = await waitFor(async () => {
      const deps = await api('GET', `/services/${gs.service.id}/deployments`);
      return deps.some((d) => d.trigger === 'git' && d.status === 'active' && d.commitMessage === 'second');
    }, 150_000, 'git auto-deploy');
    check('new commit auto-deployed', auto);
  }
} catch (e) {
  failures++;
  console.error('  ✗ error:', e.message);
} finally {
  if (!process.env.KEEP) {
    await api('DELETE', `/projects/${project.id}`).catch(() => {});
    await sleep(2000);
    const left = execSync(`docker ps -aq --filter label=servify.project=${project.id}`).toString().trim();
    const vols = execSync(`docker volume ls -q --filter label=servify.managed=true`).toString().split('\n').filter((v) => v && project && v.includes('_'));
    check('project delete removes all containers', left === '', left);
    void vols;
    console.log('\ncleaned up');
  }
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
