#!/usr/bin/env node
/**
 * The Ed25519 key that signs Servify releases. It lives only on the maintainer's machine — never in the repository,
 * a GitHub secret or CI — so whoever controls the GitHub repository still can't publish an update that installs.
 *
 *   node scripts/release-key.mjs keygen [--dir <dir>]   create ~/.servify-release/release-key.pem (refuses to overwrite)
 *   node scripts/release-key.mjs pubkey [--key <file>]  print the public key of an existing key, in the pinned form
 *
 * Only the public key is ever printed. Pin it in server/src/releasekey.ts (RELEASE_KEYS). Back up the folder
 * (like ~/.android/servify-release.*): without it, existing installs can only be updated by hand.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULT_KEY_DIR = join(homedir(), '.servify-release');
export const KEY_FILE = 'release-key.pem';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

/** The raw 32-byte public key, base64: the form RELEASE_KEYS pins. */
export function publicKeyBase64(keyObject) {
  const pub = keyObject.type === 'public' ? keyObject : createPublicKey(keyObject);
  const jwk = pub.export({ format: 'jwk' });
  if (jwk.crv !== 'Ed25519') throw new Error('not an Ed25519 key');
  return Buffer.from(jwk.x, 'base64url').toString('base64');
}
export const keyId = (pub) => createHash('sha256').update(Buffer.from(pub, 'base64')).digest('hex').slice(0, 16);

/**
 * Load the private key, refusing a file or folder anyone but its owner can read or write. Never print what this
 * returns: it is the signing key.
 */
export function loadPrivateKey(file) {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`no release key at ${path} — create one with: node scripts/release-key.mjs keygen`);
  const st = statSync(path);
  if (!st.isFile()) throw new Error(`${path} isn't a file`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`${path} belongs to another user`);
  if (st.mode & 0o077) throw new Error(`${path} is readable or writable by others (mode ${(st.mode & 0o777).toString(8)}) — run: chmod 600 ${path}`);
  const dir = resolve(path, '..');
  const dst = statSync(dir);
  if (dst.mode & 0o022) throw new Error(`${dir} is writable by others (mode ${(dst.mode & 0o777).toString(8)}) — run: chmod 700 ${dir}`);
  const key = createPrivateKey(readFileSync(path));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${path} isn't an Ed25519 key`);
  return key;
}

function keygen() {
  const dir = resolve(arg('--dir') ?? DEFAULT_KEY_DIR);
  const file = join(dir, KEY_FILE);
  if (existsSync(file)) throw new Error(`${file} already exists — refusing to overwrite it (print its public key with: node scripts/release-key.mjs pubkey)`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  // 'wx': fail rather than overwrite, even if the file appeared since the check above.
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeSync(fd, pem);
  } finally {
    closeSync(fd);
  }
  chmodSync(file, 0o600);
  const pub = publicKeyBase64(publicKey);
  console.log(`Wrote the private release key to ${file} (mode 600, folder 700). It is not printed.`);
  console.log(`Back up ${dir} somewhere safe and offline: without it, existing installs can only be updated by hand.\n`);
  console.log(`Public key (pin it in server/src/releasekey.ts):\n`);
  console.log(`  { id: '${keyId(pub)}', publicKey: '${pub}' },`);
}

function pubkey() {
  const file = resolve(arg('--key') ?? join(DEFAULT_KEY_DIR, KEY_FILE));
  const pub = publicKeyBase64(loadPrivateKey(file));
  console.log(`  { id: '${keyId(pub)}', publicKey: '${pub}' },`);
}

if (process.argv[1]?.endsWith('release-key.mjs')) {
  const cmd = process.argv[2];
  try {
    if (cmd === 'keygen') keygen();
    else if (cmd === 'pubkey') pubkey();
    else {
      console.error('usage: node scripts/release-key.mjs keygen [--dir <dir>] | pubkey [--key <file>]');
      process.exit(2);
    }
  } catch (e) {
    console.error(`release-key: ${e.message}`);
    process.exit(1);
  }
}
