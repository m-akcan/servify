/**
 * The Android app, mirrored from the signed release and served to this Servify's own phones (GET /api/mobile/app and
 * /api/mobile/app.apk), so phones update from their own server over the LAN or VPN, never from a download site.
 *
 * Which app: the one in the release of the version that is running (tag `v<config.version>`, not the newest
 * release), so a phone always gets the app built for the server it talks to. That release's manifest must carry a
 * valid signature by a trusted release key (releasesig.ts — the same check as the updater, without the
 * SERVIFY_UPDATE_ALLOW_UNSIGNED escape hatch). If its `android` entry has a higher versionCode than the cached app,
 * the APK is downloaded (stopping at the size the manifest gives), checked against the manifest's SHA-256 and size,
 * and moved into place atomically in `<data>/mobile/`, next to the manifest and signature that vouch for it. The
 * current and the previous app are kept, nothing older.
 *
 * Fail closed: when the running version's release is unsigned or its signature or manifest is invalid, no app is
 * served at all (not even the cached one) until a check verifies again, and the reason is shown. That decision is
 * stored, so a restart doesn't serve the cached file in between. A cached app is re-verified when Servify starts:
 * its manifest and signature against the trusted keys, and the file against the manifest. A manifest without an
 * android entry (a release without an app change), a release that doesn't exist (a development build) or a feed that
 * can't be reached leave the cached app in place.
 *
 * When: a few minutes after start (and so after every update, which restarts Servify), then daily, and on request
 * (POST /api/mobile/app/check, owner only). Nothing runs on import: main.ts calls startMobileMirror(). Not while the
 * data disk is in protect mode (diskguard.ts). SERVIFY_MOBILE_MIRROR=0 turns the mirror off: no requests to the feed
 * and no app served. SERVIFY_MOBILE_MIRROR_DELAY_MS changes the delay after start (default two minutes).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.ts';
import { persistPaused } from './diskguard.ts';
import { recordActivity, SYSTEM } from './events.ts';
import { ANDROID_SIGNER_SHA256 } from './releasekey.ts';
import { checkAsset, manifestName, MAX_MANIFEST_BYTES, MAX_SIGNATURE_BYTES, signatureName, trustedKeys, verifyReleaseManifest, type ReleaseManifest } from './releasesig.ts';
import { fetchSmall, releaseFeed, releaseUrlForTag } from './updater.ts';

const DIR = join(config.dataDir, 'mobile');
const STATE = join(DIR, 'state.json');
const DAY = 24 * 3600_000;
/** An APK larger than this is refused whatever the manifest says. */
const MAX_APK_BYTES = 256 * 1024 ** 2;

type Entry = {
  versionName: string;
  versionCode: number;
  sha256: string;
  size: number;
  signerSha256: string;
  /** The release it came from (its manifest and signature are kept next to it). */
  version: string;
  tag: string;
  mirroredAt: number;
};
type State = { current: Entry | null; previous: Entry | null; blocked: string | null; blockedAt?: number };

export type MobileAppInfo = {
  available: boolean;
  versionName: string | null;
  versionCode: number | null;
  sha256: string | null;
  size: number | null;
  signerSha256: string | null;
  /** Why no app is served (only when available is false). */
  reason?: string;
  /** What the last check found, in a sentence (also when available). */
  status: string;
  /** The release the served app came from. */
  release: string | null;
  mirroredAt: number | null;
  checkedAt: number | null;
  checking: boolean;
  mirror: boolean;
};

const mirrorOn = () => process.env.SERVIFY_MOBILE_MIRROR !== '0';
const apkPath = (e: Pick<Entry, 'versionCode'>) => join(DIR, `app-${e.versionCode}.apk`);
const manifestPath = (version: string) => join(DIR, manifestName(version));
const sigPath = (version: string) => join(DIR, signatureName(version));
const fmtMb = (n: number) => `${(n / 1024 ** 2).toFixed(1)} MB`;

let state: State | null = null;
/** The cached app passed its check at load (or was just mirrored). */
let verifiedCurrent = false;
let loadProblem: string | null = null;
let note = 'not checked yet';
let checkedAt: number | null = null;
let running: Promise<void> | null = null;

