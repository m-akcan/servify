#!/usr/bin/env node
/**
 * Compare two release packages by content: the same paths, types, exec bits, link targets and file contents
 * (SHA-256) — mtimes, owners and the order of entries don't matter.
 *
 *   node scripts/release-compare.mjs a.tar.gz b.tar.gz
 *
 * Used by scripts/publish-release.mjs to check the package CI built against one built on the maintainer's machine.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const str = (b) => {
  const i = b.indexOf(0);
  return b.subarray(0, i < 0 ? b.length : i).toString('utf8');
};
const oct = (b) => Number.parseInt(str(b).trim() || '0', 8);

function parsePax(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp < 0) break;
    const len = Number(buf.subarray(i, sp).toString());
    if (!len) break;
    const rec = buf.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** path → { type: 'file' | 'dir' | 'symlink' | 'hardlink' | 'other', exec, size, sha256, link } of a .tar.gz (hard links resolved to their file). */
export function listTarGz(file) {
  const tar = gunzipSync(readFileSync(file));
  const entries = new Map();
  const duplicates = [];
  let off = 0;
  let pax = {};
  let longName = null;
  let longLink = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = oct(h.subarray(124, 136));
    const type = String.fromCharCode(h[156] || 0x30);
    const data = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      pax = parsePax(data);
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      longName = str(data);
      continue;
    }
    if (type === 'K') {
      longLink = str(data);
      continue;
    }
    const prefix = str(h.subarray(345, 500));
    let path = pax.path ?? longName ?? (prefix ? `${prefix}/${str(h.subarray(0, 100))}` : str(h.subarray(0, 100)));
    const link = pax.linkpath ?? longLink ?? str(h.subarray(157, 257));
    pax = {};
    longName = longLink = null;
    path = path.replace(/^\.\//, '').replace(/\/+$/, '');
    const mode = oct(h.subarray(100, 108));
    // A path that appears twice extracts as whatever comes last, after the first did its work (a link replaced by
    // a folder …): never what a release should contain, and a way to hide a difference — reported as one.
    if (entries.has(path)) duplicates.push(path);
    if (type === '1') {
      // A hard link to an earlier entry (GNU tar stores files pnpm hard-linked this way): compare it as that file.
      const target = entries.get(link.replace(/^\.\//, ''));
      if (target?.type === 'file') {
        entries.set(path, { ...target });
        continue;
      }
    }
    const kind = type === '0' || type === '\0' || type === '7' ? 'file' : type === '5' ? 'dir' : type === '2' ? 'symlink' : type === '1' ? 'hardlink' : 'other';
    entries.set(path, {
      type: kind,
      exec: kind === 'file' ? !!(mode & 0o111) : null,
      size: kind === 'file' ? size : null,
      sha256: kind === 'file' ? createHash('sha256').update(data).digest('hex') : null,
      link: kind === 'symlink' || kind === 'hardlink' ? link : null,
    });
  }
  entries.duplicates = duplicates;
  return entries;
}

/** Differences between two packages (empty: same content). */
export function compareTarGz(a, b) {
  const x = listTarGz(a);
  const y = listTarGz(b);
  const diffs = [];
  for (const p of x.duplicates) diffs.push(`listed twice in the first: ${p}`);
  for (const p of y.duplicates) diffs.push(`listed twice in the second: ${p}`);
  for (const [p, e] of x) {
    const f = y.get(p);
    if (!f) diffs.push(`only in the first: ${p}`);
    else if (e.type !== f.type) diffs.push(`${p}: ${e.type} vs ${f.type}`);
    else if (e.link !== f.link) diffs.push(`${p}: links to ${e.link} vs ${f.link}`);
    else if (e.sha256 !== f.sha256) diffs.push(`${p}: different content`);
    else if (e.exec !== f.exec) diffs.push(`${p}: executable ${e.exec} vs ${f.exec}`);
  }
  for (const p of y.keys()) if (!x.has(p)) diffs.push(`only in the second: ${p}`);
  return { diffs, entries: x.size };
}

if (process.argv[1]?.endsWith('release-compare.mjs')) {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) {
    console.error('usage: node scripts/release-compare.mjs a.tar.gz b.tar.gz');
    process.exit(2);
  }
  const { diffs, entries } = compareTarGz(a, b);
  if (diffs.length) {
    console.error(`${diffs.length} difference${diffs.length === 1 ? '' : 's'}:\n  ${diffs.slice(0, 200).join('\n  ')}`);
    process.exit(1);
  }
  console.log(`same content (${entries} entries)`);
}
