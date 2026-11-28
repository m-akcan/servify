#!/usr/bin/env node
/**
 * End-to-end checks for the platform features (real Docker, owner access needed for settings):
 * secrets at rest, notifications, git webhooks, HTTPS, backups + restore, safety backups, persistent logs/metrics,
 * Docker Compose import, environments and pull-request previews, the router access log.
 *
 * Access log: pass this script the instance's SERVIFY_TRUSTED_PROXIES. With 127.0.0.1 in it, X-Forwarded-For must tell
 * visitors apart; without, it must be ignored.
 *
 *   SERVIFY_URL=http://localhost:7700 SERVIFY_PROXY_PORT=8080 SERVIFY_HTTPS_PORT=8443 \
 *   SERVIFY_DATA_DIR=~/.servify SERVIFY_COOKIE='servify_session=…' node scripts/acceptance-features.mjs
 *
 * Use SERVIFY_COOKIE (a logged-in dashboard session) or run the instance with SERVIFY_AUTH=none.
 * SERVIFY_DATA_DIR enables the "no plaintext secrets on disk" check.
 * DOCKER_CONFIG (a scratch folder, never ~/.docker; Servify must run with the same one) enables the registry-login
 * checks: the test writes a login for a local password-protected registry there.
 *
 * Streaming backups (ONLY=backups runs just that section) start their own MinIO container (servify-acc-minio, removed
 * afterwards). Run Servify — and this script — with SERVIFY_S3_PART_MB=5 so a modest volume goes up in many parts.
 *
 * Scoped API tokens (ONLY=tokens): needs sign-in on (not SERVIFY_AUTH=none) and SERVIFY_COOKIE, plus SERVIFY_DATA_DIR
 * for the `servify token` CLI and the pre-scopes token record. A route-by-scope matrix generated from server/src/policy.ts
 * (itself checked against every route in api.ts and every tool in mcp.ts) over REST and MCP, then streams, uploads,
 * deploy hooks and every cross-project path.
 *
 * Low disk space protection (ONLY=disk): the lines are moved above the real free space through the instance settings
 * (PATCH /settings/disk), so protect mode is entered and left on demand; they are put back afterwards. Needs
 * SERVIFY_DATA_DIR for the row counts and the "doesn't fit" restore (a backup record made to claim a huge size), and
 * starts its own MinIO (servify-acc-minio-disk) for the S3 side. Run Servify with SERVIFY_DISK_INTERVAL_MS=3000.
 *
 * Scheduled jobs (ONLY=cron): the catch-up math first (cron.ts, no server needed: a clock change, inside and outside
 * the window, several missed runs, a run that did happen), then skipped runs and de-duplicated failure notifications
 * on the instance, then catch-up across a real restart. That part stops Servify (the pid in SERVIFY_DATA_DIR) and
 * starts it again with SERVIFY_START_CMD — a shell command that starts the same instance in the background with the
 * same environment, e.g. `sh start-servify.sh` (nohup … &). Run Servify with SERVIFY_CATCHUP_GRACE_SECONDS=5 so a
 * catch-up doesn't wait the default 20 s. Takes about 8 minutes (it waits for real minutes to pass).
 *
 * The everyday CLI commands (ONLY=cli; also part of a full run): exec argv and exit codes, variables (get, stdin,
 * --from-file, --shared, read-only masking, --deploy), backup create/list/test/download with checksum verification
 * against a damaged stored file, restore (confirmation, progress, failure exit code), rollback, restart and help.
 * Needs SERVIFY_DATA_DIR (the `servify token` CLI and the stored backup file).
 *
 * Router access control (ONLY=access; also the last section of a full run): IP allow/deny lists (direct and through
 * X-Forwarded-For, with and without trust — pass the instance's SERVIFY_TRUSTED_PROXIES, as for the access log), the
 * untrusted-proxy warning, basic auth and its brute-force limit, rate limits, WebSocket upgrades, the HTTPS router,
 * TCP proxy ports, the ACME path, the deploy-hook limits, the local CA fingerprint and the dashboard domain. The
 * dashboard domain needs sign-in on (SERVIFY_COOKIE) and, for the login over HTTPS, SERVIFY_PASSWORD_FILE (a file
 * holding the owner password; never printed). Without trust, the hook check locks 127.0.0.1 out of the deploy hooks
 * for a few minutes (that is the point): run it last, or wait before running hook checks again.
 *
 * Signing in (ONLY=auth): passkeys through a software authenticator in this script (registration and sign-in, a wrong
 * origin, a wrong RP id, a replayed challenge, a counter going back, an unknown credential, a tampered signature), the
 * passkey host bound to the request's host (localhost, the dashboard domain over HTTPS; never an IP or plain HTTP), the
 * password policy (everywhere / private networks only / off) with and without a trusted proxy, `servify auth reset`,
 * the per-address throttle and the global slow-down, Secure cookies over HTTPS, sign out everywhere, and approving a
 * phone from the dashboard (pairing). Needs sign-in on, SERVIFY_COOKIE, SERVIFY_PASSWORD_FILE and SERVIFY_DATA_DIR;
 * start Servify with SERVIFY_AUTH_LOG_QUIET_MS=3000 and SERVIFY_PAIRING_TTL_MS=15000. Run it twice — with
 * SERVIFY_TRUSTED_PROXIES=127.0.0.1 and without (restart Servify between, and pass the same value to this script).
 *
 * The phone app mirror (ONLY=mobileapp): this script serves a fake release feed (GitHub-API-shaped JSON and assets) on
 * SERVIFY_MOBILE_FEED_PORT (default 17899) and signs its manifests with a THROWAWAY Ed25519 key, SERVIFY_MOBILE_KEY (a
 * PEM file; never the real release key). Start Servify with SERVIFY_UPDATE_FEED=http://127.0.0.1:<port>/repos/test/servify/releases/latest,
 * SERVIFY_UPDATE_KEYS=<that key's public key> and SERVIFY_MOBILE_MIRROR_DELAY_MS=86400000 (the script triggers every
 * check itself). Unsigned releases, bad signatures, manifests for another version, hash and size mismatches and
 * releases without an app; the API, Range requests, keeping two apps; the app version a phone reports. Needs sign-in on
 * (SERVIFY_COOKIE) and SERVIFY_PASSWORD_FILE (to sign in a test phone), SERVIFY_DATA_DIR for the files on disk.
 */
import { execSync, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import https from 'node:https';
import tls from 'node:tls';
import { networkInterfaces } from 'node:os';

const BASE = process.env.SERVIFY_URL ?? 'http://localhost:7700';
const PROXY = Number(process.env.SERVIFY_PROXY_PORT ?? 8080);
const HTTPS_PORT = Number(process.env.SERVIFY_HTTPS_PORT ?? 8443);
const DATA = process.env.SERVIFY_DATA_DIR?.replace(/^~/, process.env.HOME);
let COOKIE = process.env.SERVIFY_COOKIE;
/** Mirror of the instance's SERVIFY_TRUSTED_PROXIES (pass the same value to both): does it believe X-Forwarded-For from us? */
const TRUSTS_LOCAL = (process.env.SERVIFY_TRUSTED_PROXIES ?? '').split(',').some((t) => ['127.0.0.1', '127.0.0.0/8', '0.0.0.0/0'].includes(t.trim()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The CLI checks block this process in execSync/spawnSync, often for longer than the API's 5 s keep-alive. A fetch
// right after would reuse a pooled socket the server has closed meanwhile (fetch failed … ECONNRESET): one turn of the
// event loop first lets fetch see the close (and expire idle sockets) before it picks a connection.
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  await new Promise((r) => setImmediate(r));
  return nativeFetch(...args);
};
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

/**
 * A TCP pass-through that can cut every connection after a number of bytes sent, and refuse new ones until restored
 * (`cutAfter`); or drop just the connection that is receiving once a number of bytes came back (`dropReplyAfter`).
 */
async function cuttableProxy(targetPort) {
  let down = false;
  let budget = Infinity;
  let replyBudget = Infinity;
  let drops = 0;
  const socks = new Set();
  const cut = () => {
    down = true;
    for (const x of socks) x.destroy();
  };
  const srv = net.createServer((c) => {
    if (down) return c.destroy();
    const u = net.connect(targetPort, '127.0.0.1');
    socks.add(c);
    socks.add(u);
    const end = () => {
      c.destroy();
      u.destroy();
      socks.delete(c);
      socks.delete(u);
    };
    c.on('data', (d) => {
      if (down) return;
      budget -= d.length;
      if (budget <= 0) return cut();
      if (!u.write(d)) c.pause();
    });
    u.on('drain', () => c.resume());
    c.on('drain', () => u.resume());
    u.on('data', (d) => {
      replyBudget -= d.length;
      if (replyBudget <= 0) {
        replyBudget = Infinity;
        drops++;
        return end();
      }
      if (!c.write(d)) u.pause();
    });
    for (const x of [c, u]) {
      x.on('error', end);
      x.on('close', end);
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    port: srv.address().port,
    cutAfter: (n) => (budget = n),
    dropReplyAfter: (n) => (replyBudget = n),
    drops: () => drops,
    restore: () => {
      down = false;
      budget = Infinity;
    },
    close: () => (cut(), srv.close()),
  };
}

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
/** Files under a folder, recursively (relative paths). */
const filesUnder = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath ?? e.path, e.name).slice(dir.length + 1));

/**
 * Streaming, checksummed, verified backups: to a folder and to S3 (a local MinIO, multipart), restores from both, a
 * damaged and a cut-off archive refused with the live data intact, test restores passing and failing, an S3 upload cut
 * mid-way (failed, nothing left behind), an old record without a checksum, and a Postgres dump test-restored.
 */
async function streamingBackupChecks(P) {
  console.log('\n▸ streaming, verified backups (folder + S3)');
  const PART_MB = Number(process.env.SERVIFY_S3_PART_MB ?? 64);
  // ── MinIO with generated credentials (never printed), a bucket, and a cuttable proxy in front of it.
  const MINIO = 'servify-acc-minio';
  const user = `acc${randomBytes(5).toString('hex')}`;
  const pass = randomBytes(20).toString('hex');
  const dockerEnv = { ...process.env, MINIO_ROOT_USER: user, MINIO_ROOT_PASSWORD: pass, MC_HOST_acc: `http://${user}:${pass}@127.0.0.1:9000` };
  execSync(`docker rm -f -v ${MINIO}`, { stdio: 'ignore' });
  execSync(`docker run -d --name ${MINIO} --log-driver none -e MINIO_ROOT_USER -e MINIO_ROOT_PASSWORD -p 127.0.0.1::9000 minio/minio:latest server /data`, { env: dockerEnv, stdio: 'ignore' });
  cleanups.push(async () => execSync(`docker rm -f -v ${MINIO}`, { stdio: 'ignore' }));
  const minioPort = Number(execSync(`docker port ${MINIO} 9000/tcp`).toString().trim().split(':').pop());
  const mc = (args) => execSync(`docker exec -e MC_HOST_acc ${MINIO} mc ${args}`, { env: dockerEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  await waitFor(async () => (mc('ready acc'), true), 30_000, 'minio');
  mc('mb -p acc/servify-acc');
  const incomplete = () => mc('ls --incomplete -r acc/servify-acc').trim();
  const proxy = await cuttableProxy(minioPort);
  cleanups.push(async () => proxy.close());

  const folder = mkdtempSync(join(tmpdir(), 'servify-acc-dest-'));
  cleanups.push(async () => rmSync(folder, { recursive: true, force: true }));
  const local = await api('POST', '/settings/backups/destinations', { name: 'acc-folder', type: 'local', path: folder });
  const s3 = await api('POST', '/settings/backups/destinations', { name: 'acc-minio', type: 's3', endpoint: `http://127.0.0.1:${proxy.port}`, region: 'us-east-1', bucket: 'servify-acc', prefix: 'acc', accessKeyId: user, secretAccessKey: pass, forcePathStyle: true });
  cleanups.push(async () => {
    await api('DELETE', `/settings/backups/destinations/${local.id}`).catch(() => {});
    await api('DELETE', `/settings/backups/destinations/${s3.id}`).catch(() => {});
  });
  check('the MinIO destination passes the connection test', (await api('POST', `/settings/backups/destinations/${s3.id}/test`).catch((e) => ({ error: e.message }))).ok === true);

  // A notification sink for failures (test restores report through backup.failed).
  const notes = [];
  const sink = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try {
        notes.push(JSON.parse(b));
      } catch {}
      res.end('ok');
    });
  });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  cleanups.push(async () => sink.close());
  const ch = await api('POST', '/settings/notifications/channels', { name: 'acc-backups', type: 'webhook', url: `http://127.0.0.1:${sink.address().port}/hook`, events: ['backup.failed'] });
  cleanups.push(() => api('DELETE', `/settings/notifications/channels/${ch.id}`).catch(() => {}));

  // ── A service with ~80 MB of random data on a volume.
  execSync('docker pull -q alpine:3.20', { stdio: 'ignore' });
  const vault = (await api('POST', `/projects/${P.id}/services`, { image: 'alpine:3.20', name: 'vault', protocol: 'none', startCommand: 'sleep 1d' })).service;
  await running(P.id, 'vault');
  const vv = await api('POST', `/projects/${P.id}/volumes`, { name: 'vault-data', serviceId: vault.id, mountPath: '/data' });
  await waitFor(async () => {
    const s = await api('GET', `/services/${vault.id}`);
    return s.status === 'running' && (!vv.deployment || s.activeDeploymentId === vv.deployment.id);
  }, 120_000, 'vault with a volume');
  await exec(vault.id, 'head -c 83886080 /dev/urandom > /data/big.bin && echo original > /data/file');
  const bigSum = async () => (await exec(vault.id, 'sha256sum /data/big.bin | cut -c1-64')).output.trim();
  const fileIs = async () => (await exec(vault.id, 'cat /data/file').catch(() => ({ output: '' }))).output?.trim();
  const original = await bigSum();
  const backups = () => api('GET', `/services/${vault.id}/backups`);
  const restoreAndWait = async (id) => {
    await api('POST', `/backups/${id}/restore`);
    await sleep(1500);
    await waitFor(async () => !(await api('GET', `/services/${vault.id}`)).restoring, 300_000, 'restore');
    await running(P.id, 'vault');
  };
  const scratchLeft = () => execSync('docker ps -aq --filter label=servify.testrestore; docker volume ls -q --filter label=servify.testrestore').toString().trim();

  // ── To a folder: streamed straight there (no staging copy), checksum recorded and matching the file.
  const lb = await api('POST', `/services/${vault.id}/backups`, { destinationId: local.id });
  const lfile = lb.key ? join(folder, lb.key) : '';
  check('a volume backup streams to a folder, with a SHA-256 checksum', lb.status === 'succeeded' && /^[0-9a-f]{64}$/.test(lb.sha256 ?? '') && lb.sizeBytes > 80_000_000, `${lb.status} ${lb.error ?? ''}`);
  check('…the checksum and size are those of the stored file', !!lfile && existsSync(lfile) && statSync(lfile).size === lb.sizeBytes && sha256File(lfile) === lb.sha256);
  check('…and no partial file is left next to it', filesUnder(folder).every((f) => !f.endsWith('.part')), filesUnder(folder).join(', '));
  if (DATA) check('…nor a staging copy in the data directory', !existsSync(join(DATA, 'tmp')) || readdirSync(join(DATA, 'tmp')).length === 0);

  // ── To S3: streamed multipart, through the proxy.
  const sb = await api('POST', `/services/${vault.id}/backups`, { destinationId: s3.id });
  check('a volume backup streams to S3 (MinIO), with a checksum', sb.status === 'succeeded' && /^[0-9a-f]{64}$/.test(sb.sha256 ?? ''), `${sb.status} ${sb.error ?? ''}`);
  const etag = sb.key ? (mc(`stat --json acc/servify-acc/${sb.key}`).match(/"etag":\s*"([^"]+)"/)?.[1] ?? '') : '';
  const parts = Number(etag.split('-')[1] ?? 1);
  check(`…as a multipart upload (${parts} parts of ${PART_MB} MiB)`, parts > 1 && (PART_MB > 5 || parts >= 10), `etag ${etag}`);
  check('…the same bytes as recorded (download → sha256)', await (async () => {
    const dl = await fetch(`${BASE}/api/backups/${sb.id}/download`, { headers: COOKIE ? { cookie: COOKIE } : {} });
    return dl.status === 200 && createHash('sha256').update(Buffer.from(await dl.arrayBuffer())).digest('hex') === sb.sha256;
  })());
  check('…with no unfinished upload left in the bucket', incomplete() === '', incomplete());
  check('the API lists both backups with their checksums', (await backups()).filter((b) => b.sha256 && [lb.id, sb.id].includes(b.id)).length === 2);

  // ── Restores from both (each verified end to end first).
  await exec(vault.id, 'echo changed > /data/file && rm /data/big.bin');
  // The download is dropped once, 20 MB into the second read (the restore itself, after the check and the safety
  // backup): it must pick up where it stopped.
  proxy.dropReplyAfter(sb.sizeBytes + 20 * 1024 * 1024);
  await restoreAndWait(sb.id);
  check('restore from S3 brings the data back (streamed, verified)', (await fileIs()) === 'original' && (await bigSum()) === original, await fileIs());
  check('…even with the download dropped mid-restore (resumed with a range request)', proxy.drops() === 1, `drops=${proxy.drops()}`);
  proxy.dropReplyAfter(Infinity);
  await exec(vault.id, 'echo changed-again > /data/file');
  await restoreAndWait(lb.id);
  check('restore from the folder brings the data back', (await fileIs()) === 'original' && (await bigSum()) === original, await fileIs());

  // ── Test restores: passing (scratch volume, nothing left behind) …
  const t1 = await api('POST', `/backups/${sb.id}/test?wait=1`);
  check('a test restore of the S3 backup passes', t1.test?.status === 'passed' && /checksum ok/.test(t1.test.message) && /scratch volume: \d/.test(t1.test.message), JSON.stringify(t1.test));
  check('…leaves no scratch volume or container behind', scratchLeft() === '', scratchLeft());
  check('…and did not touch the service', (await fileIs()) === 'original' && (await svcOf(P.id, 'vault')).status === 'running');

  // ── A damaged archive (one byte flipped): refused before anything changes; test restore fails and notifies.
  await exec(vault.id, 'echo live > /data/file');
  const preBefore = (await backups()).filter((b) => b.trigger === 'pre-restore').length;
  if (lfile) {
    const buf = readFileSync(lfile);
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    writeFileSync(lfile, buf);
  }
  const t0 = Date.now();
  await restoreAndWait(lb.id);
  const acts = await api('GET', `/projects/${P.id}/activity?limit=30`);
  const refused = acts.find((a) => a.action === 'backup.restore_failed' && a.serviceId === vault.id && (a.ts ?? a.createdAt) >= t0 - 1000);
  check('restoring a damaged archive is refused (checksum mismatch / damaged)', !!refused && /checksum mismatch|damaged/.test(refused.summary ?? refused.message ?? JSON.stringify(refused)), JSON.stringify(refused ?? null).slice(0, 200));
  check('…with the live data intact and no safety backup taken for nothing', (await fileIs()) === 'live' && (await bigSum()) === original && (await backups()).filter((b) => b.trigger === 'pre-restore').length === preBefore);
  const t2 = await api('POST', `/backups/${lb.id}/test?wait=1`);
  check('a test restore of the damaged archive fails', t2.test?.status === 'failed' && /checksum mismatch|damaged/.test(t2.test.message), JSON.stringify(t2.test));
  check('…and the failure is notified', !!(await waitFor(() => notes.find((n) => n.event === 'backup.failed' && /Test restore/.test(n.title ?? '')), 15_000, 'test restore notification')));
  check('…leaving nothing behind', scratchLeft() === '', scratchLeft());

  // ── A cut-off archive (half the file): refused too.
  const cb = await api('POST', `/services/${vault.id}/backups`, { destinationId: local.id });
  if (cb.key) {
    const p = join(folder, cb.key);
    writeFileSync(p, readFileSync(p).subarray(0, Math.floor(statSync(p).size / 2)));
  }
  const t3 = Date.now();
  await restoreAndWait(cb.id);
  const cut = (await api('GET', `/projects/${P.id}/activity?limit=30`)).find((a) => a.action === 'backup.restore_failed' && a.serviceId === vault.id && (a.ts ?? a.createdAt) >= t3 - 1000);
  check('restoring a truncated archive is refused, the data intact', !!cut && (await fileIs()) === 'live' && (await bigSum()) === original, JSON.stringify(cut ?? null).slice(0, 200));

  // ── An S3 upload cut mid-way: failed, and (once the store is reachable again) no unfinished upload or object left.
  proxy.cutAfter(20 * 1024 * 1024);
  const ab = await api('POST', `/services/${vault.id}/backups`, { destinationId: s3.id });
  check('an S3 upload cut mid-way marks the backup failed', ab.status === 'failed' && !!ab.error, `${ab.status} ${ab.error ?? ''}`);
  const stuck = incomplete();
  proxy.restore();
  const cleaned = await waitFor(async () => incomplete() === '' && (await backups()).find((b) => b.id === ab.id)?.cleanupPending !== true, 150_000, 'the unfinished upload to be aborted');
  // What is in the bucket: exactly the backups listed as succeeded there (the restores' safety backups among them).
  const objects = mc('ls -r acc/servify-acc').trim().split('\n').filter(Boolean).map((l) => l.split(' ').pop());
  const known = (await backups()).filter((b) => b.status === 'succeeded' && b.destinationId === s3.id).map((b) => b.key);
  check(`…and its unfinished upload is aborted once the store is back (${stuck ? 'it was left while unreachable' : 'aborted at once'})`, !!cleaned, incomplete());
  check('…no object of it is left, and it is not listed as a backup', objects.length === known.length && objects.every((o) => known.includes(o)) && (await backups()).find((b) => b.id === ab.id)?.status === 'failed', `${objects.join(' | ')} vs ${known.join(' | ')}`);

  // ── A backup recorded before checksums existed: restores (archive-checked only) and test-restores.
  if (DATA) {
    const ob = await api('POST', `/services/${vault.id}/backups`, { destinationId: local.id });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(DATA, 'servify.db'));
    db.prepare(`UPDATE backups SET data = json_remove(data, '$.sha256', '$.image') WHERE id = ?`).run(ob.id);
    db.close();
    const old = (await backups()).find((b) => b.id === ob.id);
    check('an old-style backup record has no checksum', old && !old.sha256 && old.status === 'succeeded');
    await exec(vault.id, 'echo before-old > /data/file');
    await restoreAndWait(ob.id);
    check('…and still restores', (await fileIs()) === 'live' && (await bigSum()) === original, await fileIs());
    const t4 = await api('POST', `/backups/${ob.id}/test?wait=1`);
    check('…and test-restores (archive checked, no checksum to compare)', t4.test?.status === 'passed' && /no checksum recorded/.test(t4.test.message), JSON.stringify(t4.test));
  } else console.log('  – skipped the old-record check (set SERVIFY_DATA_DIR)');

  // ── Deleting backups removes them at the destination.
  await api('DELETE', `/backups/${sb.id}`);
  await api('DELETE', `/backups/${lb.id}`);
  check('deleting backups deletes the S3 object and the file', !mc('ls -r acc/servify-acc').includes(sb.key) && !existsSync(lfile));

  // ── A Postgres dump: to S3, test-restored into a throwaway postgres of the same image, restored.
  const pg = (await api('POST', `/projects/${P.id}/services`, { templateId: 'postgres', name: 'pg-stream' })).service;
  await running(P.id, 'pg-stream');
  await waitFor(async () => (await exec(pg.id, 'pg_isready -q -U postgres')).exitCode === 0, 60_000, 'postgres ready');
  await exec(pg.id, `psql -U postgres -d app -c "create table kept(v text); insert into kept select 'row' || g from generate_series(1, 5000) g;"`);
  const pb = await api('POST', `/services/${pg.id}/backups`, { destinationId: s3.id });
  check('a Postgres dump streams to S3 with a checksum and its image', pb.status === 'succeeded' && /^[0-9a-f]{64}$/.test(pb.sha256 ?? '') && !!pb.image, `${pb.status} ${pb.error ?? ''} ${pb.image ?? ''}`);
  const pt = await api('POST', `/backups/${pb.id}/test?wait=1`);
  check('a test restore loads it into a throwaway postgres and queries it', pt.test?.status === 'passed' && /throwaway PostgreSQL \d+.* container: \d+ databases, [1-9]\d* tables/.test(pt.test.message), JSON.stringify(pt.test));
  check('…and removes that container', scratchLeft() === '', scratchLeft());
  await exec(pg.id, 'psql -U postgres -d app -c "drop table kept;"');
  await api('POST', `/backups/${pb.id}/restore`);
  await sleep(1500);
  await waitFor(async () => !(await api('GET', `/services/${pg.id}`)).restoring, 240_000, 'restore');
  check('…and restores from S3', (await exec(pg.id, 'psql -U postgres -d app -tAc "select count(*) from kept"')).output.trim() === '5000');

  // ── Scheduled test restores (on the backup schedule's settings).
  check('an invalid test restore schedule is refused', (await api('PATCH', `/services/${pg.id}`, { backup: { testSchedule: 'nope' } }).then(() => 'ok', (e) => String(e.message))).includes('→ 400'));
  await api('PATCH', `/services/${pg.id}`, { backup: { enabled: true, schedule: '0 3 * * *', destinationId: s3.id, testSchedule: '* * * * *' } });
  const sched = await waitFor(async () => {
    const t = (await api('GET', `/services/${pg.id}/backups`)).find((b) => b.id === pb.id)?.test;
    return t?.actor === 'backup-scheduler' && t.status !== 'running' && t;
  }, 100_000, 'a scheduled test restore');
  check('a scheduled test restore runs on its cron schedule and passes', sched?.status === 'passed', JSON.stringify(sched ?? null));
  await api('PATCH', `/services/${pg.id}`, { backup: { enabled: false, testSchedule: null } });
}

/**
 * Hung replicas: running, but failing the health check. Needs an instance started with short timings, e.g.
 * SERVIFY_RESTART_AFTER_SECONDS=8 SERVIFY_RESTART_MAX=2 SERVIFY_RESTART_BACKOFF_SECONDS=3 SERVIFY_RESTART_RESET_SECONDS=15
 * SERVIFY_RESTART_CHECK_MS=1000 (and SERVIFY_SLEEP_UNIT_MS=2000 for the sleeping case); pass the same to this script.
 */
/**
 * "Move to project…" (ONLY=moveproject; also part of a full run): the dry run lists what breaks (references both ways,
 * by ${{…}} and by host name) and the name clash; broken references are refused unless forced, a taken name always;
 * the service keeps its id, deploy history, volume data and logs, and runs on the new project's network.
 */
