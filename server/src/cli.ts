/**
 * The `servify` command line for your own machine: talk to a Servify (here or on a server) with an API token.
 *
 *   servify login [url]          save the URL and a token (Servify → Agents → API tokens, or `servify token`)
 *   servify link [project] [service]   remember which project/service this folder deploys to
 *   servify up [--service name] [--detach] [--replace]   upload this folder, build and deploy it, follow the build
 *   servify deploy               redeploy the linked service
 *   servify logs [-f] [--build] [--tail n]   runtime logs (or the latest build log)
 *   servify run <command…>       run a command here with the service's variables
 *   servify exec <command…>      run a command inside the running service
 *   servify status               the linked project's services
 *   servify open                 open the service's URL
 *
 * SERVIFY_URL, SERVIFY_TOKEN, SERVIFY_PROJECT and SERVIFY_SERVICE override the saved settings (CI).
 */
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { gzipSync } from 'node:zlib';
import { tarEnd, tarEntry } from './tar.ts';

type Link = { projectId: string; projectName: string; serviceId?: string; serviceName?: string };
type Config = { url?: string; token?: string; links?: Record<string, Link> };

const CONFIG = join(process.env.SERVIFY_CLI_HOME ?? join(homedir(), '.servify'), 'cli.json');
const c = {
  dim: (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s),
};

class CliError extends Error {}
const fail = (msg: string): never => {
  throw new CliError(msg);
};

