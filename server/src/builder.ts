import { spawn } from 'node:child_process';
import { uploadPath } from './uploads.ts';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import type { DockerClient } from './docker.ts';
import { dockerFor, nodeOf, LOCAL } from './nodes.ts';
import { config } from './config.ts';
import { detect, DEFAULT_IGNORE } from './detect.ts';
import type { Deployment, Project, Service } from './types.ts';
import { INSTANCE_ID } from './engine.ts';
import { baseImageOf, fromDigestsInLog, type BaseImage } from './baseimage.ts';
import { pull, pullProblem } from './deployer.ts';
import { parseRepo, sameRepo } from './imageupdates.ts';
import { normalizeImageRef } from './docker.ts';

type Log = (line: string) => void;

export type BuildResult = { image: string; commitSha: string | null; commitMessage: string | null; builder: string; baseImage: NonNullable<Deployment['baseImage']> | null };

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

function authedUrl(repo: string, token?: string, user?: string): string {
  let url = repo.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`; // owner/repo shorthand
  if (!token) return url;
  try {
    const u = new URL(url);
    // http too when the credentials came out of an http:// URL (a git server on the home network).
    if (u.protocol === 'https:' || (u.protocol === 'http:' && user !== undefined)) {
      // '' = the token was written as the user name (https://token@host/repo): sent the same way.
      u.username = user === '' ? token : user || 'x-access-token';
      u.password = user === '' ? '' : token;
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

export async function latestCommit(repo: string, branch: string | undefined, token?: string, user?: string): Promise<string | null> {
  // `--`: a repository that starts with a dash must never be read as a git option (--upload-pack=… runs a command).
  const r = await run('git', ['ls-remote', '--', authedUrl(repo, token, user), branch ? `refs/heads/${branch}` : 'HEAD'], {
    env: { GIT_TERMINAL_PROMPT: '0' },
  }).catch(() => null);
  if (!r || r.code !== 0) return null;
  return r.out.trim().split(/\s+/)[0] || null;
}

/** The deployment's own image name: built images get it, pulled images are tagged with it (exact rollbacks). */
export function imageTag(project: Project, svc: Service, dep: Deployment) {
  return `servify/${project.slug}-${svc.slug}:${dep.id.slice(-8)}`.toLowerCase();
}

let cliBuildAvailable: boolean | null = null;

/** `pull`: fetch the base images again (`--pull`); `fromLines` collects BuildKit's `FROM ref@digest` lines. */
type BuildOpts = { args: Record<string, string>; target: string | null; pull: boolean; fromLines: string[] };

/** The service's build arguments with ${VAR} filled in from its own variables. */
function buildArgsFor(svc: Service): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(svc.buildArgs ?? {})) out[k] = String(v).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => svc.env[name] ?? '');
  return out;
}

async function cliBuild(d: DockerClient, ctx: string, dockerfile: string, tag: string, labels: Record<string, string>, log: Log, opts: BuildOpts): Promise<boolean> {
  if (cliBuildAvailable === false) return false;
  const args = ['build', '--progress=plain', '-t', tag, '-f', dockerfile];
  for (const [k, v] of Object.entries(labels)) args.push('--label', `${k}=${v}`);
  for (const [k, v] of Object.entries(opts.args)) args.push('--build-arg', `${k}=${v}`);
  if (opts.target) args.push('--target', opts.target);
  if (opts.pull) args.push('--pull');
  args.push(ctx);
  let missingBuildx = false;
  const r = await run('docker', args, {
    env: { DOCKER_HOST: d.hostEnv, DOCKER_BUILDKIT: '1', BUILDKIT_PROGRESS: 'plain' },
    onLine: (l) => {
      if (/buildx component is missing|unknown flag: --progress|docker: not found/i.test(l)) missingBuildx = true;
      if (/^#\d+ \[[^\]]*\] FROM /.test(l)) opts.fromLines.push(l);
      // Drop BuildKit's per-chunk download/extract progress; keep the "done" lines.
      if (/^#\d+ (sha256:[0-9a-f]+|extracting sha256:[0-9a-f]+) /.test(l) && !/ done$/.test(l)) return;
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

async function apiBuild(d: DockerClient, ctx: string, dockerfile: string, tag: string, labels: Record<string, string>, log: Log, opts: BuildOpts) {
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
  await d.buildFromTar(tar.stdout, tag, dfName, log, labels, { args: opts.args, target: opts.target, pull: opts.pull });
}

/**
 * The registry image the build started from and the digest it used, for update checks. BuildKit logs the digest it
 * resolved (`FROM ref@sha256:…`) — that is what the build really used, even after `--pull`, which leaves the local
 * tag alone. The classic builder logs none; it builds from the local tag, so that tag's registry digest is it.
 */
async function recordBaseImage(d: DockerClient, base: BaseImage | null, opts: BuildOpts, log: Log): Promise<BuildResult['baseImage']> {
  const r = base && parseRepo(base.ref);
  if (!base || !r) return null;
  const same = (ref: string) => {
    const x = parseRepo(ref);
    return !!x && x.registry === r.registry && x.repo === r.repo && x.tag === r.tag;
  };
  let digests = [...fromDigestsInLog(opts.fromLines)].filter(([ref]) => same(ref)).flatMap(([, ds]) => ds);
  if (!digests.length) {
    const info = await d.inspectImage(base.ref).catch(() => null);
    digests = ((info?.RepoDigests as string[] | undefined) ?? []).filter((x) => sameRepo(x.split('@')[0], r)).map((x) => x.split('@')[1]);
  }
  const ref = normalizeImageRef(base.ref);
  log(`▸ Base image ${ref}${digests.length ? ` (${digests[0].slice(7, 19)})` : ''}`);
  return { ref, tagArg: base.tagArg, digests };
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
    args.push('--', authedUrl(url, src.token, src.user), repoDir); // `--`: see latestCommit
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
    // Last commit that touched this folder (it may live inside a larger repository).
    const g = await run('git', ['-C', repoDir, 'log', '-1', '--format=%H%n%s', '--', '.']).catch(() => null);
    if (g && g.code === 0) [commitSha, commitMessage] = g.out.trim().split('\n');
  } else if (src.type === 'upload') {
    if (!src.uploadId) throw new Error('nothing uploaded yet — run `servify up` in your project folder');
    repoDir = uploadPath(svc.id, src.uploadId);
    if (!existsSync(repoDir)) throw new Error('the uploaded files are gone — run `servify up` again');
    mkdirSync(workDir, { recursive: true });
    log(`▸ Building the upload from ${src.uploadedAt ? new Date(src.uploadedAt).toISOString().replace('T', ' ').slice(0, 16) : 'earlier'} (${src.files.toLocaleString()} files${src.label ? `, ${src.label}` : ''})`);
    commitSha = src.commitSha ?? null;
    commitMessage = src.commitMessage ?? null;
  } else {
    throw new Error('image sources are not built');
  }

  try {
    const ctx = resolve(repoDir, (src as { rootDir?: string }).rootDir ?? '.');
    if (!existsSync(ctx)) throw new Error(`root directory not found in source: ${(src as any).rootDir}`);
    let dockerfile = src.dockerfile ? resolve(ctx, src.dockerfile) : join(ctx, 'Dockerfile');
    // A clone or an upload is built from its own files only: "../.." (or a symlink in the repository) must not turn
    // a folder of this machine into the build context or the Dockerfile.
    if (src.type !== 'local') {
      const root = realpathSync(repoDir);
      const within = (p: string) => {
        const real = realpathSync(p);
        return real === root || real.startsWith(root + sep);
      };
      if (!within(ctx)) throw new Error(`root directory is outside the source: ${(src as any).rootDir}`);
      if (existsSync(dockerfile) && !within(dockerfile)) throw new Error(`Dockerfile is outside the source: ${src.dockerfile}`);
    }
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
    // Builds run on the service's server (the context is streamed to its Docker).
    const d = dockerFor(nodeOf(svc));
    // An update rebuilds on a freshly pulled base image (a plain build reuses the copy already on the server).
    const opts: BuildOpts = { args: buildArgsFor(svc), target: svc.buildTarget ?? null, pull: dep.trigger === 'update', fromLines: [] };
    if (Object.keys(opts.args).length) log(`▸ Build arguments: ${Object.keys(opts.args).join(', ')}`);
    if (opts.target) log(`▸ Build target: ${opts.target}`);
    // Generated Dockerfiles pick their own base, which the user can't change: only their own Dockerfiles are checked.
    const base = builder === 'dockerfile' ? baseImageOf(readFileSync(dockerfile, 'utf8'), opts.args, opts.target) : null;
    if (opts.pull && base && parseRepo(base.ref)) {
      // Into the server's image store, not just BuildKit's cache: later plain builds use the local copy of the base,
      // and must not fall back to the old one. A failed pull fails the update, as for image services.
      log(`▸ Pulling ${base.ref} (update)`);
      const raw = await pull(d, base.ref, log, nodeOf(svc) === LOCAL);
      if (raw) throw new Error(`pull failed: ${pullProblem(raw, base.ref)}`);
    } else if (opts.pull) log('▸ Pulling the base images again (update)');
    const usedCli = await cliBuild(d, ctx, dockerfile, tag, labels, log, opts);
    if (!usedCli) await apiBuild(d, ctx, dockerfile, tag, labels, log, opts);
    log(`✓ Built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const baseImage = await recordBaseImage(d, base, opts, log);
    return { image: tag, commitSha, commitMessage, builder: usedCli ? `${builder} · buildkit` : builder, baseImage };
  } finally {
    if (cleanup) rmSync(workDir, { recursive: true, force: true });
    else rmSync(workDir, { recursive: true, force: true });
  }
}