async function moveProjectChecks() {
  console.log('\n▸ moving a service to another project');
  const raw = (path, body) => fetch(`${BASE}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(COOKIE ? { cookie: COOKIE } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const A = await api('POST', '/projects', { name: `move-a-${Date.now().toString(36)}` });
  const Bp = await api('POST', '/projects', { name: `move-b-${Date.now().toString(36)}` });
  projectsToDelete.push(A.id, Bp.id);
  const mover = (await api('POST', `/projects/${A.id}/services`, { name: 'keeper', image: 'alpine:3.20', protocol: 'none', startCommand: 'echo keeper-started; exec sleep 1d', env: { SECRET_WORD: 'kept' } })).service;
  await waitFor(async () => (await api('GET', `/services/${mover.id}`)).status === 'running', 120_000, 'keeper running');
  await api('POST', `/projects/${A.id}/volumes`, { name: 'keeper-data', serviceId: mover.id, mountPath: '/data' });
  await waitFor(async () => (await exec(mover.id, "grep -q ' /data ' /proc/mounts").catch(() => null))?.exitCode === 0, 120_000, 'keeper running with its volume');
  await exec(mover.id, 'echo moved-data > /data/file');
  const depsBefore = (await api('GET', `/services/${mover.id}/deployments?limit=100`)).map((d) => d.id);
  const logsBefore = await waitFor(async () => {
    const l = await api('GET', `/services/${mover.id}/logs?tail=500`);
    return l.some((x) => /keeper-started/.test(x.text ?? '')) ? l : null;
  }, 30_000, 'keeper logged');
  const user = (await api('POST', `/projects/${A.id}/services`, { name: 'user', image: 'alpine:3.20', protocol: 'none', startCommand: 'sleep 1d', env: { WORD: '${{keeper.SECRET_WORD}}', KEEPER: 'tcp://keeper:9000', NAME: 'keeper' }, deploy: false })).service;
  const clash = (await api('POST', `/projects/${Bp.id}/services`, { name: 'keeper', image: 'alpine:3.20', protocol: 'none', startCommand: 'sleep 1d', deploy: false })).service;

  const plan = await api('POST', `/services/${mover.id}/move-project`, { dryRun: true, project: Bp.id });
  const used = plan.warnings.find((w) => w.code === 'used_by')?.services?.[0];
  check('dry run: lists the service left behind and its keys (by reference and by host name, not a plain word)', used?.id === user.id && used.keys.includes('WORD') && used.keys.includes('KEEPER') && !used.keys.includes('NAME'), JSON.stringify(used));
  check('dry run: a taken name is a blocker, with a free one suggested', plan.blockers.some((b) => b.code === 'name_taken') && plan.suggestedName === 'keeper-2' && plan.restart === true);
  const taken = await raw(`/services/${mover.id}/move-project`, { project: Bp.id, force: true });
  check('a taken name is refused even with force', taken.status === 409 && taken.body.code === 'name_taken');
  await api('DELETE', `/services/${clash.id}`);
  const refused = await raw(`/services/${mover.id}/move-project`, { project: Bp.id });
  check('a move that would break references is refused without force', refused.status === 409 && refused.body.code === 'move_breaks_references' && /user/.test(refused.body.error ?? ''));
  await api('POST', `/services/${mover.id}/move-project`, { project: Bp.id, force: true });
  const inB = await api('GET', `/projects/${Bp.id}`);
  check('the service and its volume are in the new project', inB.services.some((x) => x.id === mover.id) && inB.volumes.some((v) => v.serviceId === mover.id));
  check('and gone from the old one', !(await api('GET', `/projects/${A.id}`)).services.some((x) => x.id === mover.id));
  const restarted = await waitFor(async () => {
    const s = await api('GET', `/services/${mover.id}`);
    if (s.status !== 'running' || depsBefore.includes(s.activeDeploymentId)) return null;
    const r = await exec(mover.id, 'cat /data/file').catch(() => null);
    return r && r.output.trim() === 'moved-data';
  }, 120_000, 'moved service running');
  check('it restarts in the new project with its data', !!restarted);
  const depsAfter = (await api('GET', `/services/${mover.id}/deployments?limit=100`)).map((d) => d.id);
  check('its deploy history is kept', depsBefore.every((id) => depsAfter.includes(id)) && depsAfter.length > depsBefore.length);
  const logsAfter = await api('GET', `/services/${mover.id}/logs?tail=500`);
  check('its logs from before the move are kept', logsAfter.length >= logsBefore.length && logsAfter.some((x) => x.ts === logsBefore[0].ts && x.text === logsBefore[0].text));

  // A reference through a shared variable of the old project counts too.
  const cache = (await api('POST', `/projects/${A.id}/services`, { name: 'cache', image: 'alpine:3.20', protocol: 'none', startCommand: 'sleep 1d', deploy: false })).service;
  await api('PATCH', `/projects/${A.id}`, { variables: { CACHE_URL: 'redis://cache:6379' } });
  const reader = (await api('POST', `/projects/${A.id}/services`, { name: 'reader', image: 'alpine:3.20', protocol: 'none', startCommand: 'sleep 1d', env: { URL: '${{shared.CACHE_URL}}' }, deploy: false })).service;
  const viaShared = (await api('POST', `/services/${cache.id}/move-project`, { dryRun: true, project: Bp.id })).warnings.find((w) => w.code === 'used_by')?.services ?? [];
  check('dry run: a sibling reading a shared variable that names it is listed', viaShared.some((x) => x.id === reader.id && x.keys.some((k) => /^URL \(via shared\.CACHE_URL\)/.test(k))), JSON.stringify(viaShared));

  // Moved under another name while running: reachable by the new host name, data intact.
  await api('POST', `/projects/${A.id}/services`, { name: 'keeper', image: 'alpine:3.20', protocol: 'none', startCommand: 'sleep 1d', deploy: false });
  const back = await raw(`/services/${mover.id}/move-project`, { project: A.id, name: 'vault' });
  check('moved back under another name (its old name is taken there)', back.status === 200 && back.body.name === 'vault' && back.body.slug === 'vault', JSON.stringify(back.body).slice(0, 160));
  const renamedUp = await waitFor(async () => {
    const s = await api('GET', `/services/${mover.id}`);
    if (s.status !== 'running') return null;
    const r = await exec(mover.id, 'cat /data/file').catch(() => null);
    return r?.output.trim() === 'moved-data' && s.projectId === A.id;
  }, 120_000, 'renamed service running');
  const probe = (await api('POST', `/projects/${A.id}/services`, { name: 'probe', image: 'alpine:3.20', protocol: 'none', startCommand: 'sleep 1d' })).service;
  await waitFor(async () => (await api('GET', `/services/${probe.id}`)).status === 'running', 120_000, 'probe running');
  const dns = await waitFor(async () => ((await exec(probe.id, 'getent hosts vault').catch(() => null))?.exitCode === 0 ? true : null), 30_000, 'vault resolves');
  check('it runs under the new name with its data, and siblings reach it by that name', !!renamedUp && !!dns);

  // Moved while stopped: the next start runs with variables resolved in the new project.
  await api('POST', `/services/${probe.id}/stop`);
  await api('POST', `/services/${probe.id}/move-project`, { project: Bp.id });
  await api('POST', `/services/${probe.id}/start`);
  const name = await waitFor(async () => {
    const r = await exec(probe.id, 'echo $SERVIFY_PROJECT_NAME').catch(() => null);
    return r?.exitCode === 0 ? r.output.trim() : null;
  }, 120_000, 'probe started in B');
  check('a service moved while stopped starts with the new project’s variables', name === Bp.name, name);
}

async function hungReplicaChecks(P) {
  console.log('\n▸ restarting hung replicas');
  const AFTER = Number(process.env.SERVIFY_RESTART_AFTER_SECONDS);
  const MAX = Number(process.env.SERVIFY_RESTART_MAX ?? 3);
  if (!AFTER || AFTER > 30) return console.log('  – skipped (run Servify and this script with SERVIFY_RESTART_AFTER_SECONDS ≤ 30, see hungReplicaChecks)');
  const notes = [];
  const sink = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try {
        notes.push(JSON.parse(b));
      } catch {}
      res.end('ok');
    });
  });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  cleanups.push(() => sink.close());
  const ch = await api('POST', '/settings/notifications/channels', { name: 'hung-replicas', type: 'webhook', url: `http://127.0.0.1:${sink.address().port}/hook`, events: ['service.crashed', 'service.recovered'] });
  cleanups.push(() => api('DELETE', `/settings/notifications/channels/${ch.id}`).catch(() => {}));

  // Fails its health check (500) after GET /break (in memory: a restart fixes it) or while /tmp/stuck exists (survives a restart).
  const app = `const fs=require('fs');let bad=false;require('http').createServer((q,s)=>{if(q.url==='/break'){bad=true;return s.end('broken')}if(q.url==='/healthz'){const b=bad||fs.existsSync('/tmp/stuck');s.writeHead(b?500:200);return s.end(b?'bad':'ok')}s.end('up')}).listen(3000)`;
  const make = async (name, extra = {}) => {
    const svc = (await api('POST', `/projects/${P.id}/services`, { name, image: 'node:22-alpine', port: 3000, startCommand: `node -e "${app}"`, ...extra })).service;
    await api('PATCH', `/services/${svc.id}`, { healthcheck: { path: '/healthz', intervalSec: 1, graceSec: 5 } });
    await running(P.id, name);
    return svc;
  };
  const reps = async (sid) => (await api('GET', `/services/${sid}/metrics?seconds=10`)).replicas;
  const acts = async (sid, action) => (await api('GET', `/projects/${P.id}/activity?limit=200`)).filter((a) => a.serviceId === sid && a.action === action);
  const view = (sid) => api('GET', `/services/${sid}`);

  const hung = await make('hung');
  const s0 = await view(hung.id);
  check('on by default, with the default threshold', s0.autoRestart?.enabled === true && s0.autoRestart.explicit === false && s0.autoRestart.afterSec === AFTER && s0.autoRestart.unavailable === null, JSON.stringify(s0.autoRestart));
  const host = `hung.${P.slug}.localhost`;
  await waitFor(async () => (await hit(host)).status === 200, 30_000, 'hung serving');
  const [r0] = await reps(hung.id);
  const t0 = Date.now();
  check('the app breaks (in memory)', (await hit(host, '/break')).body === 'broken');
  check('it is taken out of rotation first', !!(await waitFor(async () => (await reps(hung.id))[0]?.state === 'unhealthy', 20_000, 'unhealthy')));
  const restarted = await waitFor(async () => (await acts(hung.id, 'service.restarted'))[0], (AFTER + 30) * 1000, 'automatic restart');
  check('a replica failing its health check is restarted', !!restarted, '');
  check('not before the threshold', !!restarted && restarted.ts - t0 >= AFTER * 1000, restarted && `${restarted.ts - t0} ms`);
  console.log(`    (restarted ${Math.round((Date.now() - t0) / 1000)} s after breaking it; threshold ${AFTER} s)`);
  const back = await waitFor(async () => {
    const [r] = await reps(hung.id);
    return r?.state === 'healthy' && r.startedAt !== r0.startedAt && r;
  }, 30_000, 'healthy after the restart');
  check('the same container came back healthy', !!back && back.containerId === r0.containerId, JSON.stringify(back && { c: back.containerId.slice(0, 12), was: r0.containerId.slice(0, 12) }));
  check('and serves again', !!(await waitFor(async () => (await hit(host)).body === 'up', 20_000, 'serving again')));
  check('the restart is in the activity log', /Restarted replica #0 of hung: it failed its health check for \d+ s while running/.test(restarted?.summary ?? ''), restarted?.summary);
  const logs = await api('GET', `/services/${hung.id}/logs?tail=200`);
  check("and in the service's logs", logs.some((l) => /^\[servify\] Replica #0 failed its health check .* restarted it/.test(l.text)), '');
  check('a notification says so', !!(await waitFor(() => notes.find((n) => n.serviceId === hung.id && n.event === 'service.crashed' && /restarted a hung replica/.test(n.title)), 10_000, 'restart notification')));
  check('the dashboard shows the recent restart', (await view(hung.id)).autoRestart?.restarts === 1);

  // Keeps failing after every restart: the cap, then one notice and no more restarts.
  console.log('    (keeping it broken: backoff and the cap)');
  const BACKOFF = Number(process.env.SERVIFY_RESTART_BACKOFF_SECONDS ?? 0);
  const tStuck = Date.now();
  await exec(hung.id, 'touch /tmp/stuck');
  const capped = await waitFor(async () => (await view(hung.id)).autoRestart?.attention, (AFTER + 30) * MAX * 1000 + 60_000, 'needs attention');
  check(`it stops after ${MAX} restarts in the window and needs attention`, !!capped, '');
  const nRestarts = (await acts(hung.id, 'service.restarted')).length;
  check(`${MAX} restarts counted (1 earlier + ${MAX - 1} now) before giving up`, nRestarts === MAX, String(nRestarts));
  if (BACKOFF && MAX >= 3) {
    // Restart n+1 needs AFTER + BACKOFF·2^(n−1) of failing (after the startup grace): the waits grow.
    const ts = (await acts(hung.id, 'service.restarted')).map((a) => a.ts).sort((a, b) => a - b);
    const first = ts[1] - tStuck;
    const gaps = ts.slice(2).map((x, i) => x - ts[i + 1]);
    check('backoff: the 2nd restart waits threshold + backoff', first >= (AFTER + BACKOFF) * 1000, `${first} ms`);
    check('backoff: each further restart waits longer (doubling)', gaps.every((g, i) => g >= (AFTER + BACKOFF * 2 ** (i + 2 - 1)) * 1000) && gaps.every((g) => g > first), JSON.stringify({ first, gaps }));
    console.log(`    (waits before restarts 2…${MAX}: ${[first, ...gaps].map((g) => Math.round(g / 1000) + ' s').join(', ')})`);
  } else console.log('  – skipped the backoff timing (run with SERVIFY_RESTART_MAX ≥ 3 and SERVIFY_RESTART_BACKOFF_SECONDS)');
  const attentionTitle = (n) => n.serviceId === hung.id && n.event === 'service.crashed' && /needs attention/.test(n.title);
  await waitFor(() => notes.some(attentionTitle), 10_000, 'attention notification');
  await sleep((AFTER + 8) * 1000);
  check('no more restarts after the cap', (await acts(hung.id, 'service.restarted')).length === nRestarts);
  check('one "needs attention" notification, not one per check', notes.filter(attentionTitle).length === 1, String(notes.filter(attentionTitle).length));
  check('the replica shows as unhealthy, the service as crashed', (await reps(hung.id))[0]?.state === 'unhealthy' && (await view(hung.id)).status === 'crashed', `${(await reps(hung.id))[0]?.state} ${(await view(hung.id)).status}`);
  check('the attention entry is in the activity log', (await acts(hung.id, 'service.attention')).length === 1);
  // Fixed by hand: healthy for a while → counting starts over and the notice clears.
  await exec(hung.id, 'rm -f /tmp/stuck');
  const cleared = await waitFor(async () => {
    const v = await view(hung.id);
    return v.autoRestart && !v.autoRestart.attention && v.autoRestart.restarts === 0 && v.status === 'running';
  }, 90_000, 'attention cleared');
  check('healthy for a while: the count resets and "needs attention" clears', !!cleared);
  check('with a "healthy again" notification', !!(await waitFor(() => notes.find((n) => n.serviceId === hung.id && n.event === 'service.recovered' && /healthy again/.test(n.title)), 10_000, 'recovered notification')));

  // The setting: API, MCP and off means off.
  await api('PATCH', `/services/${hung.id}`, { healthcheck: { autoRestart: false } });
  const off = await view(hung.id);
  check('switched off via the API', off.autoRestart?.enabled === false && off.autoRestart.explicit === true && off.healthcheck.autoRestart === false);
  const before = (await acts(hung.id, 'service.restarted')).length;
  await hit(host, '/break');
  await sleep((AFTER + 8) * 1000);
  check('off: a hung replica is only taken out of rotation', (await acts(hung.id, 'service.restarted')).length === before && (await reps(hung.id))[0]?.state === 'unhealthy');
  const mres = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(COOKIE ? { cookie: COOKIE } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_service', arguments: { service: hung.id, healthcheck: { autoRestart: null, restartAfterSec: 3600 } } } }),
  });
  const mj = await mres.json().catch(() => ({}));
  const viaMcp = await view(hung.id);
  check('MCP update_service sets it (back to the default, own threshold)', !mj.result?.isError && viaMcp.autoRestart?.enabled === true && viaMcp.autoRestart.explicit === false && viaMcp.autoRestart.afterSec === 3600 && !('autoRestart' in viaMcp.healthcheck), JSON.stringify(viaMcp.autoRestart));
  check('updating the health check keeps the other fields', viaMcp.healthcheck.path === '/healthz' && viaMcp.healthcheck.intervalSec === 1);
  await sleep((AFTER + 4) * 1000);
  check('its own longer threshold is respected', (await acts(hung.id, 'service.restarted')).length === before);
  await api('DELETE', `/services/${hung.id}`);

  // Mid-deploy: a pre-deploy step holds the deploy while the running replica is hung.
  const dep = await make('hung-deploy');
  await api('PATCH', `/services/${dep.id}`, { preDeployCommand: `sleep ${AFTER + 15}` });
  await exec(dep.id, 'touch /tmp/stuck');
  await waitFor(async () => (await reps(dep.id))[0]?.state === 'unhealthy', 20_000, 'unhealthy before the deploy');
  const oldActive = (await view(dep.id)).activeDeploymentId;
  await api('POST', `/services/${dep.id}/deploy`);
  await sleep((AFTER + 10) * 1000);
  const mid = await view(dep.id);
  check('a service mid-deploy is left alone', mid.activeDeploymentId === oldActive && (await acts(dep.id, 'service.restarted')).length === 0, `${mid.status} ${(await acts(dep.id, 'service.restarted')).length}`);
  const deployed = await waitFor(async () => (await view(dep.id)).activeDeploymentId !== oldActive && (await view(dep.id)).status === 'running', 120_000, 'deploy done');
  check('the deploy finishes and replaces it (no restart in between)', !!deployed && (await acts(dep.id, 'service.restarted')).length === 0);
  await api('DELETE', `/services/${dep.id}`);

  // Sleeping: stopped containers are not hung, and stay asleep.
  if (process.env.SERVIFY_SLEEP_UNIT_MS) {
    const sl = await make('hung-sleeper');
    await api('PATCH', `/services/${sl.id}`, { sleepAfterMinutes: 1 });
    const asleep = await waitFor(async () => (await view(sl.id)).status === 'sleeping', 60_000, 'asleep');
    await sleep((AFTER + 8) * 1000);
    const v = await view(sl.id);
    check('a sleeping service is left alone (no restart, still asleep)', !!asleep && v.status === 'sleeping' && (await acts(sl.id, 'service.restarted')).length === 0 && (await reps(sl.id)).every((r) => r.dockerState !== 'running'), v.status);
    await api('DELETE', `/services/${sl.id}`);
  } else console.log('  – skipped the sleeping case (run Servify with SERVIFY_SLEEP_UNIT_MS)');

  // Not covered: cron jobs (and clusters, workers, routes) say why.
  const cron = (await api('POST', `/projects/${P.id}/services`, { name: 'hung-cron', image: 'alpine:3.20', protocol: 'none', startCommand: 'true', deploy: false })).service;
  await api('PATCH', `/services/${cron.id}`, { schedule: '0 3 * * *' });
  check('cron jobs are not covered, and say why', /cron/.test((await view(cron.id)).autoRestart?.unavailable ?? ''), JSON.stringify((await view(cron.id)).autoRestart));
  await api('DELETE', `/services/${cron.id}`);
}

/**
 * Scoped API tokens. Project A (in reach) and project B (out of reach), each with a service on a volume, a spare volume,
 * a deployment and a backup. Tokens: read, deploy, write (all projects), write and deploy limited to A, and a token
 * record in the shape written before scopes existed. Every route of policy.ts is sent the requests that must be refused
 * (and, for GET, the ones that must be answered); every MCP tool likewise. Details print status codes, never bodies.
 */
async function tokenChecks(A) {
  const { ROUTE_POLICIES, TOOL_POLICIES } = await import(new URL('../server/src/policy.ts', import.meta.url).href);
  const RANK = { read: 0, deploy: 1, write: 2 };

  console.log('\n▸ scoped tokens: every route and tool is classified');
  const apiSrc = readFileSync(new URL('../server/src/api.ts', import.meta.url), 'utf8');
  const routes = [...apiSrc.matchAll(/^api\.(get|post|patch|put|delete)\(\s*'([^']+)'/gm)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  const policyRoutes = Object.keys(ROUTE_POLICIES);
  check(`every REST route in api.ts has a policy (${routes.length} routes)`, routes.length > 100 && routes.every((r) => policyRoutes.includes(r)), routes.filter((r) => !policyRoutes.includes(r)).join(', '));
  check('every policy names a registered route', policyRoutes.every((r) => routes.includes(r)), policyRoutes.filter((r) => !routes.includes(r)).join(', '));
  check('api.ts registers routes only through api.get/post/patch/put/delete', !/\bapi\.(all|on|route|mount)\(/.test(apiSrc));
  const mcpSrc = readFileSync(new URL('../server/src/mcp.ts', import.meta.url), 'utf8');
  const tools = [...mcpSrc.matchAll(/^\s*tool\(\s*'([a-z_]+)'/gm)].map((m) => m[1]);
  check(`every MCP tool has a policy (${tools.length} tools)`, tools.length > 40 && tools.every((t) => TOOL_POLICIES[t]), tools.filter((t) => !TOOL_POLICIES[t]).join(', '));
  check('every tool policy names a registered tool', Object.keys(TOOL_POLICIES).every((t) => tools.includes(t)), Object.keys(TOOL_POLICIES).filter((t) => !tools.includes(t)).join(', '));
  check('mcp.ts registers tools only through the policy wrapper', (mcpSrc.match(/server\.registerTool\b/g) ?? []).length === 1);

  // ─── fixtures ───
  console.log('\n▸ scoped tokens: fixtures');
  const B = await api('POST', '/projects', { name: `tokens-b-${Date.now().toString(36)}` });
  projectsToDelete.push(B.id);
  const canary = `tok-canary-${randomBytes(6).toString('hex')}`;
  const fixture = async (P) => {
    const web = (await api('POST', `/projects/${P.id}/services`, { image: 'traefik/whoami', name: 'web', env: { API_SECRET: canary, PLAIN: 'x' } })).service;
    await running(P.id, 'web');
    await api('POST', `/projects/${P.id}/volumes`, { name: 'data', serviceId: web.id, mountPath: '/data' });
    const spare = await api('POST', `/projects/${P.id}/volumes`, { name: 'spare' });
    await waitFor(async () => {
      const d = await api('GET', `/services/${web.id}/deployments?limit=5`);
      return d.length >= 2 && d[0].status === 'active' && (await svcOf(P.id, 'web')).status === 'running';
    }, 180_000, 'redeploy with the volume');
    const deps = await api('GET', `/services/${web.id}/deployments?limit=5`);
    const backup = await api('POST', `/services/${web.id}/backups`, {});
    await waitFor(async () => (await api('GET', `/services/${web.id}/backups`)).find((b) => b.id === backup.id)?.status !== 'running', 120_000, 'backup');
    return { P, web, spare, dep: deps[0], prevDep: deps[1], backup };
  };
  const [FA, FB] = [await fixture(A), await fixture(B)];
  check('fixtures: two projects, each with a service, volumes, deployments and a backup', !!(FA.dep && FA.prevDep && FA.backup?.id && FB.dep && FB.backup?.id));

  // Only tokens made here are revoked at the end (an install's own tokens may share a name such as "agent").
  const tokensBefore = new Set((await api('GET', '/tokens')).map((t) => t.id));
  const mk = async (name, scope, projects) => (await api('POST', '/tokens', { name, scope, ...(projects ? { projects } : {}) })).token;
  const T = {
    read: { scope: 'read', token: await mk('acc-read', 'read') },
    deploy: { scope: 'deploy', token: await mk('acc-deploy', 'deploy') },
    write: { scope: 'write', token: await mk('acc-write', 'write') },
    'write[A]': { scope: 'write', projects: [A.id], token: await mk('acc-write-a', 'write', [A.slug]) },
    'deploy[A]': { scope: 'deploy', projects: [A.id], token: await mk('acc-deploy-a', 'deploy', [A.id]) },
  };
  check(
    'deploy and project-limited tokens start with svs_ (0.2.3 rejects them after a rollback), the others with svf_',
    ['deploy', 'write[A]', 'deploy[A]'].every((k) => T[k].token?.startsWith('svs_')) && ['read', 'write'].every((k) => T[k].token?.startsWith('svf_')),
  );
  const list = await api('GET', '/tokens');
  const rec = (n) => list.find((t) => t.name === n);
  check('the token list shows scope and projects', rec('acc-write-a')?.scope === 'write' && JSON.stringify(rec('acc-write-a')?.projects) === JSON.stringify([A.id]) && rec('acc-deploy')?.scope === 'deploy' && !('projects' in rec('acc-deploy')), `${rec('acc-write-a')?.scope}`);
  const badScope = await fetch(`${BASE}/api/tokens`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: COOKIE }, body: JSON.stringify({ name: 'x', scope: 'admin' }) });
  const noProjects = await fetch(`${BASE}/api/tokens`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: COOKIE }, body: JSON.stringify({ name: 'x', scope: 'write', projects: [] }) });
  check('creating a token: unknown scopes and empty project lists are refused', badScope.status === 400 && noProjects.status === 400, `${badScope.status} ${noProjects.status}`);

  // ─── the REST matrix ───
  console.log('\n▸ scoped tokens: REST, route by scope');
  const ids = (F, kind) => ({ project: F.P.id, service: F.web.id, deployment: F.dep.id, volume: F.spare.id, backup: F.backup.id })[kind];
  const OTHER = { name: 'data', key: 'PLAIN', host: 'example.com' };
  const req = async (tok, method, path, body) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await fetch(BASE + '/api' + path, { method, signal: ctrl.signal, headers: { authorization: `Bearer ${tok}`, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
      // Errors are small JSON; successful answers (streams, downloads, secrets) are never read.
      const error = res.status >= 400 ? ((await res.json().catch(() => ({}))).error ?? '') : '';
      if (res.status < 400) ctrl.abort();
      return { status: res.status, error };
    } catch (e) {
      return { status: 0, error: e.message };
    } finally {
      clearTimeout(timer);
    }
  };
  /** What a token must get: 'allow', or the status of the refusal (403 level / instance-wide, 404 out of reach). */
  const expected = (t, key, pol, where) => {
    const method = key.split(' ')[0];
    if (t.scope === 'read' && method !== 'GET') return 403;
    if (pol.level === 'owner') return 403;
    // Uploads: a deploy token may upload where the source is an upload; out of reach that reads as not found.
    if (RANK[t.scope] < RANK[pol.level]) return pol.deployOnUploads && t.scope === 'deploy' && t.projects && where === 'B' ? 404 : 403;
    if (t.projects) {
      const named = Object.keys(pol.params ?? {}).length + Object.keys(pol.body ?? {}).length;
      if (!named && !pol.filtered) return 403;
      if (named && where === 'B') return 404;
    }
    return 'allow';
  };
  const SECRET_GATES = /cannot (view|download|read)/;
  const matrix = {};
  for (const [label, t] of Object.entries(T)) {
    const stats = { allowed: 0, denied: 0, fail: [] };
    for (const where of t.projects ? ['A', 'B'] : ['A']) {
      const F = where === 'A' ? FA : FB;
      for (const [key, pol] of Object.entries(ROUTE_POLICIES)) {
        if (pol.level === 'public') continue;
        const [method, pattern] = key.split(' ');
        const path = pattern.replace(/:([a-z]+)/g, (_, p) => encodeURIComponent(pol.params?.[p] ? ids(F, pol.params[p]) : OTHER[p] ?? 'local'));
        const body = Object.fromEntries(Object.entries(pol.body ?? {}).map(([k, kind]) => [k, ids(F, kind)]));
        const want = expected(t, key, pol, where);
        if (want === 'allow') {
          // Allowed requests are only sent where they change nothing.
          if (method !== 'GET') continue;
          const r = await req(t.token, method, path);
          const refusedByScope = r.status === 401 || r.status === 404 || (r.status === 403 && !SECRET_GATES.test(r.error));
          if (refusedByScope || r.status === 0) stats.fail.push(`${where} ${key}: want allowed, got ${r.status}`);
          else stats.allowed++;
        } else {
          const r = await req(t.token, method, path, body);
          if (r.status !== want) stats.fail.push(`${where} ${key}: want ${want}, got ${r.status}`);
          else stats.denied++;
        }
      }
    }
    matrix[label] = stats;
    check(`REST ${label}: ${stats.denied} refusals and ${stats.allowed} allowed reads as the policy says`, stats.fail.length === 0, stats.fail.slice(0, 12).join(' | '));
  }

  // Hand-picked allowed actions and the cross-project escapes.
  console.log('\n▸ scoped tokens: allowed actions, secrets and cross-project paths');
  const call = (label, method, path, body) => req(T[label].token, method, path, body);
  const jcall = async (label, method, path, body) => {
    const res = await fetch(BASE + '/api' + path, { method, headers: { authorization: `Bearer ${T[label].token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const projList = (await jcall('write[A]', 'GET', '/projects')).json;
  check('a project-limited token lists only its projects', Array.isArray(projList) && projList.some((p) => p.id === A.id) && !projList.some((p) => p.id === B.id));
  const allList = (await jcall('read', 'GET', '/projects')).json;
  check('a token for all projects still lists every project', allList.some((p) => p.id === A.id) && allList.some((p) => p.id === B.id));

  const d1 = await jcall('deploy[A]', 'POST', `/services/${FA.web.id}/deploy`, {});
  const masked = d1.json?.config?.env && Object.values(d1.json.config.env).every((v) => v === '••••••••');
  check('deploy token: deploys a service in reach, and the reply masks every variable', d1.status === 200 && masked && !JSON.stringify(d1.json).includes(canary), `${d1.status}`);
  await waitFor(async () => !['queued', 'building', 'deploying'].includes((await api('GET', `/deployments/${d1.json.id}`)).status), 180_000, 'deploy');
  const r1 = await jcall('deploy[A]', 'POST', `/services/${FA.web.id}/restart`, {});
  check('deploy token: restarts', r1.status === 200 && !JSON.stringify(r1.json).includes(canary), `${r1.status}`);
  await waitFor(async () => !['queued', 'building', 'deploying'].includes((await api('GET', `/deployments/${r1.json.id}`)).status), 180_000, 'restart');
  const rb = await jcall('deploy[A]', 'POST', `/services/${FA.web.id}/rollback`, { deploymentId: FA.prevDep.id });
  check('deploy token: rolls back', rb.status === 200 && !JSON.stringify(rb.json).includes(canary), `${rb.status} ${rb.json?.error ?? ''}`);
  await waitFor(async () => !['queued', 'building', 'deploying'].includes((await api('GET', `/deployments/${rb.json.id}`)).status), 180_000, 'rollback');
  const ui = await jcall('deploy[A]', 'POST', `/services/${FA.web.id}/update-image`, { tag: 'latest', skipSafetyBackup: false });
  check('deploy token: switches an image service to a tag and deploys it (the CI path)', ui.status === 202 && !JSON.stringify(ui.json).includes(canary), `${ui.status} ${ui.json?.error ?? ''}`);
  if (ui.json?.id) await waitFor(async () => !['queued', 'building', 'deploying'].includes((await api('GET', `/deployments/${ui.json.id}`)).status), 180_000, 'image update');
  check('deploy token: may not skip the safety backup', (await call('deploy[A]', 'POST', `/services/${FA.web.id}/deploy`, { skipSafetyBackup: true })).status === 403);
  check('deploy token: reads logs and status', (await call('deploy[A]', 'GET', `/services/${FA.web.id}/logs?tail=5`)).status === 200 && (await call('deploy[A]', 'GET', `/deployments/${FA.dep.id}`)).status === 200);
  const deployNo = await Promise.all([
    call('deploy[A]', 'PATCH', `/services/${FA.web.id}`, { replicas: 1 }),
    call('deploy[A]', 'PUT', `/services/${FA.web.id}/variables`, { variables: { X: '1' } }),
    call('deploy[A]', 'DELETE', `/services/${FA.web.id}`),
    call('deploy[A]', 'POST', `/projects/${A.id}/volumes`, { name: 'nope' }),
    call('deploy[A]', 'GET', `/services/${FA.web.id}/variables/resolved`),
  ]);
  check('deploy token: no config, variables, volumes, deletes or secrets', deployNo.every((r) => r.status === 403), deployNo.map((r) => r.status).join(' '));
  const exp = await jcall('deploy[A]', 'GET', `/projects/${A.id}/export?secrets=1`);
  check('deploy token: an export keeps secrets blank', exp.status === 200 && !JSON.stringify(exp.json).includes(canary), `${exp.status}`);
  const snap = await jcall('deploy', 'GET', `/projects/${A.id}`);
  check('deploy token: secret variables and deployment variables are masked in snapshots', snap.status === 200 && !JSON.stringify(snap.json).includes(canary), `${snap.status}`);

  // servify up: a deploy token may upload to a service whose source already is an upload.
  const up = (await api('POST', `/projects/${A.id}/services`, { name: 'up', upload: true, deploy: false })).service;
  const { tarEntry, tarEnd } = await import(new URL('../server/src/tar.ts', import.meta.url).href);
  const tgz = (await import('node:zlib')).gzipSync(Buffer.concat([...tarEntry('index.html', Buffer.from('hi')), tarEnd()]));
  const upload = (label, sid) => fetch(`${BASE}/api/services/${sid}/upload?deploy=0`, { method: 'POST', headers: { authorization: `Bearer ${T[label].token}`, 'content-type': 'application/gzip' }, body: tgz }).then((r) => r.status);
  check('servify up: a deploy token uploads to an upload service in reach', (await upload('deploy[A]', up.id)) === 201);
  check('servify up: …but not onto an image service (that would replace its source)', (await upload('deploy[A]', FA.web.id)) === 403);
  check('servify up: …nor to another project, nor with a read token', (await upload('deploy[A]', FB.web.id)) === 404 && (await upload('read', up.id)) === 403);

  // Cross-project paths with a write token limited to A.
  const cross = {
    'move a service to another project': await call('write[A]', 'POST', `/services/${FA.web.id}/move-project`, { project: B.id }),
    'move it there by slug': await call('write[A]', 'POST', `/services/${FA.web.id}/move-project`, { project: B.slug }),
    'attach its volume to a service there': await call('write[A]', 'POST', `/volumes/${FA.spare.id}/attach`, { serviceId: FB.web.id, mountPath: '/x' }),
    'share its volume with a service there': await call('write[A]', 'POST', `/volumes/${FA.spare.id}/share`, { serviceId: FB.web.id, mountPath: '/x' }),
    'create a volume for a service there': await call('write[A]', 'POST', `/projects/${A.id}/volumes`, { name: 'x', serviceId: FB.web.id }),
    'watch its events': await call('write[A]', 'GET', `/events?project=${B.id}`),
    'roll back to its deployment': await call('write[A]', 'POST', `/services/${FA.web.id}/rollback`, { deploymentId: FB.dep.id }),
  };
  for (const [what, r] of Object.entries(cross)) check(`a token limited to A cannot ${what}`, r.status === 404, `${r.status}`);
  // References by name, URL-encoded as clients send them: "project/service" across projects, and a bare name that exists in both.
  const byName = await Promise.all([call('write[A]', 'GET', `/services/${encodeURIComponent(`${B.slug}/web`)}`), call('write[A]', 'GET', `/services/${encodeURIComponent(`${A.slug}/web`)}`), call('write[A]', 'GET', '/services/web'), call('write[A]', 'GET', '/services/%E0%A4%A')]);
  check('names: another project’s "project/service" and an ambiguous bare name read as not found, its own works', byName[0].status === 404 && byName[1].status === 200 && byName[2].status === 404 && byName[2].error === byName[0].error.replace(`${B.slug}/web`, 'web') && byName[3].status === 400, byName.map((r) => r.status).join(' '));
  check('a token limited to A cannot create projects, import or import compose', (await Promise.all([call('write[A]', 'POST', '/projects', { name: 'x' }), call('write[A]', 'POST', '/projects/import', { spec: { servify: 1, name: 'x', services: [] } }), call('write[A]', 'POST', '/projects/import-compose', { yaml: 'services: {}', dryRun: true })])).every((r) => r.status === 403));
  // Shared variables: references only ever resolve within the project (and its base project).
  await api('PATCH', `/projects/${B.id}`, { variables: { SECRET: canary }, secretKeys: ['SECRET'] });
  const setv = await call('write[A]', 'PUT', `/services/${FA.web.id}/variables`, { variables: { LEAK_SHARED: '${{ shared.SECRET }}', LEAK_SVC: `\${{ ${B.slug}.API_SECRET }}` } });
  const resolved = await jcall('write[A]', 'GET', `/services/${FA.web.id}/variables/resolved`);
  check("another project's shared variables and services can't be referenced", setv.status === 200 && resolved.status === 200 && resolved.json.env?.LEAK_SHARED === '' && resolved.json.env?.LEAK_SVC === '', `${setv.status} ${resolved.status}`);
  check("…and no value of another project's shows up", !Object.entries(resolved.json.env ?? {}).some(([k, v]) => k.startsWith('LEAK') && v.includes(canary)));
  await api('DELETE', `/services/${FA.web.id}/variables/LEAK_SHARED`);
  await api('DELETE', `/services/${FA.web.id}/variables/LEAK_SVC`);
  // Environments: made by a write token limited to A, they are A's — in reach; a token can't list one directly.
  const env = await jcall('write[A]', 'POST', `/projects/${A.id}/environments`, { name: 'staging', deploy: false });
  check('a token limited to A creates an environment of A, and reaches it', env.status === 201 && (await call('write[A]', 'GET', `/projects/${env.json.id}`)).status === 200 && (await jcall('write[A]', 'GET', '/projects')).json.some((p) => p.id === env.json.id), `${env.status}`);
  const envTok = await fetch(`${BASE}/api/tokens`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: COOKIE }, body: JSON.stringify({ name: 'x', projects: [env.json.id] }) });
  check('a token cannot be limited to an environment (its base project is picked instead)', envTok.status === 400, `${envTok.status}`);
  check('activity: a token limited to A sees A only', (await jcall('write[A]', 'GET', '/activity?limit=200')).json.every((a) => a.projectId && [A.id, env.json.id].includes(a.projectId)));

  // Owner-only stays owner-only for every token, with the messages it always had.
  const own = await Promise.all([call('write', 'GET', '/tokens'), call('write', 'POST', '/servers', { name: 'x' }), call('write', 'PATCH', '/settings/general', {}), call('write', 'GET', '/settings/notifications/deliveries'), call('read', 'POST', '/tokens', {})]);
  check('owner-only routes: refused for every token, same messages as before', own.every((r) => r.status === 403) && own[0].error === 'only the owner can manage tokens' && /^Managing servers can only be set by the owner/.test(own[1].error) && own[2].error === 'only the owner can change instance settings' && own[4].error === 'this token is read-only', own.map((r) => `${r.status}`).join(' '));
  check('a read-only token still gets "this token is read-only" for any change', (await call('read', 'POST', `/services/${FA.web.id}/deploy`, {})).error === 'this token is read-only');

  // ─── traffic and access log ───
  const host = (svc) => new URL(svc.url).hostname;
  const webA = await api('GET', `/services/${FA.web.id}`);
  const webB = await api('GET', `/services/${FB.web.id}`);
  for (let i = 0; i < 3; i++) {
    await hit(host(webA), '/tok-a');
    await hit(host(webB), '/tok-b');
  }
  await sleep(2500);
  const recent = (await jcall('deploy[A]', 'GET', '/access-log/recent?limit=200')).json;
  const totals = (await jcall('deploy[A]', 'GET', '/access-log/totals')).json;
  check('traffic board: a token limited to A sees requests of A only', recent.entries?.some((e) => e.serviceId === FA.web.id) && !recent.entries.some((e) => e.serviceId === FB.web.id) && !(FB.web.id in (totals.services ?? {})), `${recent.entries?.length}`);
  check('access log of B: not found for a token limited to A', (await call('deploy[A]', 'GET', `/services/${FB.web.id}/access-log`)).status === 404);

  // ─── streams ───
  console.log('\n▸ scoped tokens: event and log streams');
  const listen = (tok, path, ms) =>
    new Promise((resolveP) => {
      const chunks = [];
      const ctrl = new AbortController();
      fetch(BASE + '/api' + path, { headers: { authorization: `Bearer ${tok}`, accept: 'text/event-stream' }, signal: ctrl.signal })
        .then(async (res) => {
          if (!res.ok) return resolveP({ status: res.status, text: '' });
          setTimeout(() => ctrl.abort(), ms);
          const dec = new TextDecoder();
          try {
            for await (const c of res.body) chunks.push(dec.decode(c, { stream: true }));
          } catch {}
          resolveP({ status: res.status, text: chunks.join('') });
        })
        .catch(() => resolveP({ status: 0, text: chunks.join('') }));
    });
  const scopedStream = listen(T['deploy[A]'].token, '/events', 9000);
  const openStream = listen(T.read.token, '/events', 9000);
  await sleep(1500);
  await api('PATCH', `/projects/${A.id}`, { color: '#7ce0c3' });
  await api('PATCH', `/projects/${B.id}`, { color: '#7ce0c3' });
  await api('POST', `/services/${FB.web.id}/restart`, {});
  await api('POST', `/services/${FA.web.id}/restart`, {});
  for (let i = 0; i < 3; i++) {
    await hit(host(webA), '/tok-a2');
    await hit(host(webB), '/tok-b2');
  }
  const [ss, os] = await Promise.all([scopedStream, openStream]);
  const sawA = ss.text.includes(A.id) && ss.text.includes(FA.web.id);
  const leakB = [B.id, FB.web.id, FB.spare.id, FB.backup.id].some((x) => ss.text.includes(x));
  check('events: a token limited to A gets its project’s events…', ss.status === 200 && sawA, `${ss.status} ${ss.text.length}`);
  check('…and never one of another project (project, service, deployment, traffic, activity)', !leakB);
  check('events: a token for all projects still gets both', os.text.includes(A.id) && os.text.includes(B.id));
  check('events: only the event types the stream had, plus nothing instance-wide for a limited token', !/"type":"(settings|cert)\./.test(ss.text));
  const logsA = await listen(T['deploy[A]'].token, `/services/${FA.web.id}/logs/stream?tail=5`, 1500);
  const logsB = await listen(T['deploy[A]'].token, `/services/${FB.web.id}/logs/stream?tail=5`, 1500);
  const depB = await listen(T['deploy[A]'].token, `/deployments/${FB.dep.id}/logs/stream`, 1500);
  check('log streams: its own service streams, another project’s is not found', logsA.status === 200 && logsA.text.includes('event: backlog') && logsB.status === 404 && depB.status === 404, `${logsA.status} ${logsB.status} ${depB.status}`);

  // ─── MCP ───
  console.log('\n▸ scoped tokens: MCP, tool by scope');
  const mcp = async (tok, name, args) => {
    const r = await fetch(BASE + '/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const j = await r.json().catch(() => ({}));
    const text = j.result?.content?.[0]?.text ?? j.error?.message ?? '';
    return { status: r.status, error: j.result?.isError || j.error ? text : null, text };
  };
  const toolArgs = (F, name, pol) => {
    const a = {};
    for (const [k, kind] of Object.entries(pol.params ?? {})) a[k] = kind === 'backup' ? F.backup.id : ids(F, kind);
    const extra = {
      scale_service: { replicas: 1 }, set_variables: { variables: {} }, delete_variable: { key: 'PLAIN' }, exec_command: { command: 'true' }, rollback_service: { deploymentId: F.prevDep.id },
      create_environment: { name: 'x' }, set_previews: { enabled: false }, create_volume: { name: 'x' }, attach_volume: { mount_path: '/x' }, share_volume: { mount_path: '/x' }, unmount: { mount_path: '/x' },
      move_service: { server: 'local' }, move_service_to_project: { dry_run: true }, import_project: { spec: { servify: 1, name: 'x', services: [] } }, import_compose: { yaml: 'services: {}', dry_run: true }, create_project: { name: 'x' }, wait_for_deployment: { timeoutSec: 1 },
    }[name];
    return { ...a, ...(extra ?? {}) };
  };
  const toolWant = (t, pol, where) => {
    if (pol.level === 'owner') return /only the owner/;
    if (RANK[t.scope] < RANK[pol.level]) return t.scope === 'read' ? /read-only/ : /can only deploy/;
    if (t.projects) {
      if (!Object.keys(pol.params ?? {}).length && !pol.filtered) return /limited to some projects/;
      if (where === 'B' && Object.keys(pol.params ?? {}).length) return /not found/;
    }
    return 'allow';
  };
  const READ_TOOLS = new Set(Object.entries(TOOL_POLICIES).filter(([, p]) => p.level === 'read').map(([n]) => n));
  for (const [label, t] of Object.entries(T)) {
    const stats = { allowed: 0, denied: 0, fail: [] };
    for (const where of t.projects ? ['A', 'B'] : ['A']) {
      const F = where === 'A' ? FA : FB;
      for (const [name, pol] of Object.entries(TOOL_POLICIES)) {
        const want = toolWant(t, pol, where);
        if (want === 'allow' && !READ_TOOLS.has(name)) continue; // allowed changes: hand-picked below
        const r = await mcp(t.token, name, toolArgs(F, name, pol));
        if (want === 'allow') {
          if (r.error && /read-only|can only deploy|not found|limited to some|only the owner|Invalid/i.test(r.error)) stats.fail.push(`${where} ${name}: want allowed, got an error`);
          else stats.allowed++;
        } else if (!r.error || !want.test(r.error)) stats.fail.push(`${where} ${name}: want ${want}, got ${r.error ? 'another error' : 'success'}`);
        else stats.denied++;
      }
    }
    check(`MCP ${label}: ${stats.denied} refusals and ${stats.allowed} allowed reads as the policy says`, stats.fail.length === 0, stats.fail.slice(0, 12).join(' | '));
  }
  const ov = await mcp(T['write[A]'].token, 'overview', {});
  check('MCP overview: a token limited to A lists A (and its environment) only', !ov.error && ov.text.includes(A.id) && !ov.text.includes(B.id));
  const act = await mcp(T['deploy[A]'].token, 'get_activity', { limit: 200 });
  check('MCP get_activity: nothing of another project', !act.error && !act.text.includes(B.name));
  const md = await mcp(T['deploy[A]'].token, 'deploy_service', { service: FA.web.id });
  check('MCP deploy_service with a deploy token: deploys, variables masked', !md.error && !md.text.includes(canary), md.error ?? '');
  const mdB = await mcp(T['deploy[A]'].token, 'deploy_service', { service: `${B.slug}/web` });
  check('MCP deploy_service on another project: not found', /not found/.test(mdB.error ?? ''));
  const mskip = await mcp(T['deploy[A]'].token, 'restart_service', { service: FA.web.id, skipSafetyBackup: true });
  check('MCP: deploy tokens cannot skip the safety backup', /safety backup/.test(mskip.error ?? ''));
  const mlogs = await mcp(T['deploy[A]'].token, 'get_service_logs', { service: `${B.slug}/web` });
  check('MCP logs of another project: not found', /not found/.test(mlogs.error ?? ''));
  const mui = await mcp(T['deploy[A]'].token, 'update_image', { service: FA.web.id, tag: 'latest' });
  check('MCP update_image with a deploy token', !mui.error && !mui.text.includes(canary), mui.error ?? '');
  const mset = await mcp(T['write[A]'].token, 'set_variables', { service: FA.web.id, variables: { FROM_MCP: '1' } });
  check('MCP set_variables with a write token limited to A, in A', !mset.error, mset.error ?? '');
  await sleep(2000);

  // ─── deploy hooks ───
  console.log('\n▸ scoped tokens: deploy hooks, CLI, tokens from before scopes');
  const hook = await api('GET', `/services/${FA.web.id}/deploy-hook`);
  const hookRes = await fetch(`${BASE}/api/hooks/deploy/${hook.path.split('/').slice(-2).join('/')}`, { method: 'POST' });
  check('deploy hooks keep working', hookRes.status < 300, `${hookRes.status}`);
  check('a deploy token cannot read deploy hook URLs (they are secrets)', (await call('deploy[A]', 'GET', `/services/${FA.web.id}/deploy-hook`)).status === 403);

  if (DATA) {
    const cliToken = (args) => {
      try {
        const out = execSync(`node --disable-warning=ExperimentalWarning server/bin/servify.mjs token ${args}`, { env: { ...process.env, SERVIFY_DATA_DIR: DATA }, stdio: 'pipe' }).toString();
        return { code: 0, token: out.match(/sv[fs]_[A-Za-z0-9_-]+/)?.[0], out: out.replace(/sv[fs]_[A-Za-z0-9_-]+/g, 'svf_…') };
      } catch (e) {
        return { code: e.status ?? 1, token: null, out: String(e.stderr ?? '') };
      }
    };
    const c1 = cliToken(`acc-cli-ci --scope deploy --project ${A.slug}`);
    const c1rec = (await api('GET', '/tokens')).find((t) => t.name === 'acc-cli-ci');
    check('servify token --scope deploy --project: a deploy token limited to that project', c1.code === 0 && c1rec?.scope === 'deploy' && JSON.stringify(c1rec?.projects) === JSON.stringify([A.id]), c1.out);
    check('…which deploys there and nowhere else', (await req(c1.token, 'POST', `/services/${FA.web.id}/image-check`)).status !== 403 && (await req(c1.token, 'GET', `/projects/${B.id}`)).status === 404);
    // `servify deploy --tag` with that token, as CI runs it.
    const cliHome = mkdtempSync(join(tmpdir(), 'servify-cli-'));
    const deployCli = (svc, extra = '') => {
      try {
        const out = execSync(`node --disable-warning=ExperimentalWarning server/bin/servify.mjs deploy ${extra}`, { env: { ...process.env, SERVIFY_CLI_HOME: cliHome, SERVIFY_URL: BASE, SERVIFY_TOKEN: c1.token, SERVIFY_PROJECT: A.slug, SERVIFY_SERVICE: svc }, stdio: 'pipe', timeout: 300_000 }).toString();
        return { code: 0, out };
      } catch (e) {
        return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
      }
    };
    const dt = deployCli('web', '--tag latest');
    check('servify deploy --tag with a deploy token: switches the tag, follows the build, exits 0', dt.code === 0 && /Deployed/.test(dt.out), `exit ${dt.code}`);
    const du = deployCli('up', '--tag latest');
    check('servify deploy --tag on a service without a registry image: a clear refusal', du.code === 1 && /doesn't run a registry image/.test(du.out), `exit ${du.code}`);
    const dB = (() => {
      try {
        execSync(`node --disable-warning=ExperimentalWarning server/bin/servify.mjs deploy`, { env: { ...process.env, SERVIFY_CLI_HOME: cliHome, SERVIFY_URL: BASE, SERVIFY_TOKEN: c1.token, SERVIFY_PROJECT: B.slug, SERVIFY_SERVICE: 'web' }, stdio: 'pipe' });
        return 0;
      } catch (e) {
        return e.status ?? 1;
      }
    })();
    check('servify deploy into another project with that token fails', dB === 1);
    rmSync(cliHome, { recursive: true, force: true });
    const c2 = cliToken('acc-cli-ro --read');
    check('servify token --read still makes a read-only token for all projects', c2.code === 0 && (await api('GET', '/tokens')).find((t) => t.name === 'acc-cli-ro')?.scope === 'read' && !('projects' in (await api('GET', '/tokens')).find((t) => t.name === 'acc-cli-ro')));
    check('servify token: bad scopes, environments and unknown projects are refused', cliToken('x --scope admin').code === 1 && cliToken(`x --project ${env.json.slug}`).code === 1 && cliToken('x --project no-such-project').code === 1 && cliToken('--scope deploy').code === 0);

    // A token record exactly as 0.2.3 wrote it (and older ones, without `kind`): full access, every project.
    const { DatabaseSync } = await import('node:sqlite');
    const sdb = new DatabaseSync(join(DATA, 'servify.db'));
    sdb.exec('PRAGMA busy_timeout = 3000');
    const legacyRaw = `svf_${randomBytes(24).toString('base64url')}`;
    const legacy = { id: `tok_legacy${randomBytes(4).toString('hex')}`, name: 'acc-legacy', prefix: legacyRaw.slice(0, 10), scope: 'write', createdAt: Date.now(), lastUsedAt: null };
    sdb.prepare('INSERT INTO tokens (id, hash, data, created_at) VALUES (?, ?, ?, ?)').run(legacy.id, createHash('sha256').update(legacyRaw).digest('hex'), JSON.stringify(legacy), legacy.createdAt);
    const lr = await Promise.all([req(legacyRaw, 'GET', `/projects/${B.id}`), req(legacyRaw, 'GET', '/overview'), req(legacyRaw, 'GET', '/system'), req(legacyRaw, 'POST', `/services/${FB.web.id}/image-check`), req(legacyRaw, 'GET', '/tokens')]);
    const lp = await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { authorization: `Bearer ${legacyRaw}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'legacy-made' }) }).then((r) => r.json().then((j) => ({ status: r.status, j })));
    if (lp.j?.id) projectsToDelete.push(lp.j.id);
    const lm = await mcp(legacyRaw, 'overview', {});
    check('a token record from before scopes: still full access to every project, as before', lr[0].status === 200 && lr[1].status === 200 && lr[2].status === 200 && lr[3].status !== 403 && lp.status === 201 && !lm.error && lm.text.includes(B.id), lr.map((r) => r.status).join(' ') + ` ${lp.status}`);
    check('…and still not the owner', lr[4].status === 403);
    const stored = JSON.parse(sdb.prepare('SELECT data FROM tokens WHERE id = ?').get(legacy.id).data);
    check('…and its record is left as it was (nothing to migrate)', !('projects' in stored) && stored.scope === 'write' && !('kind' in stored));
    sdb.prepare('DELETE FROM tokens WHERE id = ?').run(legacy.id);
    sdb.close();
  } else console.log('  – skipped CLI and pre-scopes token checks (set SERVIFY_DATA_DIR)');

  // Revoke what this section made.
  for (const t of (await api('GET', '/tokens')).filter((t) => !tokensBefore.has(t.id))) await api('DELETE', `/tokens/${t.id}`);
}

/**
 * Low disk space protection, entered and left through the instance settings (a protection line above the real free
 * space): what is paused (and the live log tail that isn't), what is refused, what never is (deletes, restarts, S3
 * backups, restores that fit), one notification each way, and the automatic resume.
 */
async function diskChecks() {
  console.log('\n▸ low disk space protection');
  // A project of its own (service names like "vault" are taken in the shared one by the full run).
  const P = await api('POST', '/projects', { name: `disk-${Date.now().toString(36)}` });
  projectsToDelete.push(P.id);
  const state = async () => (await api('GET', '/system')).disk;
  const before = (await api('GET', '/settings')).disk;
  const s0 = await state();
  check('the data disk and Docker’s disk are watched, with the default lines', !!s0 && s0.disks.some((d) => d.roles.includes('data') && d.freeBytes > 0) && s0.disks.some((d) => d.roles.includes('docker') && d.freeBytes > 0) && s0.thresholds.protectGb === 3 && s0.thresholds.warnGb === 10 && s0.thresholds.protectPct === 5 && s0.thresholds.warnPct === 10, JSON.stringify(s0?.thresholds));
  if (s0?.level !== 'ok') return console.log(`  – skipped: a disk is really low (${s0?.level}) — free space first`);
  const restoreLines = async () => {
    await api('PATCH', '/settings/disk', before).catch(() => {});
    await waitFor(async () => (await state()).level === 'ok', 20_000, 'disk state back to ok');
  };
  cleanups.push(restoreLines);
  check('disk thresholds are validated', (await api('PATCH', '/settings/disk', { protectPct: 99 }).then(() => 'ok', (e) => String(e.message))).includes('→ 400'));

  const notes = [];
  const sink = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try {
        notes.push(JSON.parse(b));
      } catch {}
      res.end('ok');
    });
  });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  cleanups.push(async () => sink.close());
  const ch = await api('POST', '/settings/notifications/channels', { name: 'acc-disk', type: 'webhook', url: `http://127.0.0.1:${sink.address().port}/hook`, events: ['server.usage'] });
  cleanups.push(() => api('DELETE', `/settings/notifications/channels/${ch.id}`).catch(() => {}));
  const usage = (from) => notes.slice(from).filter((n) => n.event === 'server.usage');

  // MinIO for an S3 destination (credentials generated, never printed).
  const MINIO = 'servify-acc-minio-disk';
  const user = `acc${randomBytes(5).toString('hex')}`;
  const pass = randomBytes(20).toString('hex');
  const dockerEnv = { ...process.env, MINIO_ROOT_USER: user, MINIO_ROOT_PASSWORD: pass, MC_HOST_acc: `http://${user}:${pass}@127.0.0.1:9000` };
  execSync(`docker rm -f -v ${MINIO}`, { stdio: 'ignore' });
  execSync(`docker run -d --name ${MINIO} --log-driver none -e MINIO_ROOT_USER -e MINIO_ROOT_PASSWORD -p 127.0.0.1::9000 minio/minio:latest server /data`, { env: dockerEnv, stdio: 'ignore' });
  cleanups.push(async () => execSync(`docker rm -f -v ${MINIO}`, { stdio: 'ignore' }));
  const minioPort = Number(execSync(`docker port ${MINIO} 9000/tcp`).toString().trim().split(':').pop());
  const mc = (args) => execSync(`docker exec -e MC_HOST_acc ${MINIO} mc ${args}`, { env: dockerEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  await waitFor(async () => (mc('ready acc'), true), 30_000, 'minio');
  mc('mb -p acc/servify-acc');
  const s3 = await api('POST', '/settings/backups/destinations', { name: 'acc-disk-minio', type: 's3', endpoint: `http://127.0.0.1:${minioPort}`, region: 'us-east-1', bucket: 'servify-acc', prefix: 'disk', accessKeyId: user, secretAccessKey: pass, forcePathStyle: true });
  cleanups.push(() => api('DELETE', `/settings/backups/destinations/${s3.id}`).catch(() => {}));

  // ── Fixtures, made while there is room.
  const app = `let n=0;setInterval(()=>console.log('tick '+(n++)),250);require('http').createServer((q,s)=>s.end('ok')).listen(3000)`;
  const talker = (await api('POST', `/projects/${P.id}/services`, { name: 'talker', image: 'node:22-alpine', port: 3000, startCommand: `node -e "${app}"` })).service;
  const vault = (await api('POST', `/projects/${P.id}/services`, { image: 'alpine:3.20', name: 'vault', protocol: 'none', startCommand: 'sleep 1d' })).service;
  await running(P.id, 'talker');
  await running(P.id, 'vault');
  const vv = await api('POST', `/projects/${P.id}/volumes`, { name: 'vault-data', serviceId: vault.id, mountPath: '/data' });
  await waitFor(async () => {
    const s = await api('GET', `/services/${vault.id}`);
    return s.status === 'running' && (!vv.deployment || s.activeDeploymentId === vv.deployment.id);
  }, 120_000, 'vault with a volume');
  await exec(vault.id, 'echo original > /data/file');
  const localBak = await api('POST', `/services/${vault.id}/backups`, {});
  const s3Bak = await api('POST', `/services/${vault.id}/backups`, { destinationId: s3.id });
  check('fixtures: a folder and an S3 backup taken while there is room', localBak.status === 'succeeded' && s3Bak.status === 'succeeded', `${localBak.status} ${s3Bak.status}`);
  await exec(vault.id, 'echo changed > /data/file');
  const dir = mkdtempSync(join(tmpdir(), 'servify-acc-disk-'));
  cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'Dockerfile'), 'FROM alpine:3.20\nCMD ["sleep", "1d"]\n');
  const built = (await api('POST', `/projects/${P.id}/services`, { name: 'built', path: dir, protocol: 'none', deploy: false })).service;
  const pulled = (await api('POST', `/projects/${P.id}/services`, { name: 'pulled', image: 'traefik/whoami:latest', deploy: false })).service;
  const spare = await api('POST', `/projects/${P.id}/volumes`, { name: 'spare' });
  const thost = new URL((await api('GET', `/services/${talker.id}`)).url).hostname;
  await waitFor(async () => (await hit(thost)).status === 200, 30_000, 'talker serving');
  let sdb = null;
  if (DATA) {
    const { DatabaseSync } = await import('node:sqlite');
    sdb = new DatabaseSync(join(DATA, 'servify.db'));
    cleanups.push(async () => sdb.close());
  }
  const rows = (table, col, since) => Number(sdb.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE service_id = ? AND ${col} >= ?`).get(talker.id, since).n);

  // A build checkout a crash left behind: the automatic clean-up removes it.
  const stale = DATA ? join(DATA, 'builds', `dep_accdisk${randomBytes(4).toString('hex')}`) : null;
  if (stale) {
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'junk.bin'), randomBytes(2 * 1024 * 1024));
  }

  // ── Enter protect mode: a protection line far above the real free space.
  const seen = notes.length;
  const tEnter = Date.now();
  await api('PATCH', '/settings/disk', { protectGb: 100000 });
  const s1 = await waitFor(async () => {
    const s = await state();
    return s.level === 'protect' && s.disks.filter((d) => d.freeBytes != null).every((d) => d.level === 'protect') && s;
  }, 20_000, 'protect mode');
  check('protect mode entered once free space is below the protection line (data and Docker disk)', !!s1, JSON.stringify((await state()).disks.map((d) => [d.id, d.level])));
  check('the state says what is paused, what is refused and how to free space', !!s1 && s1.paused.some((p) => /logs/.test(p)) && s1.refused.some((r) => /builds/.test(r)) && s1.refused.some((r) => /pulls/.test(r)) && /delet/.test(s1.howToFree ?? ''), JSON.stringify(s1 && { paused: s1.paused, refused: s1.refused }));
  check('…in /overview too', (await api('GET', '/overview')).disk?.level === 'protect');
  const mres = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(COOKIE ? { cookie: COOKIE } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'overview', arguments: {} } }) }).then((r) => r.json()).catch(() => ({}));
  const mtext = (mres.result?.content ?? []).map((c) => c.text);
  check('MCP overview: the project list as before, then a low-disk note', mtext.length === 2 && mtext[0].includes(P.id) && /LOW DISK SPACE \(protect\)/.test(mtext[1]) && !mtext[1].includes(DATA ?? '\0'), mtext[1]?.slice(0, 160));
  const cleaned = await waitFor(async () => (await state()).lastCleanup?.at >= tEnter && (await state()).lastCleanup, 20_000, 'automatic clean-up');
  check('the safe clean-ups ran once on entering protect mode', !!cleaned && (!stale || (!existsSync(stale) && cleaned.steps.some((x) => /leftover build checkouts/.test(x)))), JSON.stringify(cleaned));
  const enterNote = await waitFor(() => usage(seen).find((n) => n.level === 'error'), 15_000, 'protect notification');
  check('entering protect mode is notified (server.usage)', /low disk space/i.test(enterNote?.title ?? '') && /free/.test(enterNote?.message ?? ''), enterNote?.title);
  await sleep(4000);
  check('…once, for both disks', usage(seen).length === 1, JSON.stringify(usage(seen).map((n) => n.title)));

  // ── Persistence paused, the live tail kept.
  const sk0 = (await state()).skipped;
  for (let i = 0; i < 6; i++) await hit(thost, `/disk-${i}`);
  const sk = await waitFor(async () => {
    const k = (await state()).skipped;
    return k && k.logLines > sk0.logLines && k.metricRows > sk0.metricRows && k.accessRows >= sk0.accessRows + 6 && k;
  }, 25_000, 'skipped counters');
  check('log lines, metric samples and access-log rows are not stored (counted as skipped)', !!sk, JSON.stringify((await state()).skipped));
  const tail = await api('GET', `/services/${talker.id}/logs?since=${tEnter + 1500}&tail=50`);
  check('the live log tail still shows new lines (kept in memory)', tail.length > 3 && tail.every((l) => /tick/.test(l.text)), `${tail.length} lines`);
  const stream = await (async () => {
    const ac = new AbortController();
    const res = await fetch(`${BASE}/api/services/${talker.id}/logs/stream?tail=20`, { headers: COOKIE ? { cookie: COOKIE } : {}, signal: ac.signal });
    const reader = res.body.getReader();
    let text = '';
    const end = Date.now() + 6000;
    while (Date.now() < end && !/event: lines/.test(text)) {
      const r = await Promise.race([reader.read(), sleep(6000).then(() => ({ done: true }))]);
      if (r.done) break;
      text += Buffer.from(r.value).toString();
    }
    ac.abort();
    return text;
  })().catch((e) => String(e));
  check('…and the live stream too (backlog and new lines)', /event: backlog/.test(stream) && /event: lines/.test(stream) && /tick/.test(stream));
  const al = await api('GET', `/services/${talker.id}/access-log?since=${tEnter}&path=/disk-`);
  check('no access-log rows stored meanwhile', (al.entries ?? []).length === 0, JSON.stringify(al.entries?.length));
  if (sdb) {
    const t = tEnter + 1500;
    check('the database got no log, metric or access-log rows for it meanwhile', rows('logs', 'ts', t) === 0 && rows('metrics', 't', t + 10_000) === 0 && rows('access_log', 'ts', t) === 0, `${rows('logs', 'ts', t)} ${rows('metrics', 't', t + 10_000)} ${rows('access_log', 'ts', t)}`);
  }

  // ── Refused, with a clear message (which disk, how much is free, the line).
  const err = (p) => p.then(() => 'ok', (e) => String(e.message));
  const b1 = await err(api('POST', `/services/${built.id}/deploy`));
  check('a build is refused at once (507) with which disk, its free space and the line', /→ 507 Low disk space: the data disk \(.+\) has [\d.]+ [GM]B free, below its 100000 GB protection line — builds are refused/.test(b1), b1.slice(0, 220));
  const pd = await api('POST', `/services/${pulled.id}/deploy`);
  const pdone = await waitFor(async () => {
    const d = (await api('GET', `/services/${pulled.id}/deployments?limit=1`))[0];
    return d && ['failed', 'active'].includes(d.status) && d;
  }, 60_000, 'pull deploy');
  check('an image pull for a new deploy fails without downloading, saying why', pdone?.id === pd.id && pdone.status === 'failed' && /Low disk space: the Docker disk .*image pulls are refused/.test(pdone.error ?? ''), (pdone?.error ?? '').slice(0, 200));
  const fb = await err(api('POST', `/services/${vault.id}/backups`, {}));
  check('a backup to a folder on the data disk is refused (507)', /→ 507 Low disk space: the data disk .*backups to folders on this disk are refused/.test(fb), fb.slice(0, 200));
  const sb = await api('POST', `/services/${vault.id}/backups`, { destinationId: s3.id }).catch((e) => ({ status: String(e.message) }));
  check('…while a backup to S3 goes through (it streams, nothing lands here)', sb.status === 'succeeded', sb.status);
  const tr = await err(api('POST', `/backups/${s3Bak.id}/test`));
  check('a test restore is refused (it needs a scratch volume on the Docker disk)', /→ 507 Low disk space: the Docker disk .*test restores are refused/.test(tr), tr.slice(0, 200));
  if (sdb) {
    const raw = sdb.prepare('SELECT data FROM backups WHERE id = ?').get(localBak.id).data;
    const huge = JSON.parse(raw);
    huge.sizeBytes = 2 ** 50; // a petabyte: more than the whole disk
    sdb.prepare('UPDATE backups SET data = ? WHERE id = ?').run(JSON.stringify(huge), localBak.id);
    const big = await err(api('POST', `/backups/${localBak.id}/restore`));
    sdb.prepare('UPDATE backups SET data = ? WHERE id = ?').run(raw, localBak.id);
    check('a restore that clearly can’t fit is refused, nothing changed', /→ 507 restoring this .* backup needs at least .* can't fit; nothing was changed/.test(big) && (await exec(vault.id, 'cat /data/file')).output.trim() === 'changed', big.slice(0, 220));
  } else console.log('  – skipped the restore that doesn’t fit (set SERVIFY_DATA_DIR)');
  await api('POST', `/backups/${s3Bak.id}/restore`);
  await sleep(1500);
  await waitFor(async () => !(await api('GET', `/services/${vault.id}`)).restoring, 180_000, 'restore');
  await running(P.id, 'vault');
  const restored = (await exec(vault.id, 'cat /data/file').catch(() => ({ output: '' }))).output.trim();
  check('a restore that fits is allowed (from S3, its safety backup to S3 as well)', restored === 'original', restored);
  await exec(vault.id, 'echo changed-again > /data/file');
  await api('POST', `/backups/${localBak.id}/restore`);
  await sleep(1500);
  await waitFor(async () => !(await api('GET', `/services/${vault.id}`)).restoring, 180_000, 'folder restore');
  await running(P.id, 'vault');
  const restored2 = (await exec(vault.id, 'cat /data/file').catch(() => ({ output: '' }))).output.trim();
  const preRestore = (await api('GET', `/services/${vault.id}/backups`)).find((b) => b.trigger === 'pre-restore' && b.destinationId === 'local' && b.createdAt > tEnter);
  check('…and from a folder backup too (its safety backup is held to the room check, not refused)', restored2 === 'original' && preRestore?.status === 'succeeded', `${restored2} ${preRestore?.status}`);

  // ── Never refused: what frees space or keeps things running.
  const rs = await api('POST', `/services/${talker.id}/restart`);
  const rsd = await waitFor(async () => {
    const d = (await api('GET', `/services/${talker.id}/deployments?limit=1`))[0];
    return d?.id === rs.id && ['active', 'failed'].includes(d.status) && d;
  }, 90_000, 'restart');
  check('restarting an existing service still works', rsd?.status === 'active', rsd?.error ?? '');
  check('deleting a backup works', (await err(api('DELETE', `/backups/${sb.id}`))) === 'ok');
  // A volume with no recent backup: its safety backup can't go to the full data disk, so deleting it asks for the
  // explicit "without a safety backup" (as when a backup doesn't fit) — then it goes.
  const dv0 = await err(api('DELETE', `/volumes/${spare.volume?.id ?? spare.id}`));
  check('deleting a volume with no recent backup asks to skip its safety backup (it can’t land on the full disk)', /→ 409 .*Low disk space/.test(dv0), dv0.slice(0, 200));
  const dv = await err(api('DELETE', `/volumes/${spare.volume?.id ?? spare.id}?skipSafetyBackup=1`));
  check('…and with skipSafetyBackup, deleting the volume works', dv === 'ok', dv);
  check('stopping a service works', (await err(api('POST', `/services/${vault.id}/stop`))) === 'ok');
  check('deleting a service works', (await err(api('DELETE', `/services/${pulled.id}`))) === 'ok');

  // ── Hysteresis: between the lines, protection stays until the disk is above the warn line.
  await api('PATCH', '/settings/disk', { protectGb: 1, warnGb: 100000 });
  await sleep(3000);
  check('between the protection and the warn line it stays protected (no flapping)', (await state()).level === 'protect');

  // ── Resume.
  const seen2 = notes.length;
  const tResume = Date.now();
  await api('PATCH', '/settings/disk', { protectGb: before.protectGb, warnGb: before.warnGb });
  const s2 = await waitFor(async () => (await state()).level === 'ok' && (await state()), 20_000, 'resume');
  check('resumes on its own once the disk is back above the warn line', !!s2 && s2.paused.length === 0 && s2.refused.length === 0);
  const back = await waitFor(() => usage(seen2).find((n) => n.level === 'success'), 15_000, 'all-clear notification');
  check('the all-clear is notified', /protection lifted/.test(back?.title ?? ''), back?.title);
  await sleep(3000);
  check('…once', usage(seen2).length === 1, JSON.stringify(usage(seen2).map((n) => n.title)));
  if (sdb) {
    const ok = await waitFor(() => rows('logs', 'ts', tResume + 1000) > 0 && rows('metrics', 't', tResume + 10_000) > 0, 30_000, 'rows again');
    check('logs and metrics are stored again', !!ok);
    check('the lines kept in memory meanwhile were written too', rows('logs', 'ts', tEnter + 1500) - rows('logs', 'ts', tResume) > 3);
  }
  const bd = await api('POST', `/services/${built.id}/deploy`);
  const bdone = await waitFor(async () => {
    const d = (await api('GET', `/services/${built.id}/deployments?limit=1`))[0];
    return d?.id === bd.id && ['failed', 'active'].includes(d.status) && d;
  }, 180_000, 'build');
  check('builds work again', bdone?.status === 'active', bdone?.error ?? '');

  // ── Warn only: notified, nothing refused.
  const seen3 = notes.length;
  await api('PATCH', '/settings/disk', { warnGb: 100000 });
  const s3w = await waitFor(async () => (await state()).level === 'warn' && (await state()), 20_000, 'warn');
  check('below the warn line only: warned, nothing paused or refused', !!s3w && s3w.paused.length === 0 && s3w.refused.length === 0);
  const wn = await waitFor(() => usage(seen3).find((n) => n.level === 'error'), 15_000, 'warn notification');
  check('…and notified once', /getting low/.test(wn?.title ?? '') && usage(seen3).length === 1, wn?.title);
  await restoreLines();
}

/**
 * Scheduled jobs: catch-up of runs missed while Servify was down (once, within the window), skipped starts in the run
 * history, failure notifications de-duplicated (first failure, reminder, recovered) and kept across a restart, and a
 * missed scheduled backup caught up once.
 */
async function cronChecks(P) {
  console.log('\n▸ catch-up math (cron.ts)');
  const C = await import(new URL('../server/src/cron.ts', import.meta.url).href);
  const H = 3_600_000;
  const at = (s) => new Date(s);
  const tz = 'Europe/Berlin';
  const daily = C.parseCron('0 3 * * *');
  // Ran at 03:00 Berlin (02:00Z) on the 10th; Servify was down over the 11th's 03:00.
  const ran10 = { afterMs: at('2026-03-10T02:00:00Z').getTime(), lastFired: '2026-3-10 3:0' };
  let p = C.catchUpPlan(daily, tz, { ...ran10, now: at('2026-03-11T05:00:20Z') });
  check('a daily run missed by 3 h is caught up (once)', p.catchUp && p.missed === 1 && p.last === at('2026-03-11T02:00:00Z').getTime(), JSON.stringify(p));
  check('…its window is half a day', p.windowMs === 12 * H, String(p.windowMs));
  p = C.catchUpPlan(daily, tz, { ...ran10, now: at('2026-03-11T15:00:20Z') });
  check('missed by 13 h: outside the window, not caught up', !p.catchUp && p.missed === 1, JSON.stringify(p));
  p = C.catchUpPlan(daily, tz, { ...ran10, now: at('2026-03-10T05:00:00Z') });
  check('no catch-up for a run that did happen', !p.catchUp && p.missed === 0, JSON.stringify(p));
  const hourly = C.parseCron('0 * * * *');
  p = C.catchUpPlan(hourly, null, { afterMs: at('2026-03-10T02:00:00Z').getTime(), now: at('2026-03-10T05:10:00Z') });
  check('several missed runs (03, 04, 05:00) → one catch-up run', p.catchUp && p.missed === 3 && p.last === at('2026-03-10T05:00:00Z').getTime() && p.windowMs === H / 2, JSON.stringify(p));
  p = C.catchUpPlan(hourly, null, { afterMs: at('2026-03-10T02:00:00Z').getTime(), now: at('2026-03-10T05:40:00Z') });
  check('…but not 40 min late (an hourly job catches up for 30 min)', !p.catchUp, JSON.stringify(p));
  const minutely = C.parseCron('* * * * *');
  p = C.catchUpPlan(minutely, null, { afterMs: at('2026-03-10T02:00:00Z').getTime(), now: at('2026-03-10T02:05:30Z') });
  check('an every-minute job never replays (its window is 30 s, and it is due now anyway)', !p.catchUp && p.dueNow && p.windowMs === 30_000, JSON.stringify(p));
  const at230 = C.parseCron('30 2 * * *');
  // Berlin, 29 March 2026: 02:00 → 03:00. A 02:30 job runs at 03:00 that day (01:00Z); Servify was down over it.
  p = C.catchUpPlan(at230, tz, { afterMs: at('2026-03-28T01:30:00Z').getTime(), lastFired: '2026-3-28 2:30', now: at('2026-03-29T01:20:00Z') });
  check('DST (clocks forward): the 02:30 run that day (03:00) missed → caught up once', p.catchUp && p.missed === 1 && p.last === at('2026-03-29T01:00:00Z').getTime(), JSON.stringify(p));
  // 25 October 2026: 02:30 comes twice (00:30Z and 01:30Z). It ran at the first; Servify was down over the second.
  p = C.catchUpPlan(at230, tz, { afterMs: at('2026-10-25T00:30:00Z').getTime(), lastFired: '2026-10-25 2:30', now: at('2026-10-25T02:00:00Z') });
  check('DST (clocks back): the repeated 02:30 is not a missed run', !p.catchUp && p.missed === 0, JSON.stringify(p));
  p = C.catchUpPlan(at230, tz, { afterMs: at('2026-10-24T00:30:00Z').getTime(), lastFired: '2026-10-24 2:30', now: at('2026-10-25T02:00:00Z') });
  check('…and down over both: one missed run, one catch-up', p.catchUp && p.missed === 1 && p.last === at('2026-10-25T00:30:00Z').getTime(), JSON.stringify(p));
  p = C.catchUpPlan(daily, tz, { ...ran10, now: at('2026-03-11T05:00:20Z'), windowMs: 60 * 60_000 });
  check('SERVIFY_CATCHUP_WINDOW_MINUTES (windowMs) replaces the window: 1 h → 3 h late is too late', !p.catchUp && p.windowMs === H, JSON.stringify(p));
  const nowRun = C.nextRun('0 3 * * *', new Date(), tz);
  check('nextRun from an earlier moment is not answered from the cache', C.nextRun('0 3 * * *', at('2026-01-01T00:00:00Z'), tz)?.toISOString() === '2026-01-01T02:00:00.000Z' && C.nextRun('0 3 * * *', new Date(), tz)?.getTime() === nowRun?.getTime());

  console.log('\n▸ scheduled jobs: skipped runs, failure notifications');
  const notes = [];
  const sink = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try {
        notes.push(JSON.parse(b));
      } catch {}
      res.end('ok');
    });
  });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  cleanups.push(() => sink.close());
  const ch = await api('POST', '/settings/notifications/channels', { name: 'acc-cron', type: 'webhook', url: `http://127.0.0.1:${sink.address().port}/hook`, events: ['job.failed', 'backup.failed'] });
  cleanups.push(() => api('DELETE', `/settings/notifications/channels/${ch.id}`).catch(() => {}));
  const remindBefore = (await api('GET', '/settings')).alerts.failureRemindHours;
  cleanups.push(() => api('PATCH', '/settings/alerts', { failureRemindHours: remindBefore ?? 24 }).catch(() => {}));
  check('reminders default to every 24 h', remindBefore === 24, String(remindBefore));

  const deployed = async (sid) => {
    const d = await api('POST', `/services/${sid}/deploy`);
    return waitFor(async () => {
      const x = await api('GET', `/deployments/${d.id}`);
      return ['active', 'failed', 'cancelled'].includes(x.status) && x;
    }, 120_000, 'deploy');
  };
  const job = async (name, schedule, extra = {}) => {
    const svc = (await api('POST', `/projects/${P.id}/services`, { image: 'alpine:3.20', name, protocol: 'none', deploy: false, ...extra })).service;
    await api('PATCH', `/services/${svc.id}`, { schedule, ...(extra.patch ?? {}) });
    const d = await deployed(svc.id);
    if (d?.status !== 'active') throw new Error(`${name} did not deploy: ${d?.status}`);
    return svc;
  };
  const runs = (sid) => api('GET', `/services/${sid}/runs?limit=50`);
  const jobNotes = (sid) => notes.filter((n) => n.serviceId === sid && n.event === 'job.failed');
  const runNow = async (sid) => {
    const before = (await runs(sid)).filter((r) => r.status !== 'skipped').length;
    await waitFor(async () => (await api('POST', `/services/${sid}/run`), true), 30_000, 'run accepted');
    return waitFor(async () => {
      const r = (await runs(sid)).filter((x) => x.status !== 'skipped');
      return r.length > before && r[0].status !== 'running' && r[0];
    }, 60_000, 'run finished');
  };

  // A run that outlasts its interval: the next starts are skipped — and say so, once per streak.
  const slow = await job('slow', '* * * * *', { startCommand: 'sleep 130' });
  // A job that fails until MODE=ok (a new deploy), run by hand (the de-duplication covers every run of a job).
  const flaky = await job('flaky', '0 0 1 1 *', { startCommand: 'echo "mode $MODE"; test "$MODE" = ok', env: { MODE: 'bad' } });
  const svcView = (sid) => api('GET', `/services/${sid}`);
  check('catch-up is off for jobs by default', (await svcView(flaky.id)).cron?.catchUp === false && (await svcView(flaky.id)).cron?.catchUpExplicit === false, JSON.stringify((await svcView(flaky.id)).cron));
  for (let i = 0; i < 3; i++) await runNow(flaky.id);
  const fruns = (await runs(flaky.id)).filter((r) => r.status === 'failed');
  check('three failed runs, all recorded', fruns.length === 3, String(fruns.length));
  await sleep(1500);
  check('…but one failure notification', jobNotes(flaky.id).length === 1 && /Cron job flaky failed/.test(jobNotes(flaky.id)[0].title), JSON.stringify(jobNotes(flaky.id).map((n) => n.title)));
  let fv = await svcView(flaky.id);
  check('the service says since when it is failing', fv.cron?.failing?.count === 3 && fv.cron.failing.since <= fruns[fruns.length - 1].finishedAt + 1000 && !!fv.cron.failing.notifiedAt, JSON.stringify(fv.cron));
  // A reminder after failureRemindHours (shortened to 30 s here).
  await api('PATCH', '/settings/alerts', { failureRemindHours: 30 / 3600 });
  await sleep(31_000);
  await runNow(flaky.id);
  await sleep(1500);
  check('a reminder once the reminder interval has passed', jobNotes(flaky.id).length === 2 && /flaky is still failing/.test(jobNotes(flaky.id)[1].title) && /4 failed runs in a row/.test(jobNotes(flaky.id)[1].message), JSON.stringify(jobNotes(flaky.id).map((n) => n.title)));
  await runNow(flaky.id);
  await sleep(1500);
  check('…and not at the next failure right after', jobNotes(flaky.id).length === 2);
  await api('PATCH', '/settings/alerts', { failureRemindHours: 24 });
  await api('PUT', `/services/${flaky.id}/variables`, { variables: { MODE: 'ok' } });
  await deployed(flaky.id);
  const okRun = await runNow(flaky.id);
  await sleep(1500);
  check('fixed: the run succeeds and one "recovered" notification goes out', okRun?.status === 'succeeded' && jobNotes(flaky.id).length === 3 && jobNotes(flaky.id)[2].level === 'success' && /flaky recovered/.test(jobNotes(flaky.id)[2].title) && /after 5 failed runs/.test(jobNotes(flaky.id)[2].message), JSON.stringify(jobNotes(flaky.id).slice(2)));
  await runNow(flaky.id);
  await sleep(1000);
  check('…once: another success says nothing', jobNotes(flaky.id).length === 3 && (await svcView(flaky.id)).cron?.failing === null);
  // Failing again, notified: this streak must survive the restart below without a second notice.
  await api('PUT', `/services/${flaky.id}/variables`, { variables: { MODE: 'bad' } });
  await deployed(flaky.id);
  await runNow(flaky.id);
  await sleep(1500);
  check('a new streak notifies again', jobNotes(flaky.id).length === 4 && jobNotes(flaky.id)[3].level === 'error');

  const skip = await waitFor(async () => (await runs(slow.id)).find((r) => r.status === 'skipped' && (r.skipCount ?? 1) >= 2), 200_000, 'two skipped starts');
  check('a start while the previous run is still going is recorded as skipped, with the reason', /previous run is still going/.test(skip?.reason ?? ''), JSON.stringify(skip ?? (await runs(slow.id)).slice(0, 3)));
  check('…consecutive skips share one record (×count, first and last time)', skip?.skipCount >= 2 && skip.finishedAt > skip.startedAt && (await runs(slow.id)).filter((r) => r.status === 'skipped').length === 1, JSON.stringify(skip));
  const acts = await api('GET', `/projects/${P.id}/activity?limit=200`);
  check('…and the skip is in the activity log (once)', acts.filter((a) => a.serviceId === slow.id && a.action === 'job.skipped').length === 1);
  const mcpRuns = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(COOKIE ? { cookie: COOKIE } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_runs', arguments: { service: slow.id } } }),
  }).then((r) => r.text());
  check('MCP list_runs shows the skipped start with its reason and count', /skipped/.test(mcpRuns) && /previous run is still going/.test(mcpRuns) && /\\"count\\":\s*\d/.test(mcpRuns), mcpRuns.slice(0, 300));

  console.log('\n▸ catch-up across a restart');
  const START = process.env.SERVIFY_START_CMD;
  if (!DATA || !START) return console.log('  – skipped (set SERVIFY_DATA_DIR and SERVIFY_START_CMD, see the header)');
  const health = () => fetch(BASE + '/api/health').then((r) => r.ok, () => false);
  const stop = async () => {
    const { pid } = JSON.parse(readFileSync(join(DATA, 'servify.pid'), 'utf8'));
    process.kill(pid, 'SIGTERM');
    await waitFor(async () => !(await health()), 30_000, 'Servify stopped');
  };
  const start = async () => {
    execSync(START, { stdio: 'ignore' });
    if (!(await waitFor(health, 60_000, 'Servify up'))) throw new Error('Servify did not come back');
  };
  // Pick a minute M far enough ahead to set up; schedules "M * * * *" (hourly: a 30 min window, no override needed).
  await api('DELETE', `/services/${slow.id}`);
  const t0 = Date.now();
  const dueAt = Math.ceil((t0 + 100_000) / 60_000) * 60_000;
  const M = new Date(dueAt).getMinutes();
  const hourlyAt = `${M} * * * *`;
  const late = await job('late', hourlyAt, { startCommand: 'echo late-run', patch: { scheduleCatchUp: true } });
  const nolate = await job('nolate', hourlyAt, { startCommand: 'echo no-late-run' });
  const every = await job('every', '* * * * *', { startCommand: 'echo tick', patch: { scheduleCatchUp: true } });
  const vault = (await api('POST', `/projects/${P.id}/services`, { image: 'alpine:3.20', name: 'vault', protocol: 'none', startCommand: 'sh -c "echo data > /data/f; exec sleep 1000000"', deploy: false })).service;
  await api('PATCH', `/services/${vault.id}`, { volumes: [{ name: 'data', mountPath: '/data' }] });
  await deployed(vault.id);
  await running(P.id, 'vault');
  await api('PATCH', `/services/${vault.id}`, { backup: { enabled: true, schedule: hourlyAt, destinationId: 'local', retention: 3 } });
  check('scheduled backups catch up by default', (await svcView(vault.id)).backupHealth?.catchUp === true, JSON.stringify((await svcView(vault.id)).backupHealth));
  check('jobs can opt in to catch-up', (await svcView(late.id)).cron?.catchUp === true);
  if (Date.now() > dueAt - 12_000) return check('set up before the chosen minute', false, `${Math.round((Date.now() - t0) / 1000)} s`);
  await sleep(dueAt - 10_000 - Date.now());
  await stop();
  console.log(`    (stopped Servify before ${new Date(dueAt).toLocaleTimeString()}, when "late", "nolate" and the backup were due)`);
  await sleep(dueAt + 75_000 - Date.now());
  await start();
  const caught = await waitFor(async () => (await runs(late.id)).find((r) => r.catchUp && r.status === 'succeeded'), 90_000, 'catch-up run');
  check('a run missed while Servify was down runs once after the restart, marked as a catch-up', !!caught && caught.catchUp.dueAt === dueAt && caught.catchUp.missed === 1 && caught.trigger === 'schedule', JSON.stringify(caught ?? (await runs(late.id)).slice(0, 2)));
  const bak = await waitFor(async () => (await api('GET', `/services/${vault.id}/backups`)).find((b) => b.trigger === 'schedule' && b.status !== 'running'), 90_000, 'catch-up backup');
  check('a scheduled backup missed while Servify was down runs once after the restart', bak?.status === 'succeeded' && bak.catchUp?.dueAt === dueAt, JSON.stringify(bak ?? null).slice(0, 300));
  const skippedLate = await waitFor(async () => (await runs(nolate.id)).find((r) => r.status === 'skipped'), 30_000, 'skipped record');
  check('catch-up off: no run, a skipped record says why', !!skippedLate && /missed 1 run while Servify wasn't running/.test(skippedLate.reason) && /catch-up is off/.test(skippedLate.reason) && (await runs(nolate.id)).length === 1, JSON.stringify(await runs(nolate.id)));
  await sleep(15_000);
  check('an every-minute job is not replayed (its regular runs go on)', (await runs(every.id)).every((r) => !r.catchUp), JSON.stringify((await runs(every.id)).map((r) => [r.status, r.catchUp])));
  // The failing streak from before the restart: still known, no new notice.
  fv = await svcView(flaky.id);
  check('the failure streak survives the restart', fv.cron?.failing?.count === 1 && !!fv.cron.failing.notifiedAt, JSON.stringify(fv.cron));
  await runNow(flaky.id);
  await sleep(1500);
  check('…and a failure after the restart does not notify again', jobNotes(flaky.id).length === 4 && (await svcView(flaky.id)).cron?.failing?.count === 2, String(jobNotes(flaky.id).length));

  // Another restart inside the window: the missed run already caught up must not run again.
  await stop();
  await sleep(3000);
  await start();
  await sleep(20_000);
  const lateRuns = (await runs(late.id)).filter((r) => r.status !== 'skipped');
  const baks = (await api('GET', `/services/${vault.id}/backups`)).filter((b) => b.trigger === 'schedule');
  check('exactly one catch-up run, also after another restart', lateRuns.length === 1, JSON.stringify(lateRuns.map((r) => [r.status, r.catchUp])));
  check('exactly one catch-up backup, also after another restart', baks.length === 1, String(baks.length));
  check('interrupted runs (a restart) are not reported as failures', !notes.some((n) => n.serviceId === every.id || n.serviceId === late.id));
}

