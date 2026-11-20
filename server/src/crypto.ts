/**
 * Encryption at rest for secrets (service variables, git tokens, resolved env, credentials in settings).
 *
 * Master key: SERVIFY_MASTER_KEY (any string; hashed to 32 bytes) or `<dataDir>/master.key`, created on
 * first boot with mode 0600. Values are sealed with AES-256-GCM as `svf1:<base64(iv|tag|ciphertext)>`.
 *
 * If the database already holds sealed values and the key can't open them, boot stops: falling back to a
 * fresh key and re-saving would silently destroy every secret.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';

const PREFIX = 'svf1:';
export const keyPath = join(config.dataDir, 'master.key');

function loadKey(): { key: Buffer; source: 'env' | 'file' | 'created' } {
  const fromEnv = process.env.SERVIFY_MASTER_KEY;
  if (fromEnv) return { key: createHash('sha256').update(fromEnv).digest(), source: 'env' };
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath, 'utf8').trim();
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== 32) throw new Error(`${keyPath} is not a valid Servify master key (expected 32 bytes, base64)`);
    return { key: buf, source: 'file' };
  }
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString('base64') + '\n', { mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {}
  return { key, source: 'created' };
}

const loaded = loadKey();
const KEY = loaded.key;
export const keySource = loaded.source;

export function isSealed(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(PREFIX);
}

export function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export class SealError extends Error {}

export function open(sealed: string): string {
  if (!isSealed(sealed)) return sealed; // legacy plaintext
  const buf = Buffer.from(sealed.slice(PREFIX.length), 'base64');
  try {
    const d = createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch {
    throw new SealError(
      `cannot decrypt stored secrets with the current master key (${keySource === 'env' ? 'SERVIFY_MASTER_KEY' : keyPath}). ` +
        'Restore the original key file or SERVIFY_MASTER_KEY value; Servify will not start with the wrong key.',
    );
  }
}

export const sealJson = (v: unknown) => seal(JSON.stringify(v));
export const openJson = <T,>(s: string): T => JSON.parse(open(s)) as T;
