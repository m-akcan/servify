#!/usr/bin/env node
/**
 * Build the release package the updater installs: servify-v<version>.tar.gz (+ .sha256) in dist/.
 *
 *   pnpm build && node scripts/release.mjs [--out dir]
 *
 * Contents (one top-level folder): package.json, README, LICENSE, the examples the demo uses, the built dashboard
 * (web/dist) and the server with its production dependencies (pnpm deploy), so a server only needs Node to run it —
 * nothing to install or build.
 * GitHub Actions runs this on a version tag (.github/workflows/release.yml); scripts/publish-release.mjs runs it
 * again on the maintainer's machine and compares the two before signing.
 *
 * Reproducible: the same commit gives the same files with the same contents wherever it is built. Entries are
 * sorted, every timestamp is the commit's time (or SOURCE_DATE_EPOCH), owners are 0, modes are 755/644, and the
 * gzip header has no timestamp. pnpm's bookkeeping that holds paths of the build machine (node_modules/.bin shims,
 * .modules.yaml, links back into the checkout) is left out — nothing needs it at run time. The tarball's bytes can
 * still differ between machines if their zlib compresses differently; publish-release compares contents.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const outArg = process.argv.indexOf('--out');
const out = resolve(outArg > 0 ? process.argv[outArg + 1] : join(root, 'dist'));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const serverVersion = JSON.parse(readFileSync(join(root, 'server/package.json'), 'utf8')).version;
if (serverVersion !== version) throw new Error(`server/package.json says ${serverVersion}, package.json says ${version}`);
if (!existsSync(join(root, 'web/dist/index.html'))) throw new Error('build the dashboard first (pnpm build)');

const name = `servify-v${version}`;
const work = mkdtempSync(join(tmpdir(), 'servify-release-'));
const dir = join(work, name);
mkdirSync(dir);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });

// The server with only its production dependencies, as real folders (no links into this checkout).
// `pnpm deploy --prod` rewrites this checkout's workspace state as "no dev dependencies", after which the next pnpm
// command wants to reinstall everything: keep the file and put it back.
const state = join(root, 'node_modules/.pnpm-workspace-state-v1.json');
const savedState = existsSync(state) ? readFileSync(state) : null;
try {
  run('pnpm', ['--filter', '@servify/server', 'deploy', '--prod', '--legacy', join(dir, 'server')], { env: { ...process.env, CI: 'true' } });
} finally {
  if (savedState) writeFileSync(state, savedState);
}
rmSync(join(dir, 'server/tsconfig.json'), { force: true });
mkdirSync(join(dir, 'web'));
cpSync(join(root, 'web/dist'), join(dir, 'web/dist'), { recursive: true });
for (const f of ['package.json', 'README.md', 'LICENSE']) cpSync(join(root, f), join(dir, f));
// "Try the demo" builds an example from this folder.
cpSync(join(root, 'examples'), join(dir, 'examples'), { recursive: true, filter: (p) => !/(^|\/)(node_modules|\.DS_Store)(\/|$)/.test(p) });

// Leave out what only describes the build machine: bin shims (they embed its absolute paths), pnpm's state file
// and any link that points outside the package (pnpm links the workspace package back to the checkout).
function prune(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isSymbolicLink()) {
      const target = resolve(dirname(p), readlinkSync(p));
      if (target !== dir && !target.startsWith(dir + sep)) rmSync(p);
    } else if (e.isDirectory()) {
      if (e.name === '.bin' && d.endsWith('node_modules')) rmSync(p, { recursive: true });
      else prune(p);
    } else if (e.name === '.modules.yaml' && d.endsWith('node_modules')) rmSync(p);
  }
}
prune(join(dir, 'server'));

let commit = null;
let commitTime = null;
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  commitTime = Number(execFileSync('git', ['log', '-1', '--format=%ct', 'HEAD'], { cwd: root }).toString().trim());
} catch {}
const epoch = Number(process.env.SOURCE_DATE_EPOCH) || commitTime || Math.floor(Date.now() / 1000);
if (!process.env.SOURCE_DATE_EPOCH && !commitTime) console.warn('release: no git commit and no SOURCE_DATE_EPOCH — this package is not reproducible');
// builtAt is the commit's time (not the wall clock), so two builds of one commit are identical.
writeFileSync(join(dir, 'RELEASE.json'), JSON.stringify({ version, commit, builtAt: new Date(epoch * 1000).toISOString() }, null, 2) + '\n');

// ─── a deterministic tar (ustar + pax for long names), gzip without a timestamp ───

function header(path, { size = 0, mode, type, link = '' }) {
  const h = Buffer.alloc(512);
  h.write(path, 0, 100, 'utf8');
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100);
  h.write('0000000\0', 108); // uid
  h.write('0000000\0', 116); // gid
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write(epoch.toString(8).padStart(11, '0') + '\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write(link, 157, 100, 'utf8');
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512);
function paxRecord(k, v) {
  const body = ` ${k}=${v}\n`;
  const n = Buffer.byteLength(body);
  let len = n + 1;
  while (String(len).length + n !== len) len = String(len).length + n; // the length counts its own digits
  return `${len}${body}`;
}
const chunks = [];
function entry(path, opts, data) {
  const recs = (Buffer.byteLength(path) > 99 ? paxRecord('path', path) : '') + (opts.link && Buffer.byteLength(opts.link) > 99 ? paxRecord('linkpath', opts.link) : '');
  if (recs) {
    const body = Buffer.from(recs);
    chunks.push(header('PaxHeader', { size: body.length, mode: 0o644, type: 'x' }), body, pad(body.length));
  }
  chunks.push(header(Buffer.byteLength(path) > 99 ? path.slice(0, 99) : path, { ...opts, link: opts.link && Buffer.byteLength(opts.link) > 99 ? '' : opts.link }));
  if (data) chunks.push(data, pad(data.length));
}
const byBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
function add(abs) {
  const rel = relative(work, abs).split(sep).join('/');
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) entry(rel, { mode: 0o777, type: '2', link: readlinkSync(abs) });
  else if (st.isDirectory()) {
    entry(`${rel}/`, { mode: 0o755, type: '5' });
    for (const n of readdirSync(abs).sort(byBytes)) add(join(abs, n));
  } else if (st.isFile()) {
    const data = readFileSync(abs);
    entry(rel, { size: data.length, mode: st.mode & 0o111 ? 0o755 : 0o644, type: '0' }, data);
  }
}
add(dir);
chunks.push(Buffer.alloc(1024));
const gz = gzipSync(Buffer.concat(chunks), { level: 9 });
gz[9] = 3; // the OS byte: "Unix" everywhere (zlib puts the build platform's here)

mkdirSync(out, { recursive: true });
const pkg = join(out, `${name}.tar.gz`);
writeFileSync(pkg, gz);
const sum = createHash('sha256').update(gz).digest('hex');
writeFileSync(`${pkg}.sha256`, `${sum}  ${name}.tar.gz\n`);
rmSync(work, { recursive: true, force: true });
console.log(`\n${pkg}\n${sum}`);