/**
 * The everyday CLI commands (ONLY=cli; also part of a full run): exec argv and exit codes, variables (masking, get,
 * stdin, --from-file, shared, --deploy), backup create/list/test/download (checksum verification against a damaged
 * stored file), restore (confirmation, progress, failure exit code), rollback, restart and help. Needs SERVIFY_DATA_DIR
 * (for `servify token` and the stored backup file). Every command runs through execFileSync-style argv, never a shell.
 */
async function cliParityChecks(P) {
  console.log('\n▸ servify CLI: exec, variables, backup, restore, rollback');
  if (!DATA) return console.log('  – skipped (set SERVIFY_DATA_DIR)');
  const BIN = join(process.cwd(), 'server/bin/servify.mjs');
  const home = mkdtempSync(join(tmpdir(), 'servify-cli2-home-'));
  const work = mkdtempSync(join(tmpdir(), 'servify-cli2-work-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }), () => rmSync(work, { recursive: true, force: true }));
  const mkToken = (name, extra = []) => {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, 'token', name, ...extra], { env: { ...process.env, SERVIFY_DATA_DIR: DATA }, encoding: 'utf8' });
    return r.stdout.match(/svf_[A-Za-z0-9_-]+|svs_[A-Za-z0-9_-]+/)?.[0];
  };
  const tok = mkToken('acceptance-cli-parity');
  const readTok = mkToken('acceptance-cli-parity-read', ['--scope', 'read']);
  const app = (await api('POST', `/projects/${P.id}/services`, { image: 'nginx:alpine', name: 'cli-parity' })).service;
  await running(P.id, 'cli-parity');
  await api('POST', `/projects/${P.id}/volumes`, { name: 'data', serviceId: app.id, mountPath: '/data' });
  await waitFor(async () => {
    const d = await api('GET', `/services/${app.id}/deployments?limit=5`);
    return d.length >= 2 && d[0].status === 'active' && (await svcOf(P.id, 'cli-parity')).status === 'running';
  }, 180_000, 'redeploy with the volume');
  const baseEnv = { ...process.env, SERVIFY_CLI_HOME: home, SERVIFY_URL: BASE, SERVIFY_TOKEN: tok, SERVIFY_PROJECT: P.slug, SERVIFY_SERVICE: 'cli-parity', NO_COLOR: '1' };
  /** argv in, { code, out (stdout), err (stderr), all } out — no shell anywhere. */
  const cli = (argv, opts = {}) => {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, ...argv], { cwd: opts.cwd ?? work, env: { ...baseEnv, ...(opts.env ?? {}) }, input: opts.input ?? '', encoding: 'utf8', timeout: 300_000 });
    return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };

  // ─── exec ───
  const quoted = cli(['exec', '--', 'sh', '-c', 'printf "%s|" "$@"', 'x', 'a b', 'c"d', "e'f"]);
  check('exec passes argv as is (spaces and quotes survive)', quoted.code === 0 && quoted.out.trim() === `a b|c"d|e'f|`, JSON.stringify(quoted.out));
  const echo = cli(['exec', '--', 'sh', '-c', 'echo "a b"']);
  check('`exec -- sh -c \'echo "a b"\'` reaches the container as ["sh","-c","echo \\"a b\\""]', echo.code === 0 && echo.out.trim() === 'a b', JSON.stringify(echo.out));
  const seven = cli(['exec', '--', 'sh', '-c', 'exit 7']);
  check('exec exits with the remote command’s exit code', seven.code === 7, String(seven.code));
  const shellForm = cli(['exec', 'echo hi | tr a-z A-Z']);
  check('one argument with shell syntax still runs through /bin/sh -c', shellForm.code === 0 && shellForm.out.trim() === 'HI', shellForm.all);
  const viaApiArr = await api('POST', `/services/${app.id}/exec`, { command: ['printf', '%s', 'x y'] });
  const viaApiStr = await api('POST', `/services/${app.id}/exec`, { command: 'printf %s "x y"' });
  check('the exec API takes an argv array and still takes a string', viaApiArr.output === 'x y' && viaApiArr.exitCode === 0 && viaApiStr.output === 'x y', `${JSON.stringify(viaApiArr)} ${JSON.stringify(viaApiStr)}`);
  const badArr = await fetch(`${BASE}/api/services/${app.id}/exec`, { method: 'POST', headers: { 'content-type': 'application/json', ...(COOKIE ? { cookie: COOKIE } : {}) }, body: JSON.stringify({ command: [1, 2] }) });
  const emptyArr = await fetch(`${BASE}/api/services/${app.id}/exec`, { method: 'POST', headers: { 'content-type': 'application/json', ...(COOKIE ? { cookie: COOKIE } : {}) }, body: JSON.stringify({ command: [] }) });
  check('the exec API refuses a malformed command (400)', badArr.status === 400 && emptyArr.status === 400, `${badArr.status} ${emptyArr.status}`);

  // ─── variables ───
  const set1 = cli(['variables', 'set', 'GREETING=hello', 'TWO=two words', 'EQ=a=b']);
  check('variables set NAME=value… (says a redeploy is needed)', set1.code === 0 && /Set GREETING, TWO, EQ/.test(set1.out) && /next deploy/.test(set1.out) && !set1.all.includes('two words'), set1.all);
  const masked = cli(['variables', 'list']);
  check('variables list masks values by default', masked.code === 0 && /GREETING=••••••••/.test(masked.out) && !masked.out.includes('hello') && !masked.out.includes('two words'), masked.all);
  const revealed = cli(['vars', 'list', '--reveal']);
  check('vars list --reveal shows them', revealed.code === 0 && revealed.out.includes('TWO=two words') && revealed.out.includes('EQ=a=b'), revealed.all);
  const got = cli(['variables', 'get', 'TWO']);
  check('variables get prints only the value', got.code === 0 && got.out === 'two words\n', JSON.stringify(got.out));
  const missing = cli(['variables', 'get', 'NOPE']);
  check('variables get of a missing name exits 1 and prints nothing on stdout', missing.code === 1 && missing.out === '', missing.all);
  const piped = cli(['variables', 'set', 'API_TOKEN'], { input: 'from-stdin-value\n' });
  const pipedGet = cli(['variables', 'get', 'API_TOKEN']);
  check('variables set NAME reads the value from stdin (one trailing newline dropped)', piped.code === 0 && pipedGet.out === 'from-stdin-value\n' && !piped.all.includes('from-stdin-value'), `${piped.all} ${JSON.stringify(pipedGet.out)}`);
  const envFile = join(work, 'prod.env');
  writeFileSync(envFile, ['# a comment', '', 'export FILE_A=one', 'FILE_B="two \\"quoted\\"\\nline"', "FILE_C='single $not_expanded' # comment", 'FILE_D=x=y   # trailing comment', 'FILE_E="multi', 'line"', ''].join('\n'));
  const fromFile = cli(['variables', 'set', '--from-file', envFile]);
  const env1 = (await api('GET', `/services/${app.id}`)).env;
  check(
    'variables set --from-file reads a .env file (export, comments, quotes, = in values, multi-line)',
    fromFile.code === 0 && env1.FILE_A === 'one' && env1.FILE_B === 'two "quoted"\nline' && env1.FILE_C === 'single $not_expanded' && env1.FILE_D === 'x=y' && env1.FILE_E === 'multi\nline',
    `${fromFile.all} ${JSON.stringify([env1.FILE_A, env1.FILE_B, env1.FILE_C, env1.FILE_D, env1.FILE_E])}`,
  );
  const fromStdinFile = cli(['variables', 'set', '--from-file', '-'], { input: 'FILE_F=ff\n' });
  check('--from-file - reads the .env from stdin', fromStdinFile.code === 0 && (await api('GET', `/services/${app.id}`)).env.FILE_F === 'ff', fromStdinFile.all);
  const badFile = join(work, 'bad.env');
  writeFileSync(badFile, 'GOOD=1\nthis is not a variable\n');
  const bad = cli(['variables', 'set', '--from-file', badFile]);
  check('a malformed .env is refused with its line number, nothing set', bad.code === 1 && /bad\.env:2/.test(bad.err) && !('GOOD' in (await api('GET', `/services/${app.id}`)).env), bad.all);
  const svcNow = await api('GET', `/services/${app.id}`);
  check('new secret-looking names are masked for read-only tokens', svcNow.secretKeys.includes('API_TOKEN') && !svcNow.secretKeys.includes('GREETING'), JSON.stringify(svcNow.secretKeys));
  const roGet = cli(['variables', 'get', 'API_TOKEN'], { env: { SERVIFY_TOKEN: readTok } });
  const roList = cli(['variables', 'list', '--reveal'], { env: { SERVIFY_TOKEN: readTok } });
  check('read-only token: get of a secret fails without printing it; list --reveal keeps it masked', roGet.code === 1 && !roGet.all.includes('from-stdin-value') && roList.code === 0 && roList.out.includes('API_TOKEN=••••••••') && roList.out.includes('GREETING=hello') && !roList.all.includes('from-stdin-value'), `${roGet.all} | ${roList.all}`);
  const roSet = cli(['variables', 'set', 'X=1'], { env: { SERVIFY_TOKEN: readTok } });
  check('read-only token: set is refused (exit 1)', roSet.code === 1, roSet.all);
  const unset = cli(['variables', 'unset', 'FILE_A', 'FILE_F']);
  const env2 = (await api('GET', `/services/${app.id}`)).env;
  check('variables unset removes them', unset.code === 0 && !('FILE_A' in env2) && !('FILE_F' in env2) && env2.FILE_B, unset.all);
  const unsetMissing = cli(['variables', 'unset', 'FILE_A']);
  check('variables unset of a missing name exits 1', unsetMissing.code === 1, unsetMissing.all);
  const sharedSet = cli(['variables', 'set', '--shared', 'REGION=eu-1']);
  const sharedGet = cli(['variables', 'get', '--shared', 'REGION']);
  check('--shared sets and gets the project’s shared variables', sharedSet.code === 0 && sharedGet.out === 'eu-1\n' && (await api('GET', `/projects/${P.id}`)).project.variables?.REGION === 'eu-1', `${sharedSet.all} ${JSON.stringify(sharedGet.out)}`);
  cli(['variables', 'set', 'USES_REGION=${{shared.REGION}}']);
  const sharedChange = cli(['variables', 'set', '--shared', 'REGION=eu-2', 'OTHER=1']);
  check('changing a shared variable names the services that use it', sharedChange.code === 0 && /cli-parity/.test(sharedChange.out) && (await api('GET', `/projects/${P.id}`)).project.variables?.REGION === 'eu-2', sharedChange.all);
  const sharedUnset = cli(['variables', 'unset', '--shared', 'OTHER']);
  const sharedNow = (await api('GET', `/projects/${P.id}`)).project.variables ?? {};
  check('--shared unset keeps the other shared variables', sharedUnset.code === 0 && !('OTHER' in sharedNow) && sharedNow.REGION === 'eu-2', JSON.stringify(Object.keys(sharedNow)));
  const deployed = cli(['variables', 'set', 'GREETING=hi again', '--deploy']);
  const afterDeploy = await api('GET', `/services/${app.id}`);
  check('variables set --deploy redeploys and the change is live', deployed.code === 0 && /Deployed/.test(deployed.out) && !afterDeploy.pendingChanges.includes('variables'), deployed.all.slice(-300));
  const live = cli(['exec', '--', 'sh', '-c', 'printf %s "$GREETING|$USES_REGION"']);
  check('…the container sees the new values (and the shared one)', live.out.trimEnd() === 'hi again|eu-2', JSON.stringify(live.out));

  // ─── backups ───
  cli(['exec', '--', 'sh', '-c', 'echo v1 > /data/file.txt']);
  const bk = cli(['backup']);
  const list1 = await api('GET', `/services/${app.id}/backups`);
  const b1 = list1[0];
  check('`backup` takes a backup and waits for it', bk.code === 0 && /Backed up cli-parity/.test(bk.out) && b1?.status === 'succeeded' && bk.out.includes(b1.id), bk.all);
  const bl = cli(['backup', 'list']);
  check('`backup list` shows id, short checksum, size and test status', bl.code === 0 && bl.out.includes(b1.id) && bl.out.includes(`sha256:${b1.sha256.slice(0, 12)}`) && /\d+ (B|KB|MB)/.test(bl.out) && /untested/.test(bl.out), bl.all);
  const bt = cli(['backup', 'test', b1.id]);
  check('`backup test` restores into a scratch copy and reports it', bt.code === 0 && /Test restore passed/.test(bt.out) && (await api('GET', `/backups/${b1.id}`)).test?.status === 'passed', bt.all);
  check('`backup list` shows the test result', /test passed/.test(cli(['backup', 'list']).out));
  const nw = cli(['backup', 'create', '--no-wait']);
  check('`backup create --no-wait` returns right away', nw.code === 0 && /background|queued/.test(nw.out), nw.all);
  await waitFor(async () => (await api('GET', `/services/${app.id}/backups`)).every((b) => b.status !== 'running'), 120_000, 'background backup');
  const badDest = cli(['backup', '--destination', 'nowhere']);
  check('`backup --destination` with an unknown destination fails', badDest.code === 1 && /destination/i.test(badDest.err), badDest.all);

  const dlFile = join(work, 'b1.tar.gz');
  const dl = cli(['backup', 'download', b1.id, '-o', dlFile]);
  check('`backup download -o` saves it and verifies the sha256', dl.code === 0 && /sha256 verified/.test(dl.out) && existsSync(dlFile) && createHash('sha256').update(readFileSync(dlFile)).digest('hex') === b1.sha256, dl.all);
  const dlDefault = cli(['backup', 'download', b1.id], { cwd: work });
  check('`backup download` without -o names the file after the backup (no path from the server)', dlDefault.code === 0 && existsSync(join(work, b1.key.split('/').pop())), dlDefault.all);
  const dlAgain = cli(['backup', 'download', b1.id], { cwd: work });
  check('…and won’t overwrite it without --force', dlAgain.code === 1 && /already exists/.test(dlAgain.err), dlAgain.all);

  // Restore: refused without --yes when not interactive; then a real one.
  cli(['exec', '--', 'sh', '-c', 'echo v2 > /data/file.txt']);
  const noYes = cli(['restore', b1.id]);
  check('`restore` without --yes (not a terminal) refuses and changes nothing', noYes.code === 1 && /--yes/.test(noYes.err) && cli(['exec', 'cat', '/data/file.txt']).out.trim() === 'v2', noYes.all);
  const rs = cli(['restore', '--yes', b1.id]);
  check('`restore --yes` follows the restore to the end', rs.code === 0 && /│ /.test(rs.out) && /Restored cli-parity/.test(rs.out), rs.all);
  await running(P.id, 'cli-parity');
  check('…and the data is back', (await waitFor(async () => cli(['exec', 'cat', '/data/file.txt']).out.trim() === 'v1', 60_000, 'restored data')) === true);
  const rec1 = await api('GET', `/backups/${b1.id}`);
  check('the restore’s outcome is on the backup record', rec1.restore?.status === 'succeeded' && !!rec1.restore.safetyBackupId && !!rec1.restoredAt, JSON.stringify(rec1.restore));

  // A damaged stored file: one byte flipped (same length). Download, restore and test all fail, nothing changes.
  const stored = join(DATA, 'backups', b1.key);
  if (existsSync(stored)) {
    const orig = readFileSync(stored);
    const broken = Buffer.from(orig);
    broken[Math.floor(broken.length / 2)] ^= 0xff;
    writeFileSync(stored, broken);
    try {
      const out = join(work, 'damaged.tar.gz');
      const dlBad = cli(['backup', 'download', b1.id, '-o', out]);
      check('`backup download` of a damaged backup fails the checksum and leaves no file', dlBad.code === 1 && /Checksum mismatch/.test(dlBad.err) && !existsSync(out) && !readdirSync(work).some((f) => f.includes('damaged')), dlBad.all);
      const toOut = cli(['backup', 'download', b1.id, '-o', '-']);
      check('…also to stdout (exit 1)', toOut.code === 1 && /Checksum mismatch/.test(toOut.err), toOut.err);
      cli(['exec', '--', 'sh', '-c', 'echo v3 > /data/file.txt']);
      const rsBad = cli(['restore', '--yes', b1.id]);
      check('`restore` of a damaged backup exits non-zero with the reason', rsBad.code === 1 && /Restore failed — .+nothing was changed/.test(rsBad.out), rsBad.all);
      check('…and the data is untouched', cli(['exec', 'cat', '/data/file.txt']).out.trim() === 'v3');
      const btBad = cli(['backup', 'test', b1.id]);
      check('`backup test` of a damaged backup exits non-zero', btBad.code === 1 && /Test restore failed/.test(btBad.out), btBad.all);
    } finally {
      writeFileSync(stored, orig);
    }
  } else check('the stored backup file is where expected', false, stored);
  const noSuch = cli(['restore', '--yes', 'bak_doesnotexist']);
  check('`restore` of an unknown backup exits 1', noSuch.code === 1 && /not found/.test(noSuch.err), noSuch.all);

  // ─── deployments, rollback, restart ───
  const deps = await api('GET', `/services/${app.id}/deployments?limit=20`);
  const active = deps.find((d) => d.status === 'active');
  const prev = deps.find((d) => d.status === 'superseded' && d.image && d.image !== active.image);
  const dl2 = cli(['deployments']);
  check('`deployments` lists them', dl2.code === 0 && dl2.out.includes(active.id) && /active/.test(dl2.out), dl2.all);
  const rb = cli(['rollback']);
  const afterRb = await api('GET', `/services/${app.id}`);
  const rbDep = await api('GET', `/deployments/${afterRb.activeDeploymentId}`);
  check('`rollback` goes back to the previous live image and follows it', rb.code === 0 && rb.out.includes(prev.id) && /Deployed/.test(rb.out) && rbDep.trigger === 'rollback' && rbDep.image === prev.image, `${rb.all.slice(-300)} ${rbDep.trigger} ${rbDep.image} ${prev.image}`);
  const rbTo = cli(['rollback', active.id.slice(0, 10), '--skip-safety-backup']);
  const rbToDep = await api('GET', `/deployments/${(await api('GET', `/services/${app.id}`)).activeDeploymentId}`);
  check('`rollback <id prefix> --skip-safety-backup` rolls back to that deployment', rbTo.code === 0 && /Deployed/.test(rbTo.out) && rbToDep.image === active.image, rbTo.all.slice(-300));
  const rbBad = cli(['rollback', 'dep_nope']);
  check('`rollback` to an unknown deployment exits 1', rbBad.code === 1 && /No deployment/.test(rbBad.err), rbBad.all);
  const rst = cli(['restart', '--skip-safety-backup']);
  const rstDep = await api('GET', `/deployments/${(await api('GET', `/services/${app.id}`)).activeDeploymentId}`);
  check('`restart --skip-safety-backup` restarts and follows it', rst.code === 0 && /Restarting cli-parity/.test(rst.out) && /Deployed/.test(rst.out) && rstDep.trigger === 'restart', rst.all.slice(-300));

  // ─── help ───
  const help = cli(['help']);
  check('`servify help` lists the new commands', help.code === 0 && ['variables', 'backup', 'restore', 'rollback', 'restart', '--skip-safety-backup', 'from-file'].every((w) => help.out.includes(w)), help.out.slice(-400));
  const per = ['variables', 'vars', 'backup', 'restore', 'rollback', 'restart', 'deployments', 'exec'].map((c) => [c, cli(['help', c]), cli([c, '--help'])]);
  check('per-command help for each (servify help <cmd> and <cmd> --help)', per.every(([c, a, b]) => a.code === 0 && b.code === 0 && a.out === b.out && a.out.startsWith(`servify ${c === 'vars' ? 'variables' : c}`)), per.filter(([, a, b]) => a.code || b.code).map(([c]) => c).join(', '));
  const exHelp = cli(['exec', '--', 'sh', '-c', 'echo --help']);
  check('`--help` after `--` belongs to the command', exHelp.code === 0 && exHelp.out.trim() === '--help', exHelp.all);
  const unknown = cli(['backup', 'frobnicate']);
  check('an unknown subcommand exits 1 with the usage', unknown.code === 1 && /Unknown subcommand/.test(unknown.err) && /backup list/.test(unknown.err), unknown.all);
  await api('DELETE', `/services/${app.id}?deleteVolumes=1&skipSafetyBackup=1`).catch(() => {});
}

