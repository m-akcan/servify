/**
 * The `servify` command line for your own machine: talk to a Servify (here or on a server) with an API token.
 *
 *   servify login [url]          save the URL and a token (Servify → Agents → API tokens, or `servify token`)
 *   servify link [project] [service]   remember which project/service this folder deploys to
 *   servify up [--service name] [--detach] [--replace]   upload this folder, build and deploy it, follow the build
 *   servify deploy [--tag t] [--skip-safety-backup]   redeploy the linked service; --tag: switch an image service to
 *                                that tag of its image first (CI: deploy what you just pushed; a deploy token is enough)
 *   servify restart [--skip-safety-backup]   restart the linked service (the running image)
 *   servify rollback [deployment] [--skip-safety-backup]   back to the previous live image (or that deployment)
 *   servify deployments [--limit n]   recent deployments of the service (ids for rollback)
 *   servify logs [-f] [--build] [--tail n]   runtime logs (or the latest build log)
 *   servify variables [list|get|set|unset] …   the service's (or with --shared, the project's) variables
 *   servify backup [create|list|test|download] …   back up the service now, list, test or download backups
 *   servify restore <backup id> [--yes]   replace the service's data with a backup
 *   servify run <command…>       run a command here with the service's variables
 *   servify exec [--] <command…> run a command inside the running service (exit code passed on)
 *   servify status               the linked project's services
 *   servify open                 open the service's URL
 *
 * `servify help <command>` or `servify <command> --help` shows the details (USAGE below).
 * SERVIFY_URL, SERVIFY_TOKEN, SERVIFY_PROJECT and SERVIFY_SERVICE override the saved settings (CI).
 */
import { chmodSync, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
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
  // Only before a `--`: what follows belongs to the command being run (`servify run -- node -p 1`).
  const end = args.indexOf('--');
  const i = args.findIndex((a, at) => (end < 0 || at < end) && (a === `--${name}` || (short && a === `-${short}`) || a.startsWith(`--${name}=`)));
  if (i < 0) return undefined;
  const a = args[i];
  args.splice(i, 1);
  if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
  const next = args[i];
  if (next !== undefined && (!next.startsWith('-') || next === '-')) {
    args.splice(i, 1);
    return next;
  }
  return true;
}
const str = (v: string | true | undefined) => (typeof v === 'string' ? v : undefined);
/** A flag that takes no value: unlike flag(), never swallows the argument after it (`restore --yes bak_1`). */
function bool(args: string[], name: string, short?: string): boolean {
  let found = false;
  for (let at = 0; at < args.length; at++) {
    const a = args[at];
    if (a === '--') break;
    if (a === `--${name}` || (short && a === `-${short}`)) {
      args.splice(at--, 1);
      found = true;
    }
  }
  return found;
}
/** A flag that needs a value. */
function valueFlag(args: string[], name: string, short?: string): string | undefined {
  const v = flag(args, name, short);
  if (v === true) fail(`--${name} needs a value.`);
  return str(v);
}

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

const size = (n: number) => (n > 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n > 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
/** padEnd by what shows on screen (colour codes take no room). */
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.replace(/\x1b\[[0-9;]*m/g, '').length));

// ─── commands ───

