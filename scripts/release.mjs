#!/usr/bin/env node
/**
 * Build the release package the updater installs: servify-v<version>.tar.gz (+ .sha256) in dist/.
 *
 *   pnpm build && node scripts/release.mjs [--out dir]
 *
 * Contents (one top-level folder): package.json, README, LICENSE, the examples the demo uses, the built dashboard
 * (web/dist) and the server with its production dependencies (pnpm deploy), so a server only needs Node to run it —
 * nothing to install or build.
 * GitHub Actions runs this on a version tag (.github/workflows/release.yml).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
let commit = null;
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
} catch {}
writeFileSync(join(dir, 'RELEASE.json'), JSON.stringify({ version, commit, builtAt: new Date().toISOString() }, null, 2) + '\n');

mkdirSync(out, { recursive: true });
const pkg = join(out, `${name}.tar.gz`);
run('tar', ['-czf', pkg, '-C', work, name]);
const sum = createHash('sha256').update(readFileSync(pkg)).digest('hex');
writeFileSync(`${pkg}.sha256`, `${sum}  ${name}.tar.gz\n`);
rmSync(work, { recursive: true, force: true });
console.log(`\n${pkg}\n${sum}`);