/**
 * Notification errors (ONLY=notify): fake Discord / Slack / ntfy / webhook endpoints and SMTP servers on 127.0.0.1
 * answer with known failures; each must come back as a plain-language problem with a fix, never quoting the channel's
 * credential. Three failures in a row mark a channel failing and the other channels hear about it. Telegram's host is
 * fixed, so only the local "chat ID is the bot itself" refusal on save is checked here.
 */
async function notifyChecks() {
  console.log('\n▸ notification errors');
  let answer = { status: 200, body: 'ok' };
  const got = [];
  const fake = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      if (req.url.startsWith('/good')) {
        got.push(b);
        return res.end('ok');
      }
      res.writeHead(answer.status, { 'content-type': answer.body.startsWith('{') ? 'application/json' : 'text/plain' });
      res.end(answer.body);
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  cleanups.push(async () => fake.close());
  const port = fake.address().port;
  const TOKEN = 'zQ9xV3kLmN8pR2sT5uW7yB1cD4fG6hJ0';
  const made = [];
  const add = async (body) => {
    const ch = await api('POST', '/settings/notifications/channels', { events: ['deploy.failed'], ...body });
    made.push(ch.id);
    cleanups.push(() => api('DELETE', `/settings/notifications/channels/${ch.id}`).catch(() => {}));
    return ch;
  };
  const test = (ch) => api('POST', `/settings/notifications/channels/${ch.id}/test`);
  const health = () => api('GET', '/settings/notifications/health');

  const good = await add({ name: 'acc-good', type: 'webhook', url: `http://127.0.0.1:${port}/good` });
  check('a working channel tests fine', (await test(good)).ok === true);
  check('and its health says delivered', (await health())[good.id]?.ok === true);

  const discord = await add({ name: 'acc-discord', type: 'discord', url: `http://127.0.0.1:${port}/api/webhooks/1234567890/${TOKEN}` });
  answer = { status: 404, body: '{"message": "Unknown Webhook", "code": 10015}' };
  const d1 = await test(discord);
  check('Discord 404: the webhook was deleted, with how to make a new one', d1.ok === false && /webhook doesn’t exist/.test(d1.problem) && /Integrations → Webhooks/.test(d1.fix ?? ''), JSON.stringify(d1));
  const h1 = (await health())[discord.id];
  check('the channel shows the problem, not yet failing', h1?.ok === false && h1.failures === 1 && h1.failing === false && /deleted/.test(h1.problem));
  check('no credential in the problem, fix or detail', !JSON.stringify([d1, h1]).includes(TOKEN), JSON.stringify(h1));
  got.length = 0;
  await test(discord);
  await test(discord);
  const h3 = (await health())[discord.id];
  check('three failures in a row: failing', h3?.failing === true && h3.failures === 3, JSON.stringify(h3));
  const warned = await waitFor(async () => got.find((b) => b.includes('acc-discord') && b.includes('notify.failing')), 10_000, 'failing notice');
  check('the other channel was told', !!warned && !warned.includes(TOKEN), warned ?? '');
  got.length = 0;
  await test(discord);
  await sleep(500);
  check('…once per streak', !got.some((b) => b.includes('notify.failing')));
  const dels = await api('GET', '/settings/notifications/deliveries');
  check('recent deliveries carry the problem', dels.some((d) => d.channelId === discord.id && /webhook doesn’t exist/.test(d.problem ?? '')));
  // Switching it off and on keeps the health (same URL); a new URL clears it.
  await api('POST', '/settings/notifications/channels', { ...discord, enabled: false });
  check('a disabled channel is not counted as failing', (await health())[discord.id]?.failing === false);
  await api('POST', '/settings/notifications/channels', { ...discord, enabled: true });
  check('re-enabled: failing again (nothing changed)', (await health())[discord.id]?.failing === true);
  await api('POST', '/settings/notifications/channels', { ...discord, url: `http://127.0.0.1:${port}/good` });
  check('saving a new URL clears the old results', !(await health())[discord.id]);

  const slack = await add({ name: 'acc-slack', type: 'slack', url: `http://127.0.0.1:${port}/services/T000/B000/${TOKEN}` });
  answer = { status: 404, body: 'no_service' };
  const s1 = await test(slack);
  check('Slack 404 no_service: the webhook no longer exists', /no longer exists/.test(s1.problem ?? '') && /Incoming Webhook/.test(s1.fix ?? ''), JSON.stringify(s1));
  answer = { status: 410, body: 'channel_is_archived' };
  check('Slack 410: the channel was archived', /archived/.test((await test(slack)).problem ?? ''));

  const ntfy = await add({ name: 'acc-ntfy', type: 'ntfy', url: `http://127.0.0.1:${port}`, topic: 'acc-topic' });
  answer = { status: 403, body: '{"code":40301,"http":403,"error":"forbidden"}' };
  const n1 = await test(ntfy);
  check('ntfy 403: protected topic, add an access token', /protected/.test(n1.problem ?? '') && /access token/.test(n1.fix ?? ''), JSON.stringify(n1));
  answer = { status: 429, body: '{"code":42901,"http":429,"error":"limit reached: too many requests"}' };
  check('ntfy 429: rate limited, with what to do', /rate limiting/.test((await test(ntfy)).problem ?? ''));

  const hook = await add({ name: 'acc-hook', type: 'webhook', url: `http://127.0.0.1:${port}/x`, secret: TOKEN });
  answer = { status: 500, body: `{"error":"database down","echo":"${TOKEN}"}` };
  const w1 = await test(hook);
  check('generic fallback: the status and a short excerpt', /HTTP 500/.test(w1.problem ?? '') && /database down/.test(w1.fix ?? ''), JSON.stringify(w1));
  check('the excerpt never repeats a secret', !JSON.stringify(w1).includes(TOKEN) && !JSON.stringify((await health())[hook.id]).includes(TOKEN));

  // SMTP: a closed port, and a server that refuses the login.
  const closed = await new Promise((r) => {
    const t = net.createServer().listen(0, '127.0.0.1', () => {
      const p = t.address().port;
      t.close(() => r(p));
    });
  });
  const mail = await add({ name: 'acc-mail', type: 'email', smtp: { host: '127.0.0.1', port: closed, secure: false, from: 'a@example.com', to: 'b@example.com' } });
  const m1 = await test(mail);
  check('SMTP connection refused: check host and port', /connection refused/.test(m1.problem ?? '') && /587/.test(m1.fix ?? ''), JSON.stringify(m1));
  const smtp = net.createServer((sock) => {
    sock.write('220 acc ESMTP\r\n');
    let buf = '';
    sock.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (/^EHLO/i.test(line)) sock.write('250-acc\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^AUTH/i.test(line)) sock.write('535 5.7.8 Authentication credentials invalid\r\n');
        else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n');
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
  cleanups.push(async () => smtp.close());
  await api('POST', '/settings/notifications/channels', { ...mail, smtp: { host: '127.0.0.1', port: smtp.address().port, secure: false, user: 'acc', pass: TOKEN, from: 'a@example.com', to: 'b@example.com' } });
  const m2 = await test(mail);
  check('SMTP 535: username or password refused, app passwords', /username or password/.test(m2.problem ?? '') && /app password/.test(m2.fix ?? ''), JSON.stringify(m2));
  check('the SMTP password is not repeated', !JSON.stringify(m2).includes(TOKEN));

  // Telegram: the chat ID of the bot itself is refused on save (bot tokens start with the bot's id).
  let refused = '';
  try {
    await add({ name: 'acc-tg', type: 'telegram', botToken: `7012345678:${TOKEN}AAAA`, chatId: '7012345678' });
  } catch (e) {
    refused = e.message;
  }
  check('Telegram: a chat ID that is the bot itself is refused on save', /→ 400/.test(refused) && /bot itself/.test(refused) && /getUpdates/.test(refused) && !refused.includes(TOKEN), refused);

  // Removing a channel removes its health.
  await api('DELETE', `/settings/notifications/channels/${ntfy.id}`);
  check('a removed channel has no health entry', !(await health())[ntfy.id]);
}

/**
 * Registry logins from the dashboard (ONLY=registry): a local registry:2 with htpasswd (servify-acc-ghcr, removed
 * afterwards) stands in for a private ghcr.io image. Run Servify with DOCKER_CONFIG set to an empty scratch folder so
 * neither its Engine pull nor the docker CLI retry can fall back to a docker login; this script pushes with its own
 * throwaway DOCKER_CONFIG. Checks: no login → the deploy fails; a login (token never returned) → the pull uses it;
 * update checks see a new push; the deploy hook pulls the new push with "pull before every deploy".
 */
async function registryLoginChecks(P) {
  console.log('\n▸ registry logins in the dashboard (a password-protected registry)');
  const PORT = Number(process.env.SERVIFY_ACC_REGISTRY_PORT ?? 15858);
  const NAME = 'servify-acc-ghcr';
  const USER = 'acc';
  const PW = 'svf-acc-Rq7w-registry';
  const HASH = '$2y$05$HSSyz7LzJrGSKh3qaewOsuqlyCFzBfBNRDWrjh68PBJ.txKgtIPVy'; // htpasswd -nbB acc <PW>
  const host = `localhost:${PORT}`;
  const ref = `${host}/acc/app:main`;
  const dockerHost = execSync(`docker context inspect --format '{{.Endpoints.docker.Host}}'`).toString().trim();
  const pushCfg = mkdtempSync(join(tmpdir(), 'servify-pushcfg-'));
  writeFileSync(join(pushCfg, 'config.json'), JSON.stringify({ auths: { [host]: { auth: Buffer.from(`${USER}:${PW}`).toString('base64') } } }));
  const sh = (c) => execSync(c, { stdio: 'pipe', env: { ...process.env, DOCKER_CONFIG: pushCfg, DOCKER_HOST: process.env.DOCKER_HOST || dockerHost } }).toString().trim();
  const authDir = mkdtempSync(join(tmpdir(), 'servify-ghcrauth-'));
  writeFileSync(join(authDir, 'htpasswd'), `${USER}:${HASH}\n`);
  sh(`docker rm -fv ${NAME} 2>/dev/null || true`);
  sh(`docker run -d --name ${NAME} -p ${PORT}:5000 -v ${authDir}:/auth -e REGISTRY_AUTH=htpasswd -e REGISTRY_AUTH_HTPASSWD_REALM=acc -e REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd registry:2`);
  let loginId = null;
  cleanups.push(async () => {
    if (loginId) await api('DELETE', `/settings/registries/${loginId}`).catch(() => {});
    try {
      sh(`docker rm -fv ${NAME}; docker rmi ${ref} || true`);
    } catch {}
    rmSync(authDir, { recursive: true, force: true });
    rmSync(pushCfg, { recursive: true, force: true });
  });
  check('the registry refuses anonymous requests', !!(await waitFor(async () => (await fetch(`http://${host}/v2/`).catch(() => null))?.status === 401, 30_000, 'registry')));
  const push = (from) => sh(`docker tag ${from} ${ref} && docker push -q ${ref} && docker rmi ${ref}`);
  push('alpine:3.20');
  const logOf = async (depId) => (await api('GET', `/deployments/${depId}/logs`)).map((l) => (typeof l === 'string' ? l : l.text ?? l.line ?? '')).join('\n');
  const settle = (depId) => waitFor(async () => ['active', 'failed'].includes((await api('GET', `/deployments/${depId}`)).status) && api('GET', `/deployments/${depId}`), 180_000, 'deployment');

  // Negative control: nothing to log in with.
  const made = await api('POST', `/projects/${P.id}/services`, { image: ref, name: 'ghcr-app', protocol: 'none', startCommand: 'sleep 1d' });
  const app = made.service;
  const d0 = await settle(made.deployment?.id ?? (await api('GET', `/services/${app.id}/deployments`))[0]?.id);
  check('without a login the pull is refused and the deploy fails', d0?.status === 'failed' && /pull failed: (unauthorized|not found or private)/.test(d0.error ?? ''), d0?.error);

  // Add a login: the token is write-only.
  const bad = await api('POST', '/settings/registries', { registry: `http://${host}/`, username: USER, password: 'wrong-password' });
  loginId = bad.id;
  check('the registry host is normalized', bad.registry === host, bad.registry);
  check('the API never returns the token', !('password' in bad) && !JSON.stringify(await api('GET', '/settings/registries')).includes('wrong-password'));
  const t0 = await api('POST', `/settings/registries/${bad.id}/test`);
  check('Test: a wrong password is refused', t0.ok === false && /refused/.test(t0.message), JSON.stringify(t0));
  let dup = '';
  await api('POST', '/settings/registries', { registry: host, username: 'other', password: 'x' }).catch((e) => (dup = e.message));
  check('one login per registry', /→ 409/.test(dup), dup);
  await api('POST', '/settings/registries', { id: bad.id, username: USER, password: PW });
  const t1 = await api('POST', `/settings/registries/${bad.id}/test`);
  check('Test: the right password is accepted', t1.ok === true, JSON.stringify(t1));
  const kept = await api('POST', '/settings/registries', { id: bad.id, username: USER });
  check('saving without a token keeps the stored one', (await api('POST', `/settings/registries/${kept.id}/test`)).ok === true);

  const d1 = await api('POST', `/services/${app.id}/deploy`);
  const dep1 = await settle(d1.id);
  const log1 = await logOf(d1.id);
  check('with the login the private image deploys', dep1?.status === 'active', dep1?.error ?? '');
  check('pulled through the Engine API with the dashboard login (no CLI retry)', log1.includes(`Using the registry login for ${host} (Settings → Registry logins)`) && !/Retrying pull with the docker CLI/.test(log1), log1.split('\n').filter((l) => /pull|login|Retrying/i.test(l)).join(' | '));
  check('it runs the first image', (await exec(app.id, 'test -f /etc/alpine-release && echo alpine || echo other')).output.trim() === 'alpine');
  let st = await api('POST', `/services/${app.id}/image-check`);
  check('the update check signs in with the login', st?.status === 'current', JSON.stringify(st));

  // CI pushes a new image under the same tag, then calls the deploy hook.
  push('busybox:1.36');
  sh(`docker tag alpine:3.20 ${ref}`); // the copy on the server stays the old image, as after a real pull
  st = await api('POST', `/services/${app.id}/image-check`);
  check('the update check sees the new push', st?.status === 'changed', JSON.stringify(st));
  const { path } = await api('GET', `/services/${app.id}/deploy-hook`);
  const callHook = async () => {
    const r = await fetch(`http://127.0.0.1:${PROXY}${path}`, { method: 'POST', headers: { host: 'ci.example' } });
    return r.json();
  };
  const h1 = await callHook();
  check('without "pull before every deploy" the hook says it will not pull a fixed tag', h1.ok === true && h1.pull === false, JSON.stringify(h1));
  const dep2 = await settle(h1.deploymentId);
  const log2 = await logOf(h1.deploymentId);
  const ran2 = (await exec(app.id, 'test -f /etc/alpine-release && echo alpine || echo other')).output.trim();
  check('…and redeploys the copy on the server', dep2?.status === 'active' && !/Pulling/.test(log2) && ran2 === 'alpine', `${dep2?.status} ${ran2} ${log2.split('\n').filter((l) => /image|pull/i.test(l)).join(' | ')}`);
  await api('PATCH', `/services/${app.id}`, { pullOnDeploy: true });
  check('the service setting is saved', (await api('GET', `/services/${app.id}`)).pullOnDeploy === true);
  const h2 = await callHook();
  check('with it the hook pulls', h2.ok === true && h2.pull === true, JSON.stringify(h2));
  const dep3 = await settle(h2.deploymentId);
  const log3 = await logOf(h2.deploymentId);
  check('the hook deploy pulled the new push with the login', dep3?.status === 'active' && /Pulling .*\(pull before every deploy\)/.test(log3) && log3.includes(`Using the registry login for ${host}`), dep3?.error ?? log3.split('\n').filter((l) => /pull|login/i.test(l)).join(' | '));
  check('and now runs the new image', (await exec(app.id, 'test -f /etc/alpine-release && echo alpine || echo other')).output.trim() === 'other');
  st = await api('POST', `/services/${app.id}/image-check`);
  check('the update check is current again', st?.status === 'current', JSON.stringify(st));

  // The token is nowhere it shouldn't be.
  const b64 = Buffer.from(`${USER}:${PW}`).toString('base64');
  if (DATA) {
    const hits = execSync(`grep -rlaF -e '${PW}' -e '${b64}' ${JSON.stringify(DATA)} || true`).toString().trim();
    check('the token is nowhere in the data folder in plain text (database, logs)', hits === '', hits);
  }
  const acts = JSON.stringify(await api('GET', '/activity').catch(() => []));
  check('nor in the activity or deployment logs', ![log1, log3, acts].some((t) => t.includes(PW) || t.includes(b64)));

  // Removing the login: a forced pull is refused again.
  await api('DELETE', `/settings/registries/${loginId}`);
  loginId = null;
  check('the login is removed', (await api('GET', '/settings/registries')).length === 0);
  const d4 = await api('POST', `/services/${app.id}/deploy`);
  const dep4 = await settle(d4.id);
  check('without it, "pull before every deploy" fails the deploy and the running version stays', dep4?.status === 'failed' && (await api('GET', `/services/${app.id}`)).activeDeploymentId === h2.deploymentId, dep4?.error);
  await api('DELETE', `/services/${app.id}?deleteVolumes=1&skipSafetyBackup=1`).catch(() => {});
}

async function main() {
  const settings = await api('GET', '/settings');
  const secret = settings.webhooks.secret;
  if (!secret || secret.includes('•')) throw new Error('needs owner access: set SERVIFY_COOKIE or run Servify with SERVIFY_AUTH=none');
  if (process.env.ONLY === 'auth') return authChecks();
  if (process.env.ONLY === 'notify') return notifyChecks();
  const P = await api('POST', '/projects', { name: `features-${Date.now().toString(36)}` });
  projectsToDelete.push(P.id);
  if (process.env.ONLY === 'restarts') return hungReplicaChecks(P);
  if (process.env.ONLY === 'backups') return streamingBackupChecks(P);
  if (process.env.ONLY === 'tokens') return tokenChecks(P);
  if (process.env.ONLY === 'disk') return diskChecks();
  if (process.env.ONLY === 'cron') return cronChecks(P);
  if (process.env.ONLY === 'access') return accessChecks(P);
  if (process.env.ONLY === 'cli') return cliParityChecks(P);
  if (process.env.ONLY === 'mobileapp') return mobileAppChecks();
  if (process.env.ONLY === 'moveproject') return moveProjectChecks();
  if (process.env.ONLY === 'registry') return registryLoginChecks(P);

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

  await streamingBackupChecks(P);

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ safety backups before risky operations');
  {
    execSync('docker pull -q alpine:3.20 && docker pull -q busybox:1.36', { stdio: 'ignore' });
    const keeper = (await api('POST', `/projects/${P.id}/services`, { image: 'alpine:3.20', name: 'keeper', protocol: 'none', startCommand: 'sleep 1d' })).service;
    await running(P.id, 'keeper');
    const kv = await api('POST', `/projects/${P.id}/volumes`, { name: 'keeper-data', serviceId: keeper.id, mountPath: '/data' });
    await waitFor(async () => {
      const s = await api('GET', `/services/${keeper.id}`);
      return s.status === 'running' && (!kv.deployment || s.activeDeploymentId === kv.deployment.id);
    }, 120_000, 'keeper with a volume');
    await exec(keeper.id, 'echo precious > /data/file');
    const svcNow = () => api('GET', `/services/${keeper.id}`);
    const backups = () => api('GET', `/services/${keeper.id}/backups`);
    const logOf = async (depId) => (await api('GET', `/deployments/${depId}/logs`)).map((l) => l.text).join('\n');
    // Only status fields of deployments are looked at (never printed: they carry the environment).
    const finished = (depId) => waitFor(async () => {
      const d = await api('GET', `/deployments/${depId}`);
      return ['active', 'failed', 'cancelled'].includes(d.status) && { id: d.id, status: d.status, error: d.error, safetyRefused: !!d.safetyRefused, safetyBackupId: d.safetyBackupId ?? null };
    }, 240_000, 'the deployment to finish');
    let img = 'alpine:3.20';
    // A new image on the service's data: PATCH + deploy (update-image takes a backup of its own and would prove nothing).
    const newImage = async (body = {}) => {
      img = img === 'alpine:3.20' ? 'busybox:1.36' : 'alpine:3.20';
      await api('PATCH', `/services/${keeper.id}`, { image: img });
      return finished((await api('POST', `/services/${keeper.id}/deploy`, body)).id);
    };
    const dataKept = async () => (await exec(keeper.id, 'cat /data/file').catch(() => ({ output: '' }))).output?.trim() === 'precious';

    let s0 = await svcNow();
    check('without scheduled backups, new images default to no safety backup (deleting volumes still needs one)', s0.safetyPolicy?.deploy.mode === 'off' && s0.safetyPolicy?.delete.mode === 'auto', JSON.stringify(s0.safetyPolicy));
    let d = await newImage();
    check('…so such a deploy goes ahead as before, and its log says there was no backup', d?.status === 'active' && /No safety backup: safety backups are off/.test(await logOf(d.id)) && (await backups()).length === 0, `${d?.status} ${d?.error ?? ''}`);

    await api('PATCH', `/services/${keeper.id}`, { backup: { enabled: true, schedule: '0 3 * * *' } });
    s0 = await svcNow();
    check('with scheduled backups on, the default is: reuse a backup up to 24 h old, else take one', s0.safetyPolicy?.deploy.mode === 'auto' && s0.safetyPolicy?.deploy.maxAgeHours === 24 && !s0.safetyPolicy?.deploy.explicit, JSON.stringify(s0.safetyPolicy?.deploy));
    d = await newImage();
    let bk = await backups();
    let log = d ? await logOf(d.id) : '';
    check('a new image on a service with data takes a safety backup first', d?.status === 'active' && bk.length === 1 && bk[0].trigger === 'safety' && bk[0].status === 'succeeded' && d.safetyBackupId === bk[0].id, `${d?.status} ${d?.error ?? ''} backups=${bk.map((b) => `${b.trigger}:${b.status}`).join(',')}`);
    check('…and allows the longer first-start grace for the new image', /Safety backup: no successful backup .* backing it up/.test(log) && /allowing up to 600s for the first start/.test(log));
    check('…with the data in place afterwards', await dataKept());
    const firstSafety = bk[0]?.id;

    d = await finished((await api('POST', `/services/${keeper.id}/restart`)).id);
    log = d ? await logOf(d.id) : '';
    check('a restart (same image) needs no safety backup', d?.status === 'active' && (await backups()).length === 1 && !/Safety backup/.test(log) && !/allowing up to/.test(log));

    d = await newImage();
    log = d ? await logOf(d.id) : '';
    check('the next new image reuses the recent backup instead of taking another', d?.status === 'active' && (await backups()).length === 1 && /Safety backup: reusing the safety backup from/.test(log) && d.safetyBackupId === firstSafety, `${d?.status} ${d?.error ?? ''}`);

    // Refused: "require" a recent backup when there is none. Nothing changes; the override goes through.
    await api('PATCH', `/services/${keeper.id}`, { safetyBackup: { mode: 'require', maxAgeHours: 1 } });
    for (const b of await backups()) await api('DELETE', `/backups/${b.id}`);
    const activeBefore = (await svcNow()).activeDeploymentId;
    d = await newImage();
    s0 = await svcNow();
    check('without a recent backup ("require"), the deploy is refused and nothing changes', d?.status === 'failed' && d.safetyRefused && /^no safety backup: .*require/.test(d.error ?? '') && s0.activeDeploymentId === activeBefore && s0.status === 'running' && (await dataKept()), `${d?.status} ${d?.error ?? ''}`);
    d = await finished((await api('POST', `/services/${keeper.id}/deploy`, { skipSafetyBackup: true })).id);
    check('…and goes through with skipSafetyBackup, without a backup', d?.status === 'active' && (await backups()).length === 0 && /No safety backup: skipped as asked/.test(await logOf(d.id)) && (await dataKept()), `${d?.status} ${d?.error ?? ''}`);
    const acts = await api('GET', `/projects/${P.id}/activity?limit=50`);
    check('the skip is in the activity log', acts.some((a) => a.action === 'backup.skipped' && a.serviceId === keeper.id));

    // A backup that can't be stored (here: a destination folder that can't exist) refuses the deploy too.
    const nowhere = await api('POST', '/settings/backups/destinations', { name: 'acc-nowhere', type: 'local', path: '/dev/null/servify-acc' });
    cleanups.push(async () => api('DELETE', `/settings/backups/destinations/${nowhere.id}`).catch(() => {}));
    await api('PATCH', `/services/${keeper.id}`, { backup: { destinationId: nowhere.id }, safetyBackup: { mode: 'auto', maxAgeHours: 0 } });
    d = await newImage();
    check('a safety backup that does not fit or cannot be stored refuses the deploy', d?.status === 'failed' && d.safetyRefused && /^no safety backup: (a backup of up to .* doesn't fit on|the backup failed)/.test(d.error ?? '') && (await svcNow()).status === 'running', `${d?.status} ${d?.error ?? ''}`);
    await api('PATCH', `/services/${keeper.id}`, { backup: { destinationId: 'local', enabled: false } });

    // Deleting a volume: blocked without a backup ("require"), unless skipped.
    await api('PATCH', `/services/${keeper.id}`, { safetyBackup: { mode: 'require', maxAgeHours: 1 } });
    const keeperVol = kv.volume.id;
    await api('POST', `/volumes/${keeperVol}/detach`);
    const blocked = await api('DELETE', `/volumes/${keeperVol}`).then(() => 'deleted', (e) => String(e.message));
    check('deleting a volume with no recent backup of it is refused', /→ 409 no safety backup: no recent backup holds volume/.test(blocked) && (await api('GET', `/projects/${P.id}/volumes`)).some((v) => v.id === keeperVol), blocked);
    const forced = await api('DELETE', `/volumes/${keeperVol}?skipSafetyBackup=1`);
    check('…and deleted with skipSafetyBackup', forced.ok && !forced.safetyBackup && !(await api('GET', `/projects/${P.id}/volumes`)).some((v) => v.id === keeperVol));

    // By default deleting a volume takes a backup of it first (an archive of just that volume, listed under its id).
    const spare = (await api('POST', `/projects/${P.id}/services`, { image: 'alpine:3.20', name: 'spare', protocol: 'none', startCommand: 'sleep 1d' })).service;
    await running(P.id, 'spare');
    const sv = await api('POST', `/projects/${P.id}/volumes`, { name: 'spare-data', serviceId: spare.id, mountPath: '/data' });
    await waitFor(async () => {
      const s = await api('GET', `/services/${spare.id}`);
      return s.status === 'running' && (!sv.deployment || s.activeDeploymentId === sv.deployment.id);
    }, 120_000, 'spare with a volume');
    await exec(spare.id, 'echo spare-data > /data/file');
    await api('POST', `/volumes/${sv.volume.id}/detach`);
    const del = await api('DELETE', `/volumes/${sv.volume.id}`);
    const volBackups = await api('GET', `/services/${sv.volume.id}/backups`).catch(() => []);
    check('deleting a volume takes a safety backup of it first', del.ok && del.safetyBackup?.status === 'taken' && volBackups.length === 1 && volBackups[0].status === 'succeeded' && volBackups[0].trigger === 'safety', JSON.stringify(del.safetyBackup ?? null));
    if (volBackups[0]) {
      const dl = await fetch(`${BASE}/api/backups/${volBackups[0].id}/download`, { headers: COOKIE ? { cookie: COOKIE } : {} });
      const buf = Buffer.from(await dl.arrayBuffer());
      check('…which downloads as an archive', dl.status === 200 && buf[0] === 0x1f && buf[1] === 0x8b);
    }

    // Deleting a service with its volumes: a backup first, by default.
    const goner = (await api('POST', `/projects/${P.id}/services`, { image: 'alpine:3.20', name: 'goner', protocol: 'none', startCommand: 'sleep 1d' })).service;
    await running(P.id, 'goner');
    const gv = await api('POST', `/projects/${P.id}/volumes`, { name: 'goner-data', serviceId: goner.id, mountPath: '/data' });
    await waitFor(async () => {
      const s = await api('GET', `/services/${goner.id}`);
      return s.status === 'running' && (!gv.deployment || s.activeDeploymentId === gv.deployment.id);
    }, 120_000, 'goner with a volume');
    await api('DELETE', `/services/${goner.id}?deleteVolumes=1`);
    const gb = await api('GET', `/services/${goner.id}/backups`).catch(() => []);
    check('deleting a service with its volumes backs them up first', gb.length === 1 && gb[0].trigger === 'safety' && gb[0].status === 'succeeded' && !(await api('GET', `/projects/${P.id}/volumes`)).some((v) => v.id === gv.volume.id));
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
  console.log('\n▸ access log');
  await accessLogChecks(P, web);

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
    check('a local-only image is "unknown", never "update available"', (await api('POST', `/services/${mover.id}/image-check`))?.status === 'unknown');
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ image update checks');
  {
    const REG_PORT = 15055;
    const reg = `localhost:${REG_PORT}/acc/app`;
    const sh = (c) => execSync(c, { stdio: 'pipe' }).toString().trim();
    sh(`docker rm -f servify-acc-registry 2>/dev/null || true`);
    sh(`docker run -d --name servify-acc-registry -p ${REG_PORT}:5000 registry:2`);
    cleanups.push(async () => execSync(`docker rm -f servify-acc-registry; docker rmi ${reg}:1.0 ${reg}:1.1 ${reg}:2.0 || true`, { stdio: "ignore" }));
    await waitFor(async () => (await fetch(`http://localhost:${REG_PORT}/v2/`).catch(() => null))?.ok, 30_000, 'registry');
    const push = (from, tag) => sh(`docker tag ${from} ${reg}:${tag} && docker push -q ${reg}:${tag}`);
    sh('docker pull -q busybox:1.36');
    push('alpine:3.20', '1.0');
    sh(`docker rmi ${reg}:1.0`); // Servify pulls it from the registry, so Docker records its registry digest
    await api('POST', '/settings/notifications/channels', { ...ch, events: ['deploy.succeeded', 'deploy.failed', 'server.usage', 'image.update'] });
    const upd = (await api('POST', `/projects/${P.id}/services`, { image: `${reg}:1.0`, name: 'updater', protocol: 'none', startCommand: 'sleep 1d' })).service;
    await running(P.id, 'updater');
    // Image ids change on a registry round-trip (containerd store), so look at what actually runs.
    const imageOf = async () => (await exec(upd.id, 'test -f /etc/alpine-release && echo alpine || echo busybox').catch(() => null))?.output?.trim() ?? null;
    const idOf = (ref) => (ref.startsWith('busybox') ? 'busybox' : 'alpine');
    let st = await api('POST', `/services/${upd.id}/image-check`);
    check('a freshly pulled image is up to date', st?.status === 'current' && !st.newerTag && !st.newerMajor, JSON.stringify(st));
    push('busybox:1.36', '1.0');
    push('alpine:3.20', '1.1');
    push('alpine:3.20', '2.0');
    const notes = () => received.map((r) => JSON.parse(r.body)).filter((b) => b.event === 'image.update' && b.serviceId === upd.id);
    st = await api('POST', `/services/${upd.id}/image-check`);
    check('a new image under the same tag is found', st?.status === 'changed', JSON.stringify(st));
    check('newer tags are found (same major and next major)', st?.newerTag === '1.1' && st?.newerMajor === '2.0', JSON.stringify(st));
    check('the service shows the update', (await api('GET', `/services/${upd.id}`)).imageUpdate?.status === 'changed');
    await waitFor(() => notes().length > 0, 10_000, 'update notification');
    await api('POST', `/services/${upd.id}/image-check`);
    await sleep(1000);
    check('notified once, not on every check', notes().length === 1, String(notes().length));
    const before = (await api('GET', `/services/${upd.id}`)).activeDeploymentId;
    await api('POST', `/services/${upd.id}/update-image`, {});
    await waitFor(async () => (await api('GET', `/services/${upd.id}`)).activeDeploymentId !== before, 120_000, 'update deploy');
    check('updating pulls the new image under the same tag', !!(await waitFor(async () => (await imageOf()) === idOf('busybox:1.36'), 60_000, 'new image')));
    st = await waitFor(async () => {
      const x = (await api('GET', `/services/${upd.id}`)).imageUpdate;
      return x?.status === 'current' ? x : null;
    }, 30_000, 'recheck after the update');
    check('after the update it is up to date again', st?.status === 'current');
    await api('POST', `/services/${upd.id}/update-image`, { tag: '1.1' });
    check('switching to a newer tag deploys it', !!(await waitFor(async () => (await api('GET', `/services/${upd.id}`)).source.image === `${reg}:1.1` && (await imageOf()) === idOf('alpine:3.20'), 120_000, 'tag switch')));
    check('a bad tag is refused', (await api('POST', `/services/${upd.id}/update-image`, { tag: '../x' }).then(() => 'ok', (e) => String(e.message))).includes('→ 400'));
    // Automatic: a new image under the same tag deploys by itself, once.
    await api('PATCH', `/services/${upd.id}`, { imageAutoUpdate: true });
    await waitFor(async () => (await api('GET', `/services/${upd.id}`)).imageUpdate?.ref === `${reg}:1.1`, 30_000, 'recheck of 1.1');
    push('busybox:1.36', '1.1');
    const deps = async () => (await api('GET', `/services/${upd.id}/deployments`)).filter((d) => d.trigger === 'update').length;
    const n0 = await deps();
    await api('POST', `/services/${upd.id}/image-check`);
    check('auto-update deploys the new image', !!(await waitFor(async () => (await imageOf()) === idOf('busybox:1.36'), 120_000, 'auto-update')));
    await sleep(3000);
    await api('POST', `/services/${upd.id}/image-check`);
    await sleep(2000);
    check('and only once', (await deps()) === n0 + 1, `${n0} → ${await deps()}`);
    // With data, a tag switch takes a safety backup first.
    await api('PATCH', `/services/${upd.id}`, { imageAutoUpdate: false });
    const withVol = await api('POST', `/projects/${P.id}/volumes`, { name: 'updater-data', serviceId: upd.id, mountPath: '/data' });
    await waitFor(async () => (await api('GET', `/services/${upd.id}`)).activeDeploymentId === withVol.deployment?.id && (await api('GET', `/services/${upd.id}`)).status === 'running', 120_000, 'updater with a volume');
    const backupsBefore = (await api('GET', `/services/${upd.id}/backups`)).length;
    await api('POST', `/services/${upd.id}/update-image`, { tag: '2.0' });
    const bks = await api('GET', `/services/${upd.id}/backups`);
    check('a tag switch on a service with data backs it up first', bks.length === backupsBefore + 1 && bks[0].status === 'succeeded' && (await api('GET', `/services/${upd.id}`)).source.image === `${reg}:2.0`, JSON.stringify(bks[0] ?? null).slice(0, 200));
    // Unattended: an auto-update of a service with data never takes a backup itself. Without a recent one it waits.
    await waitFor(async () => (await api('GET', `/services/${upd.id}`)).imageUpdate?.ref === `${reg}:2.0`, 60_000, 'recheck of 2.0');
    await sleep(3000); // the check after that deploy may still be finishing: it must not answer for the image pushed next
    await api('PATCH', `/services/${upd.id}`, { imageAutoUpdate: true, safetyBackup: { mode: 'auto', maxAgeHours: 1 } });
    for (const b of await api('GET', `/services/${upd.id}/backups`)) await api('DELETE', `/backups/${b.id}`);
    push('busybox:1.36', '2.0');
    const updates = async () => (await api('GET', `/services/${upd.id}/deployments`)).filter((x) => x.trigger === 'update').length;
    const skipNotes = () => received.map((r) => JSON.parse(r.body)).filter((b) => b.serviceId === upd.id && /^Auto-update of .* skipped$/.test(b.title ?? ''));
    const u0 = await updates();
    await api('POST', `/services/${upd.id}/image-check`);
    await waitFor(() => skipNotes().length > 0, 10_000, 'skip notification');
    const st2 = (await api('GET', `/services/${upd.id}`)).imageUpdate;
    check('the new image under the same tag is found', st2?.status === 'changed', `${st2?.status} ${st2?.reason ?? ''}`);
    await sleep(2000);
    check('an auto-update of a service with data and no recent backup is skipped, and says so', (await updates()) === u0 && skipNotes().length === 1, `${u0} → ${await updates()} updates, ${skipNotes().length} notices`);
    await api('POST', `/services/${upd.id}/image-check`);
    await sleep(1500);
    check('…told once, and still not deployed at the next check', (await updates()) === u0 && skipNotes().length === 1);
    await api('POST', `/services/${upd.id}/backups`, {});
    await api('POST', `/services/${upd.id}/image-check`);
    check('once a recent backup exists, the next check updates it (reusing that backup)', !!(await waitFor(async () => (await imageOf()) === idOf('busybox:1.36'), 120_000, 'auto-update after a backup')) && (await api('GET', `/services/${upd.id}/backups`)).length === 1);
    await api('PATCH', `/services/${upd.id}`, { imageAutoUpdate: false });

    // A pinned local copy (like a migrated image) can be pointed back at its registry image without a redeploy.
    push('alpine:3.20', 'track');
    sh(`docker rmi ${reg}:track && docker pull -q ${reg}:track && docker tag ${reg}:track servify-acc/pinned:copy`);
    cleanups.push(async () => execSync(`docker rmi servify-acc/pinned:copy ${reg}:track || true`, { stdio: 'ignore' }));
    const pin = (await api('POST', `/projects/${P.id}/services`, { image: 'servify-acc/pinned:copy', name: 'pinned', protocol: 'none', startCommand: 'sleep 1d' })).service;
    await running(P.id, 'pinned');
    const pinDep = (await api('GET', `/services/${pin.id}`)).activeDeploymentId;
    const depCount = async () => (await api('GET', `/services/${pin.id}/deployments`)).length;
    const n1 = await depCount();
    check('a pinned local copy is "unknown"', (await api('POST', `/services/${pin.id}/image-check`))?.status === 'unknown');
    const refuse = (body) => api('POST', `/services/${pin.id}/track-image`, body).then(() => 'ok', (e) => String(e.message));
    check('tracking a repository it was not pulled from is refused', (await refuse({ image: 'alpine:3.20' })).includes('→ 409'));
    push('busybox:1.36', 'other');
    check('tracking a different image of that repository is refused', /→ 409.*different image/.test(await refuse({ image: `${reg}:other` })));
    const tr = await api('POST', `/services/${pin.id}/track-image`, { image: `${reg}:track` });
    const after = await api('GET', `/services/${pin.id}`);
    check('tracking the identical registry image works', tr.sameImage === true && after.source.image === `${reg}:track` && tr.imageUpdate?.status === 'current', JSON.stringify(tr.imageUpdate));
    check('without a redeploy or a pending change', after.activeDeploymentId === pinDep && (await depCount()) === n1 && (after.pendingChanges ?? []).length === 0, JSON.stringify(after.pendingChanges));
    // The tag moves on in the registry (copied server-side, so the local tag stays): now it's an update.
    const accept = 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json';
    const mf = await fetch(`http://localhost:${REG_PORT}/v2/acc/app/manifests/other`, { headers: { accept } });
    const mfBody = Buffer.from(await mf.arrayBuffer());
    await fetch(`http://localhost:${REG_PORT}/v2/acc/app/manifests/track`, { method: 'PUT', headers: { 'content-type': mf.headers.get('content-type') }, body: mfBody });
    check('when the tag moves on, the tracked service shows an update', (await api('POST', `/services/${pin.id}/image-check`))?.status === 'changed');
    const pin2 = (await api('POST', `/projects/${P.id}/services`, { image: 'servify-acc/pinned:copy', name: 'pinned-two', protocol: 'none', startCommand: 'sleep 1d' })).service;
    await running(P.id, 'pinned-two');
    check('a tag that moved on is refused by default', /→ 409.*moved on/.test(await api('POST', `/services/${pin2.id}/track-image`, { image: `${reg}:track` }).then(() => 'ok', (e) => String(e.message))));
    const tr2 = await api('POST', `/services/${pin2.id}/track-image`, { image: `${reg}:track`, allowMoved: true });
    check('the tag it was pulled as can be tracked after it moved (and reports the update)', tr2.sameImage === false && tr2.imageUpdate?.status === 'changed', JSON.stringify(tr2.imageUpdate));

    // ─── builds: the base image their Dockerfile starts from ───
    console.log('\n▸ base image update checks (builds)');
    const baseRepo = `localhost:${REG_PORT}/acc/base`;
    const builderRepo = `localhost:${REG_PORT}/acc/builder`;
    cleanups.push(async () => execSync(`docker rmi ${baseRepo}:1.0 ${baseRepo}:1.1 ${baseRepo}:2.0 ${baseRepo}:moved ${builderRepo}:1.0 ${builderRepo}:1.1 ${builderRepo}:moved || true`, { stdio: 'ignore' }));
    // Pushed, then pulled back: the copy on the server is then the registry's image (pushing a multi-platform image
    // from the containerd store uploads only one platform, so the local copy would be a different image).
    const pushTo = (from, repo, tag) => sh(`docker tag ${from} ${repo}:${tag} && docker push -q ${repo}:${tag} && docker rmi ${repo}:${tag} && docker pull -q ${repo}:${tag}`);
    sh('docker pull -q busybox:1.36-musl'); // static: runs in a FROM scratch image
    /** Point a tag at another image in the registry only (the copy on the server keeps the old one). */
    const moveTag = async (repoPath, tag, fromTag) => {
      const m = await fetch(`http://localhost:${REG_PORT}/v2/${repoPath}/manifests/${fromTag}`, { headers: { accept } });
      const body = Buffer.from(await m.arrayBuffer());
      const r = await fetch(`http://localhost:${REG_PORT}/v2/${repoPath}/manifests/${tag}`, { method: 'PUT', headers: { 'content-type': m.headers.get('content-type') }, body });
      if (!r.ok) throw new Error(`moving ${repoPath}:${tag} → ${r.status}`);
    };
    pushTo('alpine:3.20', baseRepo, '1.0'); // stays on the server too: a plain rebuild uses that copy, like a real host
    pushTo('busybox:1.36', baseRepo, 'moved');
    pushTo('busybox:1.36-musl', builderRepo, '1.0');
    pushTo('alpine:3.20', builderRepo, 'moved');
    const buildService = async (name, dockerfile) => {
      const dir = mkdtempSync(join(tmpdir(), `servify-base-${name}-`));
      cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
      writeFileSync(join(dir, 'Dockerfile'), dockerfile);
      const svc = (await api('POST', `/projects/${P.id}/services`, { name, path: dir, protocol: 'none', deploy: false })).service;
      const d = await api('POST', `/services/${svc.id}/deploy`);
      await waitFor(async () => ['active', 'failed'].includes((await api('GET', `/deployments/${d.id}`)).status), 240_000, `${name} build`);
      const dep = await api('GET', `/deployments/${d.id}`);
      check(`${name}: the build deploys`, dep.status === 'active', dep.error ?? dep.status);
      return svc;
    };
    const notesFor = (id) => received.map((r) => JSON.parse(r.body)).filter((b) => b.event === 'image.update' && b.serviceId === id);
    const isAlpine = async (id) => (await exec(id, 'test -f /etc/alpine-release && echo alpine || echo busybox').catch(() => null))?.output?.trim() === 'alpine';

    const app = await buildService('base-app', `ARG BASE_TAG=1.0\nFROM ${baseRepo}:\${BASE_TAG}\nRUN echo built > /built\nCMD ["sleep", "1d"]\n`);
    const multi = await buildService('base-multi', `FROM ${builderRepo}:1.0 AS build\nRUN echo hi > /out\nFROM ${baseRepo}:moved AS final\nCOPY --from=build /out /out\nCMD ["sleep", "1d"]\n`);
    const scratch = await buildService('base-scratch', `FROM ${builderRepo}:1.0 AS build\nFROM scratch\nCOPY --from=build /bin/busybox /busybox\nCMD ["/busybox", "sleep", "86400"]\n`);
    const appView = await api('GET', `/services/${app.id}`);
    check('a build records the base image of its last stage (ARG default filled in)', appView.baseImage === `${baseRepo}:1.0`, String(appView.baseImage));
    st = await api('POST', `/services/${app.id}/image-check`);
    check('a fresh build is up to date with its base', st?.base === true && st.status === 'current' && st.tagArg === 'BASE_TAG' && !st.newerTag && !st.newerMajor, JSON.stringify(st));
    check('multi-stage: the final stage\'s base is checked, not the builder\'s', (await api('GET', `/services/${multi.id}`)).baseImage === `${baseRepo}:moved`);
    const sc = await api('GET', `/services/${scratch.id}`);
    check('FROM scratch: nothing to check', sc.baseImage === null && !sc.imageUpdate && /→ 409/.test(await api('POST', `/services/${scratch.id}/image-check`).then(() => 'ok', (e) => String(e.message))));

    // The base gets newer tags and a rebuild under its own tag; the builder stage's image changes too.
    pushTo('alpine:3.20', baseRepo, '1.1');
    pushTo('alpine:3.20', baseRepo, '2.0');
    await moveTag('acc/base', '1.0', 'moved');
    pushTo('busybox:1.36-musl', builderRepo, '1.1');
    await moveTag('acc/builder', '1.0', 'moved');
    await api('PATCH', `/services/${app.id}`, { imageAutoUpdate: true }); // left over from an image service: must not apply
    const updateDeps = async (id) => (await api('GET', `/services/${id}/deployments`)).filter((d) => d.trigger === 'update').length;
    st = await api('POST', `/services/${app.id}/image-check`);
    check('a rebuilt base image under the same tag is found', st?.base === true && st.status === 'changed', JSON.stringify(st));
    check('newer base tags are found (same major and next major)', st?.newerTag === '1.1' && st?.newerMajor === '2.0', JSON.stringify(st));
    check('the service shows the base image update', (await api('GET', `/services/${app.id}`)).imageUpdate?.base === true);
    await waitFor(() => notesFor(app.id).length > 0, 10_000, 'base update notification');
    await api('POST', `/services/${app.id}/image-check`);
    await sleep(1000);
    const appNotes = notesFor(app.id);
    check('notified once, naming the base image', appNotes.length === 1 && /base image/i.test(appNotes[0]?.message ?? '') && appNotes[0].message.includes('1.1'), JSON.stringify(appNotes.map((n) => n.message)));
    const ms = await api('POST', `/services/${multi.id}/image-check`);
    check('multi-stage: a newer builder image is no base update', ms?.status === 'current' && !ms.newerTag && !ms.newerMajor && notesFor(multi.id).length === 0, JSON.stringify(ms));
    check('a plain build keeps using the copy on the server', await isAlpine(app.id));
    check('builds never update by themselves', (await updateDeps(app.id)) === 0);
    await api('PATCH', `/services/${app.id}`, { imageAutoUpdate: false });
    // Update: pull the base and rebuild.
    const before2 = (await api('GET', `/services/${app.id}`)).activeDeploymentId;
    await api('POST', `/services/${app.id}/update-image`, {});
    const upDep = await waitFor(async () => {
      const s2 = await api('GET', `/services/${app.id}`);
      return s2.activeDeploymentId !== before2 && s2.activeDeploymentId;
    }, 240_000, 'base update rebuild');
    check('updating rebuilds on the freshly pulled base', !!upDep && (await api('GET', `/deployments/${upDep}`)).trigger === 'update' && !(await isAlpine(app.id)));
    st = await waitFor(async () => {
      const x = (await api('GET', `/services/${app.id}`)).imageUpdate;
      return x?.status === 'current' ? x : null;
    }, 30_000, 'recheck after the rebuild');
    check('after the rebuild the base is up to date again', st?.status === 'current' && st.newerTag === '1.1', JSON.stringify(st));
    // The pulled base replaced the server's copy: an ordinary deploy afterwards builds on it too.
    await sleep(1500); // the recheck after the update may still be notifying the newer tags
    const notesBefore = notesFor(app.id).length;
    const plain = await api('POST', `/services/${app.id}/deploy`);
    await waitFor(async () => ['active', 'failed'].includes((await api('GET', `/deployments/${plain.id}`)).status), 240_000, 'plain rebuild');
    st = await api('POST', `/services/${app.id}/image-check`);
    await sleep(1000);
    check('a plain deploy after the update keeps the new base', (await api('GET', `/deployments/${plain.id}`)).status === 'active' && !(await isAlpine(app.id)) && st?.status === 'current' && notesFor(app.id).length === notesBefore, JSON.stringify(st));
    // A newer tag: sets the build argument and rebuilds.
    await api('POST', `/services/${app.id}/update-image`, { tag: '1.1' });
    check('switching to a newer base tag sets the build argument and rebuilds', !!(await waitFor(async () => {
      const s2 = await api('GET', `/services/${app.id}`);
      return s2.buildArgs?.BASE_TAG === '1.1' && s2.baseImage === `${baseRepo}:1.1` && (await isAlpine(app.id));
    }, 240_000, 'base tag switch')));
    check('a base tag written in the Dockerfile is not switched', /→ 409/.test(await api('POST', `/services/${multi.id}/update-image`, { tag: '2.0' }).then(() => 'ok', (e) => String(e.message))));
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ a failed pull fails the deploy (no silent fallback to the cached image)');
  {
    const PORT = 15056;
    const NAME = 'servify-acc-registry-pull';
    const ref = `localhost:${PORT}/acc/pulled:latest`;
    const sh = (c) => execSync(c, { stdio: 'pipe' }).toString().trim();
    const registry = async () => {
      sh(`docker rm -f ${NAME} 2>/dev/null || true`);
      sh(`docker run -d --name ${NAME} -p ${PORT}:5000 registry:2`);
      await waitFor(async () => (await fetch(`http://localhost:${PORT}/v2/`).catch(() => null))?.ok, 30_000, 'registry');
    };
    await registry();
    cleanups.push(async () => execSync(`docker rm -f ${NAME}; docker rmi ${ref} || true`, { stdio: 'ignore' }));
    sh(`docker tag alpine:3.20 ${ref} && docker push -q ${ref} && docker rmi ${ref}`);
    const pulled = (await api('POST', `/projects/${P.id}/services`, { image: ref, name: 'pulled', protocol: 'none', startCommand: 'sleep 1d' })).service;
    await running(P.id, 'pulled');
    const replicasNow = async () => {
      const s = await api('GET', `/services/${pulled.id}`);
      return (await api('GET', `/services/${pulled.id}/metrics?seconds=1`)).replicas.filter((r) => r.deploymentId === s.activeDeploymentId && (r.state === 'healthy' || r.dockerState === 'running'));
    };
    const v1 = (await api('GET', `/services/${pulled.id}`)).activeDeploymentId;
    const cid1 = (await replicasNow())[0]?.containerId;
    const finished = (id) => waitFor(async () => {
      const d = await api('GET', `/deployments/${id}`);
      return ['active', 'failed'].includes(d.status) && d;
    }, 120_000, 'deployment to finish');
    const logOf = async (id) => (await api('GET', `/deployments/${id}/logs`)).map((l) => (typeof l === 'string' ? l : l.text ?? l.line ?? '')).join('\n');
    const failNotes = () => received.map((r) => JSON.parse(r.body)).filter((b) => b.event === 'deploy.failed' && b.serviceId === pulled.id);

    // The registry no longer has the image (an empty one on the same port): the `:latest` re-pull is refused.
    await registry();
    const d2 = await finished((await api('POST', `/services/${pulled.id}/deploy`)).id);
    check('a deploy whose pull is refused ends as failed', d2?.status === 'failed', d2?.status);
    check('the reason is in the deployment error', /^pull failed: not found — /.test(d2?.error ?? ''), d2?.error);
    check('and the cached copy is offered', d2?.cachedImageAvailable === true);
    const after = await api('GET', `/services/${pulled.id}`);
    check('the running version is untouched', after.activeDeploymentId === v1 && after.status === 'running' && (await replicasNow())[0]?.containerId === cid1, `${after.activeDeploymentId} ${after.status}`);
    check('the failed-deploy notification fires', !!(await waitFor(() => failNotes().some((n) => n.deploymentId === d2?.id), 15_000, 'deploy.failed notification')));
    check('no fallback to the cached image', !/using cached image|using the copy|Deploy complete/i.test(await logOf(d2.id)));

    // No registry at all: a short "unreachable" reason.
    sh(`docker rm -f ${NAME}`);
    const d3 = await finished((await api('POST', `/services/${pulled.id}/deploy`)).id);
    check('an unreachable registry fails the deploy too', d3?.status === 'failed' && /^pull failed: registry unreachable — localhost:15056$/.test(d3.error ?? ''), d3?.error);

    // Everything that brings back an image already on the server keeps working without the registry.
    await api('POST', `/services/${pulled.id}/restart`);
    const v4 = await waitFor(async () => {
      const s = await api('GET', `/services/${pulled.id}`);
      return s.activeDeploymentId !== v1 && s.status === 'running' && s.activeDeploymentId;
    }, 120_000, 'restart');
    check('a restart works without the registry', !!v4 && (await api('GET', `/deployments/${v4}`)).trigger === 'restart');
    await api('POST', `/services/${pulled.id}/rollback`, { deploymentId: v1 });
    const v5 = await waitFor(async () => {
      const s = await api('GET', `/services/${pulled.id}`);
      return s.activeDeploymentId !== v4 && s.status === 'running' && s.activeDeploymentId;
    }, 120_000, 'rollback');
    check('a rollback works without the registry', !!v5 && (await api('GET', `/deployments/${v5}`)).trigger === 'rollback');
    const victim = (await replicasNow())[0]?.containerId;
    sh(`docker rm -f ${victim}`);
    check('a crashed replica is re-created without the registry', !!(await waitFor(async () => {
      const r = await replicasNow();
      return r.length === 1 && r[0].containerId !== victim;
    }, 90_000, 'replica re-created')));
    await api('POST', `/services/${pulled.id}/scale`, { replicas: 2 });
    check('scaling up works without the registry', !!(await waitFor(async () => (await replicasNow()).length === 2, 90_000, '2 replicas')));
    check('none of these deployed anything new', (await api('GET', `/services/${pulled.id}`)).activeDeploymentId === v5);

    // The explicit opt-in deploys the copy on the server when the registry is down.
    const d6 = await finished((await api('POST', `/services/${pulled.id}/deploy`, { useCachedImage: true })).id);
    check('useCachedImage deploys the copy on the server', d6?.status === 'active' && /deploying the copy already on this server, as asked/.test(await logOf(d6.id)), d6?.error ?? d6?.status);
    await api('POST', `/services/${pulled.id}/scale`, { replicas: 1 });
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ registry logins (a private registry with a password)');
  const DC = process.env.DOCKER_CONFIG?.replace(/^~/, process.env.HOME);
  if (!DC || resolve(DC) === resolve(join(process.env.HOME, '.docker'))) console.log('  – skipped (set DOCKER_CONFIG to a scratch folder for Servify and this script)');
  else {
    const PORT = 15057;
    const NAME = 'servify-acc-registry-auth';
    const USER = 'acc';
    const PW = 'svf-acc-Rq7w-registry';
    const HASH = '$2y$05$HSSyz7LzJrGSKh3qaewOsuqlyCFzBfBNRDWrjh68PBJ.txKgtIPVy'; // htpasswd -nbB acc <PW>
    const ref = `localhost:${PORT}/acc/private:1.0`;
    const sh = (c) => execSync(c, { stdio: 'pipe' }).toString().trim();
    const authDir = mkdtempSync(join(tmpdir(), 'servify-regauth-'));
    writeFileSync(join(authDir, 'htpasswd'), `${USER}:${HASH}\n`);
    sh(`docker rm -f ${NAME} 2>/dev/null || true`);
    sh(`docker run -d --name ${NAME} -p ${PORT}:5000 -v ${authDir}:/auth -e REGISTRY_AUTH=htpasswd -e REGISTRY_AUTH_HTPASSWD_REALM=acc -e REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd registry:2`);
    const cfgPath = join(DC, 'config.json');
    const cfgBefore = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : null;
    cleanups.push(async () => {
      execSync(`docker rm -f ${NAME}; docker rmi ${ref} || true`, { stdio: 'ignore' });
      rmSync(authDir, { recursive: true, force: true });
      if (cfgBefore === null) rmSync(cfgPath, { force: true });
      else writeFileSync(cfgPath, cfgBefore);
    });
    check('the registry refuses anonymous requests', !!(await waitFor(async () => (await fetch(`http://localhost:${PORT}/v2/`).catch(() => null))?.status === 401, 30_000, 'registry')));
    // What `docker login` writes without a credential store (a scratch config, never the user's).
    const cfg = cfgBefore ? JSON.parse(cfgBefore) : {};
    cfg.auths = { ...(cfg.auths ?? {}), [`localhost:${PORT}`]: { auth: Buffer.from(`${USER}:${PW}`).toString('base64') } };
    writeFileSync(cfgPath, JSON.stringify(cfg));
    sh(`docker tag alpine:3.20 ${ref} && docker push -q ${ref} && docker rmi ${ref}`);
    const priv = (await api('POST', `/projects/${P.id}/services`, { image: ref, name: 'private', protocol: 'none', startCommand: 'sleep 1d' })).service;
    const ok = await running(P.id, 'private');
    const dep = ok ? await api('GET', `/deployments/${ok.activeDeploymentId}`) : null;
    const log = dep ? (await api('GET', `/deployments/${dep.id}/logs`)).map((l) => (typeof l === 'string' ? l : l.text ?? l.line ?? '')).join('\n') : '';
    check('a private image deploys', dep?.status === 'active', dep?.error ?? '');
    check('pulled through the Engine API with the saved login', log.includes(`Using the saved docker login for localhost:${PORT}`) && !/Retrying pull with the docker CLI/.test(log), log.split('\n').filter((l) => /pull|login|Retrying/i.test(l)).join(' | '));
    let st = await api('POST', `/services/${priv.id}/image-check`);
    check('the update check reaches the private registry', st?.status === 'current', JSON.stringify(st));
    sh(`docker tag busybox:1.36 ${ref} && docker push -q ${ref} && docker rmi ${ref}`);
    st = await api('POST', `/services/${priv.id}/image-check`);
    check('and sees a new image under the same tag', st?.status === 'changed', JSON.stringify(st));
    const b64 = Buffer.from(`${USER}:${PW}`).toString('base64');
    if (DATA) {
      const hits = sh(`grep -rlaF -e '${PW}' -e '${b64}' ${JSON.stringify(DATA)} || true`);
      check('the password is nowhere in the data folder (database, logs)', hits === '', hits);
    }
    const acts = JSON.stringify(await api('GET', '/activity').catch(() => []));
    check('nor in the activity, deployment log or notifications', !log.includes(PW) && !acts.includes(PW) && !received.some((r) => r.body.includes(PW) || r.body.includes(b64)));
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
  console.log('\n▸ database browser');
  {
    const q = (id, sql, opts = {}) => api('POST', `/services/${id}/db/query`, { sql, ...opts });
    const pg = (await api('POST', `/projects/${P.id}/services`, { name: 'browse-pg', image: 'postgres:16-alpine', protocol: 'none', env: { POSTGRES_PASSWORD: 'pw', POSTGRES_DB: 'app' } })).service;
    const my = (await api('POST', `/projects/${P.id}/services`, { name: 'browse-my', image: 'mariadb:11', protocol: 'none', env: { MARIADB_ROOT_PASSWORD: 'pw', MARIADB_DATABASE: 'shop' } })).service;
    await waitFor(async () => (await exec(pg.id, 'pg_isready -q -U postgres -h 127.0.0.1').catch(() => null))?.exitCode === 0, 120_000, 'postgres ready');
    const created = await q(pg.id, `CREATE TABLE people (id serial PRIMARY KEY, name text, note text); INSERT INTO people (name, note) VALUES ('ada', NULL), ('bob', ''), ('cy', E'a,b\n"c"')`, { write: true });
    check('a write query reports what it did', /INSERT 0 3/.test(created.message ?? ''), JSON.stringify(created));
    const info = await api('GET', `/services/${pg.id}/db`);
    check('lists the databases, current first', info.kind === 'postgres' && info.current === 'app' && info.databases[0] === 'app' && info.databases.includes('postgres'), JSON.stringify(info));
    const tbls = await api('GET', `/services/${pg.id}/db/tables?db=app`);
    check('lists the tables', tbls.some((t) => t.schema === 'public' && t.name === 'people' && t.kind === 'table'), JSON.stringify(tbls));
    const page = await api('GET', `/services/${pg.id}/db/rows?db=app&schema=public&table=people&order=name&dir=desc`);
    check('pages through rows, sorted', page.total === 3 && page.columns.join() === 'id,name,note' && page.rows.map((r) => r[1]).join() === 'cy,bob,ada', JSON.stringify(page.rows));
    check('NULL, empty strings, commas, quotes and newlines survive', page.rows[2][2] === null && page.rows[1][2] === '' && page.rows[0][2] === 'a,b\n"c"', JSON.stringify(page.rows));
    check('column types are shown', page.types.name === 'text' && page.types.id === 'integer', JSON.stringify(page.types));
    const two = await api('GET', `/services/${pg.id}/db/rows?db=app&schema=public&table=people&order=id&limit=2&offset=2`);
    check('limit and offset', two.rows.length === 1 && two.rows[0][1] === 'cy');
    const sel = await q(pg.id, 'SELECT name, length(name) AS n FROM people ORDER BY id', { db: 'app' });
    check('a query returns columns and rows', sel.columns.join() === 'name,n' && sel.rows.length === 3 && sel.rows[0].join() === 'ada,3', JSON.stringify(sel));
    const ro = await q(pg.id, `UPDATE people SET name = 'x'`, { db: 'app' }).then(() => 'ran', (e) => String(e.message));
    check('queries are read-only unless writes are allowed', /read-only/.test(ro) && /Allow writes/.test(ro), ro);
    check('the update did not happen', (await q(pg.id, `SELECT count(*) FROM people WHERE name = 'x'`, { db: 'app' })).rows[0][0] === '0');
    const bad = await q(pg.id, 'SELEC 1', { db: 'app' }).then(() => 'ran', (e) => String(e.message));
    check('SQL errors come back readable', /syntax error/.test(bad) && bad.includes('→ 400'), bad);
    check('an unknown table is a 404', (await api('GET', `/services/${pg.id}/db/rows?db=app&schema=public&table=nope`).then(() => 'ok', (e) => String(e.message))).includes('→ 404'));
    if (DATA) {
      const tok = execSync(`node --disable-warning=ExperimentalWarning server/bin/servify.mjs token acceptance-ro2 --read`, { env: { ...process.env, SERVIFY_DATA_DIR: DATA } }).toString().match(/svf_[A-Za-z0-9_-]+/)?.[0];
      const r = await fetch(`${BASE}/api/services/${pg.id}/db/rows?db=app&schema=public&table=people`, { headers: { authorization: `Bearer ${tok}` } });
      check('read-only tokens cannot read database contents', r.status === 403);
    }
    // MariaDB
    // `mariadb-admin ping` already succeeds while the image is still initialising; wait for a real login.
    await waitFor(async () => (await exec(my.id, `mariadb -uroot -ppw -e 'select 1' shop`).catch(() => null))?.exitCode === 0, 180_000, 'mariadb ready');
    await q(my.id, `CREATE TABLE items (id int PRIMARY KEY, title varchar(50), note text); INSERT INTO items VALUES (1, 'pen', NULL), (2, 'tab\there', 'line1\nline2')`, { db: 'shop', write: true });
    const minfo = await api('GET', `/services/${my.id}/db`);
    check('MySQL: lists its databases', minfo.kind === 'mysql' && minfo.databases.includes('shop') && !minfo.databases.includes('mysql'), JSON.stringify(minfo));
    const mrows = await api('GET', `/services/${my.id}/db/rows?db=shop&table=items&order=id`);
    check('MySQL: rows with NULL, tabs and newlines', mrows.total === 2 && mrows.rows[0][2] === null && mrows.rows[1][1] === 'tab\there' && mrows.rows[1][2] === 'line1\nline2', JSON.stringify(mrows.rows));
    const mro = await q(my.id, `DELETE FROM items`, { db: 'shop' }).then(() => 'ran', (e) => String(e.message));
    check('MySQL: read-only unless writes are allowed', /READ ONLY/i.test(mro), mro);
    check('a non-database service is refused', (await api('GET', `/services/${pg.id === my.id ? '' : (await svcOf(P.id, 'web')).id}/db`).then(() => 'ok', (e) => String(e.message))).includes('→ 400'));
    await api('DELETE', `/services/${pg.id}`);
    await api('DELETE', `/services/${my.id}`);
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ servify CLI (login, up, link, run, logs, deploy)');
  if (DATA) {
    const home = mkdtempSync(join(tmpdir(), 'servify-cli-home-'));
    const dir = mkdtempSync(join(tmpdir(), 'servify-cli-app-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }), () => rmSync(dir, { recursive: true, force: true }));
    const tok = execSync(`node --disable-warning=ExperimentalWarning server/bin/servify.mjs token acceptance-cli`, { env: { ...process.env, SERVIFY_DATA_DIR: DATA } }).toString().match(/svf_[A-Za-z0-9_-]+/)?.[0];
    const env = { ...process.env, SERVIFY_CLI_HOME: home, SERVIFY_URL: '', SERVIFY_TOKEN: '', NO_COLOR: '1' };
    delete env.SERVIFY_URL;
    delete env.SERVIFY_TOKEN;
    const cli = (args, opts = {}) => {
      try {
        return { code: 0, out: execSync(`node --disable-warning=ExperimentalWarning ${join(process.cwd(), 'server/bin/servify.mjs')} ${args}`, { cwd: opts.cwd ?? dir, env: { ...env, ...(opts.env ?? {}) }, stdio: 'pipe', timeout: 240_000 }).toString() };
      } catch (e) {
        return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
      }
    };
    const login = cli(`login ${BASE} --token ${tok}`);
    check('login saves the URL and token', login.code === 0 && /Logged in/.test(login.out) && (statSync(join(home, 'cli.json')).mode & 0o777) === 0o600, login.out);
    writeFileSync(join(dir, 'Dockerfile'), 'FROM nginx:alpine\nCOPY . /usr/share/nginx/html/\n');
    writeFileSync(join(dir, 'index.html'), 'cli v1');
    writeFileSync(join(dir, '.gitignore'), 'secret.env\n');
    writeFileSync(join(dir, 'secret.env'), 'TOKEN=do-not-upload');
    git(dir, 'init -q -b main');
    git(dir, 'add .');
    git(dir, 'commit -qm first');
    const host = `cli-app.${P.slug}.localhost`;
    const first = cli(`up --project ${P.id} --service cli-app`);
    check('`up` creates the service, uploads and deploys', first.code === 0 && /Created cli-app/.test(first.out) && /Deployed/.test(first.out), first.out.slice(-600));
    check('the uploaded code is served', !!(await waitFor(async () => (await hit(host)).body === 'cli v1', 60_000, 'cli v1')));
    check('git-ignored files are not uploaded', (await hit(host, '/secret.env')).status === 404);
    const linked = cli(`link ${P.id} cli-app`);
    check('`link` remembers the folder', linked.code === 0 && /cli-app/.test(linked.out), linked.out);
    writeFileSync(join(dir, 'index.html'), 'cli v2');
    const second = cli('up');
    check('`up` in a linked folder deploys local changes', second.code === 0 && /Deployed/.test(second.out), second.out.slice(-400));
    check('the change is live', !!(await waitFor(async () => (await hit(host)).body === 'cli v2', 60_000, 'cli v2')));
    const svc = await svcOf(P.id, 'cli-app');
    const dep = await api('GET', `/deployments/${svc.activeDeploymentId}`);
    check('the deployment names the commit and local changes', /@ [0-9a-f]{7}\+changes/.test(dep.sourceLabel) && dep.commitMessage === 'first', `${dep.sourceLabel} · ${dep.commitMessage}`);
    const st = cli('status');
    check('`status` lists the services', st.code === 0 && /cli-app\s+running/.test(st.out), st.out);
    await api('PUT', `/services/${svc.id}/variables`, { variables: { GREETING: 'hello from servify' } });
    const ran = cli(`run -- node -e "console.log('got:' + process.env.GREETING)"`);
    check('`run` injects the service variables', ran.code === 0 && ran.out.includes('got:hello from servify'), ran.out);
    const ex = cli('exec cat /usr/share/nginx/html/index.html');
    check('`exec` runs inside the service', ex.code === 0 && ex.out.trim() === 'cli v2', ex.out);
    const bl = cli('logs --build');
    check('`logs --build` shows the last build', bl.code === 0 && /Building the upload/.test(bl.out) && /Deployed/.test(bl.out), bl.out.slice(-300));
    const dp = cli('deploy');
    check('`deploy` rebuilds the last upload', dp.code === 0 && /Deployed/.test(dp.out), dp.out.slice(-300));
    const bad = cli('status', { env: { SERVIFY_TOKEN: 'svf_nope' } });
    check('a bad token fails clearly', bad.code === 1 && /rejected/.test(bad.out), bad.out);
    const guarded = cli(`up --project ${P.id} --service web`);
    check('`up` won’t replace an image service’s source without --replace', guarded.code === 1 && /--replace/.test(guarded.out) && (await svcOf(P.id, 'web')).source.type === 'image', guarded.out);
    const elsewhere = cli('status', { cwd: home });
    check('an unlinked folder says how to link', elsewhere.code === 1 && /servify link/.test(elsewhere.out), elsewhere.out);
    // Unsafe archive entries never leave the upload folder.
    const { tarEntry, tarEnd } = await import('../server/src/tar.ts');
    const { gzipSync } = await import('node:zlib');
    const evil = gzipSync(Buffer.concat([...tarEntry('Dockerfile', Buffer.from('FROM nginx:alpine\n')), ...tarEntry('../escaped.txt', Buffer.from('x')), ...tarEntry('/abs.txt', Buffer.from('x')), tarEnd()]));
    const up = await fetch(`${BASE}/api/services/${svc.id}/upload?deploy=0`, { method: 'POST', headers: { 'content-type': 'application/gzip', ...(COOKIE ? { cookie: COOKIE } : {}) }, body: evil }).then((r) => r.json());
    check('unsafe paths in an upload are skipped', up.skipped?.includes('../escaped.txt') && !existsSync(join(DATA, 'uploads', svc.id, 'escaped.txt')) && up.source?.files === 1, JSON.stringify(up));
    const junk = await fetch(`${BASE}/api/services/${svc.id}/upload?deploy=0`, { method: 'POST', headers: { 'content-type': 'application/gzip', ...(COOKIE ? { cookie: COOKIE } : {}) }, body: 'not a tarball' });
    check('a broken upload is refused', junk.status === 400);
    await api('DELETE', `/services/${svc.id}`);
    check('deleting the service removes its uploads', !existsSync(join(DATA, 'uploads', svc.id)));
  } else console.log('  – skipped (set SERVIFY_DATA_DIR)');
  await cliParityChecks(P);

  // ─────────────────────────────────────────────────────────────
  console.log('\n▸ app sleeping');
  if (process.env.SERVIFY_SLEEP_UNIT_MS) {
    const sl = (await api('POST', `/projects/${P.id}/services`, { name: 'sleeper', image: 'nginx:alpine', port: 80 })).service;
    await running(P.id, 'sleeper');
    const host = `sleeper.${P.slug}.localhost`;
    check('it serves before sleeping', (await waitFor(async () => (await hit(host)).status === 200, 30_000, 'sleeper up')) === true);
    const worker = (await api('POST', `/projects/${P.id}/services`, { name: 'no-sleep', image: 'alpine:3.20', protocol: 'none', startCommand: 'sleep 1d', deploy: false })).service;
    check('only HTTP services can sleep', (await api('PATCH', `/services/${worker.id}`, { sleepAfterMinutes: 5 }).then(() => 'ok', (e) => String(e.message))).includes('→ 400'));
    await api('DELETE', `/services/${worker.id}`);
    await api('PATCH', `/services/${sl.id}`, { sleepAfterMinutes: 1 });
    const asleep = await waitFor(async () => (await api('GET', `/services/${sl.id}`)).status === 'sleeping', 30_000, 'asleep');
    check('an idle service goes to sleep', !!asleep);
    const reps = (await api('GET', `/services/${sl.id}/metrics?seconds=10`)).replicas;
    check('its containers are stopped, not removed', reps.length === 1 && reps[0].dockerState !== 'running', JSON.stringify(reps.map((r) => r.dockerState)));
    await sleep(3000);
    check('and it stays asleep (no restarts, no crash)', (await api('GET', `/services/${sl.id}`)).status === 'sleeping');
    const t0 = Date.now();
    const woke = await hit(host);
    check('a request wakes it and gets the answer', woke.status === 200 && /nginx/i.test(woke.body), `${woke.status} after ${Date.now() - t0} ms`);
    console.log(`    (woke in ${Date.now() - t0} ms)`);
    check('it is running again', (await waitFor(async () => (await api('GET', `/services/${sl.id}`)).status === 'running', 15_000, 'running')) === true);
    // A long download (or WebSocket) that's still open counts as activity.
    await exec(sl.id, 'dd if=/dev/zero of=/usr/share/nginx/html/big bs=1M count=200 2>/dev/null');
    const slow = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: PROXY, path: '/big', headers: { host }, agent: false }, (res) => {
        res.once('data', () => {
          res.pause();
          resolve(req);
        });
      });
      req.on('error', () => resolve(null));
    });
    await sleep(7000); // three and a half idle "minutes"
    check('an open download keeps it awake', !!slow && (await api('GET', `/services/${sl.id}`)).status === 'running');
    slow?.destroy();
    await waitFor(async () => (await api('GET', `/services/${sl.id}`)).status === 'sleeping', 30_000, 'asleep again');
    const before = (await api('GET', `/services/${sl.id}`)).activeDeploymentId;
    await api('POST', `/services/${sl.id}/deploy`);
    const redeployed = await waitFor(async () => {
      const x = await api('GET', `/services/${sl.id}`);
      return x.activeDeploymentId !== before && (await api('GET', `/deployments/${x.activeDeploymentId}`)).status === 'active';
    }, 120_000, 'deploy while asleep');
    check('a deploy wakes it', !!redeployed);
    await api('PATCH', `/services/${sl.id}`, { sleepAfterMinutes: null });
    check('turning it off wakes it and keeps it running', !!(await waitFor(async () => (await api('GET', `/services/${sl.id}`)).status === 'running', 30_000, 'awake for good')));
    await sleep(4000);
    check('and it stays up', (await api('GET', `/services/${sl.id}`)).status === 'running');
    await api('DELETE', `/services/${sl.id}`);
  } else console.log('  – skipped (run Servify with SERVIFY_SLEEP_UNIT_MS)');

  await diskChecks();
  await hungReplicaChecks(P);

  await moveProjectChecks();

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

  // Last: without trust its hook check locks 127.0.0.1 out of the deploy hooks for a while.
  await accessChecks(P);
}

/** Router access log: one record per request, no IPs, read-only tokens over REST and MCP, filters, paging, on/off. */
async function accessLogChecks(P, web) {
  await running(P.id, 'web');
  const host = `web.${P.slug}.localhost`;
  const ua = 'Mozilla/5.0 (Macintosh) AccessLogTest/1.0';
  // A canary client address behind a "trusted proxy": needs SERVIFY_TRUSTED_PROXIES=127.0.0.1 on the instance.
  const canaryIp = '203.0.113.' + (10 + Math.floor(Math.random() * 200));
  const send = (path, headers = {}) =>
    new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: PROXY, path, headers: { host, 'user-agent': ua, ...headers }, agent: false, timeout: 8000 }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', () => resolve(0));
    });
  const t0 = Date.now();
  await send('/al-home?utm_source=newsletter&utm_medium=email', { referer: 'https://news.example.org/post/1', 'x-forwarded-for': canaryIp });
  await send('/al-home', { 'x-forwarded-for': canaryIp });
  await send('/al-about', { 'x-forwarded-for': '198.51.100.7', 'user-agent': 'Mozilla/5.0 (X11; Linux) AccessLogTest/2.0' });
  // Same agent, two forwarded addresses: told apart only when the instance trusts 127.0.0.1 as a proxy.
  await send('/al-xff-a', { 'x-forwarded-for': '198.51.100.21', 'user-agent': 'AccessLogTest-Xff/1.0 Mozilla/5.0' });
  await send('/al-xff-b', { 'x-forwarded-for': '198.51.100.22', 'user-agent': 'AccessLogTest-Xff/1.0 Mozilla/5.0' });
  await send('/al-home', { 'user-agent': 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)' });
  await send('/al-home', { 'user-agent': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)' });

  const svcView = await api('GET', `/services/${web.id}`);
  check('the access log is on by default', svcView.accessLog === true);

  const { token: readToken } = await api('POST', '/tokens', { name: 'access-log-reader', scope: 'read' });
  const asReader = async (path) => {
    const r = await fetch(BASE + '/api' + path, { headers: { authorization: `Bearer ${readToken}` } });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const page1 = await asReader(`/services/${web.id}/access-log?since=${t0 - 1000}&limit=100`);
  check('a read-only token can read the access log', page1.status === 200 && Array.isArray(page1.json.entries), `${page1.status}`);
  const mine = (page1.json.entries ?? []).filter((e) => e.path.startsWith('/al-'));
  check('one record per request', mine.length === 7, `${mine.length} records`);
  const first = mine.find((e) => e.path.includes('utm_source'));
  check(
    'records carry time, host, method, path+query, status, bytes, duration, referrer, user agent and replica',
    first && first.host === host && first.method === 'GET' && first.status === 200 && first.bytes > 0 && typeof first.ms === 'number' && first.referrer === 'https://news.example.org/post/1' && first.userAgent === ua && first.replica === 0 && !Number.isNaN(Date.parse(first.time)),
    JSON.stringify(first),
  );
  const homes = mine.filter((e) => !e.bot && e.path.startsWith('/al-home'));
  const about = mine.find((e) => e.path === '/al-about');
  check('same address + user agent → same visitor key', homes.length === 2 && homes[0].visitor === homes[1].visitor);
  check('another visitor → another visitor key', about && about.visitor !== homes[0]?.visitor);
  const xa = mine.find((e) => e.path === '/al-xff-a');
  const xb = mine.find((e) => e.path === '/al-xff-b');
  if (TRUSTS_LOCAL) check('X-Forwarded-For from a trusted proxy tells visitors apart', xa && xb && xa.visitor !== xb.visitor);
  else check('X-Forwarded-For from an untrusted peer is ignored (no spoofed visitors)', xa && xb && xa.visitor === xb.visitor);
  check('no IP address in any record', !JSON.stringify(page1.json).includes(canaryIp) && !/198\.51\.100\./.test(JSON.stringify(page1.json)));
  check('crawlers are flagged as bots', mine.filter((e) => e.bot).length === 2);

  const p404 = await asReader(`/services/${web.id}/access-log?since=${t0 - 1000}&path=/al-about&status=2xx`);
  check('path and status filters', p404.json.entries?.length === 1 && p404.json.entries[0].path === '/al-about');
  const qf = await asReader(`/services/${web.id}/access-log?since=${t0 - 1000}&q=GPTBot`);
  check('text search over user agents', qf.json.entries?.length === 1);
  const pageA = await asReader(`/services/${web.id}/access-log?since=${t0 - 1000}&path=/al-&limit=3`);
  const pageB = await asReader(`/services/${web.id}/access-log?since=${t0 - 1000}&path=/al-&limit=3&before=${pageA.json.next}`);
  const pageC = await asReader(`/services/${web.id}/access-log?since=${t0 - 1000}&path=/al-&limit=3&before=${pageB.json.next}`);
  const paged = [...pageA.json.entries, ...pageB.json.entries, ...pageC.json.entries].map((e) => e.id);
  check('paging walks every record once', new Set(paged).size === 7 && paged.length === 7 && pageC.json.next === null, JSON.stringify(paged));

  const sum = await asReader(`/services/${web.id}/access-log/summary`);
  const S = sum.json;
  check('summary: requests with bots apart', sum.status === 200 && S.requests.humans >= 3 && S.requests.bots >= 2, JSON.stringify(S.requests));
  check('summary: unique visitors', S.uniqueVisitors?.humans >= 2, JSON.stringify(S.uniqueVisitors));
  check('summary: top paths, referrers, UTM sources, user agents and bots', S.topPaths.some((p) => p.path === '/al-home' && p.requests >= 2) && S.topReferrers.some((r) => r.host === 'news.example.org') && S.topUtm.some((u) => u.source.startsWith('newsletter')) && S.topUserAgents.some((u) => u.userAgent === ua) && S.topBots.some((b) => b.name === 'GPTBot') && S.topBots.some((b) => b.name === 'ClaudeBot'), JSON.stringify(S).slice(0, 300));
  check('summary: a bad day is a clean 400', (await asReader(`/services/${web.id}/access-log/summary?day=yesterday`)).status === 400);
  // The traffic board: newest requests across services (no visitor key) and 24-hour totals per service.
  const recent = await asReader('/access-log/recent?limit=200');
  const feed = (recent.json.entries ?? []).filter((e) => e.serviceId === web.id);
  check('traffic board: a read-only token reads the cross-service feed', recent.status === 200 && feed.length >= 5 && typeof recent.json.last === 'number', `${recent.status} ${feed.length}`);
  check('traffic board: the feed carries no visitor key, IP or user agent', feed.every((e) => !('visitor' in e) && !('ip' in e) && !('userAgent' in e)) && feed.some((e) => e.botName === 'GPTBot'));
  const newer = await asReader(`/access-log/recent?after=${recent.json.last}`);
  check('traffic board: polling with after= returns only newer requests', newer.status === 200 && newer.json.entries.every((e) => e.id > recent.json.last));
  // Totals are cached for 15 s (the board polls them), so give them one refresh.
  let wt = null;
  for (let i = 0; i < 20 && !(wt && wt.requests >= 5 && wt.bots >= 2 && wt.visitors >= 2); i++) {
    if (i) await new Promise((r) => setTimeout(r, 1000));
    wt = (await asReader('/access-log/totals?hours=24')).json.services?.[web.id] ?? null;
  }
  check('traffic board: 24-hour totals per service', wt && wt.requests >= 5 && wt.bots >= 2 && wt.visitors >= 2, JSON.stringify(wt));
  check('a read-only token cannot switch the log off', (await fetch(BASE + `/api/services/${web.id}`, { method: 'PATCH', headers: { authorization: `Bearer ${readToken}`, 'content-type': 'application/json' }, body: '{"accessLog":false}' })).status === 403);

  // MCP with the same read-only token.
  const mcp = async (name, args) => {
    const r = await fetch(BASE + '/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${readToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const j = await r.json().catch(() => ({}));
    const text = j.result?.content?.[0]?.text ?? '';
    try {
      return { error: j.result?.isError ? text : null, data: JSON.parse(text) };
    } catch {
      return { error: text || JSON.stringify(j).slice(0, 200), data: null };
    }
  };
  const ml = await mcp('get_access_log', { service: `${P.slug}/web`, since_minutes: 10, path: '/al-', bot: false });
  check('MCP get_access_log works with a read-only token and filters', !ml.error && ml.data?.entries?.length === 5, ml.error ?? '');
  const ms = await mcp('get_access_summary', { service: web.id });
  check('MCP get_access_summary works with a read-only token', !ms.error && ms.data?.requests?.bots >= 2, ms.error ?? '');

  // Scoping: another service's log never shows these requests.
  const other = (await api('POST', `/projects/${P.id}/services`, { image: 'traefik/whoami', name: 'other-site' })).service;
  const otherLog = await asReader(`/services/${other.id}/access-log?since=${t0 - 1000}`);
  check("a service's log holds only its own requests", otherLog.status === 200 && otherLog.json.entries.length === 0);
  const early = (await hit(`other-site.${P.slug}.localhost`, '/too-early')).status;
  const earlyLog = (await asReader(`/services/${other.id}/access-log?path=/too-early`)).json.entries?.[0];
  if (early === 503) check("Servify's own answers are recorded too (503 while starting)", earlyLog?.status === 503 && earlyLog.bytes > 0, JSON.stringify(earlyLog));
  else console.log(`  – skipped the 503 check (the new service answered ${early} already)`);
  await api('DELETE', `/services/${other.id}`).catch(() => {});

  // WebSocket upgrade (whoami's /echo): one record with the upstream's 101, written when the socket closes.
  const ws = await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PROXY,
      path: '/echo',
      headers: { host, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'user-agent': ua },
    });
    req.on('upgrade', (res, socket) => {
      socket.end();
      resolve(res.statusCode);
    });
    req.on('response', (res) => resolve(res.statusCode));
    req.on('error', () => resolve(0));
    req.end();
  });
  const wsLog = await waitFor(async () => (await asReader(`/services/${web.id}/access-log?since=${t0 - 1000}&path=/echo`)).json.entries, 10_000, 'websocket record');
  check('WebSocket upgrades are recorded', ws === 101 && wsLog?.length === 1 && wsLog[0].status === 101, `${ws} ${JSON.stringify(wsLog)}`);

  // Redirect services.
  const redir = (await api('POST', `/projects/${P.id}/services`, { redirect: 'https://example.com', name: 'old-name' })).service;
  const rhost = new URL((await api('GET', `/services/${redir.id}`)).url).hostname;
  const rs = (await hit(rhost, '/old?x=1')).status;
  const rlog = (await asReader(`/services/${redir.id}/access-log`)).json.entries ?? [];
  check('redirect services are recorded', rs === 308 && rlog.length === 1 && rlog[0].status === 308 && rlog[0].path === '/old?x=1', `${rs} ${JSON.stringify(rlog)}`);

  // Switch off: nothing recorded; on again: recorded.
  await api('PATCH', `/services/${web.id}`, { accessLog: false });
  check('the switch is PATCH-able', (await api('GET', `/services/${web.id}`)).accessLog === false);
  await send('/al-off');
  await api('PATCH', `/services/${web.id}`, { accessLog: true });
  await send('/al-on');
  const after = await asReader(`/services/${web.id}/access-log?since=${t0 - 1000}&path=/al-o`);
  check('switched off records nothing, back on records again', after.json.entries?.length === 1 && after.json.entries[0].path === '/al-on', JSON.stringify(after.json.entries?.map((e) => e.path)));

  if (DATA) {
    await sleep(1500);
    const files = ['servify.db', 'servify.db-wal'].map((f) => join(DATA, f)).filter(existsSync);
    const leaked = files.filter((f) => readFileSync(f).includes(canaryIp));
    check('no client IP in the database files', leaked.length === 0, leaked.join(', '));
  }
}

/**
 * Router access control: IP lists (direct, X-Forwarded-For with and without trust, IPv6), the untrusted-proxy warning,
 * basic auth (401, exempt paths, ACME, brute force), rate limits, WebSockets, HTTPS, TCP proxy ports, deploy-hook limits,
 * MCP, exports, the local CA fingerprint (B1) and the dashboard domain (B2).
 */
async function accessChecks(P) {
  console.log('\n▸ access control: setup');
  const { X509Certificate } = await import('node:crypto');
  const web = (await api('POST', `/projects/${P.id}/services`, { image: 'traefik/whoami', name: 'guarded' })).service;
  await running(P.id, 'guarded');
  const host = `guarded.${P.slug}.localhost`;
  const fresh = await api('GET', `/services/${web.id}`);
  check('access control is off for a new service', fresh.access === null && Array.isArray(fresh.accessWarnings) && fresh.accessWarnings.length === 0, JSON.stringify(fresh.access));
  const caInfo = await api('GET', '/certs/local-ca');
  const CA = caInfo.pem;
  /** One request through the router (or anywhere): status, headers, body. */
  const request = (o) =>
    new Promise((resolve) => {
      const mod = o.tls ? https : http;
      const req = mod.request(
        { host: '127.0.0.1', port: o.port ?? (o.tls ? HTTPS_PORT : PROXY), path: o.path ?? '/', method: o.method ?? 'GET', headers: { host: o.host ?? host, ...(o.headers ?? {}) }, agent: false, timeout: 10_000, ...(o.tls ? { ca: CA, servername: o.servername ?? o.host ?? host } : {}) },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        },
      );
      req.on('error', (e) => resolve({ status: 0, headers: {}, body: e.message }));
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end(o.body);
    });
  const get = (path = '/', headers = {}, extra = {}) => request({ path, headers, ...extra });
  const setAccess = (access) => fetch(`${BASE}/api/services/${web.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...(COOKIE ? { cookie: COOKIE } : {}) }, body: JSON.stringify({ access }) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
  const xff = (ip) => ({ 'x-forwarded-for': ip });
  const uniq = () => `198.51.100.${10 + Math.floor(Math.random() * 240)}`;
  console.log(`  (instance trusts 127.0.0.1 as a proxy: ${TRUSTS_LOCAL ? 'yes' : 'no'} — pass SERVIFY_TRUSTED_PROXIES as on the instance)`);

  // ─── IP lists ───
  console.log('\n▸ access control: IP allow/deny lists');
  await setAccess({ allow: ['203.0.113.0/24'] });
  const direct = await get('/');
  check('allowlist: a direct client outside it gets 403 with a small page', direct.status === 403 && direct.body.length < 4000 && /Access denied/.test(direct.body), `${direct.status}`);
  const viaDoc = await get('/', xff('203.0.113.7'));
  if (TRUSTS_LOCAL) check('allowlist: X-Forwarded-For from a trusted proxy names the client (inside → 200)', viaDoc.status === 200, `${viaDoc.status}`);
  else check('allowlist: X-Forwarded-For from an untrusted peer is never believed (still 403)', viaDoc.status === 403, `${viaDoc.status}`);
  check('allowlist: a forwarded client outside it gets 403', (await get('/', xff('198.51.100.7'))).status === 403);
  await setAccess({ allow: ['private'] });
  check('"private networks only": a direct local client passes', (await get('/')).status === 200);
  const pubFwd = await get('/', xff('198.51.100.8'));
  if (TRUSTS_LOCAL) check('"private networks only": a forwarded public client (trusted proxy) gets 403', pubFwd.status === 403, `${pubFwd.status}`);
  else check('"private networks only": behind an untrusted proxy everyone looks private (200) — hence the warning', pubFwd.status === 200, `${pubFwd.status}`);
  const warned = await api('GET', `/services/${web.id}`);
  const hasWarning = (warned.accessWarnings ?? []).some((w) => w.includes('SERVIFY_TRUSTED_PROXIES') && w.includes('127.0.0.1'));
  if (TRUSTS_LOCAL) check('no untrusted-proxy warning when 127.0.0.1 is trusted', !hasWarning, JSON.stringify(warned.accessWarnings));
  else check('the API warns: a private peer sends X-Forwarded-For but is not in SERVIFY_TRUSTED_PROXIES', hasWarning, JSON.stringify(warned.accessWarnings));
  await setAccess({ allow: ['private'], deny: ['127.0.0.1'] });
  check('denylist is checked first (a denied direct client gets 403)', (await get('/')).status === 403);
  if (TRUSTS_LOCAL) check('denylist goes by the forwarded client when trusted (192.168.1.5 passes)', (await get('/', xff('192.168.1.5'))).status === 200);
  await setAccess({ allow: ['2001:db8:1::/48'], deny: [] });
  if (TRUSTS_LOCAL) {
    check('IPv6 CIDR: a forwarded 2001:db8:1::5 passes', (await get('/', xff('2001:db8:1::5'))).status === 200);
    check('IPv6 CIDR: a forwarded 2001:db8:2::1 gets 403', (await get('/', xff('2001:db8:2::1'))).status === 403);
  } else check('IPv6 CIDR: an IPv4 client outside it gets 403', (await get('/')).status === 403);
  const bad = await Promise.all([{ allow: ['10.0.0.0/33'] }, { allow: ['not-an-ip'] }, { deny: ['2001:db8::/129'] }, { basicAuth: { username: 'x' } }, { basicAuth: { username: 'x', password: 'short' } }, { rateLimit: { requests: 0, perSeconds: 10 } }].map(setAccess));
  check('bad input is refused with 400 (CIDRs parsed, passwords checked, limits bounded)', bad.every((r) => r.status === 400), bad.map((r) => `${r.status} ${r.json.error ?? ''}`).join(' | '));
  check('nothing was changed by the refused updates', JSON.stringify((await api('GET', `/services/${web.id}`)).access.allow) === JSON.stringify(['2001:db8:1::/48']));

  // ─── ACME + WebSocket + HTTPS with an allowlist ───
  await setAccess({ allow: ['203.0.113.0/24'] });
  const acme = await get('/.well-known/acme-challenge/acc-unknown-token');
  check('the ACME path always passes (an app\'s own HTTP-01 challenge is not blocked)', acme.status === 200, `${acme.status}`);
  const ws = (headers = {}) =>
    new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: PROXY, path: '/echo', headers: { host, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } });
      req.on('upgrade', (res, socket) => {
        socket.end();
        resolve(res.statusCode);
      });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', () => resolve(0));
      req.end();
    });
  check('WebSocket upgrade from outside the allowlist: 403', (await ws()) === 403);
  const tlsDenied = await get('/', {}, { tls: true });
  check('HTTPS router: outside the allowlist → 403', tlsDenied.status === 403, `${tlsDenied.status} ${tlsDenied.body.slice(0, 80)}`);
  await setAccess({ allow: ['private'] });
  check('WebSocket upgrade from a private address: 101', (await ws()) === 101);
  check('HTTPS router: inside the allowlist → 200', (await get('/', {}, { tls: true })).status === 200);

  // ─── TCP proxy port: IP lists at accept time ───
  const tcpPort = (await api('PATCH', `/services/${web.id}`, { publicTcpPort: 0 })).publicTcpPort;
  const rawTcp = () =>
    new Promise((resolve) => {
      let got = '';
      const s = net.connect(tcpPort, '127.0.0.1', () => s.write(`GET / HTTP/1.0\r\nHost: x\r\n\r\n`));
      s.on('data', (c) => (got += c));
      s.on('close', () => resolve(got));
      s.on('error', () => resolve(got));
      s.setTimeout(5000, () => s.destroy());
    });
  await sleep(1500); // the TCP listener starts within a second
  check('TCP proxy port: a private client connects', /^HTTP\/1\.[01] 200/.test(await rawTcp()));
  await setAccess({ allow: ['203.0.113.0/24'] });
  check('TCP proxy port: outside the allowlist the connection is closed at once', (await rawTcp()) === '');
  await setAccess({ allow: [], basicAuth: { username: 'acc', password: 'tcp-check-1' } });
  check('a TCP proxy port next to basic auth is flagged (it skips the password)', (await api('GET', `/services/${web.id}`)).accessWarnings.some((w) => w.includes('TCP proxy port')));
  await api('PATCH', `/services/${web.id}`, { publicTcpPort: null });

  // ─── basic auth ───
  console.log('\n▸ access control: basic auth');
  const pw = `acc-${randomBytes(9).toString('base64url')}`;
  const basic = (u, p) => ({ authorization: `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}` });
  const set = await setAccess({ allow: [], basicAuth: { username: 'acc', password: pw, exemptPaths: ['/public'] } });
  check('basic auth is set; the API shows a mask, never the password or its hash', set.status === 200 && set.json.access.basicAuth.password === '••••••••' && !JSON.stringify(set.json).includes(pw) && !/[0-9a-f]{32}:[0-9a-f]{64}/.test(JSON.stringify(set.json)), `${set.status}`);
  const none = await get('/');
  check('no credentials → 401 with WWW-Authenticate: Basic', none.status === 401 && /^Basic realm=/.test(none.headers['www-authenticate'] ?? ''), `${none.status} ${none.headers['www-authenticate']}`);
  check('the right user name and password → 200', (await get('/', basic('acc', pw))).status === 200);
  check('cached: the same credentials again → 200', (await get('/', basic('acc', pw))).status === 200);
  check('the right password with another user name → 401', (await get('/', basic('eve', pw))).status === 401);
  check('an exempt path passes without credentials', (await get('/public/health')).status === 200);
  check('dot segments can\'t escape into a protected path (/public/../secret → 401)', (await get('/public/../secret')).status === 401 && (await get('/public/%2e%2e/secret')).status === 401 && (await get('/public%2f..%2fsecret')).status === 401);
  check('a longer name is not the exempt path (/publicity → 401)', (await get('/publicity')).status === 401);
  check('the ACME path passes basic auth too', (await get('/.well-known/acme-challenge/acc-token')).status === 200);
  check('WebSocket upgrades need the password too (401 / 101)', (await ws()) === 401 && (await ws(basic('acc', pw))) === 101);
  check('HTTPS router: 401 without, 200 with the password', (await get('/', {}, { tls: true })).status === 401 && (await get('/', basic('acc', pw), { tls: true })).status === 200);
  const kept = await setAccess({ basicAuth: { username: 'acc', password: '••••••••' } });
  check('sending the mask back keeps the password', kept.status === 200 && (await get('/', basic('acc', pw))).status === 200, `${kept.status}`);
  if (DATA) {
    await sleep(1500);
    const files = ['servify.db', 'servify.db-wal'].map((f) => join(DATA, f)).filter(existsSync);
    check('the password is nowhere in the database files', !files.some((f) => readFileSync(f).includes(pw)));
  }
  // Brute force: per client address and service. With trust a fresh forwarded address, else 127.0.0.1 itself.
  const attacker = TRUSTS_LOCAL ? xff(uniq()) : {};
  // Without trust the wrong user name above already counted against 127.0.0.1: stop at the first 429.
  const tries = [];
  let locked = null;
  for (let i = 0; i < 12 && !locked; i++) {
    const r = await get('/', { ...attacker, ...basic('acc', `wrong-${i}`) });
    if (r.status === 429) locked = r;
    else tries.push(r.status);
  }
  check(
    `wrong passwords → 401 each, then 429 with Retry-After (after ${tries.length}${TRUSTS_LOCAL ? '' : ' + 1 earlier'} of 10)`,
    tries.every((t) => t === 401) && tries.length === (TRUSTS_LOCAL ? 10 : 9) && Number(locked?.headers['retry-after']) > 0,
    `${tries.join(',')} → ${locked?.status} ${locked?.headers['retry-after']}`,
  );
  check('once locked out, even the right password waits (429)', (await get('/', { ...attacker, ...basic('acc', pw) })).status === 429);
  if (TRUSTS_LOCAL) check('another client is not locked out', (await get('/', { ...xff(uniq()), ...basic('acc', pw) })).status === 200);

  // ─── rate limit ───
  console.log('\n▸ access control: rate limit');
  await setAccess({ basicAuth: null, rateLimit: { requests: 5, perSeconds: 60 } });
  const who = TRUSTS_LOCAL ? xff(uniq()) : {};
  const burst = [];
  for (let i = 0; i < 5; i++) burst.push((await get('/', who)).status);
  const limited = await get('/', who);
  check('5 requests pass, the 6th gets 429 with Retry-After', burst.every((b) => b === 200) && limited.status === 429 && Number(limited.headers['retry-after']) >= 1, `${burst.join(',')} → ${limited.status} ${limited.headers['retry-after']}`);
  const other = await get('/', xff(uniq()));
  if (TRUSTS_LOCAL) check('another (forwarded) client has its own budget', other.status === 200, `${other.status}`);
  else check('behind an untrusted proxy all visitors share one budget (429 for a "different" X-Forwarded-For)', other.status === 429, `${other.status}`);
  check('rate limits apply to WebSocket upgrades too', (await ws(who)) === 429);
  await setAccess(null);
  check('access: null switches everything off', (await get('/')).status === 200 && (await api('GET', `/services/${web.id}`)).access === null);

  // ─── MCP and exports ───
  console.log('\n▸ access control: MCP, exports, copies');
  const mcpCall = async (name, args) => {
    const r = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(COOKIE ? { cookie: COOKIE } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const j = await r.json().catch(() => ({}));
    const text = j.result?.content?.[0]?.text ?? '';
    try {
      return { error: j.result?.isError ? text : null, data: JSON.parse(text) };
    } catch {
      return { error: text || JSON.stringify(j).slice(0, 200), data: null };
    }
  };
  const viaMcp = await mcpCall('update_service', { service: web.id, access: { allow: ['private'], basicAuth: { username: 'mcp', password: pw } } });
  check('MCP update_service sets access control (password masked in the answer)', !viaMcp.error && viaMcp.data?.access?.basicAuth?.password === '••••••••' && JSON.stringify(viaMcp.data.access.allow) === '["private"]' && !JSON.stringify(viaMcp.data).includes(pw), viaMcp.error ?? '');
  const badMcp = await mcpCall('update_service', { service: web.id, access: { allow: ['300.1.1.1'] } });
  check('MCP update_service refuses a bad address', !!badMcp.error && /not an IP/.test(badMcp.error), badMcp.error ?? '');
  const spec = await api('GET', `/projects/${P.id}/export`);
  const specSvc = spec.services.find((x) => x.name === 'guarded');
  check('a spec export carries the rules but no password hash', JSON.stringify(specSvc?.access?.allow) === '["private"]' && specSvc.access.basicAuth?.username === 'mcp' && !('passwordHash' in specSvc.access.basicAuth));
  const imp = await api('POST', '/projects/import', { spec: { ...spec, services: [specSvc] }, deploy: false, name: `acc-import-${Date.now().toString(36)}` });
  projectsToDelete.push(imp.project.id);
  const copy = await api('GET', `/services/${imp.services[0]}`);
  check('an imported copy keeps the rules (basic auth locked until a password is set)', JSON.stringify(copy.access?.allow) === '["private"]' && copy.access?.basicAuth?.username === 'mcp', JSON.stringify(copy.access));
  await setAccess(null);

  // ─── deploy hooks ───
  console.log('\n▸ access control: deploy-hook rate limit');
  const hookFrom = TRUSTS_LOCAL ? xff(uniq()) : {};
  // Failed hook calls from earlier sections (same client) count too: stop at the first 429.
  const hookStatuses = [];
  let hookLocked = null;
  for (let i = 0; i < 25 && !hookLocked; i++) {
    const r = await request({ path: `/_servify/hooks/deploy/${web.id}/not-the-token-${i}`, method: 'POST', host: 'anything.example', headers: hookFrom });
    if (r.status === 429) hookLocked = r;
    else hookStatuses.push(r.status);
  }
  check(
    `bad deploy-hook calls are refused, then 429 with Retry-After (on by default; after ${hookStatuses.length})`,
    hookStatuses.length >= 1 && (TRUSTS_LOCAL ? hookStatuses.length === 20 : hookStatuses.length <= 20) && hookStatuses.every((x) => x === 401 || x === 404) && Number(hookLocked?.headers['retry-after']) > 0,
    `${[...new Set(hookStatuses)].join(',')} → ${hookLocked?.status}`,
  );
  const dashHook = await request({ port: Number(new URL(BASE).port), path: `/api/hooks/deploy/${web.id}/not-the-token`, method: 'POST', host: new URL(BASE).host, headers: hookFrom });
  check('the dashboard port\'s /api/hooks/… shares the limit', dashHook.status === 429, `${dashHook.status}`);
  if (TRUSTS_LOCAL) check('another client can still call hooks', [401, 404].includes((await request({ path: `/_servify/hooks/deploy/${web.id}/nope`, method: 'POST', host: 'anything.example', headers: xff(uniq()) })).status));

  // ─── B1: local CA fingerprint ───
  console.log('\n▸ local CA fingerprint');
  const pemRes = await fetch(`${BASE}/api/certs/local-ca.pem`, { headers: COOKIE ? { cookie: COOKIE } : {} });
  const pemFile = await pemRes.text();
  const dir = mkdtempSync(join(tmpdir(), 'servify-ca-'));
  writeFileSync(join(dir, 'ca.pem'), pemFile);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const viaOpenssl = execSync(`openssl x509 -noout -fingerprint -sha256 -in ${join(dir, 'ca.pem')}`).toString().trim().split('=')[1];
  check('GET /api/certs/local-ca: the same PEM as the download', caInfo.pem === pemFile);
  check('fingerprint256 = X509Certificate(pem).fingerprint256 = openssl -fingerprint -sha256', caInfo.fingerprint256 === new X509Certificate(pemFile).fingerprint256 && caInfo.fingerprint256 === viaOpenssl && /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(caInfo.fingerprint256), `${caInfo.fingerprint256} / ${viaOpenssl}`);
  // Clients without SNI (connecting by IP) get a local-CA certificate naming this machine's addresses.
  const noSni = await new Promise((resolve) => {
    const t = tls.connect({ host: '127.0.0.1', port: HTTPS_PORT, ca: CA, rejectUnauthorized: false }); // an IP: no SNI is sent
    t.once('secureConnect', () => {
      const san = t.getPeerCertificate()?.subjectaltname ?? '';
      t.end();
      resolve(san);
    });
    t.once('error', () => resolve(''));
  });
  const lan = Object.values(networkInterfaces()).flat().find((a) => a && !a.internal && a.family === 'IPv4')?.address;
  check('a client without SNI gets a certificate for 127.0.0.1 and this machine\'s LAN address', noSni.includes('IP Address:127.0.0.1') && (!lan || noSni.includes(`IP Address:${lan}`)), noSni.replace(/\d+\.\d+\.\d+\.\d+/g, (ip) => (ip === '127.0.0.1' ? ip : 'x.x.x.x')));

  // ─── B2: the dashboard domain ───
  console.log('\n▸ dashboard domain');
  const settings0 = await api('GET', '/settings');
  const DD = `servify-acc-${randomBytes(3).toString('hex')}.home.arpa`;
  const patchGeneral = (body) => fetch(`${BASE}/api/settings/general`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...(COOKIE ? { cookie: COOKIE } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
  const authNone = (await api('GET', '/auth/status')).authMode === 'none';
  if (authNone) {
    const r = await patchGeneral({ dashboardDomain: DD });
    check('with SERVIFY_AUTH=none a dashboard domain is refused', r.status === 400, `${r.status}`);
    console.log('  – skipped the dashboard-domain checks (they need sign-in on and SERVIFY_COOKIE)');
    return;
  }
  cleanups.push(() => patchGeneral({ dashboardDomain: settings0.dashboardDomain ?? null, dashboardAllow: settings0.dashboardAllow }));
  const setDd = await patchGeneral({ dashboardDomain: DD });
  check('setting a dashboard domain: private networks only by default', setDd.status === 200 && setDd.json.dashboardDomain === DD && JSON.stringify(setDd.json.dashboardAllow) === '["private"]', `${setDd.status} ${JSON.stringify(setDd.json.dashboardAllow)}`);
  const clash = await fetch(`${BASE}/api/services/${web.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: COOKIE }, body: JSON.stringify({ domains: [DD] }) });
  check('a service can\'t take the dashboard domain (409)', clash.status === 409);
  const redirect = await request({ host: DD, path: '/api/auth/status?x=1' });
  check('plain HTTP on the router redirects to HTTPS', redirect.status === 308 && redirect.headers.location === `https://${DD}:${HTTPS_PORT}/api/auth/status?x=1`, `${redirect.status} ${redirect.headers.location}`);
  // As a browser sends it: Host with the port (the CSRF check compares it with Origin), SNI without.
  const dd = (o) => request({ tls: true, host: `${DD}:${HTTPS_PORT}`, servername: DD, ...o });
  // curl with the local CA and --resolve, as a browser on the LAN would connect.
  const curlOut = execSync(`curl -s --max-time 10 --resolve ${DD}:${HTTPS_PORT}:127.0.0.1 --cacert ${join(dir, 'ca.pem')} -o - -w '\\n%{http_code}' https://${DD}:${HTTPS_PORT}/api/auth/status`).toString();
  check('curl --resolve with the local CA: the dashboard API answers over HTTPS (certificate verifies)', /"app":"servify"/.test(curlOut) && curlOut.trim().endsWith('200'), curlOut.slice(-60));
  const page = await dd({ path: '/' });
  check('the dashboard page itself is served', page.status === 200 && /<html/i.test(page.body), `${page.status}`);
  check('the host is allowed on the dashboard port too (SERVIFY_ALLOWED_HOSTS not needed)', (await request({ port: Number(new URL(BASE).port), host: DD, path: '/api/auth/status' })).status === 200);
  const origin = `https://${DD}:${HTTPS_PORT}`;
  if (process.env.SERVIFY_PASSWORD_FILE) {
    const password = readFileSync(process.env.SERVIFY_PASSWORD_FILE, 'utf8').trim();
    const login = await dd({ path: '/api/auth/login', method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password }) });
    const cookie = String(login.headers['set-cookie']?.[0] ?? '').split(';')[0];
    check('login over HTTPS with the domain\'s Origin sets a session cookie', login.status === 200 && cookie.startsWith('servify_session='), `${login.status}`);
    check('the session works through the domain (GET /api/projects)', (await dd({ path: '/api/projects', headers: { cookie } })).status === 200);
    check('a write with the domain\'s own Origin passes the CSRF check', (await dd({ path: '/api/settings/general', method: 'PATCH', headers: { cookie, origin, 'content-type': 'application/json' }, body: '{}' })).status === 200);
    check('a write with a foreign Origin is refused (403)', (await dd({ path: '/api/settings/general', method: 'PATCH', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status === 403);
    await dd({ path: '/api/auth/logout', method: 'POST', headers: { cookie, origin } });
  } else console.log('  – skipped the login over HTTPS (set SERVIFY_PASSWORD_FILE)');
  const { token: ddToken } = await api('POST', '/tokens', { name: 'acc-dashboard-domain', scope: 'read' });
  const tokId = (await api('GET', '/tokens')).find((t) => t.name === 'acc-dashboard-domain')?.id;
  cleanups.push(() => api('DELETE', `/tokens/${tokId}`).catch(() => {}));
  const bearer = { authorization: `Bearer ${ddToken}` };
  check('a bearer token works through the domain (the app)', (await dd({ path: '/api/projects', headers: bearer })).status === 200);
  const appCors = await dd({ path: '/api/projects', headers: { ...bearer, origin: 'https://localhost' } });
  check('the app\'s WebView origin gets CORS through the domain', appCors.status === 200 && appCors.headers['access-control-allow-origin'] === 'https://localhost');
  const mcpTools = await dd({ path: '/mcp', method: 'POST', headers: { ...bearer, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  check('MCP works through the domain', mcpTools.status === 200 && mcpTools.body.includes('update_service'), `${mcpTools.status}`);
  const sse = await new Promise((resolve) => {
    const req = https.get({ host: '127.0.0.1', port: HTTPS_PORT, path: '/api/events', servername: DD, ca: CA, headers: { host: `${DD}:${HTTPS_PORT}`, ...bearer, accept: 'text/event-stream' }, agent: false }, (res) => {
      let b = '';
      const t = setTimeout(() => (req.destroy(), resolve(`${res.statusCode} ${b}`)), 5000);
      res.on('data', (c) => {
        b += c;
        if (b.includes('hello')) {
          clearTimeout(t);
          req.destroy();
          resolve(`${res.statusCode} ${res.headers['content-type']} ${b}`);
        }
      });
    });
    req.on('error', (e) => resolve(`error ${e.message}`));
  });
  check('server-sent events stream through the domain right away', /^200 text\/event-stream/.test(sse) && sse.includes('hello'), sse.slice(0, 80));
  const fwdPublic = await dd({ path: '/api/auth/status', headers: xff('198.51.100.9') });
  if (TRUSTS_LOCAL) check('private-only default: a forwarded public address (trusted proxy) gets 403', fwdPublic.status === 403, `${fwdPublic.status}`);
  else {
    check('behind an untrusted proxy the dashboard domain refuses forwarded requests (fails closed)', fwdPublic.status === 403, `${fwdPublic.status}`);
    check('…and Settings says why (SERVIFY_TRUSTED_PROXIES)', /SERVIFY_TRUSTED_PROXIES/.test((await api('GET', '/settings')).dashboardWarning ?? ''));
  }
  check('a direct private client is let in', (await dd({ path: '/api/auth/status' })).status === 200);
  await patchGeneral({ dashboardAllow: ['203.0.113.0/24'] });
  check('the owner can change the list (outside it → 403)', (await dd({ path: '/api/auth/status' })).status === 403);
  const notOwner = await fetch(`${BASE}/api/settings/general`, { method: 'PATCH', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ dashboardAllow: [] }) });
  check('tokens can\'t change it', notOwner.status === 403);
  const cleared = await patchGeneral({ dashboardDomain: null });
  const gone = await request({ host: DD, path: '/api/auth/status' });
  check('clearing the domain stops serving it (no redirect, nothing routed)', cleared.status === 200 && gone.status === 404, `${cleared.status} ${gone.status}`);
}

// ───────────────────────────── phone app mirror ─────────────────────────────

async function mobileAppChecks() {
  const { createPrivateKey, createPublicKey, sign: edSign, generateKeyPairSync } = await import('node:crypto');
  const { ANDROID_SIGNER_SHA256 } = await import(new URL('../server/src/releasekey.ts', import.meta.url).href);
  const keyFile = process.env.SERVIFY_MOBILE_KEY;
  if (!keyFile) throw new Error('ONLY=mobileapp needs SERVIFY_MOBILE_KEY (a throwaway Ed25519 key, PEM) and Servify started with its public key in SERVIFY_UPDATE_KEYS');
  const key = createPrivateKey(readFileSync(keyFile));
  const otherKey = generateKeyPairSync('ed25519').privateKey;
  const port = Number(process.env.SERVIFY_MOBILE_FEED_PORT ?? 17899);
  const status = await api('GET', '/auth/status');
  const version = status.version;
  const tag = `v${version}`;
  const sha = (b) => createHash('sha256').update(b).digest('hex');

  // The fake feed: whatever `feed` says, answered GitHub style.
  const feed = { release: null, files: {} };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const rel = feed.release;
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (u.pathname === '/repos/test/servify/releases/latest' || u.pathname === `/repos/test/servify/releases/tags/${encodeURIComponent(tag)}`) {
      if (!rel) return json(404, { message: 'Not Found' });
      return json(200, { tag_name: rel.tag, html_url: '', body: '', assets: Object.keys(feed.files).map((n) => ({ name: n, browser_download_url: `http://127.0.0.1:${port}/dl/${encodeURIComponent(n)}` })) });
    }
    if (u.pathname.startsWith('/repos/test/servify/releases/tags/')) return json(404, { message: 'Not Found' });
    const name = decodeURIComponent(u.pathname.replace(/^\/dl\//, ''));
    if (u.pathname.startsWith('/dl/') && feed.files[name]) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': feed.files[name].length });
      return res.end(feed.files[name]);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r, j) => server.once('error', j).listen(port, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => server.close(r)));

  /** A release of the running version: the package, optionally an app, and a manifest signed as asked. */
  const publish = ({ apk = null, signWith = key, unsigned = false, manifestOver = {}, serveApk = apk?.bytes, tamper = false } = {}) => {
    const pkg = Buffer.from(`package ${version}`);
    const files = { [`servify-v${version}.tar.gz`]: pkg };
    const m = { format: 1, product: 'servify', version, tag, createdAt: new Date().toISOString(), assets: { [`servify-v${version}.tar.gz`]: { sha256: sha(pkg), size: pkg.length } }, ...manifestOver };
    if (apk) {
      const file = `servify-android-${apk.name}.apk`;
      m.assets[file] = { sha256: sha(apk.bytes), size: apk.bytes.length };
      m.android = { file, versionName: apk.name, versionCode: apk.code, sha256: sha(apk.bytes), size: apk.bytes.length, signerSha256: ANDROID_SIGNER_SHA256 };
      files[file] = serveApk;
    }
    let bytes = Buffer.from(JSON.stringify(m, null, 2) + '\n');
    const sig = edSign(null, bytes, signWith).toString('base64') + '\n';
    if (tamper) bytes = Buffer.from(bytes.toString().replace('"format": 1', '"format": 1, "x": 1'));
    if (!unsigned) {
      files[`servify-v${version}.manifest.json`] = bytes;
      files[`servify-v${version}.manifest.json.sig`] = Buffer.from(sig);
    }
    feed.release = { tag };
    feed.files = files;
  };
  const fakeApk = (code, name) => ({ code, name, bytes: Buffer.concat([Buffer.from(`fake apk ${code} `), randomBytes(300_000 + code)]) });
  const refresh = () => api('POST', '/mobile/app/check');
  const info = () => api('GET', '/mobile/app');
  const getApk = async (headers = {}) => {
    const res = await fetch(`${BASE}/api/mobile/app.apk`, { headers: { cookie: COOKIE, ...headers } });
    return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
  };
  const files = () => (DATA && existsSync(join(DATA, 'mobile')) ? readdirSync(join(DATA, 'mobile')).sort() : null);

  console.log('\n▸ phone app: the API before anything is mirrored');
  check('/auth/status lists the app-version-header and mobile-app features', Array.isArray(status.features) && status.features.includes('app-version-header') && status.features.includes('mobile-app'), JSON.stringify(status.features));
  feed.release = null;
  const none = await refresh();
  check('no release for this version: nothing served, and it says why', none.available === false && /no release/.test(none.reason ?? ''), JSON.stringify(none));
  const noFile = await getApk();
  check('GET /mobile/app.apk without an app: 409 with the reason', noFile.status === 409 && /no release/.test(JSON.parse(noFile.body.toString()).error ?? ''), `${noFile.status}`);
  const anon = await fetch(`${BASE}/api/mobile/app`);
  const anonApk = await fetch(`${BASE}/api/mobile/app.apk`);
  check('both need authentication', anon.status === 401 && anonApk.status === 401, `${anon.status} ${anonApk.status}`);

  console.log('\n▸ phone app: fail closed');
  publish({ apk: fakeApk(201, '0.2.1'), unsigned: true });
  const unsigned = await refresh();
  check('an unsigned release: no app served, the reason says so', !unsigned.available && /not signed/.test(unsigned.reason ?? ''), JSON.stringify(unsigned.reason));

  console.log('\n▸ phone app: mirroring');
  const a201 = fakeApk(201, '0.2.1');
  publish({ apk: a201 });
  const m201 = await refresh();
  check('a signed release with an app: mirrored and offered', m201.available && m201.versionCode === 201 && m201.versionName === '0.2.1' && m201.sha256 === sha(a201.bytes) && m201.size === a201.bytes.length && m201.signerSha256 === ANDROID_SIGNER_SHA256 && m201.release === tag, JSON.stringify(m201));
  check('…and the earlier block (unsigned) is lifted', !m201.reason);
  const full = await getApk();
  check(
    'GET /mobile/app.apk streams exactly the signed bytes, with Content-Length and the APK content type',
    full.status === 200 && sha(full.body) === sha(a201.bytes) && full.headers.get('content-length') === String(a201.bytes.length) && full.headers.get('content-type') === 'application/vnd.android.package-archive' && full.headers.get('accept-ranges') === 'bytes',
    `${full.status} ${full.headers.get('content-type')}`,
  );
  const part = await getApk({ range: 'bytes=100-199' });
  check('Range: bytes=100-199 → 206 with those 100 bytes', part.status === 206 && part.body.length === 100 && part.body.equals(a201.bytes.subarray(100, 200)) && part.headers.get('content-range') === `bytes 100-199/${a201.bytes.length}`, `${part.status} ${part.headers.get('content-range')}`);
  const tail = await getApk({ range: 'bytes=-10' });
  check('Range: the last 10 bytes', tail.status === 206 && tail.body.equals(a201.bytes.subarray(-10)), `${tail.status}`);
  const bad = await getApk({ range: `bytes=${a201.bytes.length + 5}-` });
  check('an unsatisfiable range → 416', bad.status === 416, `${bad.status}`);
  if (DATA) check('stored in <data>/mobile with its signed manifest and signature', JSON.stringify(files()) === JSON.stringify(['app-201.apk', `servify-v${version}.manifest.json`, `servify-v${version}.manifest.json.sig`, 'state.json'].sort()), JSON.stringify(files()));

  console.log('\n▸ phone app: who may fetch it');
  const mkTok = async (name, scope, projects) => (await api('POST', '/tokens', { name, scope, ...(projects ? { projects } : {}) }));
  const scratchProject = await api('POST', '/projects', { name: `mobile-${Date.now().toString(36)}` });
  projectsToDelete.push(scratchProject.id);
  const readTok = await mkTok('acc-mobile-read', 'read');
  const limitedTok = await mkTok('acc-mobile-limited', 'write', [scratchProject.id]);
  cleanups.push(async () => {
    for (const t of [readTok, limitedTok]) await api('DELETE', `/tokens/${t.record.id}`).catch(() => {});
  });
  const as = (tok, path) => fetch(`${BASE}/api${path}`, { headers: { authorization: `Bearer ${tok}` } }).then((r) => r.status);
  check('a read token may read the app info and download it', (await as(readTok.token, '/mobile/app')) === 200 && (await as(readTok.token, '/mobile/app.apk')) === 200);
  check('a project-limited token may not (instance-wide)', (await as(limitedTok.token, '/mobile/app')) === 403 && (await as(limitedTok.token, '/mobile/app.apk')) === 403);
  const refreshByToken = await fetch(`${BASE}/api/mobile/app/check`, { method: 'POST', headers: { authorization: `Bearer ${readTok.token}` } });
  check('only the owner can trigger a check', refreshByToken.status === 403, `${refreshByToken.status}`);

  console.log('\n▸ phone app: the version a phone reports');
  const pre = await fetch(`${BASE}/api/mobile/app`, { method: 'OPTIONS', headers: { origin: 'http://localhost', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,x-servify-app' } });
  check('CORS preflights from the app allow X-Servify-App', /x-servify-app/i.test(pre.headers.get('access-control-allow-headers') ?? ''), pre.headers.get('access-control-allow-headers') ?? '');
  if (process.env.SERVIFY_PASSWORD_FILE) {
    const password = readFileSync(process.env.SERVIFY_PASSWORD_FILE, 'utf8').trim();
    const signin = await fetch(`${BASE}/api/auth/device`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify({ password, name: 'acc-phone' }) });
    const { token: devTok, device } = await signin.json();
    cleanups.push(() => api('DELETE', `/devices/${device?.id}`).catch(() => {}));
    const asPhone = (h) => fetch(`${BASE}/api/mobile/app`, { headers: { authorization: `Bearer ${devTok}`, origin: 'http://localhost', ...(h ? { 'x-servify-app': h } : {}) } });
    const devRec = async () => (await api('GET', '/devices')).find((d) => d.id === device.id);
    check('a signed-in phone reads GET /mobile/app', signin.status === 201 && (await asPhone()).status === 200, `${signin.status}`);
    check('before it reports one, the device has no app version', (await devRec())?.lastAppVersion === undefined);
    await asPhone('0.2.0/200');
    const r1 = await devRec();
    check('X-Servify-App: 0.2.0/200 is stored on the device (lastAppVersion)', r1?.lastAppVersion === '0.2.0' && r1?.lastAppVersionCode === 200, JSON.stringify(r1));
    await asPhone('../etc/passwd');
    await asPhone('0.2.0/200; drop');
    check('a malformed header is ignored', (await devRec())?.lastAppVersion === '0.2.0');
    await asPhone('0.2.1/201');
    check('a newer version replaces it at once (not held back by the last-used throttle)', (await devRec())?.lastAppVersionCode === 201);
    await fetch(`${BASE}/api/mobile/app`, { headers: { authorization: `Bearer ${readTok.token}`, 'x-servify-app': '9.9.9/90909' } });
    check('agent tokens get no app version', !('lastAppVersion' in ((await api('GET', '/tokens')).find((t) => t.id === readTok.record.id) ?? {})));
  } else console.log('  – skipped the phone checks (set SERVIFY_PASSWORD_FILE)');

  console.log('\n▸ phone app: downloads that don\'t match');
  const a202 = fakeApk(202, '0.2.2');
  publish({ apk: a202, serveApk: Buffer.concat([a202.bytes.subarray(0, -1), Buffer.from([a202.bytes.at(-1) ^ 1])]) });
  const hashBad = await refresh();
  check('a hash mismatch: not used, the app mirrored before stays', hashBad.available && hashBad.versionCode === 201 && /not used/.test(hashBad.status) && /SHA-256/.test(hashBad.status), JSON.stringify(hashBad.status));
  publish({ apk: a202, serveApk: Buffer.concat([a202.bytes, Buffer.from('more')]) });
  const sizeBad = await refresh();
  check('a download larger than the manifest says: stopped, not used', sizeBad.available && sizeBad.versionCode === 201 && /larger/.test(sizeBad.status), JSON.stringify(sizeBad.status));
  if (DATA) check('nothing of the refused downloads is left on disk', !files().some((f) => f.includes('202') || f.includes('.tmp')), JSON.stringify(files()));

  console.log('\n▸ phone app: a release without an app');
  publish({});
  const noApp = await refresh();
  check('no android entry: the cached app is still served', noApp.available && noApp.versionCode === 201 && /no Android app/.test(noApp.status), JSON.stringify(noApp));

  console.log('\n▸ phone app: newer apps, and keeping two');
  const a203 = fakeApk(203, '0.2.3');
  publish({ apk: a203 });
  const m203 = await refresh();
  check('a newer app replaces it', m203.available && m203.versionCode === 203, JSON.stringify(m203));
  const again = await refresh();
  check('the same app again: nothing downloaded, up to date', again.versionCode === 203 && /up to date/.test(again.status), again.status);
  publish({ apk: fakeApk(202, '0.2.2') });
  check('an older app in the manifest is not taken', (await refresh()).versionCode === 203);
  const a204 = fakeApk(204, '0.2.4');
  publish({ apk: a204 });
  const m204 = await refresh();
  check('and the next one', m204.versionCode === 204 && sha((await getApk()).body) === sha(a204.bytes));
  if (DATA) check('only the current and the previous app are kept', JSON.stringify(files().filter((f) => f.endsWith('.apk'))) === JSON.stringify(['app-203.apk', 'app-204.apk']), JSON.stringify(files()));

  console.log('\n▸ phone app: invalid manifests serve nothing');
  publish({ apk: fakeApk(205, '0.2.5'), signWith: otherKey });
  const badSig = await refresh();
  check('signed by an untrusted key: no app served at all (not even the cached one)', !badSig.available && /signature invalid/.test(badSig.reason ?? '') && badSig.versionCode === null, JSON.stringify(badSig.reason));
  check('…and the download says why', (await getApk()).status === 409);
  publish({ apk: a204 });
  check('a valid manifest again: served again', (await refresh()).available === true);
  publish({ apk: fakeApk(205, '0.2.5'), tamper: true });
  const tampered = await refresh();
  check('a manifest changed after signing: nothing served', !tampered.available && /signature invalid/.test(tampered.reason ?? ''), JSON.stringify(tampered.reason));
  publish({ apk: fakeApk(205, '0.2.5'), manifestOver: { version: '0.0.1', tag: 'v0.0.1' } });
  const wrongVersion = await refresh();
  check('a signed manifest for another version: nothing served', !wrongVersion.available && /not for this release/.test(wrongVersion.reason ?? ''), JSON.stringify(wrongVersion.reason));
  if (DATA) {
    const st = JSON.parse(readFileSync(join(DATA, 'mobile', 'state.json'), 'utf8'));
    check('the block is stored (a restart doesn\'t serve the cached app in between)', typeof st.blocked === 'string' && /not for this release/.test(st.blocked), JSON.stringify(st.blocked));
  }
  feed.release = null;
  const offline = await refresh();
  check('the feed no longer knows the release: still blocked (fail closed until a manifest verifies)', !offline.available, JSON.stringify(offline));
  publish({ apk: a204 });
  const back = await refresh();
  check('verified again: the cached 204 is served, nothing re-downloaded', back.available && back.versionCode === 204 && /up to date/.test(back.status), JSON.stringify(back));
}

// ───────────────────────────── sign-in: passkeys, password policy, throttling, pairing ─────────────────────────────

/**
 * A tiny software authenticator (no browser): a P-256 key from WebCrypto, clientDataJSON, authenticatorData (rpIdHash,
 * UP/UV flags, counter, attested credential data on registration) and a "none" attestation, CBOR-encoded by hand.
 */
function cborEncode(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) {
      const b = Buffer.alloc(3);
      b[0] = (major << 5) | 25;
      b.writeUInt16BE(n, 1);
      return b;
    }
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const s = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, s.length), s]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cborEncode)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cborEncode(k), cborEncode(x)])]);
  throw new Error('cbor: unsupported value');
}
function ecdsaDer(raw) {
  const int = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    b = b.subarray(i);
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return Buffer.concat([Buffer.from([2, b.length]), b]);
  };
  const r = int(raw.subarray(0, 32));
  const s = int(raw.subarray(32));
  return Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s]);
}
async function softAuthenticator() {
  const { subtle } = (await import('node:crypto')).webcrypto;
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const jwk = await subtle.exportKey('jwk', kp.publicKey);
  const credId = randomBytes(16);
  const b64u = (b) => Buffer.from(b).toString('base64url');
  const sha = (b) => createHash('sha256').update(b).digest();
  const st = { counter: 0, userHandle: null };
  const authData = (rpId, attested, count) => {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(count);
    const parts = [sha(rpId), Buffer.from([0x01 | 0x04 | (attested ? 0x40 : 0)]), c];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(credId.length);
      const cose = cborEncode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
      parts.push(Buffer.alloc(16), len, credId, cose);
    }
    return Buffer.concat(parts);
  };
  return {
    id: b64u(credId),
    st,
    register(options, { origin, rpId = options.rp.id } = {}) {
      st.userHandle = options.user.id;
      const cd = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }));
      const att = cborEncode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData(rpId, true, st.counter)]]));
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', response: { clientDataJSON: b64u(cd), attestationObject: b64u(att), transports: ['internal', 'hybrid'] }, clientExtensionResults: {}, authenticatorAttachment: 'platform' };
    },
    /** count: report this counter once (a cloned authenticator) without changing the real one. */
    async assert(options, { origin, rpId = options.rpId, count, tamper = false } = {}) {
      if (count === undefined) st.counter++;
      const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }));
      const ad = authData(rpId, false, count ?? st.counter);
      const sig = ecdsaDer(Buffer.from(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, Buffer.concat([ad, sha(cd)]))));
      if (tamper) sig[sig.length - 3] ^= 0x01;
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', response: { clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(sig), userHandle: st.userHandle }, clientExtensionResults: {}, authenticatorAttachment: 'platform' };
    },
  };
}