async function login(args: string[]) {
  const cfg = readConfig();
  const givenToken = str(flag(args, 'token')); // first, so `login --token svf_…` doesn't take the flag for the URL
  const url = (args[0] ?? process.env.SERVIFY_URL ?? (await ask(`Servify URL ${c.dim(`(${cfg.url ?? 'http://localhost:7700'})`)}: `)) ?? '') || cfg.url || 'http://localhost:7700';
  const token = givenToken ?? process.env.SERVIFY_TOKEN ?? (await ask('API token (Servify → Agents → API tokens): ', { hidden: true }));
  if (!/^sv[fs]_/.test(token)) fail('That does not look like a Servify token (they start with svf_ or svs_).');
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
  const skipSafetyBackup = !!flag(args, 'skip-safety-backup');
  const tagFlag = flag(args, 'tag', 't');
  if (tagFlag === true) fail('--tag needs a value, e.g. --tag 1.4.2');
  const { service } = await target(args);
  const tag = str(tagFlag);
  if (tag && service.source.type !== 'image') fail(`${service.name} doesn't run a registry image, so there is no tag to switch to.`);
  const extra = skipSafetyBackup ? { skipSafetyBackup: true } : {};
  // A tag: switch the image service to it and deploy (the image's repository stays). Otherwise redeploy as it is.
  const dep = tag
    ? await api<any>('POST', `/services/${service.id}/update-image`, { tag, ...extra })
    : await api<any>('POST', `/services/${service.id}/deploy`, skipSafetyBackup ? extra : undefined);
  console.log(tag ? `Deploying ${service.name} with tag ${tag}…` : `Deploying ${service.name}…`);
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
  const replica = valueFlag(args, 'replica');
  const { service } = await target(args);
  if (args[0] === '--') args.shift();
  if (!args.length) fail(`usage: ${USAGE.exec.split('\n')[0]}`);
  // Several words are the argv, passed as they are (no shell on the other side re-splits them). One word with
  // shell syntax in it (`servify exec 'ls | wc -l'`) runs through /bin/sh -c, as it always did.
  const command = args.length === 1 && /[\s'"`$&|;<>(){}*?\\[\]~#!]/.test(args[0]) ? args[0] : args;
  if (replica !== undefined && !/^\d+$/.test(replica)) fail('--replica takes a replica number (0, 1, …).');
  const r = await api<{ exitCode: number; output: string }>('POST', `/services/${service.id}/exec`, { command, ...(replica !== undefined ? { replica: Number(replica) } : {}) });
  if (r.output) console.log(r.output);
  process.exitCode = r.exitCode < 0 ? 1 : r.exitCode;
}

async function status(args: string[]) {
  const t = await target(args, { needService: false });
  console.log(c.bold(t.project.name));
  for (const s of t.services) {
    const mark = s.id === t.service?.id ? '›' : ' ';
    const st = s.status === 'running' ? c.green(s.status) : s.status === 'crashed' || s.status === 'failed' ? c.red(s.status) : c.dim(s.status);
    console.log(`${mark} ${s.name.padEnd(24)} ${st.padEnd(process.stdout.isTTY ? 18 : 9)} ${c.dim(s.url ?? s.tcpAddress ?? '')}`);
  }
  // Low disk space protection (instance-wide: tokens limited to some projects can't see it, and that's fine).
  const disk = (await api<any>('GET', '/system').catch(() => null))?.disk;
  if (disk && disk.level === 'protect') {
    const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
    const low = (disk.disks as any[]).filter((d) => d.level === 'protect').map((d) => `${d.name} ${gb(d.freeBytes)} free (protect below ${gb(d.protectBytes)})`);
    console.log(c.red(`\n! Low disk space: ${low.join('; ')}. Refused: ${disk.refused.join('; ')}.`));
  }
}

async function open(args: string[]) {
  const { service } = await target(args);
  const url = service.domainInfo?.[0]?.url ?? service.url;
  if (!url) fail(`${service.name} has no public URL.`);
  console.log(url);
  spawn(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
}

async function restart(args: string[]) {
  const detach = bool(args, 'detach', 'd');
  const skipSafetyBackup = bool(args, 'skip-safety-backup');
  const { service } = await target(args);
  const dep = await api<any>('POST', `/services/${service.id}/restart`, skipSafetyBackup ? { skipSafetyBackup: true } : {});
  console.log(`Restarting ${service.name}…`);
  if (!detach && !(await follow(dep.id))) process.exitCode = 1;
}

const when = (ts: number | null | undefined) => {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

async function deployments(args: string[]) {
  const limit = Number(valueFlag(args, 'limit', 'n') ?? 15);
  const { service } = await target(args);
  const list = await api<any[]>('GET', `/services/${service.id}/deployments?limit=${Math.max(1, Math.min(100, limit || 15))}`);
  if (!list.length) return console.log(c.dim(`${service.name} hasn't been deployed yet.`));
  for (const d of list) {
    const st = d.status === 'active' ? c.green(d.status) : d.status === 'failed' ? c.red(d.status) : c.dim(d.status);
    console.log(`${d.id}  ${when(d.createdAt)}  ${pad(st, 10)} ${pad(d.trigger ?? '', 8)} ${c.dim(d.sourceLabel ?? d.image ?? '')}`);
  }
}

async function rollback(args: string[]) {
  const detach = bool(args, 'detach', 'd');
  const skipSafetyBackup = bool(args, 'skip-safety-backup');
  const { service } = await target(args);
  const [ref] = args.filter((a) => a !== '--');
  const list = await api<any[]>('GET', `/services/${service.id}/deployments?limit=100`);
  const active = list.find((d) => d.id === service.activeDeploymentId) ?? null;
  let to: any;
  if (ref) {
    const hits = list.filter((d) => d.id === ref || d.id.startsWith(ref));
    to = hits.find((d) => d.id === ref) ?? (hits.length === 1 ? hits[0] : null);
    if (!to) fail(hits.length > 1 ? `"${ref}" matches ${hits.length} deployments — give more of the id.` : `No deployment "${ref}" of ${service.name} (\`servify deployments\` lists them).`);
    if (to.id === active?.id) fail(`${to.id} is what ${service.name} runs now.`);
  } else {
    // The newest earlier deployment that was live (superseded) and runs a different image than today.
    to = list.find((d) => d.id !== active?.id && d.status === 'superseded' && d.image && d.image !== active?.image && (!active || d.createdAt < active.createdAt));
    if (!to) fail(`${service.name} has no earlier live deployment with a different image to roll back to (\`servify deployments\` lists them).`);
  }
  const dep = await api<any>('POST', `/services/${service.id}/rollback`, { deploymentId: to.id, ...(skipSafetyBackup ? { skipSafetyBackup: true } : {}) });
  console.log(`Rolling ${service.name} back to ${to.id} ${c.dim(`(${to.sourceLabel ?? to.image}, deployed ${when(to.createdAt)})`)}…`);
  if (!detach && !(await follow(dep.id))) process.exitCode = 1;
}

// ─── variables ───

const MASK = '••••••••';
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function readStdin(): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of process.stdin) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts).toString('utf8');
}

