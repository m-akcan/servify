/**
 * Updating Servify itself from a release. Nothing is checked until someone asks: "Check for updates" asks the
 * release feed (GitHub releases of this repository by default), and an update is installed only on request.
 *
 * Installing: download the release package and check it against the release's signed manifest (releasesig.ts: an
 * Ed25519 signature by a key pinned in releasekey.ts — a release that isn't signed by one is refused, whoever
 * published it), unpack it next to the install folder, run the new version's self-test, snapshot the database, then
 * swap the folders (the old one stays as `<install>.prev`) and exit so the service manager starts the new version.
 * bin/update-guard.mjs watches the next starts: the new version confirms itself once it serves the dashboard and
 * reaches Docker, and after three failed starts the old folder and the database snapshot are put back. Only for a supervised install (Start at login / the systemd or launchd service)
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
import { flushAccessLog } from './accesslog.ts';
import { restoresRunning } from './backups.ts';
import { checkAsset, manifestName, MAX_MANIFEST_BYTES, MAX_SIGNATURE_BYTES, packageName, signatureName, signingSelfTest, trustedKeys, verifyReleaseManifest, type ReleaseManifest } from './releasesig.ts';

// The release check is part of `servify selftest` (which imports this file): the pinned keys must load and the
// verifier must accept a good signature and refuse a bad one, or this version can't update itself safely.
signingSelfTest();
export { verifyReleaseManifest, checkAsset, trustedKeys } from './releasesig.ts';

/**
 * Escape hatch for people who build their own releases without signing them: SERVIFY_UPDATE_ALLOW_UNSIGNED=1 installs
 * a release that has no manifest or signature (checked against its .sha256 only, as before 0.3.0). A release whose
 * signature is present but wrong is still refused. Prefer signing your builds and setting SERVIFY_UPDATE_KEYS.
 */
const allowUnsigned = () => process.env.SERVIFY_UPDATE_ALLOW_UNSIGNED === '1';
const warned = new Set<string>();
function warnOnce(msg: string) {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(`\n  ⚠ Updates: ${msg}\n`);
}

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

/**
 * Where to ask for one release by tag (the phone app mirror wants the release of the running version, not the newest):
 * the feed's `/releases/latest` with `/releases/tags/<tag>` instead. Null when the feed is some other URL — then the
 * feed itself is asked, and used only if it is that release.
 */
export function releaseUrlForTag(tag: string): string | null {
  return /\/releases\/latest\/?$/.test(FEED) ? FEED.replace(/\/latest\/?$/, `/tags/${encodeURIComponent(tag)}`) : null;
}
export const releaseFeed = () => FEED;

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

export type Release = {
  version: string;
  tag: string;
  url: string;
  notes: string;
  publishedAt: string | null;
  asset: string;
  checksum: string | null;
  manifest: string | null;
  signature: string | null;
  /** Signed by a trusted key (checked only for a release newer than this one). */
  signed: boolean;
  signedBy: string | null;
  /** No signature, but SERVIFY_UPDATE_ALLOW_UNSIGNED=1 lets it install. */
  unsigned: boolean;
};

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

let lastCheck: { at: number; release: Release | null; blocked?: string | null; error?: string } | null = null;

export async function fetchJson(url: string) {
  const res = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': `servify/${config.version}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json() as Promise<any>;
}

/** Fetch a small file (manifest, signature) with a size limit. */
export async function fetchSmall(url: string, max: number): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'user-agent': `servify/${config.version}` }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok || !res.body) throw new Error(`downloading ${url.split('/').pop()} failed (${res.status})`);
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    n += c.length;
    if (n > max) throw new Error(`${url.split('/').pop()} is larger than ${max} bytes`);
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

type Found = { release: Release; newer: boolean; verified: { manifest: ReleaseManifest; keyId: string } | null; blocked: string | null };

/**
 * The newest release and, when it is newer than this version, whether it may be installed: its manifest must be
 * signed by a trusted key and be for exactly this version and tag, and list the package. `blocked` says why not.
 */
async function findRelease(): Promise<Found> {
  const r = await fetchJson(FEED);
  const tag = String(r.tag_name ?? '');
  const version = tag.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) throw new Error(`the newest release has an unexpected tag (${tag || 'none'})`);
  const assets: { name: string; browser_download_url: string }[] = Array.isArray(r.assets) ? r.assets : [];
  const byName = (n: string) => assets.find((a) => a.name === n);
  const asset = byName(packageName(version));
  if (!asset) throw new Error(`release ${tag} has no servify package to install`);
  const sum = byName(`${asset.name}.sha256`);
  const man = byName(manifestName(version));
  const sig = byName(signatureName(version));
  const release: Release = {
    version,
    tag,
    url: String(r.html_url ?? ''),
    notes: String(r.body ?? '').slice(0, 4000),
    publishedAt: r.published_at ?? null,
    asset: asset.browser_download_url,
    checksum: sum?.browser_download_url ?? null,
    manifest: man?.browser_download_url ?? null,
    signature: sig?.browser_download_url ?? null,
    signed: false,
    signedBy: null,
    unsigned: false,
  };
  if (!newer(version, config.version)) return { release, newer: false, verified: null, blocked: null };
  try {
    if (!man || !sig) {
      if (!allowUnsigned()) throw new Error(`release ${tag} is not signed — Servify only installs releases signed by a trusted release key`);
      if (!sum) throw new Error(`release ${tag} is not signed and has no checksum`);
      warnOnce(`release ${tag} is NOT signed; SERVIFY_UPDATE_ALLOW_UNSIGNED=1 lets it install anyway (checked against its .sha256 only)`);
      release.unsigned = true;
      return { release, newer: true, verified: null, blocked: null };
    }
    const { keys, fromEnv } = trustedKeys();
    if (fromEnv) warnOnce('trusting the release keys in SERVIFY_UPDATE_KEYS instead of the built-in ones');
    const [manifestBytes, sigBytes] = await Promise.all([fetchSmall(man.browser_download_url, MAX_MANIFEST_BYTES), fetchSmall(sig.browser_download_url, MAX_SIGNATURE_BYTES)]);
    const verified = verifyReleaseManifest(manifestBytes, sigBytes, { version, tag, keys });
    if (!Object.hasOwn(verified.manifest.assets, asset.name)) throw new Error(`release ${tag}: the signed manifest doesn’t list ${asset.name}`);
    release.signed = true;
    release.signedBy = verified.keyId;
    return { release, newer: true, verified, blocked: null };
  } catch (e) {
    const blocked = (e as Error).message;
    warnOnce(`not installing ${tag}: ${blocked}`);
    return { release, newer: true, verified: null, blocked };
  }
}

