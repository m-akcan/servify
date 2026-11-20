import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { docker, dockerHostEnv } from './docker.ts';
import { config } from './config.ts';
import { detect, DEFAULT_IGNORE } from './detect.ts';
import type { Deployment, Project, Service } from './types.ts';
import { INSTANCE_ID } from './engine.ts';

type Log = (line: string) => void;

export type BuildResult = { image: string; commitSha: string | null; commitMessage: string | null; builder: string };

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; onLine?: Log; mask?: string[] } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let partial = '';
    const onData = (b: Buffer) => {
      let s = b.toString('utf8');
      for (const m of opts.mask ?? []) if (m) s = s.split(m).join('****');
      out += s;
      if (out.length > 200_000) out = out.slice(-100_000);
      if (!opts.onLine) return;
      partial += s;
      const lines = partial.split(/\r?\n|\r/);
      partial = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) opts.onLine(l);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      if (partial.trim() && opts.onLine) opts.onLine(partial);
      resolvePromise({ code: code ?? 1, out });
    });
  });
}

function authedUrl(repo: string, token?: string): string {
  let url = repo.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`; // owner/repo shorthand
  if (!token) return url;
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') {
      u.username = 'x-access-token';
      u.password = token;
      return u.toString();
    }
  } catch {}
  return url;
}

export function normalizeRepo(repo: string): string {
  let url = repo.trim().replace(/\/+$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  if (/^github\.com\//.test(url)) url = `https://${url}`;
  // Support pasted browser URLs like https://github.com/o/r/tree/main/sub
  const m = url.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/tree\/([^/]+)(?:\/(.*))?$/);
  if (m) return m[1];
  return url;
}

export async function latestCommit(repo: string, branch: string | undefined, token?: string): Promise<string | null> {
  const r = await run('git', ['ls-remote', authedUrl(repo, token), branch ? `refs/heads/${branch}` : 'HEAD'], {
    env: { GIT_TERMINAL_PROMPT: '0' },
  }).catch(() => null);
  if (!r || r.code !== 0) return null;
  return r.out.trim().split(/\s+/)[0] || null;
}

function imageTag(project: Project, svc: Service, dep: Deployment) {
  return `servify/${project.slug}-${svc.slug}:${dep.id.slice(-8)}`.toLowerCase();
}

let cliBuildAvailable: boolean | null = null;

async function cliBuild(ctx: string, dockerfile: string, tag: string, labels: Record<string, string>, log: Log): Promise<boolean> {
  if (cliBuildAvailable === false) return false;
  const args = ['build', '--progress=plain', '-t', tag, '-f', dockerfile];
  for (const [k, v] of Object.entries(labels)) args.push('--label', `${k}=${v}`);
  args.push(ctx);
  let missingBuildx = false;
  const r = await run('docker', args, {
    env: { DOCKER_HOST: dockerHostEnv, DOCKER_BUILDKIT: '1', BUILDKIT_PROGRESS: 'plain' },
    onLine: (l) => {
      if (/buildx component is missing|unknown flag: --progress|docker: not found/i.test(l)) missingBuildx = true;
      log(l);
    },
  }).catch((e) => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  });
  if (r === null || missingBuildx) {
    cliBuildAvailable = false;
    log('! docker CLI/buildx unavailable — falling back to the Engine API builder');
    return false;
  }
  cliBuildAvailable = true;
  if (r.code !== 0) throw new Error('docker build failed (see log above)');
  return true;
}

async function apiBuild(ctx: string, dockerfile: string, tag: string, labels: Record<string, string>, log: Log) {
  // Dockerfile may live outside the context: tar both into a single stream.
  const relDf = relative(ctx, dockerfile);
  const inside = !relDf.startsWith('..') && !isAbsolute(relDf);
  const args = ['-c', '-C', ctx, '.'];
  let dfName = relDf;
  if (!inside) {
    const dir = resolve(dockerfile, '..');
    dfName = '.servify.Dockerfile';
    args.push('-C', dir, dfName);
  }
  const tar = spawn('tar', args, { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, COPYFILE_DISABLE: '1' } });
  await docker.buildFromTar(tar.stdout, tag, dfName, log, labels);
}

