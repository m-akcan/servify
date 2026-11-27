#!/usr/bin/env node
/**
 * Unit test of release signing: the updater's verifier (exported from server/src/updater.ts) against a fake release
 * signed with a throwaway key made in a temporary folder — never the real release key. No network, no Docker.
 *
 *   node scripts/test-release-signing.mjs
 *
 * CI runs it (ci.yml, release.yml).
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'servify-signing-test-'));
process.env.SERVIFY_DATA_DIR = join(tmp, 'data');
delete process.env.SERVIFY_UPDATE_KEYS;

let failed = 0;
const ok = (name, fn) => {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
};
const refuses = (name, fn, match) =>
  ok(name, () => {
    let err = null;
    try {
      fn();
    } catch (e) {
      err = e;
    }
    if (!err) throw new Error('was accepted');
    if (match && !match.test(err.message)) throw new Error(`refused for the wrong reason: ${err.message}`);
  });

try {
  const updater = await import(pathToFileURL(join(root, 'server/src/updater.ts')).href);
  const { verifyReleaseManifest, checkAsset, trustedKeys } = updater;
  const { publicKeyBase64 } = await import(pathToFileURL(join(root, 'scripts/release-key.mjs')).href);
  const { loadPrivateKey } = await import(pathToFileURL(join(root, 'scripts/release-key.mjs')).href);

  // A throwaway key, written like the real one (0600 in a 0700 folder) so loadPrivateKey's checks run too.
  const keyDir = join(tmp, 'key');
  mkdirSync(keyDir, { mode: 0o700 });
  const kp = generateKeyPairSync('ed25519');
  writeFileSync(join(keyDir, 'release-key.pem'), kp.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const key = loadPrivateKey(join(keyDir, 'release-key.pem'));
  const pub = publicKeyBase64(kp.publicKey);
  const keys = [{ id: 'test', key: kp.publicKey }];
  const other = generateKeyPairSync('ed25519');

  // A fake release folder.
  const rel = join(tmp, 'release');
  mkdirSync(rel);
  const version = '9.8.7';
  const tag = `v${version}`;
  const pkgName = `servify-v${version}.tar.gz`;
  const tarball = Buffer.from(`not really a tarball ${Math.random()}`.repeat(100));
  writeFileSync(join(rel, pkgName), tarball);
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const manifestOf = (over = {}) => ({
    format: 1,
    product: 'servify',
    version,
    tag,
    commit: 'a'.repeat(40),
    createdAt: new Date().toISOString(),
    assets: { [pkgName]: { sha256: sha(tarball), size: tarball.length } },
    ...over,
  });
  const bytes = (m) => Buffer.from(JSON.stringify(m, null, 2) + '\n');
  const signed = (b, k = key) => sign(null, b, k).toString('base64') + '\n';
  const good = bytes(manifestOf());
  writeFileSync(join(rel, `servify-v${version}.manifest.json`), good);
  writeFileSync(join(rel, `servify-v${version}.manifest.json.sig`), signed(good));
  const fileOf = (b) => ({ sha256: sha(b), size: b.length });
  const opts = { version, tag, keys };
  const m = readFileSync(join(rel, `servify-v${version}.manifest.json`));
  const s = readFileSync(join(rel, `servify-v${version}.manifest.json.sig`));

  console.log('release signing:');
  ok('accepts a valid manifest and package', () => {
    const r = verifyReleaseManifest(m, s, opts);
    if (r.keyId !== 'test' || r.manifest.version !== version) throw new Error('wrong result');
    checkAsset(r.manifest, pkgName, fileOf(readFileSync(join(rel, pkgName))));
  });
  ok('accepts the signature as a Buffer or a string', () => verifyReleaseManifest(m, Buffer.from(s), opts));
  refuses('refuses a tampered manifest', () => verifyReleaseManifest(Buffer.from(m.toString().replace(String(tarball.length), String(tarball.length + 1))), s, opts), /signature invalid/);
  refuses('refuses a manifest with one byte appended', () => verifyReleaseManifest(Buffer.concat([m, Buffer.from(' ')]), s, opts), /signature invalid/);
  refuses('refuses a tampered package (hash mismatch)', () => {
    const t = Buffer.from(tarball);
    t[10] ^= 1;
    checkAsset(verifyReleaseManifest(m, s, opts).manifest, pkgName, fileOf(t));
  }, /SHA-256/);
  refuses('refuses a package of the wrong size', () => checkAsset(verifyReleaseManifest(m, s, opts).manifest, pkgName, fileOf(Buffer.concat([tarball, Buffer.from('x')]))), /bytes/);
  refuses('refuses a file the manifest does not list', () => checkAsset(verifyReleaseManifest(m, s, opts).manifest, 'servify-v9.8.8.tar.gz', fileOf(tarball)), /isn.t listed/);
  refuses('refuses a signature by another key', () => verifyReleaseManifest(m, signed(m, other.privateKey), opts), /signature invalid/);
  refuses('refuses when only the wrong key is trusted', () => verifyReleaseManifest(m, s, { ...opts, keys: [{ id: 'x', key: other.publicKey }] }), /signature invalid/);
  refuses('refuses a signed manifest for another version', () => verifyReleaseManifest(m, s, { ...opts, version: '9.8.8', tag: 'v9.8.8' }), /not for this release/);
  refuses('refuses a signed manifest for another tag', () => verifyReleaseManifest(m, s, { ...opts, tag: 'v9.8.7-evil' }), /not for this release/);
  refuses('refuses an old signed manifest replayed for a newer release', () => {
    const old = bytes(manifestOf({ version: '9.8.6', tag: 'v9.8.6' }));
    verifyReleaseManifest(old, signed(old), opts);
  }, /not for this release/);
  refuses('refuses a missing signature', () => verifyReleaseManifest(m, null, opts), /not signed/);
  refuses('refuses an empty signature', () => verifyReleaseManifest(m, Buffer.alloc(0), opts), /not signed/);
  refuses('refuses a missing manifest', () => verifyReleaseManifest(Buffer.alloc(0), s, opts), /not signed/);
  refuses('refuses a malformed signature', () => verifyReleaseManifest(m, 'aGVsbG8=', opts), /malformed/);
  refuses('refuses an unknown manifest format (even when signed)', () => {
    const b = bytes(manifestOf({ format: 2 }));
    verifyReleaseManifest(b, signed(b), opts);
  }, /format/);
  refuses('refuses a signed manifest with a malformed asset', () => {
    const b = bytes(manifestOf({ assets: { [pkgName]: { sha256: 'nothex', size: 1 } } }));
    verifyReleaseManifest(b, signed(b), opts);
  }, /malformed/);
  const apk = { file: 'servify-android-9.8.7.apk', versionName: '9.8.7', versionCode: 42, sha256: 'b'.repeat(64), size: 1234, signerSha256: 'c'.repeat(64) };
  ok('accepts an android entry that matches its asset', () => {
    const b = bytes(manifestOf({ assets: { [pkgName]: { sha256: sha(tarball), size: tarball.length }, [apk.file]: { sha256: apk.sha256, size: apk.size } }, android: apk }));
    verifyReleaseManifest(b, signed(b), opts);
  });
  refuses('refuses an android entry that does not match its asset', () => {
    const b = bytes(manifestOf({ android: apk }));
    verifyReleaseManifest(b, signed(b), opts);
  }, /android/);
  refuses('the pinned keys refuse a release signed with the test key', () => verifyReleaseManifest(m, s, { version, tag }), /signature invalid/);
  ok('the pinned keys load', () => {
    const t = trustedKeys({});
    if (t.fromEnv || !t.keys.length) throw new Error('no pinned keys');
  });
  ok('SERVIFY_UPDATE_KEYS replaces the pinned keys (only when set)', () => {
    const t = trustedKeys({ SERVIFY_UPDATE_KEYS: pub });
    if (!t.fromEnv || t.keys.length !== 1) throw new Error('not used');
    verifyReleaseManifest(m, s, { version, tag, keys: t.keys });
    if (trustedKeys({ SERVIFY_UPDATE_KEYS: '' }).fromEnv) throw new Error('an empty value was used');
  });
  refuses('SERVIFY_UPDATE_KEYS with a bad key is an error', () => trustedKeys({ SERVIFY_UPDATE_KEYS: 'bm90IGEga2V5' }), /not a base64 Ed25519/);
  refuses('a world-readable key file is refused', () => {
    chmodSync(join(keyDir, 'release-key.pem'), 0o644);
    try {
      loadPrivateKey(join(keyDir, 'release-key.pem'));
    } finally {
      chmodSync(join(keyDir, 'release-key.pem'), 0o600);
    }
  }, /readable or writable by others/);
} catch (e) {
  failed++;
  console.log(`  FAIL  setup: ${e.stack ?? e.message}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
