/**
 * Checking a release's signed manifest. Pure functions with no server state, so `servify selftest`, the updater and
 * scripts/test-release-signing.mjs all run exactly this code.
 *
 * Every release has `servify-v<version>.manifest.json` and `servify-v<version>.manifest.json.sig`: a detached
 * Ed25519 signature (base64, one line) over the exact bytes of the manifest, made on the maintainer's machine by
 * scripts/publish-release.mjs. The manifest (format 1):
 *
 *   {
 *     "format": 1,
 *     "product": "servify",
 *     "version": "0.2.4",                 // the Servify version, = package.json
 *     "tag": "v0.2.4",                    // the git tag / GitHub release
 *     "commit": "<40-hex>",               // the commit the package was built from (optional)
 *     "createdAt": "2026-11-27T12:00:00Z",
 *     "assets": {                         // every file of the release the signature vouches for
 *       "servify-v0.2.4.tar.gz": { "sha256": "<64-hex>", "size": 6683865 }
 *     },
 *     "android": {                        // optional: the Android app built for this release
 *       "file": "servify-android-0.2.4.apk",  // also listed in "assets", with the same sha256 and size
 *       "versionName": "0.2.4",
 *       "versionCode": 7,
 *       "sha256": "<64-hex>",
 *       "size": 12345678,
 *       "signerSha256": "<64-hex>"            // SHA-256 of the APK signing certificate
 *     }
 *   }
 *
 * Unknown top-level fields are allowed (a later format-1 manifest may add some); an unknown "format" is refused.
 */
import { createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { RELEASE_KEYS, type ReleaseKey } from './releasekey.ts';

export const MANIFEST_FORMAT = 1;
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_SIGNATURE_BYTES = 1024;

export type ManifestAsset = { sha256: string; size: number };
export type ReleaseManifest = {
  format: 1;
  product: 'servify';
  version: string;
  tag: string;
  commit?: string;
  createdAt: string;
  assets: Record<string, ManifestAsset>;
  android?: { file: string; versionName: string; versionCode: number; sha256: string; size: number; signerSha256: string };
};

export const packageName = (version: string) => `servify-v${version}.tar.gz`;
export const manifestName = (version: string) => `servify-v${version}.manifest.json`;
export const signatureName = (version: string) => `${manifestName(version)}.sig`;

/** A raw 32-byte Ed25519 public key in base64 → a key object (throws on anything else). */
export function publicKeyFromBase64(b64: string): KeyObject {
  const raw = Buffer.from(b64.trim(), 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== b64.trim()) throw new Error(`not a base64 Ed25519 public key: ${b64.slice(0, 12)}…`);
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
}

/**
 * The keys to trust: the pinned ones, or — when the owner set SERVIFY_UPDATE_KEYS (comma-separated base64 public
 * keys, for people who build and sign their own releases) — only those. `fromEnv` says which, for logging.
 */
export function trustedKeys(env: NodeJS.ProcessEnv = process.env): { keys: { id: string; key: KeyObject }[]; fromEnv: boolean } {
  const custom = env.SERVIFY_UPDATE_KEYS?.trim();
  const list: ReleaseKey[] = custom ? custom.split(/[\s,]+/).filter(Boolean).map((k, i) => ({ id: `SERVIFY_UPDATE_KEYS[${i}]`, publicKey: k })) : [...RELEASE_KEYS];
  if (!list.length) throw new Error('no release keys are configured');
  return { keys: list.map((k) => ({ id: k.id, key: publicKeyFromBase64(k.publicKey) })), fromEnv: !!custom };
}

const HEX64 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
const isSize = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

function parseManifest(bytes: Buffer): ReleaseManifest {
  let m: any;
  try {
    m = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('the manifest isn’t valid JSON');
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('the manifest isn’t a JSON object');
  if (m.format !== MANIFEST_FORMAT) throw new Error(`the manifest has format ${JSON.stringify(m.format)}, this version understands ${MANIFEST_FORMAT}`);
  if (m.product !== 'servify') throw new Error('the manifest isn’t for Servify');
  if (typeof m.version !== 'string' || !VERSION.test(m.version)) throw new Error('the manifest has no valid version');
  if (typeof m.tag !== 'string' || !m.tag) throw new Error('the manifest has no tag');
  if (typeof m.createdAt !== 'string') throw new Error('the manifest has no creation time');
  if (!m.assets || typeof m.assets !== 'object' || Array.isArray(m.assets)) throw new Error('the manifest has no assets');
  for (const [name, a] of Object.entries<any>(m.assets)) {
    if (!a || typeof a.sha256 !== 'string' || !HEX64.test(a.sha256) || !isSize(a.size)) throw new Error(`the manifest's entry for ${name} is malformed`);
  }
  if (m.android !== undefined) {
    const a = m.android;
    const ok =
      a && typeof a.file === 'string' && typeof a.versionName === 'string' && Number.isSafeInteger(a.versionCode) && a.versionCode > 0 && HEX64.test(a.sha256 ?? '') && isSize(a.size) && HEX64.test(a.signerSha256 ?? '');
    if (!ok) throw new Error('the manifest’s android entry is malformed');
    const listed = m.assets[a.file];
    if (!listed || listed.sha256 !== a.sha256 || listed.size !== a.size) throw new Error('the manifest’s android entry doesn’t match its assets');
  }
  return m as ReleaseManifest;
}

export type VerifyOptions = {
  /** The release being installed, from the feed: the manifest must be for exactly this version and tag. */
  version: string;
  tag: string;
  /** Keys to try; default trustedKeys(). */
  keys?: { id: string; key: KeyObject }[];
};

/**
 * Check a release manifest against its detached signature and the release it claims to be. Returns the parsed
 * manifest and which key signed it; throws an Error with a short reason otherwise. The signature is checked over
 * the raw bytes before anything is parsed.
 */
export function verifyReleaseManifest(manifestBytes: Buffer, signature: Buffer | string | null | undefined, opts: VerifyOptions): { manifest: ReleaseManifest; keyId: string } {
  const label = `release ${opts.tag || opts.version}`;
  if (!manifestBytes?.length) throw new Error(`${label} is not signed (it has no manifest)`);
  if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error(`${label}: the manifest is too large`);
  if (signature === null || signature === undefined || !signature.length) throw new Error(`${label} is not signed (it has no signature)`);
  const sigText = Buffer.isBuffer(signature) ? signature.toString('utf8') : signature;
  const sig = Buffer.from(sigText.trim(), 'base64');
  if (sig.length !== 64) throw new Error(`${label}: the signature is malformed`);
  const keys = opts.keys ?? trustedKeys().keys;
  const signer = keys.find((k) => {
    try {
      return verify(null, manifestBytes, k.key, sig);
    } catch {
      return false;
    }
  });
  if (!signer) throw new Error(`${label}: signature invalid (not signed by a trusted release key)`);
  const manifest = parseManifest(manifestBytes);
  if (manifest.version !== opts.version || manifest.tag !== opts.tag) {
    throw new Error(`${label}: the signed manifest is for ${manifest.tag} (${manifest.version}), not for this release`);
  }
  return { manifest, keyId: signer.id };
}

/** Check a downloaded release file against the verified manifest (call before unpacking or using it). */
export function checkAsset(manifest: ReleaseManifest, name: string, file: { sha256: string; size: number }): void {
  const want = Object.hasOwn(manifest.assets, name) ? manifest.assets[name] : undefined;
  if (!want) throw new Error(`${name} isn’t listed in the signed manifest`);
  if (file.size !== want.size) throw new Error(`${name} is ${file.size} bytes, the signed manifest says ${want.size}`);
  if (file.sha256.toLowerCase() !== want.sha256) throw new Error(`${name} doesn’t match the SHA-256 in the signed manifest`);
}

/**
 * Proof the pinned keys load and the verifier works, for `servify selftest` (it imports updater.ts, which runs this):
 * offline, with a throwaway key.
 */
export function signingSelfTest(): void {
  trustedKeys({}); // the pinned keys parse
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const m = Buffer.from(JSON.stringify({ format: 1, product: 'servify', version: '0.0.1', tag: 'v0.0.1', createdAt: new Date(0).toISOString(), assets: { [packageName('0.0.1')]: { sha256: '0'.repeat(64), size: 1 } } }));
  const s = sign(null, m, privateKey).toString('base64');
  const keys = [{ id: 'selftest', key: publicKey }];
  const { manifest } = verifyReleaseManifest(m, s, { version: '0.0.1', tag: 'v0.0.1', keys });
  checkAsset(manifest, packageName('0.0.1'), { sha256: '0'.repeat(64), size: 1 });
  let refused = false;
  try {
    verifyReleaseManifest(Buffer.from(m.toString().replace('0.0.1', '0.0.2')), s, { version: '0.0.1', tag: 'v0.0.1', keys });
  } catch {
    refused = true;
  }
  if (!refused) throw new Error('release signature check accepted a tampered manifest');
}
