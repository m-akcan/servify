#!/usr/bin/env node
/**
 * Sign and publish a release that CI built as a draft. Runs on the maintainer's machine — the only place the
 * release key is — after `git push origin vX.Y.Z` and the Release workflow finished:
 *
 *   node scripts/publish-release.mjs vX.Y.Z (--apk <file> | --no-apk) [--wait] [--dry-run] [--key <file>] [--repo owner/name] [--out <dir>]
 *
 *   1. checks that the local tag and GitHub's point at the same commit, and that the draft release exists with the
 *      package and its .sha256 (--wait: polls until CI created it);
 *   2. downloads CI's package;
 *   3. rebuilds the package here from a clean clone of the tag (pnpm 11.0.9, frozen lockfile, scripts/release.mjs)
 *      and compares the two by content (paths, types, link targets, exec bits, SHA-256 of every file) — any
 *      difference aborts: CI's package isn't what the tag builds;
 *   4. writes servify-vX.Y.Z.manifest.json (the hash and size of CI's package — the bytes people download), signs it
 *      with the release key (Ed25519, detached .sig) and checks the result with the updater's own verifier;
 *   5. uploads the manifest and signature (and the app) to the draft and publishes it (marked as the latest release).
 *
 * The Android app: every release says whether it ships one. --apk <file> takes the release-signed APK built here
 * (cd mobile && npm run apk): its versionName and versionCode are read with aapt2 and its signing certificate with
 * apksigner (build-tools 36 under $ANDROID_HOME; apksigner needs a JDK, $JAVA_HOME or Homebrew's openjdk@21). It is
 * refused unless it is cloud.servify.app, signed by exactly one certificate, the one pinned in
 * server/src/releasekey.ts (ANDROID_SIGNER_SHA256), and its versionCode is higher than the app in the previous
 * release's manifest (when that has one). It goes into the manifest (`assets` and `android`) and is uploaded as
 * servify-android-<versionName>.apk; every Servify on this version mirrors it for its phones. --no-apk: a release
 * without an app change (Servify keeps serving the app it mirrored before).
 *
 * --dry-run does all of it except uploading and publishing (it also works on an already published release), and
 * leaves the files in --out (default: a temporary folder it prints). For testing the steps without GitHub, with
 * --dry-run only: --source <git repo> clones the tag from there instead of this checkout, and --ci-tarball <file>
 * stands in for CI's package (no gh calls), and --prev-manifest <file> stands in for the previous release's manifest
 * (without it, test mode skips the versionCode comparison).
 *
 * The key (default ~/.servify-release/release-key.pem) is refused when anyone but its owner can read it. It is
 * never printed. Nothing else needs a secret: CI never sees the key.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, createPublicKey, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { copyFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DEFAULT_KEY_DIR, KEY_FILE, loadPrivateKey, publicKeyBase64, keyId } from './release-key.mjs';
import { compareTarGz } from './release-compare.mjs';

const PNPM = 'pnpm@11.0.9';
const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const tag = args.find((a) => /^v\d+\.\d+\.\d+(-[\w.]+)?$/.test(a));
const dryRun = flag('--dry-run');
const repo = opt('--repo') ?? 'm-akcan/servify';
const keyFile = resolve(opt('--key') ?? join(DEFAULT_KEY_DIR, KEY_FILE));
const source = opt('--source');
const ciTarball = opt('--ci-tarball');
const apkArg = opt('--apk');
const noApk = flag('--no-apk');
const prevManifestArg = opt('--prev-manifest');

const step = (s) => console.log(`\n▸ ${s}`);
const fail = (s) => {
  console.error(`\n✗ ${s}\n`);
  process.exit(1);
};
const sh = (cmd, a, o = {}) => execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...o }).trim();
const gh = (a) => sh('gh', a);

if (!tag) fail('usage: node scripts/publish-release.mjs vX.Y.Z (--apk <file> | --no-apk) [--wait] [--dry-run] [--key <file>] [--repo owner/name] [--out <dir>]');
if ((source || ciTarball || prevManifestArg) && !dryRun) fail('--source, --ci-tarball and --prev-manifest are for testing and need --dry-run');
if ((apkArg !== undefined && (!apkArg || apkArg.startsWith('--'))) || (!!apkArg === noApk)) fail('say whether this release ships the Android app: --apk <file> (the release-signed APK) or --no-apk');
const testMode = !!(source || ciTarball);
const version = tag.slice(1);
const pkgName = `servify-v${version}.tar.gz`;
const manifestName = `servify-v${version}.manifest.json`;

// The key first: no point building anything if it can't be used. Refused when its permissions are too open.
step(`Release key ${keyFile}`);
let privateKey;
try {
  privateKey = loadPrivateKey(keyFile);
} catch (e) {
  fail(e.message);
}
const pub = publicKeyBase64(createPublicKey(privateKey));
console.log(`  public key ${pub} (id ${keyId(pub)})`);

const work = resolve(opt('--out') ?? mkdtempSync(join(tmpdir(), `servify-publish-${version}-`)));
mkdirSync(work, { recursive: true });
console.log(`  working in ${work}`);

// 1. The tag: here, on GitHub, and the draft release.
const src = source ? resolve(source) : root;
step(`Tag ${tag}`);
let commit;
try {
  commit = sh('git', ['-C', src, 'rev-parse', `${tag}^{commit}`]);
} catch {
  fail(`there's no tag ${tag} in ${src} (git fetch --tags?)`);
}
console.log(`  ${tag} is ${commit} here`);
if (!source) {
  const remote = sh('git', ['ls-remote', `https://github.com/${repo}.git`, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  const lines = Object.fromEntries(remote.split('\n').filter(Boolean).map((l) => l.split('\t').reverse()));
  const remoteCommit = lines[`refs/tags/${tag}^{}`] ?? lines[`refs/tags/${tag}`];
  if (!remoteCommit) fail(`${tag} isn't on GitHub yet — push it: git push origin ${tag}`);
  if (remoteCommit !== commit) fail(`${tag} is ${remoteCommit} on GitHub but ${commit} here — someone moved the tag`);
  console.log('  GitHub has the same commit');
}

// The Android app, before anything is built: refused unless it's ours, signed with the pinned release certificate
// and newer than the app in the previous release.
let apk = null;
if (apkArg) {
  step(`Android app ${apkArg}`);
  apk = readApk(resolve(apkArg));
  console.log(`  ${apk.packageName} ${apk.versionName} (versionCode ${apk.versionCode}), ${apk.size} bytes, sha256 ${apk.sha256}`);
  const { ANDROID_SIGNER_SHA256 } = await import(pathToFileURL(join(root, 'server/src/releasekey.ts')).href);
  if (apk.packageName !== 'cloud.servify.app') fail(`the APK is ${apk.packageName}, not cloud.servify.app`);
  if (apk.signers.length !== 1) fail(`the APK has ${apk.signers.length} signers; it must be signed by exactly one (the release key)`);
  if (apk.signers[0] !== ANDROID_SIGNER_SHA256) fail(`the APK is signed by ${apk.signers[0]}, not by the release signer ${ANDROID_SIGNER_SHA256} (server/src/releasekey.ts) — phones would refuse it as an update`);
  console.log(`  signed by the release certificate ${apk.signers[0].slice(0, 16)}…`);
  const prevTag = sh('git', ['-C', src, 'tag', '--list', 'v*', '--sort=-v:refname', '--merged', commit]).split('\n').filter((t) => t && t !== tag)[0];
  const prevManifest = previousManifest(prevTag);
  if (prevManifest?.android) {
    // The unchanged app again (a server-only release) is fine: each Servify mirrors the app from its own release.
    const sameApp = apk.versionCode === prevManifest.android.versionCode && apk.sha256 === prevManifest.android.sha256;
    if (sameApp) console.log(`  the same app as ${prevManifest.tag ?? 'the previous release'} (unchanged)`);
    else if (!(apk.versionCode > prevManifest.android.versionCode)) fail(`the APK's versionCode ${apk.versionCode} isn't higher than ${prevManifest.android.versionCode} in ${prevManifest.tag ?? 'the previous release'}'s manifest — raise mobile/package.json's version and rebuild`);
    console.log(`  newer than the app in ${prevManifest.tag ?? 'the previous release'} (versionCode ${prevManifest.android.versionCode})`);
  } else if (prevManifest) console.log(`  ${prevManifest.tag ?? 'the previous release'} has no app in its manifest: nothing to compare`);
} else {
  step('Android app: none in this release (--no-apk)');
}

/** versionName/versionCode (aapt2) and signing certificates (apksigner) of an APK. */
function readApk(file) {
  if (!existsSync(file)) fail(`there's no APK at ${file}`);
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), 'Library/Android/sdk');
  const btRoot = join(sdk, 'build-tools');
  const candidates = existsSync(btRoot)
    ? readdirSync(btRoot)
        .filter((d) => d.startsWith('36'))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .map((d) => join(btRoot, d))
        .filter((d) => existsSync(join(d, 'aapt2')) && existsSync(join(d, 'apksigner')))
    : [];
  if (!candidates.length) fail(`no build-tools 36 with aapt2 and apksigner under ${btRoot} (set ANDROID_HOME)`);
  const bt = candidates[0];
  const badging = spawnSync(join(bt, 'aapt2'), ['dump', 'badging', file], { encoding: 'utf8' });
  if (badging.status !== 0) fail(`aapt2 can't read ${file}: ${(badging.stderr || '').trim().slice(0, 300)}`);
  const pkg = /^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m.exec(badging.stdout);
  if (!pkg) fail(`aapt2 shows no package name, versionCode and versionName for ${file}`);
  const versionName = pkg[3];
  if (!/^\d+\.\d+\.\d+$/.test(versionName)) fail(`the APK's versionName ${versionName} isn't X.Y.Z`);
  const javaHome = process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home';
  const certs = spawnSync(join(bt, 'apksigner'), ['verify', '--print-certs', file], { encoding: 'utf8', env: { ...process.env, JAVA_HOME: javaHome, PATH: `${join(javaHome, 'bin')}:${process.env.PATH}` } });
  if (certs.status !== 0) fail(`apksigner doesn't verify ${file}: ${(certs.stderr || certs.stdout || '').trim().slice(0, 300)}`);
  const signers = [...certs.stdout.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([0-9a-f]{64})$/gm)].map((m) => m[1]);
  const bytes = readFileSync(file);
  return { file, packageName: pkg[1], versionCode: Number(pkg[2]), versionName, signers, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** The previous release's manifest (parsed), or null when there is none or it has none. */
function previousManifest(prevTag) {
  if (prevManifestArg) {
    const m = JSON.parse(readFileSync(resolve(prevManifestArg), 'utf8'));
    console.log(`  previous manifest: ${prevManifestArg} (test mode)`);
    return m;
  }
  if (testMode) {
    console.log('  test mode without --prev-manifest: not comparing with the previous release');
    return null;
  }
  if (!prevTag) {
    console.log('  no previous release');
    return null;
  }
  const prevVersion = prevTag.slice(1);
  const dir = join(work, 'prev');
  mkdirSync(dir, { recursive: true });
  const name = `servify-v${prevVersion}.manifest.json`;
  const r = spawnSync('gh', ['release', 'download', prevTag, '--repo', repo, '--pattern', name, '--pattern', `${name}.sig`, '--dir', dir, '--clobber'], { encoding: 'utf8' });
  if (r.status !== 0 || !existsSync(join(dir, name))) {
    console.log(`  ${prevTag} has no manifest (it predates signed releases)`);
    return null;
  }
  return { tag: prevTag, ...JSON.parse(readFileSync(join(dir, name), 'utf8')) };
}

const ciDir = join(work, 'ci');
mkdirSync(ciDir, { recursive: true });
let ciPkg = join(ciDir, pkgName);
if (ciTarball) {
  step(`CI's package: using ${ciTarball} (test mode, no GitHub)`);
  ciPkg = resolve(ciTarball);
} else {
  step(`Draft release ${tag} on ${repo}`);
  const view = () => {
    const r = spawnSync('gh', ['release', 'view', tag, '--repo', repo, '--json', 'tagName,isDraft,assets,url'], { encoding: 'utf8' });
    return r.status === 0 ? JSON.parse(r.stdout) : null;
  };
  const ready = (r) => r && [pkgName, `${pkgName}.sha256`].every((n) => r.assets.some((a) => a.name === n));
  let rel = view();
  if (!ready(rel) && flag('--wait')) {
    const until = Date.now() + 60 * 60_000;
    while (!ready(rel) && Date.now() < until) {
      console.log('  not there yet (CI still running?) — checking again in 20s');
      await new Promise((r) => setTimeout(r, 20_000));
      rel = view();
    }
  }
  if (!rel) fail(`there's no release ${tag} on ${repo} — has the Release workflow finished? (--wait polls for it)`);
  if (!ready(rel)) fail(`release ${tag} has no ${pkgName} and .sha256 yet — has the Release workflow finished?`);
  if (!rel.isDraft && !dryRun) fail(`release ${tag} is already published — nothing to do (re-check it with --dry-run)`);
  console.log(`  ${rel.isDraft ? 'draft' : 'published'}: ${rel.url}`);
  step(`Downloading CI's package`);
  gh(['release', 'download', tag, '--repo', repo, '--pattern', pkgName, '--pattern', `${pkgName}.sha256`, '--dir', ciDir, '--clobber']);
  const want = readFileSync(`${ciPkg}.sha256`, 'utf8').trim().split(/\s+/)[0];
  const got = createHash('sha256').update(readFileSync(ciPkg)).digest('hex');
  if (want !== got) fail(`CI's ${pkgName} doesn't match its own .sha256`);
}
const ciBytes = readFileSync(ciPkg);
const ciSum = createHash('sha256').update(ciBytes).digest('hex');
console.log(`  ${pkgName}: ${ciBytes.length} bytes, sha256 ${ciSum}`);

// 2. Rebuild from a clean clone of the tag, with the pinned pnpm.
step(`Rebuilding ${tag} here from a clean clone`);
const clone = join(work, 'src');
if (existsSync(clone)) fail(`${clone} already exists — use an empty --out folder`);
sh('git', ['clone', '--quiet', '--no-local', '--no-hardlinks', src, clone]);
sh('git', ['-C', clone, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', commit]);
const cloned = JSON.parse(readFileSync(join(clone, 'package.json'), 'utf8')).version;
if (cloned !== version) fail(`${tag} has version ${cloned} in package.json`);
const bin = join(work, 'bin');
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\nexec npx -y ${PNPM} "$@"\n`);
chmodSync(join(bin, 'pnpm'), 0o755);
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CI: 'true' };
delete env.SOURCE_DATE_EPOCH; // the commit's time, as in CI
const build = (a) => {
  const r = spawnSync(a[0], a.slice(1), { cwd: clone, env, stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) fail(`${a.join(' ')} failed in ${clone}`);
};
build(['pnpm', 'install', '--frozen-lockfile']);
build(['pnpm', 'build']);
const localDir = join(work, 'local');
build([process.execPath, 'scripts/release.mjs', '--out', localDir]);
const localPkg = join(localDir, pkgName);

// 3. Compare.
step(`Comparing CI's package with the local build`);
const { diffs, entries } = compareTarGz(ciPkg, localPkg);
if (diffs.length) {
  console.error(`\n  ${diffs.length} difference${diffs.length === 1 ? '' : 's'} between CI's package and the local build:\n    ${diffs.slice(0, 60).join('\n    ')}${diffs.length > 60 ? `\n    … and ${diffs.length - 60} more` : ''}`);
  fail(`MISMATCH — CI's ${pkgName} is not what ${tag} builds. Not signing. (Both are in ${work}.)`);
}
const identical = Buffer.compare(ciBytes, readFileSync(localPkg)) === 0;
console.log(`  same content (${entries} entries)${identical ? ', byte-identical' : ' (the gzip bytes differ — zlib differs between the machines; the contents are what count)'}`);

// 4. Is the key one the installs will trust?
step('Checking the key is pinned');
const pinnedIn = (text) => !!text && text.includes(`'${pub}'`);
const problems = [];
if (!pinnedIn(readFileSync(join(clone, 'server/src/releasekey.ts'), 'utf8'))) problems.push(`${tag}'s server/src/releasekey.ts doesn't pin this key`);
const prev = sh('git', ['-C', clone, 'tag', '--list', 'v*', '--sort=-v:refname', '--merged', commit])
  .split('\n')
  .filter((t) => t && t !== tag)[0];
if (prev) {
  const r = spawnSync('git', ['-C', clone, 'show', `${prev}:server/src/releasekey.ts`], { encoding: 'utf8' });
  if (r.status === 0 && !pinnedIn(r.stdout)) problems.push(`installs running ${prev} don't trust this key (its releasekey.ts doesn't pin it) — they would refuse ${tag}`);
  else console.log(r.status === 0 ? `  ${prev} trusts it` : `  ${prev} predates signed releases (it doesn't check signatures)`);
}
for (const p of problems) (dryRun ? console.warn : console.error)(`  ${dryRun ? '⚠' : '✗'} ${p}`);
if (problems.length && !dryRun) fail('the key is not pinned where it has to be — not signing');
if (!problems.length) console.log(`  ${tag} pins it`);

// 5. The manifest, signed.
step(`Writing and signing ${manifestName}`);
const manifest = {
  format: 1,
  product: 'servify',
  version,
  tag,
  commit,
  createdAt: new Date().toISOString(),
  assets: { [pkgName]: { sha256: ciSum, size: ciBytes.length } },
};
let apkUpload = null;
if (apk) {
  const apkName = `servify-android-${apk.versionName}.apk`;
  manifest.assets[apkName] = { sha256: apk.sha256, size: apk.size };
  manifest.android = { file: apkName, versionName: apk.versionName, versionCode: apk.versionCode, sha256: apk.sha256, size: apk.size, signerSha256: apk.signers[0] };
  // gh uploads a file under its own name: the copy carries the release name.
  apkUpload = join(work, apkName);
  if (resolve(apk.file) !== apkUpload) copyFileSync(apk.file, apkUpload);
  if (createHash('sha256').update(readFileSync(apkUpload)).digest('hex') !== apk.sha256) fail(`the copy of the APK at ${apkUpload} doesn't match`);
}
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
const sig = sign(null, manifestBytes, privateKey).toString('base64');
const manifestPath = join(work, manifestName);
writeFileSync(manifestPath, manifestBytes);
writeFileSync(`${manifestPath}.sig`, sig + '\n');
// Check it the way the updater will: this checkout's verifier, with this key and (when pinned) the pinned keys.
const verifier = await import(pathToFileURL(join(root, 'server/src/releasesig.ts')).href);
const own = [{ id: keyId(pub), key: createPublicKey(privateKey) }];
const checked = verifier.verifyReleaseManifest(readFileSync(manifestPath), readFileSync(`${manifestPath}.sig`), { version, tag, keys: own });
verifier.checkAsset(checked.manifest, pkgName, { sha256: ciSum, size: ciBytes.length });
if (apk) verifier.checkAsset(checked.manifest, basename(apkUpload), { sha256: apk.sha256, size: apk.size });
if (!problems.length) verifier.verifyReleaseManifest(readFileSync(manifestPath), readFileSync(`${manifestPath}.sig`), { version, tag, keys: verifier.trustedKeys({}).keys });
console.log(`  ${manifestPath}\n  ${manifestPath}.sig${apk ? `\n  ${apkUpload} (android: ${apk.versionName}, versionCode ${apk.versionCode})` : ''}\n  verified`);

if (dryRun) {
  console.log(`\n✓ Dry run: everything checks out. Not uploaded, not published. Files are in ${work}\n`);
  process.exit(0);
}

// 6. Upload and publish.
step(`Uploading the manifest and signature${apk ? ' and the Android app' : ''} to ${tag}`);
gh(['release', 'upload', tag, '--repo', repo, '--clobber', manifestPath, `${manifestPath}.sig`, ...(apkUpload ? [apkUpload] : [])]);
step(`Publishing ${tag}`);
gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest']);
const latest = JSON.parse(gh(['api', `repos/${repo}/releases/latest`]));
if (latest.tag_name !== tag) console.warn(`  ⚠ GitHub's latest release is ${latest.tag_name}, not ${tag}`);
const names = (latest.assets ?? []).map((a) => a.name);
for (const n of [pkgName, `${pkgName}.sha256`, manifestName, `${manifestName}.sig`, ...(apkUpload ? [basename(apkUpload)] : [])]) if (!names.includes(n)) console.warn(`  ⚠ ${n} is missing from the published release`);
console.log(`\n✓ ${tag} is published and signed: ${latest.html_url}\n`);
