/**
 * Updating Servify itself from a release. Nothing is checked until someone asks: "Check for updates" asks the
 * release feed (GitHub releases of this repository by default), and an update is installed only on request.
 *
 * Installing: download the release package and check its checksum, unpack it next to the install folder, run the
 * new version's self-test, snapshot the database, then swap the folders (the old one stays as `<install>.prev`) and
 * exit so the service manager starts the new version. bin/update-guard.mjs watches the next starts: the new version
 * confirms itself once it serves the dashboard and reaches Docker, and after three failed starts the old folder and
 * the database snapshot are put back. Only for a supervised install (Start at login / the systemd or launchd service)
 * — something has to start Servify again — and not inside a container, where you update the image instead.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.ts';
import { busy } from './engine.ts';
import { HttpError } from './util.ts';
import { recordActivity, SYSTEM, type Actor } from './events.ts';
import { notify } from './notify.ts';
import { flushLogs } from './logstore.ts';
import { restoresRunning } from './backups.ts';

/** Run a command without blocking the router (it keeps serving every site meanwhile). */
function runAsync(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout = (stdout + d).slice(-20_000)));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-20_000)));
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 120_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ code: null, stdout, stderr: stderr + e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}

/** A sibling folder we may delete: missing, or an earlier Servify install (never anything else). */
function servifyFolder(dir: string): boolean {
  if (!existsSync(dir)) return true;
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === 'servify' && existsSync(join(dir, 'server/bin/servify.mjs'));
  } catch {
    return false;
  }
}
function removeSibling(dir: string) {
  if (!servifyFolder(dir)) throw new HttpError(409, `${dir} exists and isn't a Servify folder — move it away first`);
  rmSync(dir, { recursive: true, force: true });
}

export const INSTALL_DIR = resolve(import.meta.dirname, '../..');
const MARKER = join(config.dataDir, 'update.json');
const FEED = process.env.SERVIFY_UPDATE_FEED ?? `https://api.github.com/repos/${process.env.SERVIFY_UPDATE_REPO ?? 'm-akcan/servify'}/releases/latest`;

export type UpdateMarker = {
  from: string;
  to: string;
  installDir: string;
  prevDir: string;
  dbBackup: string;
  startedAt: number;
  attempts: number;
  state: 'switched' | 'confirmed' | 'rolled-back' | 'failed';
  error?: string;
  finishedAt?: number;
  reported?: boolean;
  failedDir?: string;
};

export type Release = { version: string; tag: string; url: string; notes: string; publishedAt: string | null; asset: string; checksum: string };

function readMarker(): UpdateMarker | null {
  try {
    return JSON.parse(readFileSync(MARKER, 'utf8'));
  } catch {
    return null;
  }
}
const writeMarker = (m: UpdateMarker) => writeFileSync(MARKER, JSON.stringify(m, null, 2));

/** 1.10.0 > 1.9.3; pre-release suffixes sort before the release. */
export function newer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, '').split('-', 2);
    return { n: core.split('.').map((x) => Number.parseInt(x, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) > (y.n[i] ?? 0);
  if (x.pre === y.pre) return false;
  return x.pre === null; // 1.0.0 > 1.0.0-rc.1
}

/** Why this install can't update itself, or null. */
export function cannotUpdate(): string | null {
  if (config.inContainer) return 'Servify runs in a container: update it by pulling or rebuilding the image';
  if (process.env.SERVIFY_SUPERVISED !== '1') return 'turn on “Start at login” first: something has to start Servify again after the update';
  if (existsSync(join(INSTALL_DIR, '.git'))) return `${INSTALL_DIR} is a git checkout: update it with git pull and pnpm build`;
  try {
    accessSync(INSTALL_DIR, constants.W_OK);
    accessSync(dirname(INSTALL_DIR), constants.W_OK);
  } catch {
    return `Servify can't write to ${dirname(INSTALL_DIR)}`;
  }
  return null;
}

let lastCheck: { at: number; release: Release | null; error?: string } | null = null;

async function fetchJson(url: string) {
  const res = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': `servify/${config.version}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json() as Promise<any>;
}

/** Ask the release feed for the newest release (on request only). */
export async function checkForUpdate(): Promise<{ current: string; latest: Release | null; available: boolean; error?: string }> {
  try {
    const r = await fetchJson(FEED);
    const tag = String(r.tag_name ?? '');
    const version = tag.replace(/^v/, '');
    const assets: { name: string; browser_download_url: string }[] = r.assets ?? [];
    const asset = assets.find((a) => a.name === `servify-${tag}.tar.gz` || a.name === `servify-v${version}.tar.gz`);
    const sum = asset && assets.find((a) => a.name === `${asset.name}.sha256`);
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) throw new Error(`the newest release has an unexpected tag (${tag || 'none'})`);
    const release: Release | null =
      asset && sum ? { version, tag, url: String(r.html_url ?? ''), notes: String(r.body ?? '').slice(0, 4000), publishedAt: r.published_at ?? null, asset: asset.browser_download_url, checksum: sum.browser_download_url } : null;
    if (!release) throw new Error(`release ${tag} has no servify package to install`);
    lastCheck = { at: Date.now(), release };
    return { current: config.version, latest: release, available: newer(version, config.version) };
  } catch (e) {
    lastCheck = { at: Date.now(), release: null, error: (e as Error).message };
    return { current: config.version, latest: null, available: false, error: (e as Error).message };
  }
}