export async function buildSource(svc: Service, project: Project, dep: Deployment, log: Log): Promise<BuildResult> {
  const src = dep.config.source;
  const workDir = join(config.buildsDir, dep.id);
  let repoDir: string;
  let commitSha: string | null = null;
  let commitMessage: string | null = null;
  let cleanup = false;

  if (src.type === 'git') {
    mkdirSync(workDir, { recursive: true });
    repoDir = join(workDir, 'src');
    const url = normalizeRepo(src.repo);
    log(`▸ Cloning ${url}${src.branch ? ` (${src.branch})` : ''}`);
    const args = ['clone', '--depth', '1', '--single-branch'];
    if (src.branch) args.push('--branch', src.branch);
    args.push(authedUrl(url, src.token), repoDir);
    const r = await run('git', args, { env: { GIT_TERMINAL_PROMPT: '0' }, onLine: log, mask: [src.token ?? ''] });
    if (r.code !== 0) throw new Error('git clone failed — check the repository URL, branch and access token');
    cleanup = true;
    const sha = await run('git', ['-C', repoDir, 'log', '-1', '--format=%H%n%s']);
    [commitSha, commitMessage] = sha.out.trim().split('\n');
    log(`▸ Commit ${commitSha?.slice(0, 7)} — ${commitMessage}`);
  } else if (src.type === 'local') {
    repoDir = resolve(src.path.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
    if (!existsSync(repoDir) || !statSync(repoDir).isDirectory()) throw new Error(`local path not found: ${repoDir}`);
    mkdirSync(workDir, { recursive: true });
    log(`▸ Building from local folder ${repoDir}`);
    const g = await run('git', ['-C', repoDir, 'log', '-1', '--format=%H%n%s']).catch(() => null);
    if (g && g.code === 0) [commitSha, commitMessage] = g.out.trim().split('\n');
  } else {
    throw new Error('image sources are not built');
  }

  try {
    const ctx = resolve(repoDir, (src as { rootDir?: string }).rootDir ?? '.');
    if (!existsSync(ctx)) throw new Error(`root directory not found in source: ${(src as any).rootDir}`);
    let dockerfile = src.dockerfile ? resolve(ctx, src.dockerfile) : join(ctx, 'Dockerfile');
    let builder = 'dockerfile';
    if (!existsSync(dockerfile)) {
      if (src.dockerfile) throw new Error(`Dockerfile not found: ${src.dockerfile}`);
      const d = detect(ctx, svc.buildCommand);
      if (!d) throw new Error('could not detect how to build this source — add a Dockerfile or pick an image');
      builder = d.stack;
      log(`▸ No Dockerfile found — detected ${d.stack}`);
      dockerfile = join(workDir, '.servify.Dockerfile');
      writeFileSync(dockerfile, d.dockerfile);
      if (!existsSync(join(ctx, '.dockerignore'))) writeFileSync(`${dockerfile}.dockerignore`, DEFAULT_IGNORE);
      for (const l of d.dockerfile.split('\n')) if (l.trim()) log(`  │ ${l}`);
      if (d.port && !svc.port && !dep.config.port) dep.port = d.port;
    } else {
      log(`▸ Using ${relative(ctx, dockerfile) || 'Dockerfile'}`);
    }
    const tag = imageTag(project, svc, dep);
    const labels = { 'servify.managed': 'true', 'servify.instance': INSTANCE_ID, 'servify.service': svc.id, 'servify.deployment': dep.id };
    log(`▸ Building image ${tag}`);
    const t0 = Date.now();
    const usedCli = await cliBuild(ctx, dockerfile, tag, labels, log);
    if (!usedCli) await apiBuild(ctx, dockerfile, tag, labels, log);
    log(`✓ Built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return { image: tag, commitSha, commitMessage, builder: usedCli ? `${builder} · buildkit` : builder };
  } finally {
    if (cleanup) rmSync(workDir, { recursive: true, force: true });
    else rmSync(workDir, { recursive: true, force: true });
  }
}
