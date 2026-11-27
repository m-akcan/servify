/**
 * A small tar (ustar + pax) writer and a streaming extractor, for `servify up` uploads. The extractor only writes
 * regular files and folders, inside the target folder: links, devices and paths that would escape are skipped.
 */
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';

// ─── writing ───

function header(name: string, size: number, mode: number, type: string, mtime: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write(Math.floor(mtime / 1000).toString(8).padStart(11, '0') + '\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512);

/** One tar entry (with a pax header first when the name doesn't fit ustar). */
export function tarEntry(name: string, data: Buffer, mode = 0o644, mtime = Date.now()): Buffer[] {
  const out: Buffer[] = [];
  if (Buffer.byteLength(name) > 99) {
    const rec = (k: string, v: string) => {
      const body = ` ${k}=${v}\n`;
      const n = Buffer.byteLength(body);
      let len = n + 1;
      while (String(len).length + n !== len) len = String(len).length + n; // the length counts its own digits
      return `${len}${body}`;
    };
    const pax = Buffer.from(rec('path', name));
    out.push(header('PaxHeader', pax.length, 0o644, 'x', mtime), pax, pad(pax.length));
  }
  out.push(header(name, data.length, mode, '0', mtime), data, pad(data.length));
  return out;
}
export const tarEnd = () => Buffer.alloc(1024);

// ─── reading ───

function octal(b: Buffer): number {
  if (b[0] & 0x80) {
    // base-256 for sizes over 8 GB
    let n = 0;
    for (let i = 1; i < b.length; i++) n = n * 256 + b[i];
    return n;
  }
  const s = b.toString('ascii').replace(/\0.*$/s, '').trim();
  return s ? parseInt(s, 8) : 0;
}
const cstr = (b: Buffer) => b.toString('utf8').replace(/\0.*$/s, '');

export type ExtractStats = { files: number; bytes: number; skipped: string[] };

/** Extract a tar stream into `root`. Throws past the limits. */
export async function extractTar(input: Readable, root: string, limits = { bytes: 2 * 1024 ** 3, files: 200_000 }): Promise<ExtractStats> {
  const base = resolve(root);
  mkdirSync(base, { recursive: true });
  const stats: ExtractStats = { files: 0, bytes: 0, skipped: [] };
  let buf: Buffer = Buffer.alloc(0);
  let fd: number | null = null; // the file being written
  let remaining = 0; // its bytes still to come
  let padding = 0; // and the block padding after it
  let collect: Buffer[] | null = null; // pax / GNU long-name data being collected
  let collectType = '';
  let longName: string | null = null;
  let zeros = 0;

  const safe = (name: string): string | null => {
    const n = name.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
    if (!n || n.startsWith('/') || n.split('/').includes('..')) return null;
    const p = resolve(base, n);
    return p === base || p.startsWith(base + sep) ? p : null;
  };

  try {
    return await read();
  } catch (e) {
    if (fd !== null) closeSync(fd); // a failed upload must not leak the file it was writing
    throw e;
  }

  async function read(): Promise<ExtractStats> {
    for await (const chunk of input) {
      buf = buf.length ? Buffer.concat([buf, chunk as Buffer]) : (chunk as Buffer);
      for (;;) {
        if (remaining > 0) {
          if (!buf.length) break;
          const take = Math.min(remaining, buf.length);
          const part = buf.subarray(0, take);
          if (collect) collect.push(Buffer.from(part));
          else if (fd !== null) writeSync(fd, part);
          remaining -= take;
          buf = buf.subarray(take);
          if (remaining > 0) break;
          if (fd !== null) {
            closeSync(fd);
            fd = null;
          }
          if (collect) {
            const data = Buffer.concat(collect).toString('utf8');
            if (collectType === 'L') longName = data.replace(/\0.*$/s, '');
            else {
              const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data);
              if (m && collectType === 'x') longName = m[1];
            }
            collect = null;
          }
        }
        if (padding > 0) {
          const take = Math.min(padding, buf.length);
          padding -= take;
          buf = buf.subarray(take);
          if (padding > 0) break;
        }
        if (buf.length < 512) break;
        const h = buf.subarray(0, 512);
        buf = buf.subarray(512);
        if (h.every((b) => b === 0)) {
          if (++zeros >= 2) return finish();
          continue;
        }
        zeros = 0;
        const size = octal(h.subarray(124, 136));
        const type = String.fromCharCode(h[156] || 48);
        const prefix = cstr(h.subarray(345, 500));
        let name = longName ?? (prefix ? `${prefix}/${cstr(h.subarray(0, 100))}` : cstr(h.subarray(0, 100)));
        if (type !== 'x' && type !== 'L' && type !== 'g') longName = null;
        remaining = size;
        padding = (512 - (size % 512)) % 512;
        if (type === 'x' || type === 'L' || type === 'g') {
          collect = [];
          collectType = type;
          if (size === 0) collect = null;
          continue;
        }
        name = name.replace(/\/+$/, '');
        const path = safe(name);
        if (type === '5') {
          if (path) mkdirSync(path, { recursive: true });
          continue;
        }
        if ((type !== '0' && type !== '7') || !path) {
          if (name) stats.skipped.push(name);
          continue; // links, devices, unsafe paths: the data that follows is skipped
        }
        stats.files++;
        stats.bytes += size;
        if (stats.files > limits.files) throw new Error(`too many files (over ${limits.files.toLocaleString()})`);
        if (stats.bytes > limits.bytes) throw new Error(`too large (over ${Math.round(limits.bytes / 1024 ** 2)} MB unpacked)`);
        mkdirSync(dirname(path), { recursive: true });
        const mode = octal(h.subarray(100, 108)) & 0o111 ? 0o755 : 0o644;
        fd = openSync(path, 'w', mode);
        if (size === 0) {
          closeSync(fd);
          fd = null;
        }
      }
    }
    return finish();
  }

  function finish() {
    if (fd !== null) closeSync(fd);
    return stats;
  }
}