/** A .env file: KEY=value lines, `export` prefixes, # comments, '…' (literal) and "…" (escapes, may span lines) values. */
export function parseDotenv(text: string, from = '.env'): Record<string, string> {
  const out: Record<string, string> = {};
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const nl = src.indexOf('\n', i);
    const end = nl < 0 ? src.length : nl;
    const raw = src.slice(i, end);
    const here = line;
    i = end + 1;
    line++;
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(t);
    if (!m) fail(`${from}:${here}: expected NAME=value`);
    const [, key, rest] = m!;
    let val: string;
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const q = rest[0];
      // The value may continue on the next lines (double quotes only): find the closing quote in the whole text.
      let body = rest.slice(1);
      let close = -1;
      for (;;) {
        for (let k = 0; k < body.length; k++) {
          if (q === '"' && body[k] === '\\') {
            k++;
            continue;
          }
          if (body[k] === q) {
            close = k;
            break;
          }
        }
        if (close >= 0 || q === "'" || i > src.length) break;
        const n2 = src.indexOf('\n', i);
        const e2 = n2 < 0 ? src.length : n2;
        body += '\n' + src.slice(i, e2);
        i = e2 + 1;
        line++;
      }
      if (close < 0) fail(`${from}:${here}: unterminated ${q === '"' ? 'double' : 'single'} quote in ${key}`);
      const after = body.slice(close + 1).trim();
      if (after && !after.startsWith('#')) fail(`${from}:${here}: unexpected text after the quoted value of ${key}`);
      val = body.slice(0, close);
      if (q === '"') val = val.replace(/\\(.)/g, (_, ch: string) => (ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch));
    } else {
      val = rest.replace(/\s+#.*$/, '').trim();
    }
    out[key] = val;
  }
  return out;
}

type VarScope = {
  label: string;
  values: Record<string, string>;
  secretKeys: string[];
  /** Writes the changed variables (null: removed) and returns the names of services to redeploy for them to apply. */
  write: (changes: Record<string, string | null>, secretKeys: string[]) => Promise<{ redeploy: { id: string; name: string }[]; note: string | null }>;
};

async function varScope(args: string[]): Promise<VarScope> {
  if (bool(args, 'shared')) {
    const t = await target(args, { needService: false });
    const snap = await api<any>('GET', `/projects/${t.project.id}`);
    const values: Record<string, string> = snap.project.variables ?? {};
    return {
      label: `${t.project.name} (shared)`,
      values,
      secretKeys: snap.project.secretKeys ?? [],
      async write(changes, secretKeys) {
        // The project's map is replaced as a whole: read, change, write (masked values keep what is stored).
        const next: Record<string, string> = { ...values };
        for (const [k, v] of Object.entries(changes)) if (v === null) delete next[k];
        else next[k] = v;
        const r = await api<any>('PATCH', `/projects/${t.project.id}`, { variables: next, secretKeys: secretKeys.filter((k) => k in next) });
        const users: { id: string; name: string }[] = (r.usesShared ?? []).map((s: any) => ({ id: s.id, name: s.name }));
        return { redeploy: users, note: users.length ? `Services that use shared variables pick this up on their next deploy: ${users.map((s) => s.name).join(', ')}.` : null };
      },
    };
  }
  const { service } = await target(args);
  return {
    label: service.name,
    values: service.env ?? {},
    secretKeys: service.secretKeys ?? [],
    async write(changes, secretKeys) {
      const set = Object.fromEntries(Object.entries(changes).filter((e): e is [string, string] => e[1] !== null));
      let svc: any = null;
      if (Object.keys(set).length) svc = await api<any>('PUT', `/services/${service.id}/variables`, { variables: set, secretKeys });
      for (const [k, v] of Object.entries(changes)) if (v === null) svc = await api<any>('DELETE', `/services/${service.id}/variables/${encodeURIComponent(k)}`);
      const pending = !!svc?.activeDeploymentId && (svc.pendingChanges ?? []).includes('variables');
      return { redeploy: svc?.activeDeploymentId ? [{ id: service.id, name: service.name }] : [], note: pending ? `${service.name} runs with the old values until its next deploy.` : null };
    },
  };
}

