#!/usr/bin/env node
/**
 * End-to-end checks for the platform features (real Docker, owner access needed for settings):
 * secrets at rest, notifications, git webhooks, HTTPS, backups + restore, persistent logs/metrics,
 * Docker Compose import, environments and pull-request previews.
 *
 *   SERVIFY_URL=http://localhost:7700 SERVIFY_PROXY_PORT=8080 SERVIFY_HTTPS_PORT=8443 \
 *   SERVIFY_DATA_DIR=~/.servify SERVIFY_COOKIE='servify_session=…' node scripts/acceptance-features.mjs
 *
 * Use SERVIFY_COOKIE (a logged-in dashboard session) or run the instance with SERVIFY_AUTH=none.
 * SERVIFY_DATA_DIR enables the "no plaintext secrets on disk" check.
 */
import { execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';

const BASE = process.env.SERVIFY_URL ?? 'http://localhost:7700';
const PROXY = Number(process.env.SERVIFY_PROXY_PORT ?? 8080);
const HTTPS_PORT = Number(process.env.SERVIFY_HTTPS_PORT ?? 8443);
const DATA = process.env.SERVIFY_DATA_DIR?.replace(/^~/, process.env.HOME);
const COOKIE = process.env.SERVIFY_COOKIE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const projectsToDelete = [];
const cleanups = [];

async function api(method, path, body) {
  const res = await fetch(BASE + '/api' + path, { method, headers: { 'content-type': 'application/json', ...(COOKIE ? { cookie: COOKIE } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.error ?? text.slice(0, 120)}`);
  return json;
}
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}
async function waitFor(fn, ms = 120_000, label = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(700);
  }
  console.log(`  … timed out waiting for ${label}`);
  return null;
}
const svcOf = async (pid, name) => (await api('GET', `/projects/${pid}`)).services.find((s) => s.name === name || s.slug === name);
const running = (pid, name) => waitFor(async () => (await svcOf(pid, name))?.status === 'running' && (await svcOf(pid, name)), 180_000, `${name} running`);
function hit(host, path = '/') {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PROXY, path, headers: { host }, agent: false, timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => req.destroy());
  });
}
function post(port, path, headers, body) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.end(body);
  });
}
async function exec(serviceId, command) {
  return api('POST', `/services/${serviceId}/exec`, { command });
}
const git = (cwd, cmd) => execSync(`git -c user.email=t@t -c user.name=t ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();

async function main() {
  const settings = await api('GET', '/settings');
  const secret = settings.webhooks.secret;
  if (!secret || secret.includes('•')) throw new Error('needs owner access: set SERVIFY_COOKIE or run Servify with SERVIFY_AUTH=none');
  const P = await api('POST', '/projects', { name: `features-${Date.now().toString(36)}` });
  projectsToDelete.push(P.id);

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ secrets at rest');
  const canary = `canary-${Math.random().toString(36).slice(2)}-secret`;
  const web = (await api('POST', `/projects/${P.id}/services`, { image: 'traefik/whoami', name: 'web', env: { API_SECRET: canary } })).service;
  check('service stores and returns the secret', (await api('GET', `/services/${web.id}`)).env.API_SECRET === canary);
  if (DATA) {
    await sleep(1500);
    const files = ['servify.db', 'servify.db-wal'].map((f) => join(DATA, f)).filter(existsSync);
    const leaked = files.filter((f) => readFileSync(f).includes(canary));
    check('no plaintext secret in the database files', leaked.length === 0, leaked.join(', '));
  } else console.log('  – skipped on-disk check (set SERVIFY_DATA_DIR)');

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ notifications');
  const received = [];
  const sink = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: b });
      res.end('ok');
    });
  });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  cleanups.push(() => sink.close());
  const ch = await api('POST', '/settings/notifications/channels', { name: 'acceptance', type: 'webhook', url: `http://127.0.0.1:${sink.address().port}/hook`, secret: 'sig-secret', events: ['deploy.succeeded', 'deploy.failed'] });
  cleanups.push(() => api('DELETE', `/settings/notifications/channels/${ch.id}`).catch(() => {}));
  check('channel credentials are masked', ch.url === '••••••••' && ch.secret === '••••••••');
  check('test notification delivered', (await api('POST', `/settings/notifications/channels/${ch.id}/test`)).ok === true);
  await running(P.id, 'web');
  const deployNote = await waitFor(() => received.map((r) => JSON.parse(r.body)).find((b) => b.event === 'deploy.succeeded' && b.serviceId === web.id), 30_000, 'deploy notification');
  check('deploy success notification sent', !!deployNote);
  const signed = received.find((r) => r.body.includes(web.id));
  check('notification is HMAC-signed', !!signed && signed.headers['x-servify-signature'] === `sha256=${createHmac('sha256', 'sig-secret').update(signed.body).digest('hex')}`);

  console.log('\n▸ usage alerts');
  const alertsBefore = (await api('GET', '/settings')).alerts;
  check('usage alerts on by default', alertsBefore?.enabled === true && alertsBefore.diskPct === 90, JSON.stringify(alertsBefore));
  check('alert thresholds are validated', (await api('PATCH', '/settings/alerts', { diskPct: 20 }).then(() => 'ok', (e) => String(e.message))).includes('→ 400'));
  cleanups.push(() => api('PATCH', '/settings/alerts', alertsBefore).catch(() => {}));
  await api('POST', '/settings/notifications/channels', { ...ch, events: ['deploy.succeeded', 'deploy.failed', 'server.usage'] });
  const localSrv = (await api('GET', '/overview')).servers.find((s) => s.local);
  const st = localSrv?.stats;
  const diskPct = st?.diskTotal ? ((st.diskTotal - st.diskFree) / st.diskTotal) * 100 : 0;
  if (process.env.SERVIFY_ALERTS_INTERVAL_MS && diskPct >= 51 && diskPct < 95.9) {
    // Start from a clean state: the disk may already have been over the default line when Servify started.
    await api('PATCH', '/settings/alerts', { diskPct: 99 });
    await sleep(5000);
    const seen = received.length;
    await api('PATCH', '/settings/alerts', { diskPct: Math.max(50, Math.floor(diskPct) - 1) });
    const usage = () => received.slice(seen).map((r) => JSON.parse(r.body)).filter((b) => b.event === 'server.usage');
    const alert = await waitFor(() => usage().find((b) => b.level === 'error'), 20_000, 'disk alert');
    check('disk over the threshold is notified', /disk at \d+%/.test(alert?.title ?? ''), alert?.title);
    await sleep(3000);
    check('alerted only once while it stays over', usage().filter((b) => b.level === 'error').length === 1);
    await api('PATCH', '/settings/alerts', { diskPct: 99 });
    const back = await waitFor(() => usage().find((b) => b.level === 'success'), 20_000, 'recovery');
    check('recovery is notified', /back to \d+%/.test(back?.title ?? ''), back?.title);
  } else console.log(`  – skipped the live alert (disk at ${Math.round(diskPct)}%, or SERVIFY_ALERTS_INTERVAL_MS unset)`);

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ git webhooks');
  const tmp = mkdtempSync(join(tmpdir(), 'servify-hooks-'));
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  execSync(`git init -q --bare -b main ${join(tmp, 'repo.git')}`);
  const work = join(tmp, 'work');
  execSync(`git init -q -b main ${work}`);
  writeFileSync(join(work, 'Dockerfile'), 'FROM traefik/whoami\n');
  git(work, 'add .');
  git(work, 'commit -qm init');
  git(work, `remote add origin ${join(tmp, 'repo.git')}`);
  git(work, 'push -q origin main');
  const repo = join(tmp, 'repo.git');
  const app = (await api('POST', `/projects/${P.id}/services`, { repo, name: 'app', port: 80 })).service;
  await running(P.id, 'app');
  writeFileSync(join(work, 'CHANGE'), 'v2');
  git(work, 'add .');
  git(work, 'commit -qm second');
  git(work, 'push -q origin main');
  const sha = git(work, 'rev-parse HEAD');
  const pushBody = JSON.stringify({ ref: 'refs/heads/main', after: sha, repository: { clone_url: repo, default_branch: 'main' }, head_commit: { message: 'second' } });
  const sig = (b) => `sha256=${createHmac('sha256', secret).update(b).digest('hex')}`;
  const bad = await post(PROXY, '/_servify/hooks/git', { 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=00' }, pushBody);
  check('unsigned/bad-signature webhook rejected', bad.status === 401);
  const good = await post(PROXY, '/_servify/hooks/git', { host: 'anything.example', 'x-github-event': 'push', 'x-hub-signature-256': sig(pushBody) }, pushBody);
  check('signed push accepted on the router', good.status === 202 && good.body.includes('"app"'), good.body);
  const deployed = await waitFor(async () => (await api('GET', `/services/${app.id}/deployments?limit=3`)).find((d) => d.commitSha === sha && d.status === 'active'), 120_000, 'webhook deploy');
  check('push deployed exactly that commit', !!deployed);
  const hook = await api('GET', `/services/${app.id}/deploy-hook`);
  check('deploy hook triggers a deploy', (await post(PROXY, hook.path, {}, '')).status === 202);
  // Watch paths: a push that changes nothing under them is skipped, one that does deploys.
  await waitFor(async () => !(await api('GET', `/services/${app.id}/deployments?limit=5`)).some((d) => ['queued', 'building', 'deploying'].includes(d.status)), 120_000, 'deploys settle');
  await api('PATCH', `/services/${app.id}`, { watchPaths: ['web/**', '!**/*.md'] });
  const deployCount = async () => (await api('GET', `/services/${app.id}/deployments?limit=50`)).length;
  const before = await deployCount();
  const pushWith = (files) => JSON.stringify({ ref: 'refs/heads/main', after: sha, repository: { clone_url: repo, default_branch: 'main' }, head_commit: { message: 'change' }, commits: [{ id: sha, added: [], modified: files, removed: [] }] });
  const unrelated = pushWith(['README.md', 'web/NOTES.md', 'api/server.js']);
  const r1 = await post(PROXY, '/_servify/hooks/git', { 'x-github-event': 'push', 'x-hub-signature-256': sig(unrelated) }, unrelated);
  await sleep(1500);
  check('a push outside the watch paths is skipped', r1.status === 202 && r1.body.includes('watch paths') && (await deployCount()) === before, r1.body);
  const related = pushWith(['web/index.js']);
  const r2 = await post(PROXY, '/_servify/hooks/git', { 'x-github-event': 'push', 'x-hub-signature-256': sig(related) }, related);
  check('a push touching the watch paths deploys', r2.status === 202 && r2.body.includes('"deployed":["app"]'), r2.body);
  await waitFor(async () => !(await api('GET', `/services/${app.id}/deployments?limit=5`)).some((d) => ['queued', 'building', 'deploying'].includes(d.status)), 120_000, 'deploy settles');
  await api('PATCH', `/services/${app.id}`, { watchPaths: null });

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ HTTPS (local CA)');
  const ca = await (await fetch(`${BASE}/api/certs/local-ca.pem`, { headers: COOKIE ? { cookie: COOKIE } : {} })).text();
  const host = `web.${P.slug}.localhost`;
  const tls = await new Promise((resolve) => {
    const req = https.get({ host: '127.0.0.1', port: HTTPS_PORT, servername: host, path: '/', headers: { host }, ca, timeout: 8000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
  });
  check('HTTPS with a certificate chained to the local CA', tls.status === 200, tls.body.slice(0, 100));
  check('apps see X-Forwarded-Proto: https', /X-Forwarded-Proto: https/i.test(tls.body));

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ backups and restore (postgres)');
  const pg = (await api('POST', `/projects/${P.id}/services`, { templateId: 'postgres', name: 'pg' })).service;
  await running(P.id, 'pg');
  await waitFor(async () => (await exec(pg.id, 'pg_isready -q -U postgres')).exitCode === 0, 60_000, 'postgres ready');
  await exec(pg.id, `psql -U postgres -d app -c "create table t(v text); insert into t values ('precious');"`);
  const bak = await api('POST', `/services/${pg.id}/backups`, {});
  check('backup succeeded', bak.status === 'succeeded' && bak.sizeBytes > 100, bak.error ?? '');
  await exec(pg.id, 'psql -U postgres -d app -c "drop table t;"');
  await api('POST', `/backups/${bak.id}/restore`);
  await sleep(2000);
  await waitFor(async () => !(await api('GET', `/services/${pg.id}`)).restoring, 240_000, 'restore');
  const after = await exec(pg.id, 'psql -U postgres -d app -tAc "select v from t"');
  check('restore brings the data back', after.output.trim() === 'precious', after.output.slice(0, 120));
  check('a safety backup was taken first', (await api('GET', `/services/${pg.id}/backups`)).some((b) => b.trigger === 'pre-restore' && b.status === 'succeeded'));
  const dl = await fetch(`${BASE}/api/backups/${bak.id}/download`, { headers: COOKIE ? { cookie: COOKIE } : {} });
  const buf = Buffer.from(await dl.arrayBuffer());
  check('backup downloads as gzip', dl.status === 200 && buf[0] === 0x1f && buf[1] === 0x8b);
  await api('PATCH', `/services/${pg.id}`, { backup: { enabled: true, schedule: '* * * * *', retention: 2 } });
  const scheduled = await waitFor(async () => (await api('GET', `/services/${pg.id}/backups`)).find((b) => b.trigger === 'schedule' && b.status === 'succeeded'), 90_000, 'scheduled backup');
  check('scheduled backup fires on its cron schedule', !!scheduled);
  await api('PATCH', `/services/${pg.id}`, { backup: { enabled: false } });
  {
    // A database whose image name says nothing (a pinned or renamed copy, a compose import): still dumped, not tarred.
    const tpl = (await api('GET', `/services/${pg.id}`)).source.image;
    const renamed = 'servify-acceptance-renamed-db:pinned';
    execSync(`docker tag ${tpl} ${renamed}`);
    cleanups.push(async () => execSync(`docker rmi ${renamed}`, { stdio: 'ignore' }));
    const rdb = (await api('POST', `/projects/${P.id}/services`, { image: renamed, name: 'renamed-db', protocol: 'tcp', port: 5432, env: { POSTGRES_PASSWORD: 'acceptance' } })).service;
    await running(P.id, 'renamed-db');
    await waitFor(async () => (await exec(rdb.id, 'pg_isready -q -U postgres')).exitCode === 0, 60_000, 'renamed postgres ready');
    check('a renamed postgres image is recognised as postgres', (await api('GET', `/services/${rdb.id}`)).backupMethod === 'pg_dumpall');
    await exec(rdb.id, `psql -U postgres -c "create table r(v text); insert into r values ('kept');"`);
    const rb = await api('POST', `/services/${rdb.id}/backups`, {});
    check('and backed up with a database dump', rb.status === 'succeeded' && rb.method === 'pg_dumpall', `${rb.method} ${rb.error ?? ''}`);
    await exec(rdb.id, 'psql -U postgres -c "drop table r;"');
    await api('POST', `/backups/${rb.id}/restore`);
    await sleep(2000);
    await waitFor(async () => !(await api('GET', `/services/${rdb.id}`)).restoring, 240_000, 'restore');
    check('which restores', (await exec(rdb.id, 'psql -U postgres -tAc "select v from r"')).output.trim() === 'kept');
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ persistent logs and metrics');
  const logger = (await api('POST', `/projects/${P.id}/services`, { image: 'alpine:3.20', name: 'logger', protocol: 'none', startCommand: 'i=0; while true; do i=$((i+1)); echo "line $i"; sleep 1; done' })).service;
  await running(P.id, 'logger');
  await sleep(4000);
  const firstDep = (await api('GET', `/services/${logger.id}`)).activeDeploymentId;
  await api('POST', `/services/${logger.id}/deploy`);
  await waitFor(async () => (await api('GET', `/services/${logger.id}`)).activeDeploymentId !== firstDep, 120_000, 'redeploy');
  await sleep(3000);
  const old = await api('GET', `/services/${logger.id}/logs?deployment=${firstDep}&tail=50`);
  check("logs from the previous deployment survive a redeploy", old.length >= 3, `${old.length} lines`);
  const found = await api('GET', `/services/${logger.id}/logs?search=line%202&tail=5`);
  check('log search across history', found.some((l) => l.text.startsWith('line 2')));
  const m = await api('GET', `/services/${web.id}/metrics?seconds=3600`);
  check('metrics answer for a 1-hour window', Array.isArray(m.points));

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ rollback when the image tag moves');
  {
    // A local `:latest` tag that gets re-pointed between deploys (like a fresh `docker pull` or `compose build`).
    const tag = `servify-acceptance-moving:latest`;
    const imageId = (ref) => execSync(`docker image inspect -f '{{.Id}}' ${ref}`).toString().trim();
    execSync(`docker tag alpine:3.20 ${tag}`);
    cleanups.push(async () => execSync(`docker rmi ${tag}`, { stdio: 'ignore' }));
    const mover = (await api('POST', `/projects/${P.id}/services`, { image: tag, name: 'mover', protocol: 'none', startCommand: 'sleep 1d' })).service;
    await running(P.id, 'mover');
    const runningImage = async () => {
      const r = (await api('GET', `/services/${mover.id}/metrics?seconds=1`)).replicas.find((x) => x.state === 'healthy' || x.dockerState === 'running');
      return r ? execSync(`docker inspect -f '{{.Image}}' ${r.containerId}`).toString().trim() : null;
    };
    const v1 = (await api('GET', `/services/${mover.id}`)).activeDeploymentId;
    const v1Image = await runningImage();
    check('first deploy runs the tagged image', v1Image === imageId('alpine:3.20'));
    const d1 = await api('GET', `/deployments/${v1}`);
    check('the deployment is pinned to its own image name', d1.image?.startsWith('servify/') && d1.sourceLabel.includes(tag), `${d1.image} · ${d1.sourceLabel}`);
    execSync(`docker pull -q busybox:1.36 && docker tag busybox:1.36 ${tag}`, { stdio: 'ignore' });
    await api('POST', `/services/${mover.id}/deploy`);
    await waitFor(async () => (await api('GET', `/services/${mover.id}`)).activeDeploymentId !== v1, 120_000, 'second deploy');
    check('a redeploy picks up the moved tag', !!(await waitFor(async () => (await runningImage()) === imageId('busybox:1.36'), 60_000, 'new image')));
    await api('POST', `/services/${mover.id}/rollback`, { deploymentId: v1 });
    check('rolling back brings the old image back, not the moved tag', !!(await waitFor(async () => (await runningImage()) === v1Image, 120_000, 'rollback image')));
    const v3 = (await api('GET', `/services/${mover.id}`)).activeDeploymentId;
    await api('POST', `/services/${mover.id}/restart`);
    await waitFor(async () => (await api('GET', `/services/${mover.id}`)).activeDeploymentId !== v3, 120_000, 'restart');
    check('a restart keeps the rolled-back image', (await runningImage()) === v1Image);
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ build arguments, build target and pre-deploy');
  {
    const dir = mkdtempSync(join(tmpdir(), 'servify-buildargs-'));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    // The last stage would overwrite the greeting: only --target app plus --build-arg gives "hi servify".
    writeFileSync(join(dir, 'Dockerfile'), 'FROM alpine:3.20 AS base\nARG GREETING=unset\nRUN echo "$GREETING" > /greeting\nFROM base AS app\nCMD ["sh", "-c", "sleep 1d"]\nFROM base AS other\nRUN echo wrong > /greeting\n');
    const made = await api('POST', `/projects/${P.id}/services`, { name: 'built', path: dir, protocol: 'none', env: { NAME: 'servify' }, deploy: false });
    const b = made.service;
    await api('PATCH', `/services/${b.id}`, { buildArgs: { GREETING: 'hi ${NAME}' }, buildTarget: 'app', preDeployCommand: 'echo "migrated $NAME"' });
    const d1 = await api('POST', `/services/${b.id}/deploy`);
    const ok1 = await waitFor(async () => ['active', 'failed'].includes((await api('GET', `/deployments/${d1.id}`)).status), 240_000, 'build deploy');
    const dep1 = await api('GET', `/deployments/${d1.id}`);
    check('a build with arguments and a target deploys', !!ok1 && dep1.status === 'active', dep1.error ?? dep1.status);
    check('the build used the target and the argument', (await exec(b.id, 'cat /greeting')).output.trim() === 'hi servify');
    const log1 = (await api('GET', `/deployments/${d1.id}/logs`)).map((l) => (typeof l === 'string' ? l : l.text ?? l.line ?? '')).join('\n');
    check('the pre-deploy command ran with the service variables', log1.includes('migrated servify'));
    await api('PATCH', `/services/${b.id}`, { preDeployCommand: 'echo boom; exit 3' });
    const d2 = await api('POST', `/services/${b.id}/deploy`);
    await waitFor(async () => ['active', 'failed'].includes((await api('GET', `/deployments/${d2.id}`)).status), 240_000, 'failing deploy');
    const dep2 = await api('GET', `/deployments/${d2.id}`);
    check('a failing pre-deploy command stops the deploy', dep2.status === 'failed' && /pre-deploy/.test(dep2.error ?? ''), `${dep2.status} ${dep2.error ?? ''}`);
    check('and the running version stays', (await api('GET', `/services/${b.id}`)).activeDeploymentId === d1.id && (await exec(b.id, 'cat /greeting')).output.trim() === 'hi servify');
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ shared variables');
  {
    const SP = await api('POST', '/projects', { name: `shared-${Date.now().toString(36)}` });
    projectsToDelete.push(SP.id);
    const reader = (await api('POST', `/projects/${SP.id}/services`, { name: 'reader', image: 'alpine:3.20', protocol: 'none', startCommand: 'sleep 1d', env: { GREETING: '${{shared.GREETING}}', URL: 'https://${{shared.HOST}}/x', MISSING: '${{shared.NOPE}}' }, deploy: false })).service;
    const upd = await api('PATCH', `/projects/${SP.id}`, { variables: { GREETING: 'hello', HOST: 'example.com', TOKEN: 's3cret' }, secretKeys: ['TOKEN'] });
    check('saving shared variables lists the services that use them', (upd.usesShared ?? []).some((u) => u.id === reader.id));
    const res = await api('GET', `/services/${reader.id}/variables/resolved`);
    check('a service resolves ${{shared.NAME}}', res.env.GREETING === 'hello' && res.env.URL === 'https://example.com/x', JSON.stringify(res.env));
    check('an unknown shared variable is reported', res.unresolved.includes('shared.NOPE'));
    const again = await api('PATCH', `/projects/${SP.id}`, { variables: { GREETING: 'hello', HOST: 'example.com', TOKEN: '••••••••' }, secretKeys: ['TOKEN'] });
    check('sending a masked secret back keeps it', (await api('GET', `/projects/${SP.id}`)).project.variables.TOKEN === 's3cret' && !!again);
    const env = await api('POST', `/projects/${SP.id}/environments`, { name: 'staging', deploy: false });
    await api('PATCH', `/projects/${env.id}`, { variables: { GREETING: 'hi from staging' } });
    const envReader = (await api('GET', `/projects/${env.id}`)).services.find((x) => x.name === 'reader');
    const envRes = await api('GET', `/services/${envReader.id}/variables/resolved`);
    check("an environment's shared variable overrides the project's (the rest are inherited)", envRes.env.GREETING === 'hi from staging' && envRes.env.URL === 'https://example.com/x', JSON.stringify(envRes.env));
    if (DATA) {
      const ro = execSync(`node --disable-warning=ExperimentalWarning server/bin/servify.mjs token acceptance-ro --read`, { env: { ...process.env, SERVIFY_DATA_DIR: DATA } }).toString().match(/svf_[A-Za-z0-9_-]+/)?.[0];
      const roSnap = await fetch(`${BASE}/api/projects/${SP.id}`, { headers: { authorization: `Bearer ${ro}` } }).then((r) => r.json());
      check('read-only access sees shared secrets masked', roSnap.project.variables.TOKEN === '••••••••' && roSnap.project.variables.GREETING === 'hello', JSON.stringify(roSnap.project?.variables));
    }
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ moving a service to another project');
  {
    const A = await api('POST', '/projects', { name: `move-a-${Date.now().toString(36)}` });
    const Bp = await api('POST', '/projects', { name: `move-b-${Date.now().toString(36)}` });
    projectsToDelete.push(A.id, Bp.id);
    const mover = (await api('POST', `/projects/${A.id}/services`, { name: 'keeper', image: 'alpine:3.20', protocol: 'none', startCommand: 'sleep 1d', env: { SECRET_WORD: 'kept' } })).service;
    await waitFor(async () => (await api('GET', `/services/${mover.id}`)).status === 'running', 120_000, 'keeper running');
    await api('POST', `/projects/${A.id}/volumes`, { name: 'keeper-data', serviceId: mover.id, mountPath: '/data' });
    await waitFor(async () => (await exec(mover.id, "grep -q ' /data ' /proc/mounts").catch(() => null))?.exitCode === 0, 120_000, 'keeper running with its volume');
    await exec(mover.id, 'echo moved-data > /data/file');
    const user = (await api('POST', `/projects/${A.id}/services`, { name: 'user', image: 'alpine:3.20', protocol: 'none', startCommand: 'sleep 1d', env: { WORD: '${{keeper.SECRET_WORD}}' }, deploy: false })).service;
    const refused = await fetch(`${BASE}/api/services/${mover.id}/move-project`, { method: 'POST', headers: { 'content-type': 'application/json', ...(COOKIE ? { cookie: COOKIE } : {}) }, body: JSON.stringify({ project: Bp.id }) });
    check('a move that would break references is refused', refused.status === 409 && /user/.test((await refused.json()).error ?? ''));
    await api('DELETE', `/services/${user.id}`);
    await api('POST', `/services/${mover.id}/move-project`, { project: Bp.id });
    const inB = await api('GET', `/projects/${Bp.id}`);
    check('the service and its volume are in the new project', inB.services.some((x) => x.id === mover.id) && inB.volumes.some((v) => v.serviceId === mover.id));
    check('and gone from the old one', !(await api('GET', `/projects/${A.id}`)).services.some((x) => x.id === mover.id));
    const restarted = await waitFor(async () => {
      const r = await exec(mover.id, 'cat /data/file').catch(() => null);
      return r && r.output.trim() === 'moved-data' && (await api('GET', `/services/${mover.id}`)).status === 'running';
    }, 120_000, 'moved service running');
    check('it runs in the new project with its data', !!restarted);
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ volumes (attach / detach)');
  const writer = (await api('POST', `/projects/${P.id}/services`, { image: 'alpine:3.20', name: 'writer', protocol: 'none', startCommand: 'sleep infinity' })).service;
  const reader = (await api('POST', `/projects/${P.id}/services`, { image: 'alpine:3.20', name: 'reader', protocol: 'none', startCommand: 'sleep infinity' })).service;
  await running(P.id, 'reader');
  const made = await api('POST', `/projects/${P.id}/volumes`, { name: 'shared-files', serviceId: writer.id, mountPath: '/data' });
  const volId = made.volume.id;
  await running(P.id, 'writer');
  const attachDep = made.deployment?.id;
  await waitFor(async () => {
    const s = await svcOf(P.id, 'writer');
    return s.status === 'running' && (!attachDep || s.activeDeploymentId === attachDep);
  }, 120_000, 'writer redeployed with the volume');
  const writerOk = (await exec(writer.id, 'echo moved-with-the-volume > /data/hello && cat /data/hello')).exitCode === 0;
  check('a new volume attaches and is writable', !!writerOk);
  let refused = false;
  try {
    await api('DELETE', `/volumes/${volId}`);
  } catch {
    refused = true;
  }
  check('an attached volume cannot be deleted', refused);
  await api('POST', `/volumes/${volId}/detach`);
  check('detached volume is listed without a service', (await api('GET', `/projects/${P.id}/volumes`)).find((v) => v.id === volId)?.serviceId === null);
  await api('POST', `/volumes/${volId}/attach`, { serviceId: reader.id, mountPath: '/mnt/files' });
  const moved = await waitFor(async () => {
    const r = await exec(reader.id, 'cat /mnt/files/hello');
    return r.exitCode === 0 && r.output.trim() === 'moved-with-the-volume';
  }, 120_000, 'data on the other service');
  check('the data follows the volume to another service', !!moved);
  check('the old service no longer mounts it', (await exec(writer.id, 'test -e /data/hello && echo still || echo gone')).output.trim() === 'gone');
  await api('DELETE', `/services/${reader.id}?keepVolumes=1`);
  check('deleting a service can keep its volume', (await api('GET', `/projects/${P.id}/volumes`)).find((v) => v.id === volId)?.serviceId === null);

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ PostgreSQL cluster (replication + failover)');
  const pgc = (await api('POST', `/projects/${P.id}/services`, { templateId: 'postgres-cluster', name: 'pgc' })).service;
  const cli = (await api('POST', `/projects/${P.id}/services`, { image: 'postgres:17-alpine', name: 'pgcli', protocol: 'none', startCommand: 'exec sleep infinity', env: { PGPASSWORD: '${{ pgc.POSTGRES_PASSWORD }}' } })).service;
  const cstatus = async () => (await api('GET', `/services/${pgc.id}`)).clusterStatus;
  const formed = await waitFor(async () => {
    const c = await cstatus();
    return c.members.filter((m) => m.role === 'primary').length === 1 && c.members.filter((m) => m.syncState === 'quorum').length === 2 && c;
  }, 600_000, 'cluster');
  check('cluster forms: 1 primary + 2 synchronous standbys', !!formed);
  await running(P.id, 'pgcli');
  const pq = (t, host = 'pgc') => exec(cli.id, `psql -h ${host} -U postgres -d app -qtAX -c "${t}"`);
  const names = await exec(cli.id, "getent ahosts pgc | awk '{print $1}' | sort -u | wc -l; getent ahosts pgc-read | awk '{print $1}' | sort -u | wc -l");
  check('writes name → primary only, -read → standbys', names.output.trim().split('\n').join(',') === '1,2', names.output);
  await pq('create table w(v int primary key)');
  check('standbys are read-only', /read-only/.test((await pq('insert into w values (-1)', 'pgc-read')).output ?? ''));
  await exec(cli.id, 'nohup sh -c \'i=0; while [ ! -f /tmp/stop ]; do i=$((i+1)); psql -h pgc -U postgres -d app -qtAX -c "insert into w values ($i)" >/dev/null 2>&1 && echo $i >> /tmp/acks; sleep 0.05; done\' >/dev/null 2>&1 &');
  await sleep(3000);
  const was = (await cstatus()).primary;
  execSync(`docker pause ${(await cstatus()).members.find((m) => m.index === was).containerId}`);
  const failedOver = await waitFor(async () => (await cstatus()).primary !== was, 120_000, 'failover');
  check('a hung primary fails over automatically', !!failedOver);
  await sleep(5000);
  await exec(cli.id, 'touch /tmp/stop');
  await sleep(1500);
  const acked = (await exec(cli.id, 'cat /tmp/acks')).output.trim().split('\n').filter(Boolean);
  const have = new Set((await pq('select v from w')).output.trim().split('\n'));
  check('no acknowledged write is lost', acked.length > 10 && acked.every((a) => have.has(a)), `${acked.length} acknowledged, ${acked.filter((a) => !have.has(a)).length} missing`);
  const healed = await waitFor(async () => {
    const c = await cstatus();
    return c.members.filter((m) => m.role === 'primary').length === 1 && c.members.filter((m) => m.syncState === 'quorum').length === 2 && c;
  }, 600_000, 'old primary rebuilt');
  check('the old primary is fenced and rebuilt as a standby', !!healed && healed.members.find((m) => m.index === was)?.role === 'standby');

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ docker compose import');
  const yaml = `name: compose-${Date.now().toString(36)}
services:
  cache_db:
    image: redis:7-alpine
  probe:
    image: alpine:3.20
    command: ["sh", "-c", "while true; do nc -z cache_db 6379 && echo REACHED-BY-NAME; sleep 2; done"]
    privileged: true
    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]
`;
  const plan = await api('POST', '/projects/import-compose', { yaml, dryRun: true });
  check('compose plan keeps the compose name as an alias', plan.services.find((s) => s.slug === 'cache-db')?.aliases.includes('cache_db'));
  check('unsafe settings produce warnings', plan.warnings.some((w) => /privileged/.test(w)) && plan.warnings.some((w) => /docker\.sock/.test(w)));
  const imp = await api('POST', '/projects/import-compose', { yaml });
  projectsToDelete.push(imp.project.id);
  await running(imp.project.id, 'probe');
  const probe = await svcOf(imp.project.id, 'probe');
  const reached = await waitFor(async () => (await api('GET', `/services/${probe.id}/logs?search=REACHED&tail=1`)).length > 0, 60_000, 'compose hostname');
  check('services reach each other by compose name', !!reached);

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ environments and pull-request previews');
  git(work, 'checkout -q -b feature');
  writeFileSync(join(work, 'FEATURE'), 'x');
  git(work, 'add .');
  git(work, 'commit -qm feature');
  git(work, 'push -q origin feature');
  const env = await api('POST', `/projects/${P.id}/environments`, { name: 'staging', branch: 'feature', deploy: true });
  const envApp = await running(env.id, 'app');
  check('environment copies services with the branch override', envApp?.source.branch === 'feature');
  check('environment has its own hostname', (await hit(`app.${env.slug}.localhost`)).status === 200);
  await api('PATCH', `/projects/${P.id}/previews`, { enabled: true });
  const pr = (action, n, head = repo) =>
    JSON.stringify({ action, number: n, pull_request: { title: 'Feature', head: { ref: 'feature', repo: { clone_url: head } }, base: { repo: { clone_url: repo } } } });
  const fork = pr('opened', 41, 'https://github.com/someone/fork.git');
  check('fork pull requests never get previews', (await post(PROXY, '/_servify/hooks/git', { 'x-github-event': 'pull_request', 'x-hub-signature-256': sig(fork) }, fork)).body.includes('fork'));
  const opened = pr('opened', 42);
  await post(PROXY, '/_servify/hooks/git', { 'x-github-event': 'pull_request', 'x-hub-signature-256': sig(opened) }, opened);
  const preview = await waitFor(async () => (await api('GET', `/projects/${P.id}/environments`)).find((e) => e.preview?.number === 42), 30_000, 'preview');
  check('opening a PR creates a preview environment', !!preview);
  const closed = pr('closed', 42);
  await post(PROXY, '/_servify/hooks/git', { 'x-github-event': 'pull_request', 'x-hub-signature-256': sig(closed) }, closed);
  check('closing the PR deletes only its preview', !!(await waitFor(async () => {
    const envs = await api('GET', `/projects/${P.id}/environments`);
    return !envs.some((e) => e.preview) && envs.some((e) => e.name === 'staging');
  }, 60_000, 'preview removal')));
}

main()
  .catch((e) => {
    failures++;
    console.error('\n✗', e.message);
  })
  .finally(async () => {
    if (!process.env.KEEP) {
      for (const id of projectsToDelete.reverse()) await api('DELETE', `/projects/${id}`).catch(() => {});
      for (const fn of cleanups.reverse()) await fn();
      console.log('\ncleaned up');
    }
    console.log(failures ? `\n${failures} check(s) failed` : '\nall feature checks passed');
    process.exit(failures ? 1 : 0);
  });