export function updateStatus() {
  const m = readMarker();
  return {
    version: config.version,
    installDir: INSTALL_DIR,
    cannotUpdate: cannotUpdate(),
    lastCheck,
    lastUpdate: m ? { from: m.from, to: m.to, state: m.state, error: m.error ?? null, startedAt: m.startedAt, finishedAt: m.finishedAt ?? null, previousKeptAt: m.state === 'confirmed' && existsSync(m.prevDir) ? m.prevDir : null } : null,
  };
}

let installing = false;

/** Download, verify, self-test and switch to the given release, then exit so the service manager restarts us. */
export async function installUpdate(actor: Actor, wanted?: string | null): Promise<{ from: string; to: string }> {
  const why = cannotUpdate();
  if (why) throw new HttpError(409, why);
  if (installing) throw new HttpError(409, 'an update is already being installed');
  if (busy.size) throw new HttpError(409, `wait until the ${busy.size} running deploy${busy.size === 1 ? ' finishes' : 's finish'}`);
  if (restoresRunning()) throw new HttpError(409, 'wait until the running restore finishes');
  installing = true;
  const work = join(config.dataDir, 'updates');
  try {
    const check = await checkForUpdate();
    if (!check.latest) throw new HttpError(502, `couldn't get the newest release: ${check.error ?? 'unknown error'}`);
    const rel = check.latest;
    if (wanted && wanted.replace(/^v/, '') !== rel.version) throw new HttpError(409, `the newest release is ${rel.version}, not ${wanted}`);
    if (!newer(rel.version, config.version)) throw new HttpError(409, `${config.version} is already the newest release`);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    // 1. Download and check.
    const pkg = join(work, `servify-v${rel.version}.tar.gz`);
    const res = await fetch(rel.asset, { headers: { 'user-agent': `servify/${config.version}` }, signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok || !res.body) throw new HttpError(502, `downloading ${rel.tag} failed (${res.status})`);
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(pkg));
    const sumRes = await fetch(rel.checksum, { headers: { 'user-agent': `servify/${config.version}` }, signal: AbortSignal.timeout(30_000) });
    const want = (await sumRes.text()).trim().split(/\s+/)[0]?.toLowerCase();
    const got = createHash('sha256').update(readFileSync(pkg)).digest('hex');
    if (!want || want !== got) throw new HttpError(502, `the downloaded package doesn't match its checksum — nothing was changed`);
    // 2. Unpack next to the install and test the new version.
    const staging = `${INSTALL_DIR}.next`;
    removeSibling(staging);
    mkdirSync(staging, { recursive: true });
    const tar = await runAsync('tar', ['-xzf', pkg, '-C', staging, '--strip-components=1']);
    if (tar.code !== 0) throw new HttpError(500, `unpacking failed: ${tar.stderr.trim().slice(0, 300)}`);
    const unpacked = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8')).version;
    if (unpacked !== rel.version) throw new HttpError(500, `the package contains ${unpacked}, not ${rel.version}`);
    if (!existsSync(join(staging, 'web/dist/index.html'))) throw new HttpError(500, 'the package has no dashboard (web/dist)');
    const scratch = mkdtempSync(join(tmpdir(), 'servify-selftest-'));
    const test = await runAsync(process.execPath, ['--disable-warning=ExperimentalWarning', join(staging, 'server/bin/servify.mjs'), 'selftest'], {
      timeoutMs: 90_000,
      env: { ...process.env, SERVIFY_DATA_DIR: scratch, SERVIFY_MASTER_KEY: '', SERVIFY_SUPERVISED: '' },
    });
    rmSync(scratch, { recursive: true, force: true });
    if (test.code !== 0 || !test.stdout.includes(`selftest ok ${rel.version}`)) {
      rmSync(staging, { recursive: true, force: true });
      throw new HttpError(500, `the new version failed its self-test — nothing was changed: ${(test.stderr || test.stdout || '').trim().slice(-400)}`);
    }
    // 3. Snapshot the database, so a rollback also undoes what the new version's start changed in it.
    // In a child process: on a big database this takes a while, and the router keeps serving meanwhile.
    const snapshot = join(work, `servify-${config.version}.db`);
    const snap = await runAsync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '-e', "const { DatabaseSync } = require('node:sqlite'); const [db, to] = process.argv.slice(1); new DatabaseSync(db).exec(`VACUUM INTO '${to.replaceAll(\"'\", \"''\")}'`)", config.dbPath, snapshot],
      { timeoutMs: 10 * 60_000 },
    );
    if (snap.code !== 0 || !existsSync(snapshot)) throw new HttpError(500, `saving a copy of the database failed — nothing was changed: ${snap.stderr.trim().slice(-300)}`);
    // 4. Switch folders and hand over to the service manager.
    const prev = `${INSTALL_DIR}.prev`;
    removeSibling(prev);
    removeSibling(`${INSTALL_DIR}.failed`);
    const marker: UpdateMarker = { from: config.version, to: rel.version, installDir: INSTALL_DIR, prevDir: prev, dbBackup: snapshot, startedAt: Date.now(), attempts: 0, state: 'switched' };
    writeMarker(marker);
    renameSync(INSTALL_DIR, prev);
    try {
      renameSync(staging, INSTALL_DIR);
    } catch (e) {
      renameSync(prev, INSTALL_DIR);
      rmSync(MARKER, { force: true });
      throw new HttpError(500, `switching folders failed — kept ${config.version}: ${(e as Error).message}`);
    }
    recordActivity(actor, 'servify.update', `Updating Servify from ${config.version} to ${rel.version}: restarting`, null, null);
    setTimeout(() => {
      try {
        flushLogs();
      } catch {}
      process.exit(75); // not a clean exit: systemd (Restart=on-failure) and launchd (KeepAlive) start us again
    }, 800).unref();
    return { from: config.version, to: rel.version };
  } catch (e) {
    installing = false;
    throw e;
  }
}

/** On start: confirm a fresh update once healthy, and report how the last one ended. */
export function settleUpdate(healthy: { docker: boolean }) {
  const m = readMarker();
  if (!m) return;
  if (m.state === 'switched' && m.to === config.version) {
    if (!healthy.docker) return; // let the guard's deadline decide
    m.state = 'confirmed';
    m.finishedAt = Date.now();
    m.reported = true;
    writeMarker(m);
    recordActivity(SYSTEM, 'servify.update', `Servify updated from ${m.from} to ${m.to}`, null, null);
    notify({ event: 'servify.update', level: 'success', title: `Servify updated to ${m.to}`, message: `Updated from ${m.from}. The previous version is kept at ${m.prevDir}.` } as any);
    return;
  }
  if ((m.state === 'rolled-back' || m.state === 'failed') && !m.reported) {
    m.reported = true;
    writeMarker(m);
    recordActivity(SYSTEM, 'servify.update', `Update to ${m.to} failed: ${m.error ?? 'unknown error'}`, null, null);
    notify({ event: 'servify.update', level: 'error', title: `Servify update to ${m.to} failed`, message: m.error ?? 'unknown error' } as any);
  }
}