async function redeployAfter(redeploy: { id: string; name: string }[], note: string | null, deployNow: boolean) {
  if (!deployNow) {
    if (note) console.log(c.dim(`${note} Run \`servify deploy\`${redeploy.length > 1 ? ' for each' : ''}, or pass --deploy next time.`));
    return;
  }
  let ok = true;
  for (const s of redeploy) {
    const dep = await api<any>('POST', `/services/${s.id}/deploy`, {});
    console.log(`Deploying ${s.name}…`);
    if (!(await follow(dep.id))) ok = false;
  }
  if (!ok) process.exitCode = 1;
}

async function variables(args: string[]) {
  const sub = args[0] && !args[0].startsWith('-') ? args.shift()! : 'list';
  if (sub === 'list' || sub === 'ls') {
    const reveal = bool(args, 'reveal');
    const scope = await varScope(args);
    const names = Object.keys(scope.values);
    if (!names.length) return console.log(c.dim(`No variables on ${scope.label}.`));
    let maskedByToken = false;
    for (const k of names) {
      const v = scope.values[k];
      if (reveal && v === MASK && scope.secretKeys.includes(k)) maskedByToken = true;
      const secret = process.stdout.isTTY && scope.secretKeys.includes(k) ? c.dim('  (secret)') : '';
      // A value over several lines is shown quoted, as a .env file would hold it.
      const shown = reveal ? (/[\n\r]/.test(v) ? JSON.stringify(v) : v) : MASK;
      console.log(`${k}=${shown}${secret}`);
    }
    if (maskedByToken) console.error(c.dim('Secret values stay masked for read-only and deploy tokens.'));
    else if (!reveal) console.error(c.dim('Values masked — pass --reveal to show them.'));
    return;
  }
  if (sub === 'get') {
    const scope = await varScope(args);
    const names = args.filter((a) => a !== '--');
    if (names.length !== 1) fail('usage: servify variables get NAME [--shared]');
    const [name] = names;
    if (!(name in scope.values)) fail(`No variable ${name} on ${scope.label}.`);
    const v = scope.values[name];
    if (v === MASK && scope.secretKeys.includes(name)) fail(`${name} is a secret: this token can't read it (needs a write token).`);
    process.stdout.write(v + '\n');
    return;
  }
  if (sub === 'set') {
    const deployNow = bool(args, 'deploy');
    const markSecret = bool(args, 'secret');
    const fromFile = valueFlag(args, 'from-file', 'f');
    const scope = await varScope(args); // takes --service/--project/--shared out of args
    const pairs = args.filter((a) => a !== '--');
    const changes: Record<string, string> = {};
    if (fromFile) Object.assign(changes, parseDotenv(fromFile === '-' ? await readStdin() : readFileSync(resolve(fromFile), 'utf8'), fromFile === '-' ? 'stdin' : fromFile));
    const fromStdin = pairs.filter((p) => !p.includes('='));
    if (fromStdin.length > 1) fail(`Only one value can come from stdin (${fromStdin.join(', ')}): use NAME=value or --from-file for the others.`);
    if (fromStdin.length && fromFile === '-') fail('stdin is already read by --from-file -.');
    for (const p of pairs) {
      const eq = p.indexOf('=');
      const k = eq < 0 ? p : p.slice(0, eq);
      if (!VAR_NAME.test(k)) fail(`Invalid variable name "${k}" (letters, digits and _, not starting with a digit).`);
      if (eq >= 0) changes[k] = p.slice(eq + 1);
    }
    if (fromStdin.length) {
      const [k] = fromStdin;
      changes[k] = process.stdin.isTTY ? await ask(`${k}: `, { hidden: true }) : (await readStdin()).replace(/\r?\n$/, '');
    }
    const names = Object.keys(changes);
    if (!names.length) fail('usage: servify variables set NAME=value… [NAME] [--from-file .env]');
    // New names that look secret are masked for read-only access, like the variables a new service starts with.
    const looksSecret = names.filter((k) => !(k in scope.values) && /SECRET|PASSWORD|TOKEN|KEY/i.test(k));
    const secretKeys = [...new Set([...scope.secretKeys, ...(markSecret ? names : looksSecret)])];
    const r = await scope.write(changes, secretKeys);
    console.log(`${c.green('✓')} Set ${names.join(', ')} on ${scope.label}.`);
    await redeployAfter(r.redeploy, r.note, deployNow);
    return;
  }
  if (sub === 'unset' || sub === 'rm' || sub === 'delete') {
    const deployNow = bool(args, 'deploy');
    const scope = await varScope(args);
    const names = args.filter((a) => a !== '--');
    if (!names.length) fail('usage: servify variables unset NAME… [--shared]');
    const missing = names.filter((k) => !(k in scope.values));
    if (missing.length) fail(`No variable ${missing.join(', ')} on ${scope.label} — nothing changed.`);
    const r = await scope.write(Object.fromEntries(names.map((k) => [k, null])), scope.secretKeys.filter((k) => !names.includes(k)));
    console.log(`${c.green('✓')} Removed ${names.join(', ')} from ${scope.label}.`);
    await redeployAfter(r.redeploy, r.note, deployNow);
    return;
  }
  fail(`Unknown subcommand "${sub}".\n${USAGE.variables}`);
}