function readConfig(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG, 'utf8'));
  } catch {
    return {};
  }
}
function writeConfig(cfg: Config) {
  mkdirSync(join(CONFIG, '..'), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  chmodSync(CONFIG, 0o600);
}

function connection() {
  const cfg = readConfig();
  const url = (process.env.SERVIFY_URL ?? cfg.url ?? '').replace(/\/$/, '');
  const token = process.env.SERVIFY_TOKEN ?? cfg.token;
  if (!url || !token) fail('Not logged in — run `servify login` first.');
  return { url, token: token! };
}

async function api<T = any>(method: string, path: string, body?: unknown, init: { raw?: Buffer; headers?: Record<string, string> } = {}): Promise<T> {
  const { url, token } = connection();
  let res: Response;
  try {
    res = await fetch(`${url}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
      body: init.raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch (e) {
    return fail(`Can't reach ${url} (${(e as Error & { cause?: { code?: string } }).cause?.code ?? (e as Error).message}).`);
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (res.status === 401) fail('The token was rejected — run `servify login` again.');
  if (!res.ok) fail(json?.error ?? `${method} ${path} → ${res.status}`);
  return json as T;
}

function ask(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
  if (!process.stdin.isTTY) fail(`${question.trim()} — run interactively, or pass it as an argument / environment variable.`);
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (opts.hidden) {
      const write = (rl as any)._writeToOutput?.bind(rl);
      (rl as any)._writeToOutput = (s: string) => (s.includes(question) ? write?.(s) : write?.(''));
    }
    rl.question(question, (a) => {
      rl.close();
      if (opts.hidden) process.stdout.write('\n');
      done(a.trim());
    });
  });
}

async function choose<T>(title: string, items: T[], label: (t: T) => string): Promise<T> {
  if (!items.length) fail(`No ${title.toLowerCase()} to choose from.`);
  if (items.length === 1) return items[0];
  console.log(c.bold(title));
  items.forEach((t, i) => console.log(`  ${c.dim(String(i + 1).padStart(2))}  ${label(t)}`));
  const a = await ask('Number: ');
  const n = Number(a);
  if (!Number.isInteger(n) || n < 1 || n > items.length) fail('No such choice.');
  return items[n - 1];
}

function flag(args: string[], name: string, short?: string): string | true | undefined {
  const i = args.findIndex((a) => a === `--${name}` || (short && a === `-${short}`) || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const a = args[i];
  args.splice(i, 1);
  if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
  const next = args[i];
  if (next !== undefined && !next.startsWith('-')) {
    args.splice(i, 1);
    return next;
  }
  return true;
}
const str = (v: string | true | undefined) => (typeof v === 'string' ? v : undefined);

// ─── project / service resolution ───

async function findProject(ref: string) {
  const list = await api<any[]>('GET', '/projects');
  return list.find((p) => p.id === ref || p.slug === ref || p.name === ref) ?? fail(`No project "${ref}".`);
}

function linkFor(dir = process.cwd()): Link | null {
  const links = readConfig().links ?? {};
  // The folder or the nearest parent that was linked.
  for (let d = resolve(dir); ; d = resolve(d, '..')) {
    if (links[d]) return links[d];
    if (d === resolve(d, '..')) return null;
  }
}

async function target(args: string[], opts: { needService?: boolean } = { needService: true }) {
  const svcArg = str(flag(args, 'service', 's')) ?? process.env.SERVIFY_SERVICE;
  const projArg = str(flag(args, 'project', 'p')) ?? process.env.SERVIFY_PROJECT;
  const link = linkFor();
  const projectRef = projArg ?? link?.projectId;
  if (!projectRef) fail('No project linked to this folder — run `servify link` (or pass --project).');
  const snap = await api<any>('GET', `/projects/${encodeURIComponent(projectRef!)}`);
  const services: any[] = snap.services;
  const ref = svcArg ?? (projArg ? undefined : link?.serviceId);
  const service = ref ? services.find((s) => s.id === ref || s.slug === ref || s.name === ref) : null;
  if (opts.needService && !service) fail(ref ? `No service "${ref}" in ${snap.project.name}.` : 'No service linked — run `servify link` or pass --service.');
  return { project: snap.project, services, service, serviceRef: ref };
}

// ─── following a deployment ───

async function* sse(path: string): AsyncGenerator<{ event: string; data: string }> {
  const { url, token } = connection();
  const res = await fetch(`${url}/api${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' } });
  if (!res.ok || !res.body) fail(`${path} → ${res.status}`);
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      yield { event, data: data.join('\n') };
    }
  }
}

const TERMINAL = (s: string) => !['queued', 'building', 'deploying'].includes(s);

async function follow(deploymentId: string): Promise<boolean> {
  let status = (await api<any>('GET', `/deployments/${deploymentId}`)).status as string;
  const print = (l: { text: string }) => console.log(c.dim('│ ') + l.text);
  if (!TERMINAL(status)) {
    const ctrl = new AbortController();
    const stream = sse(`/deployments/${deploymentId}/logs/stream`);
    // The status can change between the GET and the stream opening; poll as a backstop.
    const poll = setInterval(async () => {
      const d = await api<any>('GET', `/deployments/${deploymentId}`).catch(() => null);
      if (d && TERMINAL(d.status)) {
        status = d.status;
        ctrl.abort();
        void stream.return(undefined);
      }
    }, 3000);
    try {
      for await (const ev of stream) {
        if (ev.event === 'backlog') for (const l of JSON.parse(ev.data)) print(l);
        else if (ev.event === 'line') print(JSON.parse(ev.data));
        else if (ev.event === 'status' && TERMINAL(ev.data)) {
          status = ev.data;
          break;
        }
      }
    } catch {
      /* stream closed */
    } finally {
      clearInterval(poll);
    }
    if (!TERMINAL(status)) status = (await api<any>('GET', `/deployments/${deploymentId}`)).status;
  } else for (const l of await api<any[]>('GET', `/deployments/${deploymentId}/logs`)) print(l);
  const d = await api<any>('GET', `/deployments/${deploymentId}`);
  if (d.status === 'active') console.log(c.green('✓ Deployed') + c.dim(` (${d.sourceLabel})`));
  else console.log(c.red(`✗ ${d.status}`) + (d.error ? ` — ${d.error}` : ''));
  return d.status === 'active';
}

// ─── packing a folder ───

const ALWAYS_SKIP = new Set(['.git', 'node_modules', '.DS_Store', '.servify']);

function filesToUpload(root: string): string[] {
  const git = spawnSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (git.status === 0) {
    return git.stdout
      .split('\0')
      .filter(Boolean)
      .filter((f) => !f.split('/').some((p) => ALWAYS_SKIP.has(p)))
      .filter((f) => {
        try {
          return lstatSync(join(root, f)).isFile();
        } catch {
          return false; // deleted but still in the index
        }
      });
  }
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (ALWAYS_SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(root, p));
    }
  };
  walk(root);
  return out;
}

function pack(root: string) {
  const files = filesToUpload(root);
  if (!files.length) fail('Nothing to upload in this folder.');
  const parts: Buffer[] = [];
  let bytes = 0;
  for (const f of files) {
    const p = join(root, f);
    const st = statSync(p);
    bytes += st.size;
    if (bytes > 1024 ** 3) fail('This folder is over 1 GB — add a .gitignore (or .dockerignore) for build output and dependencies.');
    parts.push(...tarEntry(f.split('\\').join('/'), readFileSync(p), st.mode & 0o111 ? 0o755 : 0o644, st.mtimeMs));
  }
  parts.push(tarEnd());
  return { files: files.length, bytes, tgz: gzipSync(Buffer.concat(parts)) };
}

function gitInfo(root: string) {
  const r = spawnSync('git', ['-C', root, 'log', '-1', '--format=%H%n%s'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const [sha, message] = r.stdout.trim().split('\n');
  const dirty = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim().length > 0;
  return { sha, message, dirty };
}

const size = (n: number) => (n > 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// ─── commands ───

async function login(args: string[]) {
  const cfg = readConfig();
  const url = (args[0] ?? process.env.SERVIFY_URL ?? (await ask(`Servify URL ${c.dim(`(${cfg.url ?? 'http://localhost:7700'})`)}: `)) ?? '') || cfg.url || 'http://localhost:7700';
  const token = str(flag(args, 'token')) ?? process.env.SERVIFY_TOKEN ?? (await ask('API token (Servify → Agents → API tokens): ', { hidden: true }));
  if (!/^svf_/.test(token)) fail('That does not look like a Servify token (they start with svf_).');
  process.env.SERVIFY_URL = url.replace(/\/$/, '');
  process.env.SERVIFY_TOKEN = token;
  const projects = await api<any[]>('GET', '/projects');
  writeConfig({ ...cfg, url: url.replace(/\/$/, ''), token });
  console.log(`${c.green('✓')} Logged in to ${url} — ${projects.length} project${projects.length === 1 ? '' : 's'}. Saved to ${CONFIG}.`);
}

async function link(args: string[]) {
  const projects = (await api<any[]>('GET', '/projects')).filter((p) => !p.parentId);
  const project = args[0] ? await findProject(args[0]) : await choose('Project', projects, (p) => p.name);
  const snap = await api<any>('GET', `/projects/${project.id}`);
  const buildable = snap.services.filter((s: any) => !['external', 'redirect'].includes(s.source.type));
  const service = args[1] ? (snap.services.find((s: any) => s.name === args[1] || s.slug === args[1] || s.id === args[1]) ?? fail(`No service "${args[1]}" in ${project.name}.`)) : buildable.length ? await choose('Service', buildable, (s: any) => `${s.name} ${c.dim(s.source.type)}`) : null;
  const cfg = readConfig();
  cfg.links = { ...(cfg.links ?? {}), [process.cwd()]: { projectId: project.id, projectName: project.name, serviceId: service?.id, serviceName: service?.name } };
  writeConfig(cfg);
  console.log(`${c.green('✓')} ${process.cwd()} → ${project.name}${service ? ` / ${service.name}` : ''}`);
}

async function up(args: string[]) {
  const detach = !!flag(args, 'detach', 'd');
  const replace = !!flag(args, 'replace');
  const t = await target(args, { needService: false });
  let service = t.service;
  if (!service) {
    if (!t.serviceRef) fail('Which service? Pass --service <name> (a new name creates the service).');
    service = (await api<any>('POST', `/projects/${t.project.id}/services`, { name: t.serviceRef, upload: true, deploy: false })).service;
    console.log(`${c.green('+')} Created ${service.name} in ${t.project.name}`);
  }
  if (service.source.type !== 'upload' && !replace) {
    // A wrong --service name must not rebuild a database (or anything else) from this folder.
    const from = service.source.type === 'git' ? service.source.repo : service.source.type === 'image' ? service.source.image : service.source.type === 'local' ? service.source.path : service.source.type;
    const msg = `${service.name} runs ${from} today; uploading replaces that source.`;
    if (!process.stdin.isTTY) fail(`${msg} Pass --replace if that's what you want.`);
    const a = await ask(`${msg} Continue? [y/N] `);
    if (!/^y(es)?$/i.test(a)) fail('Nothing uploaded.');
  }
  const root = process.cwd();
  const g = gitInfo(root);
  process.stdout.write(c.dim('Packing… '));
  const p = pack(root);
  console.log(c.dim(`${p.files.toLocaleString()} files, ${size(p.bytes)} → ${size(p.tgz.length)}`));
  const label = `${basename(root)}${g ? ` @ ${g.sha.slice(0, 7)}${g.dirty ? '+changes' : ''}` : ''}`;
  const r = await api<any>('POST', `/services/${service.id}/upload`, undefined, {
    raw: p.tgz,
    headers: { 'content-type': 'application/gzip', 'x-servify-label': encodeURIComponent(label), ...(g ? { 'x-servify-commit': g.sha, 'x-servify-message': encodeURIComponent(g.message ?? '') } : {}) },
  });
  if (r.skipped?.length) console.log(c.dim(`Skipped (links or unsafe paths): ${r.skipped.join(', ')}`));
  console.log(`${c.green('↑')} Uploaded to ${t.project.name} / ${service.name}`);
  if (!r.deployment) return;
  if (detach) return console.log(c.dim(`Building — follow with \`servify logs --build\`.`));
  if (!(await follow(r.deployment.id))) process.exitCode = 1;
}

async function deploy(args: string[]) {
  const detach = !!flag(args, 'detach', 'd');
  const { service } = await target(args);
  const dep = await api<any>('POST', `/services/${service.id}/deploy`);
  console.log(`Deploying ${service.name}…`);
  if (!detach && !(await follow(dep.id))) process.exitCode = 1;
}

async function logs(args: string[]) {
  const followLogs = !!flag(args, 'follow', 'f');
  const build = !!flag(args, 'build', 'b');
  const tail = Number(str(flag(args, 'tail', 'n')) ?? 200);
  const { service } = await target(args);
  if (build) {
    const [latest] = await api<any[]>('GET', `/services/${service.id}/deployments?limit=1`);
    if (!latest) fail(`${service.name} hasn't been deployed yet.`);
    if (!(await follow(latest.id))) process.exitCode = 1;
    return;
  }
  const line = (l: any) => console.log(`${c.dim(new Date(l.ts).toISOString().slice(11, 19))} ${l.stream === 'stderr' ? c.red(l.text) : l.text}`);
  if (!followLogs) {
    const r = await api<any>('GET', `/services/${service.id}/logs?tail=${tail}`);
    for (const l of Array.isArray(r) ? r : (r.lines ?? [])) line(l);
    return;
  }
  for await (const ev of sse(`/services/${service.id}/logs/stream?tail=${tail}`)) {
    if (ev.event === 'backlog') {
      const r = JSON.parse(ev.data);
      for (const l of Array.isArray(r) ? r : (r.lines ?? [])) line(l);
    } else if (ev.event === 'lines') for (const l of JSON.parse(ev.data)) line(l);
  }
}

async function run(args: string[]) {
  const { service } = await target(args);
  if (args[0] === '--') args.shift();
  if (!args.length) fail('usage: servify run <command…>');
  const r = await api<{ env: Record<string, string>; unresolved: string[] }>('GET', `/services/${service.id}/variables/resolved`);
  if (r.unresolved.length) console.error(c.dim(`unresolved: ${r.unresolved.join(', ')}`));
  const child = spawn(args[0], args.slice(1), { stdio: 'inherit', env: { ...process.env, ...r.env }, shell: process.platform === 'win32' });
  child.on('exit', (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
}

async function exec(args: string[]) {
  const { service } = await target(args);
  if (args[0] === '--') args.shift();
  if (!args.length) fail('usage: servify exec <command…>');
  const r = await api<{ exitCode: number; output: string }>('POST', `/services/${service.id}/exec`, { command: args.join(' ') });
  if (r.output) console.log(r.output);
  process.exitCode = r.exitCode;
}

async function status(args: string[]) {
  const t = await target(args, { needService: false });
  console.log(c.bold(t.project.name));
  for (const s of t.services) {
    const mark = s.id === t.service?.id ? '›' : ' ';
    const st = s.status === 'running' ? c.green(s.status) : s.status === 'crashed' || s.status === 'failed' ? c.red(s.status) : c.dim(s.status);
    console.log(`${mark} ${s.name.padEnd(24)} ${st.padEnd(process.stdout.isTTY ? 18 : 9)} ${c.dim(s.url ?? s.tcpAddress ?? '')}`);
  }
}

async function open(args: string[]) {
  const { service } = await target(args);
  const url = service.domainInfo?.[0]?.url ?? service.url;
  if (!url) fail(`${service.name} has no public URL.`);
  console.log(url);
  spawn(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
}

export const CLIENT_COMMANDS = ['login', 'logout', 'link', 'unlink', 'up', 'deploy', 'logs', 'run', 'exec', 'status', 'open'];

export async function main(cmd: string, args: string[]) {
  try {
    if (cmd === 'login') await login(args);
    else if (cmd === 'logout') {
      const cfg = readConfig();
      delete cfg.token;
      writeConfig(cfg);
      console.log('Logged out.');
    } else if (cmd === 'link') await link(args);
    else if (cmd === 'unlink') {
      const cfg = readConfig();
      delete cfg.links?.[process.cwd()];
      writeConfig(cfg);
      console.log('Unlinked.');
    } else if (cmd === 'up') await up(args);
    else if (cmd === 'deploy') await deploy(args);
    else if (cmd === 'logs') await logs(args);
    else if (cmd === 'run') await run(args);
    else if (cmd === 'exec') await exec(args);
    else if (cmd === 'status') await status(args);
    else if (cmd === 'open') await open(args);
  } catch (e) {
    if (e instanceof CliError) {
      console.error(c.red('✗ ') + e.message);
      process.exit(1);
    }
    throw e;
  }
}