/**
 * Ask the release feed for the newest release (on request only). `available` means newer and installable;
 * `blocked` says why a newer release won't be installed (not signed, signature invalid …).
 */
export async function checkForUpdate(): Promise<{ current: string; latest: Release | null; available: boolean; newer: boolean; blocked: string | null; error?: string }> {
  try {
    const f = await findRelease();
    lastCheck = { at: Date.now(), release: f.release, blocked: f.blocked };
    return { current: config.version, latest: f.release, available: f.newer && !f.blocked, newer: f.newer, blocked: f.blocked };
  } catch (e) {
    lastCheck = { at: Date.now(), release: null, error: (e as Error).message };
    return { current: config.version, latest: null, available: false, newer: false, blocked: null, error: (e as Error).message };
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
    let found: Found;
    try {
      found = await findRelease();
      lastCheck = { at: Date.now(), release: found.release, blocked: found.blocked };
    } catch (e) {
      throw new HttpError(502, `couldn't get the newest release: ${(e as Error).message}`);
    }
    const rel = found.release;
    if (wanted && wanted.replace(/^v/, '') !== rel.version) throw new HttpError(409, `the newest release is ${rel.version}, not ${wanted}`);
    if (!found.newer) throw new HttpError(409, `${config.version} is already the newest release`);
    if (found.blocked) throw new HttpError(409, `${found.blocked} — nothing was changed`);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    // 1. Download and check against the signed manifest (or, for an allowed unsigned release, its .sha256),
    // before anything is unpacked. The download stops as soon as it is larger than the manifest says.
    const name = packageName(rel.version);
    const pkg = join(work, name);
    const limit = found.verified ? found.verified.manifest.assets[name].size : 4 * 1024 ** 3;
    const res = await fetch(rel.asset, { headers: { 'user-agent': `servify/${config.version}` }, signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok || !res.body) throw new HttpError(502, `downloading ${rel.tag} failed (${res.status})`);
    const hash = createHash('sha256');
    let size = 0;
    await pipeline(
      Readable.fromWeb(res.body as any),
      async function* (src: AsyncIterable<Buffer>) {
        for await (const chunk of src) {
          size += chunk.length;
          if (size > limit) throw new HttpError(502, `the downloaded package is larger than the signed manifest says — nothing was changed`);
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(pkg),
    );
    const got = hash.digest('hex');
    if (found.verified) {
      try {
        checkAsset(found.verified.manifest, name, { sha256: got, size });
      } catch (e) {
        rmSync(pkg, { force: true });
        throw new HttpError(502, `${(e as Error).message} — nothing was changed`);
      }
    } else {
      if (!rel.unsigned || !allowUnsigned() || !rel.checksum) throw new HttpError(409, `release ${rel.tag} is not signed — nothing was changed`);
      const sumRes = await fetch(rel.checksum, { headers: { 'user-agent': `servify/${config.version}` }, signal: AbortSignal.timeout(30_000) });
      const want = (await sumRes.text()).trim().split(/\s+/)[0]?.toLowerCase();
      if (!want || want !== got) throw new HttpError(502, `the downloaded package doesn't match its checksum — nothing was changed`);
      console.warn(`\n  ⚠ Updates: installing UNSIGNED release ${rel.tag} because SERVIFY_UPDATE_ALLOW_UNSIGNED=1\n`);
      recordActivity(actor, 'servify.update', `Installing unsigned release ${rel.tag} (SERVIFY_UPDATE_ALLOW_UNSIGNED=1)`, null, null);
    }
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
        flushAccessLog();
      } catch {}
      process.exit(75); // not a clean exit: systemd (Restart=on-failure) and launchd (KeepAlive) start us again
    }, 800).unref();
    return { from: config.version, to: rel.version };
  } catch (e) {
    installing = false;
    throw e;
  }
}

/**
 * A start that failed for a reason the previous version would share (Docker isn't running) is not the new
 * version's fault: it must not count towards the three attempts after which the update is rolled back.
 */
export function uncountUpdateAttempt() {
  const m = readMarker();
  if (m?.state !== 'switched' || m.to !== config.version || !(m.attempts > 0)) return;
  m.attempts--;
  writeMarker(m);
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