function writeAtomic(path: string, data: string | Buffer) {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}
function save() {
  if (!state) return;
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeAtomic(STATE, JSON.stringify(state, null, 2));
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The cached app is what its stored, signed manifest says, and that manifest still verifies. Throws the reason. */
function verifyCached(e: Entry) {
  const m = readFileSync(manifestPath(e.version));
  const s = readFileSync(sigPath(e.version));
  const { manifest } = verifyReleaseManifest(m, s, { version: e.version, tag: e.tag, keys: trustedKeys().keys });
  const a = manifest.android;
  if (!a || a.versionCode !== e.versionCode || a.sha256 !== e.sha256 || a.size !== e.size) throw new Error(`the stored manifest of ${e.tag} doesn't describe the cached app`);
  const st = statSync(apkPath(e));
  if (st.size !== e.size) throw new Error(`the cached app is ${st.size} bytes, its manifest says ${e.size}`);
  if (sha256File(apkPath(e)) !== e.sha256) throw new Error('the cached app doesn’t match the SHA-256 in its signed manifest');
}

function load(): State {
  if (state) return state;
  let s: State = { current: null, previous: null, blocked: null };
  try {
    s = { ...s, ...JSON.parse(readFileSync(STATE, 'utf8')) };
  } catch {}
  state = s;
  if (s.current) {
    try {
      verifyCached(s.current);
      verifiedCurrent = true;
    } catch (err) {
      verifiedCurrent = false;
      loadProblem = `the cached app (${s.current.versionName}) failed its check: ${(err as Error).message}`;
      console.warn(`[mobile] ${loadProblem} — not serving it`);
    }
  }
  if (s.current) note = s.blocked ?? loadProblem ?? `serving ${s.current.versionName} (versionCode ${s.current.versionCode}) mirrored from ${s.current.tag}`;
  return s;
}

/** Remove everything in <data>/mobile that the current and previous app don't need. */
function prune() {
  const keep = new Set(['state.json']);
  for (const e of [state?.current, state?.previous]) {
    if (!e) continue;
    keep.add(`app-${e.versionCode}.apk`);
    keep.add(manifestName(e.version));
    keep.add(signatureName(e.version));
  }
  for (const f of readdirSync(DIR)) if (!keep.has(f)) rmSync(join(DIR, f), { force: true, recursive: true });
}

function block(reason: string) {
  const s = load();
  s.blocked = reason;
  s.blockedAt = Date.now();
  note = reason;
  save();
  console.warn(`[mobile] ${reason}`);
}

type GhAsset = { name: string; browser_download_url: string };

/** The release with this tag, or null when there is none. Throws when the feed can't be asked. */
async function fetchRelease(tag: string): Promise<{ tag_name: string; assets: GhAsset[] } | null> {
  const byTag = releaseUrlForTag(tag);
  const url = byTag ?? releaseFeed();
  const res = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': `servify/${config.version}` }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`the release feed answered ${res.status}`);
  const r: any = await res.json();
  if (String(r?.tag_name ?? '') !== tag) return null;
  return { tag_name: tag, assets: Array.isArray(r.assets) ? r.assets : [] };
}

async function refresh(): Promise<void> {
  const s = load();
  const version = config.version;
  const tag = `v${version}`;
  const keepNote = (why: string) => {
    note = s.current && verifiedCurrent && !s.blocked ? `${why}; still serving ${s.current.versionName} mirrored from ${s.current.tag}` : why;
  };
  checkedAt = Date.now();

  let rel: Awaited<ReturnType<typeof fetchRelease>>;
  try {
    rel = await fetchRelease(tag);
  } catch (err) {
    return keepNote(`couldn't ask the release feed: ${(err as Error).message}`);
  }
  if (!rel) return keepNote(`there is no release ${tag} (a development build?)`);
  const byName = (n: string) => rel.assets.find((a) => a.name === n);
  const man = byName(manifestName(version));
  const sig = byName(signatureName(version));
  if (!man || !sig) return block(`release ${tag} is not signed, so no phone app is served`);

  let manifestBytes: Buffer;
  let sigBytes: Buffer;
  try {
    [manifestBytes, sigBytes] = await Promise.all([fetchSmall(man.browser_download_url, MAX_MANIFEST_BYTES), fetchSmall(sig.browser_download_url, MAX_SIGNATURE_BYTES)]);
  } catch (err) {
    return keepNote(`couldn't download the manifest of ${tag}: ${(err as Error).message}`);
  }
  let manifest: ReleaseManifest;
  const { keys, fromEnv } = trustedKeys();
  try {
    manifest = verifyReleaseManifest(manifestBytes, sigBytes, { version, tag, keys }).manifest;
  } catch (err) {
    return block(`${(err as Error).message} — no phone app is served`);
  }
  // The running version's manifest verifies: whatever was blocked before is lifted.
  if (s.blocked) {
    s.blocked = null;
    delete s.blockedAt;
    save();
  }
  const a = manifest.android;
  if (!a) return keepNote(`release ${tag} has no Android app`);
  if (!fromEnv && a.signerSha256 !== ANDROID_SIGNER_SHA256) return keepNote(`the manifest of ${tag} names an app signed by an unexpected certificate (${a.signerSha256.slice(0, 12)}…): not mirrored`);
  if (s.current && verifiedCurrent && a.versionCode <= s.current.versionCode) {
    note = `up to date: serving ${s.current.versionName} (versionCode ${s.current.versionCode}) mirrored from ${s.current.tag}`;
    return;
  }
  if (a.size > MAX_APK_BYTES) return keepNote(`the app in ${tag} is ${fmtMb(a.size)}, more than the ${fmtMb(MAX_APK_BYTES)} allowed`);
  if (persistPaused()) return keepNote(`low disk space: not downloading the phone app ${a.versionName} until the data disk has room again`);
  const asset = byName(a.file);
  if (!asset) return keepNote(`release ${tag} lists ${a.file} in its manifest but has no such file`);

  // Download into a temporary file, stopping as soon as it's larger than the manifest says.
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tmp = join(DIR, `.download-${randomBytes(6).toString('hex')}.tmp`);
  const hash = createHash('sha256');
  let size = 0;
  try {
    const res = await fetch(asset.browser_download_url, { headers: { 'user-agent': `servify/${config.version}` }, signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`downloading ${a.file} failed (${res.status})`);
    await pipeline(
      Readable.fromWeb(res.body as any),
      async function* (src: AsyncIterable<Buffer>) {
        for await (const chunk of src) {
          size += chunk.length;
          if (size > a.size) throw new Error(`${a.file} is larger than the signed manifest says`);
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(tmp, { mode: 0o600 }),
    );
    checkAsset(manifest, a.file, { sha256: hash.digest('hex'), size });
  } catch (err) {
    rmSync(tmp, { force: true });
    const why = `the downloaded ${a.file} was not used: ${(err as Error).message}`;
    console.warn(`[mobile] ${why}`);
    return keepNote(why);
  }

  // Into place: the manifest and signature first, then the app, then the state that points at them.
  const entry: Entry = { versionName: a.versionName, versionCode: a.versionCode, sha256: a.sha256, size: a.size, signerSha256: a.signerSha256, version, tag, mirroredAt: Date.now() };
  writeAtomic(manifestPath(version), manifestBytes);
  writeAtomic(sigPath(version), sigBytes);
  renameSync(tmp, apkPath(entry));
  if (s.current && verifiedCurrent && s.current.versionCode !== entry.versionCode) s.previous = s.current;
  s.current = entry;
  verifiedCurrent = true;
  loadProblem = null;
  save();
  try {
    prune();
  } catch (err) {
    console.warn(`[mobile] cleaning up ${DIR}: ${(err as Error).message}`);
  }
  note = `mirrored ${entry.versionName} (versionCode ${entry.versionCode}) from ${tag}`;
  console.log(`[mobile] ${note}`);
  recordActivity(SYSTEM, 'mobile.mirror', `Phone app ${entry.versionName} is ready for your phones (from release ${tag})`);
}

/** Check the running version's release now (a check already running is joined). */
export function refreshMobileApp(): Promise<void> {
  if (!mirrorOn()) return Promise.resolve();
  if (!running) {
    running = refresh()
      .catch((err) => {
        note = `checking failed: ${(err as Error).message}`;
        console.warn(`[mobile] ${note}`);
      })
      .finally(() => (running = null));
  }
  return running;
}

/** The app phones are offered, and the mirror's state. */
export function mobileAppInfo(): MobileAppInfo {
  const on = mirrorOn();
  const s = on ? load() : null;
  const e = s?.current ?? null;
  const available = !!(on && s && e && verifiedCurrent && !s.blocked);
  const reason = available
    ? undefined
    : !on
      ? 'The phone app mirror is turned off on this Servify (SERVIFY_MOBILE_MIRROR=0).'
      : s?.blocked
        ? s.blocked
        : (loadProblem ?? (checkedAt ? note : 'no phone app has been mirrored yet'));
  return {
    available,
    versionName: available ? e!.versionName : null,
    versionCode: available ? e!.versionCode : null,
    sha256: available ? e!.sha256 : null,
    size: available ? e!.size : null,
    signerSha256: available ? e!.signerSha256 : null,
    ...(reason ? { reason } : {}),
    status: on ? note : 'off',
    release: available ? e!.tag : null,
    mirroredAt: available ? e!.mirroredAt : null,
    checkedAt,
    checking: !!running,
    mirror: on,
  };
}

/** The file to serve, or null (with mobileAppInfo().reason saying why). */
export function mobileAppFile(): { path: string; size: number; sha256: string; versionName: string } | null {
  const info = mobileAppInfo();
  if (!info.available) return null;
  const e = state!.current!;
  const path = apkPath(e);
  if (!existsSync(path)) return null;
  return { path, size: e.size, sha256: e.sha256, versionName: e.versionName };
}

/** A byte range of the app for a `Range` header: [start, end] inclusive, 'invalid' (416), or null for all of it. */
export function parseRange(header: string | undefined, size: number): [number, number] | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return 'invalid';
  let start: number;
  let end: number;
  if (!m[1]) {
    const n = Number(m[2]);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return 'invalid';
  return [start, end];
}

export const openMobileApp = (path: string, range?: [number, number]) => createReadStream(path, range ? { start: range[0], end: range[1] } : {});

export function startMobileMirror() {
  if (!mirrorOn()) {
    console.log('[mobile] phone app mirror is off (SERVIFY_MOBILE_MIRROR=0)');
    return;
  }
  try {
    load();
  } catch (err) {
    console.warn(`[mobile] ${(err as Error).message}`);
  }
  const delay = Number(process.env.SERVIFY_MOBILE_MIRROR_DELAY_MS ?? 120_000);
  setTimeout(() => void refreshMobileApp(), Number.isFinite(delay) && delay >= 0 ? delay : 120_000).unref();
  setInterval(() => void refreshMobileApp(), DAY).unref();
}
