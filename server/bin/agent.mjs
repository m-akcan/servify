#!/usr/bin/env node
/**
 * servify agent — lets a Servify run services on this machine's Docker.
 *
 *   node agent.mjs --join https://<servify-host>:7701 --token svn_… --fingerprint AB:CD:…
 *
 * The agent dials out to Servify (no inbound ports here). It checks the server's TLS certificate against the pinned
 * fingerprint before sending its token, then opens streams on request — only ever to this machine's Docker socket or
 * to a 127.0.0.1 port (where Servify publishes replica ports). Zero dependencies: Node 18+ is enough.
 *
 * Options (or env): --join (SERVIFY_JOIN), --token (SERVIFY_AGENT_TOKEN), --fingerprint (SERVIFY_FINGERPRINT),
 *                   --docker <socket path> (DOCKER_HOST=unix://… , default /var/run/docker.sock)
 */
import tls from 'node:tls';
import net from 'node:net';
import os from 'node:os';
import { readFileSync, statfsSync } from 'node:fs';
import http from 'node:http';

const VERSION = '0.2.1';

// Live usage of this machine for Servify's overview (same fields as server/src/hoststats.ts). Inside the agent's
// container /proc/meminfo and the CPU counters are the host's; the disk is the one Docker stores containers on.
const cpuTimes = () => os.cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq }), { idle: 0, total: 0 });
let prevCpu = cpuTimes();
function hostStats() {
  const cpu = cpuTimes();
  const dTotal = cpu.total - prevCpu.total;
  const cpuPct = dTotal > 0 ? Math.round((1 - (cpu.idle - prevCpu.idle) / dTotal) * 1000) / 10 : null;
  prevCpu = cpu;
  let memAvailable = os.freemem();
  try {
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readFileSync('/proc/meminfo', 'utf8'));
    if (m) memAvailable = Number(m[1]) * 1024;
  } catch {}
  let diskTotal = null;
  let diskFree = null;
  try {
    const s = statfsSync('/');
    diskTotal = s.blocks * s.bsize;
    diskFree = s.bavail * s.bsize;
  } catch {}
  return { cpuPct, load: os.loadavg().map((n) => Math.round(n * 100) / 100), memTotal: os.totalmem(), memAvailable, diskTotal, diskFree, uptimeSec: Math.round(os.uptime()) };
}
const args = process.argv.slice(2);
const opt = (name, env) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : process.env[env];
};
const join = opt('join', 'SERVIFY_JOIN');
const token = opt('token', 'SERVIFY_AGENT_TOKEN');
const fingerprint = (opt('fingerprint', 'SERVIFY_FINGERPRINT') ?? '').toUpperCase();
const dockerSock = opt('docker', 'SERVIFY_DOCKER_SOCK') ?? (process.env.DOCKER_HOST?.startsWith('unix://') ? process.env.DOCKER_HOST.slice(7) : '/var/run/docker.sock');
if (!join || !token || !fingerprint) {
  console.error('usage: agent.mjs --join https://<servify-host>:7701 --token svn_… --fingerprint AB:CD:…');
  process.exit(2);
}
const u = new URL(join);
const host = u.hostname.replace(/^\[|\]$/g, '');
const port = Number(u.port || 7701);
const log = (...a) => console.log(new Date().toISOString(), ...a);