// ─── backups ───

const sha = (b: any) => (b.sha256 ? `sha256:${b.sha256.slice(0, 12)}` : 'no checksum');
const testLabel = (b: any) => {
  const t = b.test;
  if (!t) return c.dim('untested');
  if (t.status === 'passed') return c.green('test passed');
  if (t.status === 'failed') return c.red('test failed');
  return t.status === 'checked' ? 'archive checked' : 'testing…';
};

async function poll<T>(get: () => Promise<T>, done: (v: T) => boolean, onTick?: (v: T) => void): Promise<T> {
  for (;;) {
    const v = await get();
    onTick?.(v);
    if (done(v)) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function backupCreate(args: string[]) {
  const noWait = bool(args, 'no-wait');
  const destRef = valueFlag(args, 'destination');
  const { service } = await target(args);
  let destinationId = destRef;
  if (destRef) {
    // An id or a name (the list is instance-wide: a token limited to some projects passes the id).
    const dests: any[] = (await api<any>('GET', '/settings').catch(() => null))?.backups?.destinations ?? [];
    const hit = dests.find((d) => d.id === destRef) ?? dests.find((d) => d.name === destRef);
    if (hit) destinationId = hit.id;
  }
  const before = new Set((await api<any[]>('GET', `/services/${service.id}/backups?limit=20`)).map((b) => b.id));
  const r = await api<any>('POST', `/services/${service.id}/backups`, { ...(destinationId ? { destinationId } : {}), wait: false });
  let rec: any = r.started ? r.backup : r;
  if (noWait) {
    console.log(rec ? `Backing up ${service.name} in the background (${rec.id}) — \`servify backup list\` shows it.` : `${service.name}'s backup is queued behind another backup or restore — \`servify backup list\` shows it.`);
    return;
  }
  if (!rec) {
    console.log(c.dim(`Waiting for another backup or restore of ${service.name} to finish…`));
    // Ours is the next backup asked for by hand or by a token (not a restore's safety backup or a scheduled one). If
    // nothing is running any more and ours still hasn't appeared after a while, it failed before it got a record.
    let idleSince = 0;
    for (;;) {
      const list = await api<any[]>('GET', `/services/${service.id}/backups?limit=20`);
      rec = list.find((b) => !before.has(b.id) && (b.trigger === 'manual' || b.trigger === 'agent'));
      if (rec) break;
      const busy = list.some((b) => b.status === 'running' || b.restore?.status === 'running');
      if (busy) idleSince = 0;
      else if (!idleSince) idleSince = Date.now();
      else if (Date.now() - idleSince > 30_000) {
        console.log(c.red('✗ The queued backup never started') + c.dim(' — the service\'s activity shows why; try `servify backup` again'));
        process.exitCode = 1;
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (rec.status === 'running') console.log(`Backing up ${service.name} to ${rec.destinationName}…`);
  rec = await poll(() => api<any>('GET', `/backups/${rec.id}`), (b) => b.status !== 'running');
  if (rec.status === 'succeeded') console.log(`${c.green('✓')} Backed up ${service.name}: ${size(rec.sizeBytes ?? 0)} on ${rec.destinationName} ${c.dim(`(${rec.id}, ${rec.sha256 ? `sha256 ${rec.sha256.slice(0, 12)}…` : 'no checksum'})`)}`);
  else {
    console.log(c.red('✗ Backup failed') + (rec.error ? ` — ${rec.error}` : ''));
    process.exitCode = 1;
  }
}

async function backupList(args: string[]) {
  const limit = Number(valueFlag(args, 'limit', 'n') ?? 20);
  const { service } = await target(args);
  const list = await api<any[]>('GET', `/services/${service.id}/backups?limit=${Math.max(1, Math.min(200, limit || 20))}`);
  if (!list.length) return console.log(c.dim(`No backups of ${service.name} yet — \`servify backup\` takes one.`));
  for (const b of list) {
    const st = b.status === 'succeeded' ? c.green('ok') : b.status === 'failed' ? c.red('failed') : c.dim('running');
    const sz = b.sizeBytes != null ? size(b.sizeBytes) : '—';
    const restored = b.restore?.status === 'running' ? '  restoring…' : b.restoredAt ? c.dim(`  restored ${when(b.restoredAt)}`) : '';
    console.log(`${b.id}  ${when(b.createdAt)}  ${pad(st, 7)}  ${pad(b.trigger ?? '', 11)} ${sz.padStart(9)}  ${pad(sha(b), 19)}  ${pad(testLabel(b), 15)} ${c.dim(b.destinationName ?? '')}${restored}${b.status === 'failed' && b.error ? c.dim(`  ${b.error.slice(0, 80)}`) : ''}`);
  }
}

async function backupTest(args: string[]) {
  const noWait = bool(args, 'no-wait');
  const [id] = args.filter((a) => a !== '--');
  if (!id) fail('usage: servify backup test <backup id> [--no-wait]');
  const b = await api<any>('GET', `/backups/${encodeURIComponent(id)}`);
  await api<any>('POST', `/backups/${b.id}/test`, {});
  if (noWait) return console.log(`Testing the backup of ${b.serviceName} from ${when(b.createdAt)} in the background — \`servify backup list\` shows the result.`);
  console.log(`Test-restoring the backup of ${b.serviceName} from ${when(b.createdAt)} (${size(b.sizeBytes ?? 0)})…`);
  const done = await poll(() => api<any>('GET', `/backups/${b.id}`), (x) => !!x.test && x.test.status !== 'running');
  const t = done.test;
  if (t.status === 'passed') console.log(`${c.green('✓')} Test restore passed — ${t.message}`);
  else if (t.status === 'checked') console.log(`${c.green('✓')} The archive is sound (no room for a scratch restore) — ${t.message}`);
  else {
    console.log(c.red('✗ Test restore failed') + ` — ${t.message}`);
    process.exitCode = 1;
  }
}

async function backupDownload(args: string[]) {
  const out = valueFlag(args, 'output', 'o');
  const force = bool(args, 'force');
  const [id] = args.filter((a) => a !== '--');
  if (!id) fail('usage: servify backup download <backup id> [-o file|-]');
  const b = await api<any>('GET', `/backups/${encodeURIComponent(id)}`);
  if (b.status !== 'succeeded') fail(`That backup ${b.status === 'running' ? 'is still running' : 'failed'} — there is nothing to download.`);
  const { url, token } = connection();
  let res: Response;
  try {
    res = await fetch(`${url}/api/backups/${b.id}/download`, { headers: { authorization: `Bearer ${token}` } });
  } catch (e) {
    return fail(`Can't reach ${url} (${(e as Error & { cause?: { code?: string } }).cause?.code ?? (e as Error).message}).`);
  }
  if (res.status === 401) fail('The token was rejected — run `servify login` again.');
  if (!res.ok || !res.body) fail(((await res.json().catch(() => null)) as any)?.error ?? `download → ${res.status}`);
  const toStdout = out === '-';
  // Only the file name of what the server suggests: never a path.
  const suggested = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1];
  const file = toStdout ? null : resolve(out ?? basename(suggested ?? `${b.id}.gz`));
  if (file && existsSync(file) && !force && !out) fail(`${basename(file)} already exists — pass -o <file> or --force.`);
  const part = file ? join(dirname(file), `.${basename(file)}.part`) : null;
  const sink = part ? createWriteStream(part) : process.stdout;
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      bytes += chunk.length;
      if (!sink.write(chunk)) await new Promise((r) => sink.once('drain', r));
    }
    if (part) await new Promise<void>((ok, bad) => (sink as ReturnType<typeof createWriteStream>).end((e?: Error | null) => (e ? bad(e) : ok())));
  } catch (e) {
    if (part) rmSync(part, { force: true });
    fail(`The download broke off after ${size(bytes)}: ${(e as Error).message}`);
  }
  const digest = hash.digest('hex');
  const wrongSize = b.sizeBytes != null && bytes !== b.sizeBytes;
  if ((b.sha256 && digest !== b.sha256) || wrongSize) {
    if (part) rmSync(part, { force: true });
    fail(`Checksum mismatch: got ${size(bytes)} with sha256 ${digest.slice(0, 12)}…, the backup record says ${size(b.sizeBytes ?? 0)} with sha256 ${(b.sha256 ?? '?').slice(0, 12)}… — the stored backup is damaged${part ? '; nothing was saved' : ''}.`);
  }
  if (part && file) renameSync(part, file);
  const verified = b.sha256 ? `sha256 verified (${digest.slice(0, 12)}…)` : 'no checksum recorded for this (older) backup: not verified';
  (toStdout ? console.error : console.log)(`${c.green('✓')} ${file ? `Saved ${relative(process.cwd(), file) || file}` : 'Downloaded'} — ${size(bytes)}, ${verified}`);
}

async function backup(args: string[]) {
  const sub = args[0] && !args[0].startsWith('-') ? args.shift()! : 'create';
  if (sub === 'create' || sub === 'now') return backupCreate(args);
  if (sub === 'list' || sub === 'ls') return backupList(args);
  if (sub === 'test') return backupTest(args);
  if (sub === 'download') return backupDownload(args);
  fail(`Unknown subcommand "${sub}".\n${USAGE.backup}`);
}

async function restore(args: string[]) {
  const yes = bool(args, 'yes', 'y');
  const [id] = args.filter((a) => a !== '--');
  if (!id) fail(`usage: ${USAGE.restore.split('\n')[0]}`);
  const b = await api<any>('GET', `/backups/${encodeURIComponent(id)}`);
  if (b.status !== 'succeeded') fail(`That backup ${b.status === 'running' ? 'is still running' : 'failed'} — it can't be restored.`);
  const what = `${b.serviceName}'s data with the backup of ${when(b.createdAt)} (${size(b.sizeBytes ?? 0)} on ${b.destinationName})`;
  if (!yes) {
    if (!process.stdin.isTTY) fail(`Restoring replaces ${what}. Pass --yes to go ahead.`);
    const a = await ask(`Replace ${what}? A safety backup of the current data is taken first. [y/N] `);
    if (!/^y(es)?$/i.test(a)) fail('Nothing restored.');
  }
  await api<any>('POST', `/backups/${b.id}/restore`, {});
  console.log(`Restoring ${b.serviceName} from the backup of ${when(b.createdAt)}… ${c.dim('(it carries on if you press Ctrl-C)')}`);
  let step = '';
  const done = await poll(
    () => api<any>('GET', `/backups/${b.id}`),
    (x) => x.restore?.status !== 'running',
    (x) => {
      if (x.restore?.status === 'running' && x.restore.step !== step) console.log(c.dim('│ ') + (step = x.restore.step));
    },
  );
  if (done.restore?.status === 'succeeded') console.log(`${c.green('✓')} Restored ${b.serviceName}${done.restore.safetyBackupId ? c.dim(` (the data from before is in safety backup ${done.restore.safetyBackupId})`) : ''}`);
  else {
    console.log(c.red('✗ Restore failed') + ` — ${done.restore?.error ?? 'see the activity log'}`);
    process.exitCode = 1;
  }
}

/** Per-command help: `servify help <command>` and `servify <command> --help`. */
export const USAGE: Record<string, string> = {
  login: 'servify login [url] [--token svf_…]\n  Save the URL and an API token (Servify → Agents → API tokens, or `servify token`).',
  logout: 'servify logout\n  Forget the saved token.',
  link: 'servify link [project] [service]\n  Remember which project/service this folder deploys to (asks when not given).',
  unlink: 'servify unlink\n  Forget this folder’s link.',
  up: 'servify up [--service name] [--project p] [--detach] [--replace]\n  Upload this folder, build and deploy it, and follow the build. A new --service name creates the service.\n  --replace: allow replacing an image, git or folder source with the upload.',
  deploy:
    'servify deploy [--tag t] [--skip-safety-backup] [--detach]\n  Redeploy the linked service and follow it (exits non-zero if it fails).\n  --tag: switch an image service to that tag of its image first (CI: deploy what you just pushed; a deploy token is enough).\n  --skip-safety-backup: go ahead without the safety backup a new image on a service with data needs.',
  restart: 'servify restart [--skip-safety-backup] [--detach]\n  Restart the linked service with the image it runs, and follow it (exits non-zero if it fails).',
  rollback:
    'servify rollback [deployment id] [--skip-safety-backup] [--detach]\n  Go back to the previous live deployment with a different image (or the one given — a unique prefix is enough),\n  and follow it like deploy. An older image on a service with data gets a safety backup first, unless skipped.',
  deployments: 'servify deployments [--limit n]\n  Recent deployments of the linked service: id, when, status, trigger, source (ids for rollback).',
  logs: 'servify logs [-f] [--build] [--tail n]\n  Runtime logs (-f follows them), or the latest build log with --build.',
  variables:
    'servify variables [list] [--reveal]          the variables, values masked unless --reveal\n' +
    'servify variables get NAME                   print just the value (for scripts); fails on a secret the token may not read\n' +
    'servify variables set NAME=value… [NAME] [--from-file .env|-] [--secret] [--deploy]\n' +
    '                                             NAME alone reads its value from stdin (a hidden prompt on a terminal),\n' +
    '                                             --from-file reads a .env file (- for stdin): no secrets in shell history\n' +
    'servify variables unset NAME… [--deploy]\n' +
    '  --shared: the project’s shared variables (${{shared.NAME}}) instead of the service’s.\n' +
    '  --secret: mask these for read-only and deploy tokens (new names with SECRET, PASSWORD, TOKEN or KEY are anyway).\n' +
    '  Changes apply on the next deploy; --deploy redeploys right away (with --shared: every service that uses them).\n' +
    '  `servify vars` is the same command.',
  backup:
    'servify backup [create] [--destination id|name] [--no-wait]   back up the linked service now and wait for it\n' +
    'servify backup list [--limit n]               id, when, status, trigger, size, checksum, test result, destination\n' +
    'servify backup test <id> [--no-wait]          restore it into a scratch copy (the service is not touched)\n' +
    'servify backup download <id> [-o file|-] [--force]   stream it here and verify its sha256 (a mismatch exits 1)',
  restore:
    'servify restore <backup id> [--yes]\n  Replace the service’s data with a backup (checked end to end first; a safety backup of the current data is taken).\n  Asks first unless --yes; follows the restore and exits non-zero if it fails.',
  run: 'servify run [--] <command…>\n  Run a command here with the service’s variables (resolved as the service sees them).',
  exec:
    'servify exec [--replica n] [--] <command…>\n  Run a command inside the running service; its exit code is the CLI’s. Words are passed as they are\n  (`servify exec -- sh -c \'echo "a b"\'`); a single argument with shell syntax (`servify exec \'ls | wc -l\'`) runs through /bin/sh -c.\n  Put -- before a command that has flags of its own.',
  status: 'servify status\n  The linked project’s services (and a low-disk warning if there is one).',
  open: 'servify open\n  Open the service’s URL.',
};
USAGE.vars = USAGE.variables;

export const CLIENT_COMMANDS = ['login', 'logout', 'link', 'unlink', 'up', 'deploy', 'restart', 'rollback', 'deployments', 'logs', 'variables', 'vars', 'backup', 'restore', 'run', 'exec', 'status', 'open'];

export async function main(cmd: string, args: string[]) {
  try {
    // --help before a `--` (for run and exec: only as the first word, the rest is the command).
    const helpAt = ['run', 'exec'].includes(cmd) ? (['--help', '-h'].includes(args[0]) ? 0 : -1) : args.findIndex((a, i) => (a === '--help' || a === '-h') && !args.slice(0, i).includes('--'));
    if (cmd === 'help' || helpAt >= 0) {
      const what = cmd === 'help' ? args[0] : cmd;
      if (!what || !USAGE[what]) fail(`No help for "${what ?? ''}" — run \`servify help\` for the list.`);
      console.log(USAGE[what]);
      return;
    }
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
    else if (cmd === 'restart') await restart(args);
    else if (cmd === 'rollback') await rollback(args);
    else if (cmd === 'deployments') await deployments(args);
    else if (cmd === 'logs') await logs(args);
    else if (cmd === 'variables' || cmd === 'vars') await variables(args);
    else if (cmd === 'backup') await backup(args);
    else if (cmd === 'restore') await restore(args);
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