/**
 * ONLY=auth. Needs sign-in on, SERVIFY_COOKIE, SERVIFY_PASSWORD_FILE (the owner password; never printed) and
 * SERVIFY_DATA_DIR (the recovery CLI, and ageing a session's confirmation time). Start Servify with
 * SERVIFY_AUTH_LOG_QUIET_MS=3000 (activity batches) and SERVIFY_PAIRING_TTL_MS=15000 (pairing expiry), and pass this
 * script the instance's SERVIFY_TRUSTED_PROXIES: with 127.0.0.1 in it, X-Forwarded-For stands for other addresses (the
 * multi-address throttle, the global slow-down, pairing limits); without, it must be ignored, and "private networks
 * only" must fail closed when it is sent. Run it once each way (restart Servify in between). It leaves the instance as
 * it found it: password policy everywhere, no passkeys, the dashboard domain as it was.
 */
async function authChecks() {
  const pwFile = process.env.SERVIFY_PASSWORD_FILE;
  if (!pwFile || !DATA || !COOKIE) throw new Error('ONLY=auth needs SERVIFY_COOKIE, SERVIFY_PASSWORD_FILE and SERVIFY_DATA_DIR');
  const PASSWORD = readFileSync(pwFile, 'utf8').trim();
  const sectionStart = Date.now();
  const { DatabaseSync } = await import('node:sqlite');
  const port = Number(new URL(BASE).port);
  const LOCAL_ORIGIN = `http://localhost:${port}`;
  const CA = (await (await fetch(`${BASE}/api/certs/local-ca.pem`, { headers: { cookie: COOKIE } })).text());
  const DD = `servify-auth-${randomBytes(3).toString('hex')}.test`;
  const DD_ORIGIN = `https://${DD}:${HTTPS_PORT}`;
  const xff = (ip) => ({ 'x-forwarded-for': ip });

  /** One request, to the dashboard port (default) or through the router's HTTPS port (router: true). */
  const hreq = ({ router = false, host, path, method = 'GET', headers = {}, body } = {}) =>
    new Promise((resolve) => {
      const t0 = Date.now();
      const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
      const opts = {
        host: '127.0.0.1',
        port: router ? HTTPS_PORT : port,
        path,
        method,
        agent: false,
        headers: { host: host ?? (router ? `${DD}:${HTTPS_PORT}` : `localhost:${port}`), ...(data !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(router ? { servername: DD, ca: CA } : {}),
      };
      const r = (router ? https : http).request(opts, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          let json = {};
          try {
            json = JSON.parse(b);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json, ms: Date.now() - t0 });
        });
      });
      r.on('error', (e) => resolve({ status: 0, headers: {}, json: { error: e.message }, ms: Date.now() - t0 }));
      r.end(data);
    });
  const cookieOf = (r) => String([].concat(r.headers['set-cookie'] ?? [])[0] ?? '').split(';')[0];
  const setCookieLine = (r) => String([].concat(r.headers['set-cookie'] ?? [])[0] ?? '');
  const as = (cookie, o) => hreq({ ...o, headers: { ...(o.router ? { origin: DD_ORIGIN } : { origin: LOCAL_ORIGIN }), ...(cookie ? { cookie } : {}), ...(o.headers ?? {}) } });
  const login = (o = {}) => hreq({ path: '/api/auth/login', method: 'POST', body: { password: o.password ?? PASSWORD }, ...o, headers: { origin: o.router ? DD_ORIGIN : LOCAL_ORIGIN, ...(o.headers ?? {}) } });
  const relogin = async () => {
    const r = await login();
    if (r.status !== 200) throw new Error(`could not sign in again (${r.status} ${r.json.error ?? ''})`);
    COOKIE = cookieOf(r);
  };
  const ageSession = (cookie) => {
    const sid = decodeURIComponent(cookie.split('=')[1]);
    const db = new DatabaseSync(join(DATA, 'servify.db'));
    db.prepare('UPDATE sessions SET reauth_at = 0 WHERE id = ?').run(`h:${createHash('sha256').update(sid).digest('hex')}`);
    db.close();
  };
  const cliAuth = (args, input) => spawnSync(process.execPath, [new URL('../server/bin/servify.mjs', import.meta.url).pathname, 'auth', ...args], { env: { ...process.env, SERVIFY_DATA_DIR: DATA }, input, encoding: 'utf8' });
  const setPolicy = (policy, cookie = COOKIE) => as(cookie, { path: '/api/auth/password-policy', method: 'PUT', body: { policy } });
  const pkOptions = (o = {}) => as(null, { path: '/api/auth/passkey/options', method: 'POST', body: {}, ...o });
  const pkLogin = (o, challengeId, response) => as(null, { path: '/api/auth/passkey/login', method: 'POST', body: { challengeId, response }, ...o });
  /** A full passkey sign-in with `auth` on this host (router or direct); returns the response. */
  const passkeySignIn = async (auth, o = {}, assertOpts = {}) => {
    const opt = await pkOptions(o);
    if (opt.status !== 200) return opt;
    const origin = o.router ? DD_ORIGIN : LOCAL_ORIGIN;
    return pkLogin(o, opt.json.challengeId, await auth.assert(opt.json.options, { origin, ...assertOpts }));
  };
  const created = { tokens: [], channel: null };

  // ─── the throttle's arithmetic ───
  console.log('\n▸ sign-in throttle: the arithmetic');
  {
    const { FailureThrottle } = await import(new URL('../server/src/throttle.ts', import.meta.url).href);
    let now = 1_000_000_000;
    const t = new FailureThrottle({}, () => now);
    const fails = [1, 2, 3, 4].map(() => t.fail('a').lockMs);
    check('the first four failures in a row cost nothing', fails.every((x) => x === 0) && t.lockedMs('a') === 0);
    const locks = [t.fail('a').lockMs, t.fail('a').lockMs, t.fail('a').lockMs];
    check('then the lock doubles: 1 s, 2 s, 4 s', JSON.stringify(locks) === '[1000,2000,4000]', JSON.stringify(locks));
    for (let i = 0; i < 20; i++) t.fail('a');
    check('…up to 15 minutes at most', t.lockedMs('a') === 15 * 60_000, String(t.lockedMs('a')));
    check('another address is not affected', t.lockedMs('b') === 0);
    t.succeed('a');
    check('a success resets the address', t.lockedMs('a') === 0 && t.fail('a').lockMs === 0);
    const d = new FailureThrottle({}, () => now);
    for (let i = 0; i < 50; i++) {
      d.fail('c');
      now += 20 * 60_000; // past every backoff lock
    }
    check('the daily cap: 50 failures within 24 h lock the address until the oldest is a day old', d.lockedMs('c') > 0 && d.lockedMs('c') <= 86_400_000, String(d.lockedMs('c')));
    now += 86_400_000;
    check('…and a quiet day forgets it', d.lockedMs('c') === 0);
    const g = new FailureThrottle({}, () => now);
    for (let i = 0; i < 30; i++) g.fail(`ip${i}`);
    check('global: up to 30 failures a minute, no slow-down', g.globalDelayMs() === 0);
    for (let i = 0; i < 20; i++) g.fail(`ip${i + 30}`);
    check('above it each password check waits (100 ms per extra failure)', g.globalDelayMs() === 2000, String(g.globalDelayMs()));
    for (let i = 0; i < 500; i++) g.fail(`x${i}`);
    check('…never more than 5 s, and never a refusal (no lock for fresh addresses)', g.globalDelayMs() === 5000 && g.lockedMs('fresh') === 0);
    now += 61_000;
    check('a quiet minute ends the slow-down', g.globalDelayMs() === 0);
  }

  // ─── fixtures ───
  console.log('\n▸ sign-in: fixtures');
  check('starts with password sign-in everywhere and no passkeys (clean instance)', (await as(COOKIE, { path: '/api/auth/security' })).json.passwordPolicy === 'everywhere' && (await as(COOKIE, { path: '/api/auth/security' })).json.passkeys?.length === 0);
  const hooks = [];
  const receiver = http.createServer((q, s) => {
    let b = '';
    q.on('data', (c) => (b += c));
    q.on('end', () => {
      try {
        hooks.push(JSON.parse(b));
      } catch {}
      s.end('ok');
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => receiver.close(r)));
  const ch = await api('POST', '/settings/notifications/channels', { name: 'acc-auth', type: 'webhook', url: `http://127.0.0.1:${receiver.address().port}/hook`, events: ['auth.failed'] });
  cleanups.push(() => api('DELETE', `/settings/notifications/channels/${ch.id}`).catch(() => {}));
  const settings0 = await api('GET', '/settings');
  // Open to anyone, so the router passes forwarded addresses through instead of refusing them at the door.
  await api('PATCH', '/settings/general', { dashboardDomain: DD, dashboardAllow: [] });
  cleanups.push(() => api('PATCH', '/settings/general', { dashboardDomain: settings0.dashboardDomain ?? null, dashboardAllow: settings0.dashboardAllow }).catch(() => {}));
  const readTok = (await api('POST', '/tokens', { name: 'acc-auth-read', scope: 'read' })).token;
  const readId = (await api('GET', '/tokens')).find((t) => t.name === 'acc-auth-read')?.id;
  cleanups.push(() => api('DELETE', `/tokens/${readId}`).catch(() => {}));

  // ─── where passkeys can be used ───
  console.log('\n▸ passkeys: which hosts');
  const st = async (o) => (await hreq({ path: '/api/auth/status', ...o })).json.passkeySignIn ?? {};
  const local = await st({});
  check('http://localhost: passkeys available, bound to "localhost"', local.available === true && local.rpId === 'localhost', JSON.stringify(local));
  const ip = await st({ host: `127.0.0.1:${port}` });
  check('an IP address (even 127.0.0.1): no passkeys, and the login page is told why', ip.available === false && /IP address/.test(ip.reason ?? ''), JSON.stringify(ip));
  const lan = await st({ host: `192.0.2.10:${port}` });
  check('a LAN address over plain HTTP: no passkeys', lan.available === false, JSON.stringify(lan));
  const appHost = await st({ host: `web.someproject.localhost:${port}` });
  check('*.localhost names Servify does not list (hosted apps live there): no passkeys', appHost.available === false && /aren't offered/.test(appHost.reason ?? ''), JSON.stringify(appHost));
  const ddHttp = await st({ host: `${DD}:${port}` });
  check('the dashboard domain over plain HTTP (dashboard port): no passkeys, "need HTTPS"', ddHttp.available === false && /HTTPS/.test(ddHttp.reason ?? ''), JSON.stringify(ddHttp));
  const ddHttps = await st({ router: true });
  check('the dashboard domain over HTTPS through the router: passkeys bound to it', ddHttps.available === true && ddHttps.rpId === DD, JSON.stringify(ddHttps));
  const caDir = mkdtempSync(join(tmpdir(), 'acc-auth-ca-'));
  writeFileSync(join(caDir, 'ca.pem'), CA);
  cleanups.push(() => rmSync(caDir, { recursive: true, force: true }));
  const curlStatus = execSync(`curl -s --max-time 10 --resolve ${DD}:${HTTPS_PORT}:127.0.0.1 --cacert ${join(caDir, 'ca.pem')} https://${DD}:${HTTPS_PORT}/api/auth/status`).toString();
  check('curl --resolve with the local CA (the real HTTPS path): passkeys offered for the domain', JSON.parse(curlStatus).passkeySignIn?.rpId === DD, curlStatus.slice(0, 160));

  // ─── password policy ───
  console.log('\n▸ password policy');
  check('"off" is refused while there is no passkey (409)', (await setPolicy('off')).status === 409);
  check('an unknown value is refused (400)', (await setPolicy('sometimes')).status === 400);
  check('tokens can\'t change it', (await hreq({ path: '/api/auth/password-policy', method: 'PUT', body: { policy: 'private' }, headers: { authorization: `Bearer ${readTok}` } })).status === 403);
  const pPriv = await setPolicy('private');
  check('"private networks only" is set (fresh session)', pPriv.status === 200 && pPriv.json.passwordPolicy === 'private', `${pPriv.status} ${pPriv.json.error ?? ''}`);
  check('…from this machine (loopback, no proxy) the password still works', (await login()).status === 200);
  if (TRUSTS_LOCAL) {
    const pub = await login({ headers: xff('203.0.113.7') });
    check('trusted proxy: a public forwarded client is refused (403 password_private_only)', pub.status === 403 && pub.json.code === 'password_private_only', `${pub.status} ${pub.json.code}`);
    check('trusted proxy: a private forwarded client (10.x) is let in', (await login({ headers: xff('10.20.30.40') })).status === 200);
    const dev = await hreq({ path: '/api/auth/device', method: 'POST', body: { password: PASSWORD, name: 'acc' }, headers: { origin: 'http://localhost', ...xff('203.0.113.7') } });
    check('…and the phone app sign-in (/auth/device) obeys it too', dev.status === 403 && dev.json.code === 'password_private_only', `${dev.status}`);
    const viaRouter = await login({ router: true, headers: xff('198.51.100.44') });
    check('through the dashboard domain the router passes the real visitor on: public → refused', viaRouter.status === 403 && viaRouter.json.code === 'password_private_only', `${viaRouter.status} ${viaRouter.json.code ?? ''}`);
    check('…and its own loopback hop does not count as private for a public visitor, but a local visitor gets in', (await login({ router: true })).status === 200);
    const stPub = (await hreq({ path: '/api/auth/status', headers: xff('203.0.113.7') })).json.passwordSignIn;
    check('/auth/status tells a public client the password is refused here (for the login page)', stPub?.allowed === false && stPub.code === 'password_private_only', JSON.stringify(stPub));
  } else {
    const spoofPub = await login({ headers: xff('203.0.113.7') });
    const spoofPriv = await login({ headers: xff('10.20.30.40') });
    check('untrusted peer sending X-Forwarded-For: not believed either way — refused, fails closed (403)', spoofPub.status === 403 && spoofPriv.status === 403 && spoofPriv.json.code === 'password_private_only', `${spoofPub.status} ${spoofPriv.status}`);
    const viaRouter = await login({ router: true, headers: xff('10.20.30.40') });
    check('through the router with X-Forwarded-For from an untrusted peer: refused too (the router flags it)', viaRouter.status === 403, `${viaRouter.status}`);
    check('…and without it, the local visitor through the router gets in', (await login({ router: true })).status === 200);
  }
  check('back to "everywhere"', (await setPolicy('everywhere')).json.passwordPolicy === 'everywhere');

  // ─── confirming before sensitive changes ───
  console.log('\n▸ confirm it is you (re-authentication)');
  ageSession(COOKIE);
  const stale = await as(COOKIE, { path: '/api/auth/passkeys/options', method: 'POST', body: {} });
  check('a session signed in more than 5 minutes ago must confirm first (403 reauth_required)', stale.status === 403 && stale.json.code === 'reauth_required', `${stale.status} ${stale.json.code}`);
  check('…also for the password policy', (await setPolicy('private')).json.code === 'reauth_required');
  check('a wrong password does not confirm (401)', (await as(COOKIE, { path: '/api/auth/reauth', method: 'POST', body: { password: 'nope-nope' } })).status === 401);
  const ok = await as(COOKIE, { path: '/api/auth/reauth', method: 'POST', body: { password: PASSWORD } });
  check('the right one does, for 5 minutes', ok.status === 200 && ok.json.freshUntil > Date.now() + 4 * 60_000);
  const devSignin = await hreq({ path: '/api/auth/device', method: 'POST', body: { password: PASSWORD, name: 'acc-auth-phone' }, headers: { origin: 'http://localhost' } });
  const devTok = devSignin.json.token;
  check('a phone signs in with the password (everywhere)', devSignin.status === 201 && typeof devTok === 'string');
  check('a phone (device token) can\'t add passkeys or change the policy, though it acts as the owner', (await hreq({ path: '/api/auth/passkeys/options', method: 'POST', body: {}, headers: { authorization: `Bearer ${devTok}` } })).status === 403 && (await hreq({ path: '/api/auth/password-policy', method: 'PUT', body: { policy: 'off' }, headers: { authorization: `Bearer ${devTok}` } })).status === 403);

  // ─── adding a passkey ───
  console.log('\n▸ passkeys: adding');
  const A = await softAuthenticator();
  const regOpt = await as(COOKIE, { path: '/api/auth/passkeys/options', method: 'POST', body: {} });
  check('registration options: discoverable, user verification required, bound to localhost', regOpt.status === 200 && regOpt.json.options?.rp?.id === 'localhost' && regOpt.json.options.authenticatorSelection?.residentKey === 'required' && regOpt.json.options.authenticatorSelection?.userVerification === 'required', JSON.stringify(regOpt.json.options?.authenticatorSelection));
  const badOrigin = await softAuthenticator();
  const regBad = await as(COOKIE, { path: '/api/auth/passkeys', method: 'POST', body: { challengeId: regOpt.json.challengeId, response: badOrigin.register(regOpt.json.options, { origin: 'http://evil.example' }) } });
  check('a registration from another origin is refused', regBad.status === 400, `${regBad.status}`);
  const regReplay = await as(COOKIE, { path: '/api/auth/passkeys', method: 'POST', body: { challengeId: regOpt.json.challengeId, response: A.register(regOpt.json.options, { origin: LOCAL_ORIGIN }) } });
  check('…and its challenge is gone afterwards (single use, pass or fail)', regReplay.status === 401 && regReplay.json.code === 'challenge_expired', `${regReplay.status} ${regReplay.json.code}`);
  const otherSession = cookieOf(await login());
  const regOpt2 = await as(COOKIE, { path: '/api/auth/passkeys/options', method: 'POST', body: {} });
  const regOtherSess = await as(otherSession, { path: '/api/auth/passkeys', method: 'POST', body: { challengeId: regOpt2.json.challengeId, response: A.register(regOpt2.json.options, { origin: LOCAL_ORIGIN }) } });
  check('a registration challenge belongs to the session that asked for it', regOtherSess.status === 401 && regOtherSess.json.code === 'challenge_mismatch', `${regOtherSess.status} ${regOtherSess.json.code}`);
  const regOpt3 = await as(COOKIE, { path: '/api/auth/passkeys/options', method: 'POST', body: {} });
  const reg = await as(COOKIE, { path: '/api/auth/passkeys', method: 'POST', body: { challengeId: regOpt3.json.challengeId, response: A.register(regOpt3.json.options, { origin: LOCAL_ORIGIN }), name: 'acc soft key' } });
  check('a passkey is added (software authenticator, "none" attestation)', reg.status === 201 && reg.json.passkey?.rpId === 'localhost' && reg.json.passkey?.name === 'acc soft key', `${reg.status} ${reg.json.error ?? ''}`);
  check('the first passkey: the server suggests "private networks only" — and changes nothing by itself', reg.json.suggestPolicy === 'private' && (await as(COOKIE, { path: '/api/auth/security' })).json.passwordPolicy === 'everywhere');
  const sec = (await as(COOKIE, { path: '/api/auth/security' })).json;
  check('the list shows name, host (RP id), created and last used', sec.passkeys?.length === 1 && sec.passkeys[0].rpId === 'localhost' && sec.passkeys[0].createdAt > 0 && sec.passkeys[0].lastUsedAt === null && !('publicKey' in sec.passkeys[0]));
  const regOpt4 = await as(COOKIE, { path: '/api/auth/passkeys/options', method: 'POST', body: {} });
  check('the same authenticator is excluded next time (excludeCredentials)', regOpt4.json.options?.excludeCredentials?.some((c) => c.id === A.id));
  const pkId = reg.json.passkey?.id;
  check('rename works', (await as(COOKIE, { path: `/api/auth/passkeys/${pkId}`, method: 'PATCH', body: { name: 'acc renamed' } })).json.name === 'acc renamed');

  // ─── signing in with it ───
  console.log('\n▸ passkeys: signing in');
  const good = await passkeySignIn(A);
  const pkCookie = cookieOf(good);
  check('sign in with the passkey: a session cookie (no Secure on plain http://localhost)', good.status === 200 && pkCookie.startsWith('servify_session=') && !/;\s*Secure/i.test(setCookieLine(good)), `${good.status} ${good.json.error ?? ''}`);
  check('…that works', (await as(pkCookie, { path: '/api/projects' })).status === 200);
  check('…and last used is recorded', (await as(COOKIE, { path: '/api/auth/security' })).json.passkeys[0].lastUsedAt > 0);
  // Negative cases, each followed by a good sign-in (which resets this address's passkey failures).
  const neg = async (label, fn, want = 401) => {
    const r = await fn();
    check(label, r.status === want, `${r.status} ${r.json.code ?? ''} ${r.json.error ?? ''}`.slice(0, 160));
    await passkeySignIn(A);
    return r;
  };
  {
    const o = await pkOptions();
    const resp = await A.assert(o.json.options, { origin: LOCAL_ORIGIN });
    await pkLogin({}, o.json.challengeId, resp);
    await neg('a replayed assertion (same challenge) is refused', () => pkLogin({}, o.json.challengeId, resp));
  }
  await neg('a wrong origin is refused', async () => {
    const o = await pkOptions();
    return pkLogin({}, o.json.challengeId, await A.assert(o.json.options, { origin: 'http://evil.example' }));
  });
  await neg('a wrong RP id (signed for another host) is refused', async () => {
    const o = await pkOptions();
    return pkLogin({}, o.json.challengeId, await A.assert(o.json.options, { origin: LOCAL_ORIGIN, rpId: 'example.com' }));
  });
  await neg('an unknown credential is refused (unknown_passkey)', async () => {
    const stranger = await softAuthenticator();
    const o = await pkOptions();
    return pkLogin({}, o.json.challengeId, await stranger.assert(o.json.options, { origin: LOCAL_ORIGIN }));
  });
  await neg('a tampered signature is refused', async () => {
    const o = await pkOptions();
    return pkLogin({}, o.json.challengeId, await A.assert(o.json.options, { origin: LOCAL_ORIGIN, tamper: true }));
  });
  await neg('a counter going backwards is refused (a cloned authenticator)', async () => {
    const o = await pkOptions();
    return pkLogin({}, o.json.challengeId, await A.assert(o.json.options, { origin: LOCAL_ORIGIN, count: 1 }));
  });
  await neg('a made-up challenge id is refused', async () => {
    const o = await pkOptions();
    return pkLogin({}, 'not-a-challenge', await A.assert(o.json.options, { origin: LOCAL_ORIGIN }));
  });
  check('passkey options on an IP address are refused (400 passkeys_unavailable)', (await pkOptions({ host: `127.0.0.1:${port}`, headers: { origin: `http://127.0.0.1:${port}` } })).json.code === 'passkeys_unavailable');

  // ─── the dashboard domain: Secure cookies, a passkey bound to it ───
  console.log('\n▸ the dashboard domain over HTTPS');
  const ddLogin = await login({ router: true });
  const ddCookie = cookieOf(ddLogin);
  check('password sign-in over HTTPS (router): the cookie is Secure, HttpOnly, SameSite=Strict', ddLogin.status === 200 && /;\s*Secure/i.test(setCookieLine(ddLogin)) && /HttpOnly/i.test(setCookieLine(ddLogin)) && /SameSite=Strict/i.test(setCookieLine(ddLogin)), setCookieLine(ddLogin).replace(/=[^;]+/, '=…'));
  const plainLogin = await login();
  check('…and not Secure over plain http://localhost', plainLogin.status === 200 && !/;\s*Secure/i.test(setCookieLine(plainLogin)));
  const B = await softAuthenticator();
  const ddOpt = await as(ddCookie, { router: true, path: '/api/auth/passkeys/options', method: 'POST', body: {} });
  const ddReg = await as(ddCookie, { router: true, path: '/api/auth/passkeys', method: 'POST', body: { challengeId: ddOpt.json.challengeId, response: B.register(ddOpt.json.options, { origin: DD_ORIGIN }) } });
  check('a passkey added through the domain is bound to the domain', ddReg.status === 201 && ddReg.json.passkey?.rpId === DD && ddReg.json.suggestPolicy === null, `${ddReg.status} ${ddReg.json.error ?? ''}`);
  const ddPk = await passkeySignIn(B, { router: true });
  check('it signs in there (Secure cookie)', ddPk.status === 200 && /;\s*Secure/i.test(setCookieLine(ddPk)), `${ddPk.status} ${ddPk.json.error ?? ''}`);
  const crossA = await passkeySignIn(A, { router: true }, { rpId: DD });
  check('the localhost passkey does not sign in on the domain (wrong_host)', crossA.status === 401 && crossA.json.code === 'wrong_host', `${crossA.status} ${crossA.json.code}`);
  await passkeySignIn(A);
  const crossB = await passkeySignIn(B, {}, { rpId: 'localhost' });
  check('…nor the domain\'s passkey on localhost', crossB.status === 401 && crossB.json.code === 'wrong_host', `${crossB.status} ${crossB.json.code}`);
  await passkeySignIn(B, { router: true });
  const ddKey = (await as(COOKIE, { path: '/api/auth/security' })).json.passkeys.find((p) => p.rpId === DD);

  // ─── per-address throttle ───
  console.log('\n▸ sign-in throttle on the instance');
  const wrong = (o = {}) => login({ password: 'definitely-wrong', ...o });
  if (TRUSTS_LOCAL) {
    const atk = xff('198.51.100.20');
    const five = [];
    for (let i = 0; i < 5; i++) five.push((await wrong({ headers: atk })).status);
    check('an attacker address: five wrong passwords get 401', five.every((s) => s === 401), five.join(','));
    const locked = await wrong({ headers: atk });
    check('…then 429 with Retry-After', locked.status === 429 && Number(locked.headers['retry-after']) >= 1 && locked.json.code === 'throttled', `${locked.status} ${locked.headers['retry-after']}`);
    check('…even with the right password (locked addresses learn nothing)', (await login({ headers: atk })).status === 429);
    check('the owner from another address signs in at once', (await login({ headers: xff('198.51.100.30') })).status === 200);
    check('a passkey still signs in from the locked address (counted separately)', (await passkeySignIn(A, { headers: atk })).status === 200);
    await sleep(2200);
    check('after the lock, the right password from that address works…', (await login({ headers: atk })).status === 200);
    check('…and resets it (the next wrong one is a plain 401, not 429)', (await wrong({ headers: atk })).status === 401);
    for (let i = 0; i < 5; i++) await wrong({ headers: xff('2001:db8:aa:bb::1') });
    check('IPv6 counts by /64: another address in the same /64 is locked too', (await wrong({ headers: xff('2001:db8:aa:bb::2') })).status === 429);
    check('…a different /64 is not', (await wrong({ headers: xff('2001:db8:aa:cc::1') })).status === 401);
    for (let i = 0; i < 5; i++) await hreq({ path: '/api/auth/device', method: 'POST', body: { password: 'wrong-again', name: 'x' }, headers: { origin: 'http://localhost', ...xff('198.51.100.21') } });
    check('phone sign-in failures count toward the same address limit', (await login({ headers: xff('198.51.100.21') })).status === 429);
    // The global backstop: many addresses failing at once slow every password check down, never refuse it.
    for (let a = 0; a < 8; a++) for (let i = 0; i < 5; i++) await wrong({ headers: xff(`198.51.100.${100 + a}`) });
    const fresh = await login({ headers: xff('198.51.100.250') });
    check('under a spread-out attack the owner on a fresh address still gets in (slowed, never 429)', fresh.status === 200 && fresh.ms >= 500, `${fresh.status} after ${fresh.ms} ms`);
    const pkFast = await passkeySignIn(A, { headers: xff('198.51.100.251') });
    check('…and passkey sign-in is not slowed by it', pkFast.status === 200 && pkFast.ms < 500, `${pkFast.status} ${pkFast.ms} ms`);
  } else {
    for (let i = 0; i < 5; i++) await wrong();
    const locked = await wrong();
    check('five wrong passwords from this address, then 429 with Retry-After', locked.status === 429 && Number(locked.headers['retry-after']) >= 1, `${locked.status}`);
    check('a forwarded address from an untrusted peer does not get around it (X-Forwarded-For ignored)', (await wrong({ headers: xff('198.51.100.77') })).status === 429);
    check('a passkey still signs in (counted separately)', (await passkeySignIn(A)).status === 200);
    await sleep(2200);
    check('after the lock the right password works and resets the count', (await login()).status === 200 && (await wrong()).status === 401);
    await login();
    console.log('  – the multi-address checks (owner on another address, IPv6 /64, global slow-down) need SERVIFY_TRUSTED_PROXIES=127.0.0.1');
  }

  // ─── password sign-in off, and the way back ───
  console.log('\n▸ password sign-in off, and recovery');
  const pkConfirmOpt = await pkOptions();
  const pkConfirm = await as(COOKIE, { path: '/api/auth/reauth', method: 'POST', body: { challengeId: pkConfirmOpt.json.challengeId, response: await A.assert(pkConfirmOpt.json.options, { origin: LOCAL_ORIGIN }) } });
  check('confirming with a passkey works too', pkConfirm.status === 200 && pkConfirm.json.freshUntil > Date.now(), `${pkConfirm.status} ${pkConfirm.json.error ?? ''}`);
  check('"off" is accepted now that passkeys exist', (await setPolicy('off')).json.passwordPolicy === 'off');
  const offLogin = await login();
  const offDev = await hreq({ path: '/api/auth/device', method: 'POST', body: { password: PASSWORD, name: 'x' }, headers: { origin: 'http://localhost' } });
  check('the password is refused everywhere — dashboard and phone (403 password_off)', offLogin.status === 403 && offLogin.json.code === 'password_off' && offDev.status === 403 && offDev.json.code === 'password_off', `${offLogin.status} ${offDev.status}`);
  check('…and confirming with it too', (await as(COOKIE, { path: '/api/auth/reauth', method: 'POST', body: { password: PASSWORD } })).json.code === 'password_off');
  check('passkeys still sign in', (await passkeySignIn(A)).status === 200);
  check('removing one of two passkeys is fine', (await as(COOKIE, { path: `/api/auth/passkeys/${pkId}`, method: 'DELETE' })).status === 200);
  const moveDomain = await api('PATCH', '/settings/general', { dashboardDomain: null }).then(() => 200, (e) => Number(/→ (\d+)/.exec(e.message)?.[1]));
  check('clearing the dashboard domain is refused while its passkey is the only way in (409)', moveDomain === 409, String(moveDomain));
  check('removing the last usable passkey is refused (409)', (await as(COOKIE, { path: `/api/auth/passkeys/${ddKey?.id}`, method: 'DELETE' })).status === 409);
  const status0 = cliAuth(['status']);
  check('`servify auth status` on the host shows the policy and passkeys (no secrets)', status0.status === 0 && /off \(passkeys only\)/.test(status0.stdout) && status0.stdout.includes(DD) && !status0.stdout.includes(PASSWORD), status0.stderr.slice(0, 200));
  const rst = cliAuth(['reset', '--keep-password']);
  check('`servify auth reset --keep-password` turns password sign-in back on (no restart)', rst.status === 0 && /allowed everywhere/.test(rst.stdout) && (await login()).status === 200, (rst.stderr || rst.stdout).slice(0, 200));
  check('…and it ended every dashboard session', (await as(COOKIE, { path: '/api/projects' })).status === 401);
  const newPw = cliAuth(['reset', '--password-stdin'], `${PASSWORD}\n`);
  check('`servify auth reset --password-stdin` sets a new password from stdin (never argv)', newPw.status === 0 && /new owner password/.test(newPw.stdout), (newPw.stderr || newPw.stdout).slice(0, 200));
  check('a too-short password is refused and nothing changes', cliAuth(['reset', '--password-stdin'], 'abc\n').status === 1 && (await login()).status === 200);
  check('the activity log records the reset', (await (async () => (await relogin(), await api('GET', '/activity?limit=50')))()).some((a) => a.action === 'auth.reset'));

  // ─── sign out everywhere ───
  console.log('\n▸ sign out everywhere');
  const s1 = cookieOf(await login());
  const s2 = cookieOf(await login());
  const phone = (await hreq({ path: '/api/auth/device', method: 'POST', body: { password: PASSWORD, name: 'acc-auth-phone-2' }, headers: { origin: 'http://localhost' } })).json.token;
  const out1 = await as(s1, { path: '/api/auth/signout-all', method: 'POST', body: {} });
  check('ends every dashboard session, this one too', out1.status === 200 && (await as(s1, { path: '/api/projects' })).status === 401 && (await as(s2, { path: '/api/projects' })).status === 401 && (await as(COOKIE, { path: '/api/projects' })).status === 401);
  check('…phones stay signed in unless asked', (await hreq({ path: '/api/projects', headers: { authorization: `Bearer ${phone}` } })).status === 200);
  await relogin();
  const out2 = await as(COOKIE, { path: '/api/auth/signout-all', method: 'POST', body: { devices: true } });
  check('with devices: true every phone is signed out too', out2.status === 200 && out2.json.devices >= 1 && (await hreq({ path: '/api/projects', headers: { authorization: `Bearer ${phone}` } })).status === 401 && (await hreq({ path: '/api/projects', headers: { authorization: `Bearer ${devTok}` } })).status === 401);
  check('tokens can\'t sign everyone out', (await hreq({ path: '/api/auth/signout-all', method: 'POST', body: {}, headers: { authorization: `Bearer ${readTok}` } })).status === 403);
  await relogin();

  // ─── phone pairing ───
  console.log('\n▸ approving a phone from the dashboard');
  const app = { origin: 'http://localhost' };
  const tip = (n) => (TRUSTS_LOCAL ? xff(`192.0.2.${n}`) : {});
  const start = (n, name = 'acc pixel') => hreq({ path: '/api/auth/pair/start', method: 'POST', body: { name }, headers: { ...app, ...tip(n) } });
  const poll = (pid, n) => hreq({ path: `/api/auth/pair/${pid}`, headers: { ...app, ...tip(n) } });
  const events = [];
  const listen = (headers) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { host: `localhost:${port}`, accept: 'text/event-stream', ...headers }, agent: false }, (res) => res.on('data', (c) => events.push([headers.cookie ? 'owner' : 'token', String(c)])));
    r.on('error', () => {});
    return r;
  };
  const evOwner = listen({ cookie: COOKIE });
  const evTok = listen({ authorization: `Bearer ${readTok}` });
  await sleep(400);
  const p1 = await start(1);
  check('POST /auth/pair/start (from the app\'s origin, no credentials): 201 with pairingId, an 8-character code and expiresAt', p1.status === 201 && p1.json.pairingId?.length >= 40 && /^[A-HJ-NP-Z2-9]{8}$/.test(p1.json.code ?? '') && p1.json.expiresAt > Date.now(), `${p1.status} ${p1.json.error ?? ''}`);
  const ttl = p1.json.expiresAt - Date.now();
  check('the app polls: pending', (await poll(p1.json.pairingId, 1)).json.status === 'pending');
  const pend = await as(COOKIE, { path: '/api/auth/pairings' });
  const mine = pend.json.find?.((p) => p.code === p1.json.code);
  check('the owner sees it: code, device name, address and time (no pairingId)', !!mine && mine.name === 'acc pixel' && mine.ip === (TRUSTS_LOCAL ? '192.0.2.1' : '127.0.0.1') && mine.createdAt > 0 && !JSON.stringify(pend.json).includes(p1.json.pairingId), JSON.stringify(mine ?? {}).replace(/"code":"[^"]+"/, '"code":"…"'));
  check('tokens can\'t list or approve pairings', (await hreq({ path: '/api/auth/pairings', headers: { authorization: `Bearer ${readTok}` } })).status === 403 && (await hreq({ path: `/api/auth/pairings/${mine?.id}/approve`, method: 'POST', body: {}, headers: { authorization: `Bearer ${readTok}` } })).status === 403);
  await sleep(400);
  check('the owner\'s dashboard is told (auth.pairing event); a read token\'s event stream is not', events.some(([w, d]) => w === 'owner' && d.includes('auth.pairing')) && !events.some(([w, d]) => w === 'token' && d.includes('auth.pairing')));
  evOwner.destroy();
  evTok.destroy();
  check('approve', (await as(COOKIE, { path: `/api/auth/pairings/${mine?.id}/approve`, method: 'POST', body: {} })).status === 200);
  const claimed = await poll(p1.json.pairingId, 1);
  const pairTok = claimed.json.token;
  check('the next poll: approved, with a device token and the device record', claimed.status === 200 && claimed.json.status === 'approved' && /^svf_/.test(pairTok ?? '') && claimed.json.device?.kind === 'device' && claimed.json.device?.name === 'acc pixel', `${claimed.status} ${claimed.json.status}`);
  const again = await poll(p1.json.pairingId, 1);
  check('…exactly once: the poll after that gets nothing (404 expired)', again.status === 404 && again.json.status === 'expired' && !again.json.token);
  check('the token is a normal device token: listed under signed-in devices, acts as the owner', (await api('GET', '/devices')).some((d) => d.name === 'acc pixel') && (await hreq({ path: '/api/devices', headers: { authorization: `Bearer ${pairTok}` } })).status === 200);
  check('…and it can sign itself out', (await hreq({ path: '/api/auth/device', method: 'DELETE', headers: { authorization: `Bearer ${pairTok}` } })).status === 200);
  const acts = JSON.stringify(await api('GET', '/activity?limit=50'));
  check('neither the code nor the pairingId reaches the activity log', !acts.includes(p1.json.code) && !acts.includes(p1.json.pairingId));
  const p2 = await start(2, 'acc deny me');
  const p2id = (await as(COOKIE, { path: '/api/auth/pairings' })).json.find((p) => p.code === p2.json.code)?.id;
  check('deny', (await as(COOKIE, { path: `/api/auth/pairings/${p2id}/deny`, method: 'POST', body: {} })).status === 200);
  check('…the app is told: denied (no token)', (await poll(p2.json.pairingId, 2)).json.status === 'denied');
  check('…and a denied request can\'t be approved afterwards', (await as(COOKIE, { path: `/api/auth/pairings/${p2id}/approve`, method: 'POST', body: {} })).status === 404);
  check('a made-up pairingId: 404 expired', (await poll(randomBytes(32).toString('base64url'), 2)).status === 404);
  const p3 = await start(3, 'acc second');
  const p4 = await start(3, 'acc third');
  const p5 = await start(3, 'acc fourth');
  check('at most 2 waiting requests per address (the third: 429)', p3.status === 201 && p4.status === 201 && p5.status === 429 && Number(p5.headers['retry-after']) > 0, `${p3.status} ${p4.status} ${p5.status}`);
  if (ttl <= 20_000) {
    // p3 and p4 are still waiting: let them run out.
    await sleep(Math.max(0, p4.json.expiresAt - Date.now()) + 1500);
    const exp = await poll(p4.json.pairingId, 3);
    check('an unanswered request expires (the app sees "expired")', exp.json.status === 'expired', JSON.stringify(exp.json.status));
    check('…and is gone from the owner\'s list', !(await as(COOKIE, { path: '/api/auth/pairings' })).json.some((p) => p.code === p4.json.code || p.code === p3.json.code));
    check('…which frees the address\'s slots', (await as(COOKIE, { path: '/api/auth/pairings' })).json.length === 0);
  } else {
    console.log(`  – skipped the expiry check (start Servify with SERVIFY_PAIRING_TTL_MS=15000; the TTL here is ${Math.round(ttl / 1000)} s)`);
    await as(COOKIE, { path: '/api/auth/pairings/deny-all', method: 'POST', body: {} });
  }
  if (TRUSTS_LOCAL) {
    for (let n = 10; n < 15; n++) for (let k = 0; k < 2; k++) await start(n);
    const full = await start(20);
    check('at most 10 waiting in all: then new requests are refused (429), not pushed out', full.status === 429 && /waiting/.test(full.json.error ?? ''), `${full.status}`);
    check('deny all frees them', (await as(COOKIE, { path: '/api/auth/pairings/deny-all', method: 'POST', body: {} })).json.denied === 10 && (await start(20)).status === 201);
    const starts = [];
    for (let k = 0; k < 6; k++) {
      const r = await start(30);
      starts.push(r.status);
      await as(COOKIE, { path: '/api/auth/pairings/deny-all', method: 'POST', body: {} });
    }
    check('at most 5 starts per address per 10 minutes', JSON.stringify(starts) === '[201,201,201,201,201,429]', starts.join(','));
  }
  await as(COOKIE, { path: '/api/auth/pairings/deny-all', method: 'POST', body: {} });

  // ─── what the owner hears about failures ───
  console.log('\n▸ failed sign-ins in the activity log and notifications');
  await sleep(4500); // SERVIFY_AUTH_LOG_QUIET_MS=3000
  const fails = (await api('GET', '/activity?limit=200')).filter((a) => a.action === 'auth.failed' && a.ts >= sectionStart);
  const counted = fails.reduce((n, a) => n + Number(/^(\d+) failed/.exec(a.summary)?.[1] ?? 0), 0);
  check(`failures are logged in batches: ${counted} failures in ${fails.length} entr${fails.length === 1 ? 'y' : 'ies'}`, fails.length >= 1 && counted >= 10 && fails.length * 3 < counted, fails.map((a) => a.summary.slice(0, 80)).join(' | '));
  check('…naming the addresses and how they were tried', fails.some((a) => /password/.test(a.summary) && /\(\d+\)/.test(a.summary)));
  const notes = hooks.filter((h) => h.event === 'auth.failed');
  check('one notification for the whole burst', notes.length === 1, `${notes.length}`);

  // ─── leave it as it was ───
  const done = cliAuth(['reset', '--keep-password', '--remove-passkeys']);
  check('clean-up: `servify auth reset --keep-password --remove-passkeys`', done.status === 0 && /passkey\(s\) removed/.test(done.stdout), (done.stderr || done.stdout).slice(0, 200));
  await relogin();
}

main()
  .catch((e) => {
    failures++;
    console.error('\n✗', e.message, e.cause ?? '', (e.stack ?? '').split('\n').slice(1, 4).join(' | '));
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