/** TLS to Servify, pin-checked, then an HTTP Upgrade on `path`. Resolves with the raw socket. */
function dial(path) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, allowHalfOpen: true });
    const fail = (e) => {
      sock.destroy();
      reject(e);
    };
    sock.setTimeout(15_000, () => fail(new Error('timed out')));
    sock.once('error', fail);
    sock.once('secureConnect', () => {
      const fp = sock.getPeerCertificate()?.fingerprint256?.toUpperCase();
      if (fp !== fingerprint) return fail(new Error(`certificate fingerprint mismatch (got ${fp}) — refusing to send the token`));
      sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nAuthorization: Bearer ${token}\r\nUpgrade: servify-agent\r\nConnection: Upgrade\r\n\r\n`);
      let buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) {
          if (buf.length > 8192) fail(new Error('bad response'));
          return;
        }
        sock.off('data', onData);
        const status = buf.subarray(0, buf.indexOf('\r\n')).toString();
        if (!/^HTTP\/1\.1 101/.test(status)) return fail(new Error(status.includes('401') ? 'Servify rejected the token' : status));
        sock.setTimeout(0);
        sock.off('error', fail);
        sock.setKeepAlive(true, 15_000);
        const rest = buf.subarray(end + 4);
        if (rest.length) sock.unshift(rest);
        resolve(sock);
      };
      sock.on('data', onData);
    });
  });
}

function connectTarget(target) {
  return new Promise((resolve, reject) => {
    let s;
    if (target === 'docker') s = net.connect({ path: dockerSock, allowHalfOpen: true });
    else if (target && Number.isInteger(target.port) && target.port > 0 && target.port < 65536) s = net.connect({ host: '127.0.0.1', port: target.port, allowHalfOpen: true });
    else return reject(new Error('target not allowed'));
    s.once('connect', () => {
      s.off('error', reject);
      resolve(s);
    });
    s.once('error', reject);
  });
}

/**
 * One side of a stream is gone: the other gets what is still queued for it before it closes (destroying it at once
 * would drop the tail of a long output, e.g. a `docker run … tar cf -` that has just exited). After an error, or if
 * it doesn't drain within 30 s, it is destroyed.
 */
function closeAfter(b, hadError) {
  if (hadError || b.destroyed || b.writableFinished) return b.destroy(); // nothing left to deliver
  const t = setTimeout(() => b.destroy(), 30_000);
  t.unref?.();
  b.once('close', () => clearTimeout(t));
  b.once('finish', () => b.destroy());
  b.end();
}

async function openStream(control, id, target) {
  let local;
  try {
    local = await connectTarget(target);
  } catch (e) {
    control.write(JSON.stringify({ t: 'fail', id, error: e.message }) + '\n');
    return;
  }
  local.pause();
  try {
    const remote = await dial(`/agent/v1/stream/${id}`);
    for (const [a, b] of [
      [local, remote],
      [remote, local],
    ]) {
      a.on('error', () => b.destroy());
      a.on('close', (hadError) => closeAfter(b, hadError));
      a.pipe(b);
    }
    local.resume();
  } catch (e) {
    local.destroy();
    control.write(JSON.stringify({ t: 'fail', id, error: e.message }) + '\n');
  }
}

function dockerVersion() {
  return new Promise((resolve) => {
    const req = http.get({ socketPath: dockerSock, path: '/version', timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body).Version ?? '');
        } catch {
          resolve('');
        }
      });
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => req.destroy());
  });
}

let backoff = 1000;
async function run() {
  for (;;) {
    const dv = await dockerVersion();
    if (!dv) log(`warning: no Docker answering on ${dockerSock}`);
    try {
      const control = await dial('/agent/v1/control');
      backoff = 1000;
      log(`connected to ${host}:${port}`);
      control.write(
        JSON.stringify({
          t: 'hello',
          info: { hostname: os.hostname(), os: `${os.type()} ${os.release()}`, arch: os.arch(), cpus: os.cpus().length, memBytes: os.totalmem(), dockerVersion: dv, agentVersion: VERSION },
        }) + '\n',
      );
      await new Promise((done) => {
        let buf = '';
        control.setEncoding('utf8');
        control.on('data', (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            let msg;
            try {
              msg = JSON.parse(line);
            } catch {
              continue;
            }
            if (msg.t === 'open' && typeof msg.id === 'string') void openStream(control, msg.id, msg.target);
            else if (msg.t === 'ping') control.write('{"t":"pong"}\n');
            else if (msg.t === 'bye') {
              log('this server was removed from Servify; exiting');
              process.exit(0);
            }
          }
        });
        control.on('close', done);
        control.on('error', () => {});
        // Streams may be half-open; the control connection never is. Servify pings every 10s: silence means it's gone.
        control.on('end', () => control.destroy());
        let last = Date.now();
        control.on('data', () => (last = Date.now()));
        const stats = setInterval(() => control.write(JSON.stringify({ t: 'stats', stats: hostStats() }) + '\n'), 15_000);
        setTimeout(() => control.writable && control.write(JSON.stringify({ t: 'stats', stats: hostStats() }) + '\n'), 2000);
        control.on('close', () => clearInterval(stats));
        const watchdog = setInterval(() => {
          if (Date.now() - last > 40_000) control.destroy();
        }, 5000);
        control.on('close', () => clearInterval(watchdog));
      });
      log('disconnected');
    } catch (e) {
      log(`could not connect: ${e.message}`);
      if (/fingerprint|rejected the token/.test(e.message)) backoff = 30_000;
    }
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 30_000);
  }
}

log(`servify agent ${VERSION} — Docker at ${dockerSock}, Servify at ${host}:${port}`);
void run();
