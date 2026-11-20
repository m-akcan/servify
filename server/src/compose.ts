/**
 * Docker Compose → Servify. Turns a docker-compose.yml into a project spec, with a warning for every
 * setting that doesn't carry over. Services keep reaching each other by their compose names (network
 * aliases), so `postgres://db:5432` keeps working.
 *
 * Never honoured (warned instead): host bind mounts, privileged, host networking/PID, extra capabilities,
 * devices and the Docker socket — a compose file must not be a way to escape onto the machine.
 */
import { parse } from 'yaml';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, relative } from 'node:path';
import { templates } from './templates.ts';
import type { Protocol, Service, Source } from './types.ts';
import { HttpError, slugify } from './util.ts';

export type ComposeService = {
  name: string;
  slug: string;
  aliases: string[];
  source: Source;
  templateId: string | null;
  protocol: Protocol;
  port: number | null;
  publishedPort: number | null;
  replicas: number;
  env: Record<string, string>;
  secretKeys: string[];
  volumes: { name: string; mountPath: string }[];
  /** Compose semantics: `command` replaces only CMD, `entrypoint` only ENTRYPOINT. */
  cmd: string[] | null;
  entrypoint: string[] | null;
  icon: string | null;
  healthPath: string | null;
  resources: { cpus: number | null; memoryMb: number | null };
  dependsOn: string[];
  x: number;
  y: number;
};
export type ComposePlan = { name: string; services: ComposeService[]; warnings: string[] };

const TCP_PORTS = new Set([5432, 3306, 6379, 27017, 9042, 5672, 1883, 11211, 9092, 2181, 4222, 26257, 8086, 9000]);

/** ${VAR}, ${VAR:-default}, ${VAR-default}, ${VAR:?err}, $VAR and $$ — against .env and env_file values. */
function interpolate(value: string, vars: Record<string, string>, missing: Set<string>): string {
  return value.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name, op, arg, bare) => {
    if (whole === '$$') return '$';
    const key = name ?? bare;
    const v = vars[key];
    const unset = v === undefined;
    const empty = unset || v === '';
    if (op === ':-') return empty ? arg : v;
    if (op === '-') return unset ? arg : v;
    if (op === ':?' || op === '?') {
      if ((op === ':?' && empty) || (op === '?' && unset)) missing.add(key);
      return v ?? '';
    }
    if (unset) missing.add(key);
    return v ?? '';
  });
}

function deepInterpolate(node: unknown, vars: Record<string, string>, missing: Set<string>): unknown {
  if (typeof node === 'string') return interpolate(node, vars, missing);
  if (Array.isArray(node)) return node.map((n) => deepInterpolate(n, vars, missing));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deepInterpolate(v, vars, missing)]));
  return node;
}

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

function envMap(e: unknown): Record<string, string> {
  if (!e) return {};
  if (Array.isArray(e)) {
    const out: Record<string, string> = {};
    for (const item of e) {
      const s = String(item);
      const i = s.indexOf('=');
      if (i > 0) out[s.slice(0, i)] = s.slice(i + 1);
      else out[s] = '';
    }
    return out;
  }
  return Object.fromEntries(Object.entries(e as Record<string, unknown>).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)]));
}

/** Split a string command the way Compose does (shell-like words, quotes, backslashes — no shell). */
export function shellSplit(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < input.length) cur += input[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < input.length) {
      cur += input[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}
const argv = (v: unknown): string[] | null => {
  if (v === undefined || v === null || v === '') return null;
  return Array.isArray(v) ? v.map(String) : shellSplit(String(v));
};

function parsePort(p: unknown): { container: number; published: number | null; proto: string } | null {
  if (typeof p === 'number') return { container: p, published: null, proto: 'tcp' };
  if (p && typeof p === 'object') {
    const o = p as any;
    return o.target ? { container: Number(o.target), published: o.published ? Number(o.published) : null, proto: o.protocol ?? 'tcp' } : null;
  }
  const s = String(p);
  const [spec, proto = 'tcp'] = s.split('/');
  const parts = spec.split(':');
  const container = Number.parseInt(parts[parts.length - 1].split('-')[0], 10);
  const published = parts.length >= 2 ? Number.parseInt(parts[parts.length - 2].split('-')[0], 10) : null;
  return Number.isFinite(container) ? { container, published: Number.isFinite(published as number) ? published : null, proto } : null;
}

function parseMemory(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const mult = { '': 1 / (1024 * 1024), k: 1 / 1024, m: 1, g: 1024, t: 1024 * 1024 }[m[2].toLowerCase() as '' | 'k' | 'm' | 'g' | 't'];
  return Math.max(16, Math.round(n * mult));
}

function templateFor(image: string) {
  const repo = image.toLowerCase().split('@')[0].replace(/:[^/]*$/, '');
  return templates.find((t) => t.image.split(':')[0] === repo || t.image.split(':')[0] === repo.replace(/^docker\.io\/(library\/)?/, '')) ?? null;
}

/** Keep paths (build contexts, env_files) inside the base folder. */
function inside(base: string, p: string): string | null {
  const full = isAbsolute(p) ? resolve(p) : resolve(base, p);
  let real = full;
  try {
    real = realpathSync(full);
  } catch {}
  let baseReal = base;
  try {
    baseReal = realpathSync(base);
  } catch {}
  const rel = relative(baseReal, real);
  return rel.startsWith('..') || isAbsolute(rel) ? null : real;
}

export function planCompose(input: { yaml: string; env?: string; basePath?: string; name?: string }): ComposePlan {
  let doc: any;
  try {
    doc = parse(input.yaml, { merge: true, maxAliasCount: 200 });
  } catch (e) {
    throw new HttpError(400, `not valid YAML: ${(e as Error).message}`);
  }
  if (!doc || typeof doc !== 'object' || !doc.services || typeof doc.services !== 'object') throw new HttpError(400, 'no "services:" section found — is this a docker-compose.yml?');
  const warnings: string[] = [];
  const base = input.basePath?.trim() ? resolve(input.basePath.trim()) : null;
  if (base && !(existsSync(base) && statSync(base).isDirectory())) throw new HttpError(400, `base folder does not exist: ${base}`);

  const vars: Record<string, string> = {};
  if (base && existsSync(join(base, '.env'))) Object.assign(vars, parseDotenv(readFileSync(join(base, '.env'), 'utf8')));
  if (input.env) Object.assign(vars, parseDotenv(input.env));
  const missing = new Set<string>();
  const services = deepInterpolate(doc.services, vars, missing) as Record<string, any>;
  if (missing.size) warnings.push(`Variables not set (left empty): ${[...missing].join(', ')}. Paste your .env to fill them in.`);

  const out: ComposeService[] = [];
  const used = new Set<string>();
  for (const [name, raw] of Object.entries(services)) {
    const svc = raw ?? {};
    const w = (msg: string) => warnings.push(`${name}: ${msg}`);
    if (svc.profiles?.length) w(`profiles ${JSON.stringify(svc.profiles)} ignored — the service is imported anyway`);

    // ── source
    let source: Source | null = null;
    const build = typeof svc.build === 'string' ? { context: svc.build } : svc.build;
    if (build?.context) {
      const ctx = String(build.context);
      if (/^(https?:\/\/|git@|github\.com\/)/.test(ctx)) {
        const [repo, frag] = ctx.split('#');
        const [branch, dir] = (frag ?? '').split(':');
        source = { type: 'git', repo, branch: branch || undefined, rootDir: dir || undefined, dockerfile: build.dockerfile };
      } else if (base) {
        const dir = inside(base, ctx);
        if (!dir) w(`build context ${ctx} is outside the base folder — skipped`);
        else if (!existsSync(dir)) w(`build context ${dir} does not exist`);
        else source = { type: 'local', path: dir, dockerfile: build.dockerfile };
      } else if (!svc.image) w(`builds from ${ctx}; give the base folder of the compose file to build it, or it is skipped`);
      if (build.args) w('build args are not supported yet — set them as ARG defaults in the Dockerfile');
      if (build.target) w(`build target "${build.target}" is not supported — the last stage is built`);
    }
    if (!source && svc.image) source = { type: 'image', image: String(svc.image) };
    if (!source) {
      w('no image or usable build context — skipped');
      continue;
    }

    // ── refuse host escapes
    if (svc.privileged) w('privileged mode is never granted — ignored');
    if (svc.network_mode) w(`network_mode "${svc.network_mode}" ignored — services share the project network`);
    if (svc.pid === 'host' || svc.ipc === 'host') w('host PID/IPC namespaces are never shared — ignored');
    if (svc.cap_add?.length) w(`extra capabilities (${svc.cap_add.join(', ')}) are not granted`);
    if (svc.devices?.length) w('device mappings are not supported — ignored');
    if (svc.security_opt?.length) w('security_opt ignored');
    if (svc.networks && !Array.isArray(svc.networks) && Object.keys(svc.networks).length > 1) w('multiple networks collapse into the one project network');
    if (svc.extra_hosts?.length) w('extra_hosts ignored');

    const image = source.type === 'image' ? source.image : '';
    const tpl = image ? templateFor(image) : null;

    // ── env
    const env: Record<string, string> = {};
    for (const f of [].concat(svc.env_file ?? [])) {
      const file = typeof f === 'string' ? f : (f as any)?.path;
      if (!file) continue;
      if (!base) {
        w(`env_file ${file} needs the base folder to be read — skipped`);
        continue;
      }
      const p = inside(base, file);
      if (!p) w(`env_file ${file} is outside the base folder — skipped`);
      else if (!existsSync(p)) {
        if ((f as any)?.required !== false) w(`env_file ${file} not found`);
      } else Object.assign(env, parseDotenv(readFileSync(p, 'utf8')));
    }
    Object.assign(env, envMap(svc.environment));

    // ── ports
    const ports = (svc.ports ?? []).map(parsePort).filter(Boolean) as NonNullable<ReturnType<typeof parsePort>>[];
    const expose = (svc.expose ?? []).map((p: unknown) => Number.parseInt(String(p), 10)).filter(Number.isFinite);
    if (ports.some((p) => p.proto === 'udp')) w('UDP ports are not supported');
    const tcpPorts = ports.filter((p) => p.proto !== 'udp');
    // Like Compose: no ports/expose → nothing is published or health-probed on a port (it's still reachable
    // by name on the project network). Probing a template's port would fail for e.g. a redis image running a script.
    const port = tcpPorts[0]?.container ?? expose[0] ?? null;
    if (tcpPorts.length + expose.length > 1) w(`several ports — routing to ${port}; the others stay reachable inside the project network`);
    let protocol: Protocol = port === null ? 'none' : tpl?.protocol ?? (TCP_PORTS.has(port) ? 'tcp' : 'http');
    if (svc.labels && JSON.stringify(svc.labels).includes('traefik.http')) protocol = 'http';
    const publishedPort = tcpPorts[0]?.published ?? null;

    // ── volumes
    const volumes: { name: string; mountPath: string }[] = [];
    for (const v of svc.volumes ?? []) {
      let src: string | undefined;
      let target: string | undefined;
      let type = 'volume';
      if (typeof v === 'string') {
        const parts = v.split(':');
        if (parts.length === 1) target = parts[0];
        else [src, target] = parts;
        if (src && (src.startsWith('.') || src.startsWith('/') || src.startsWith('~'))) type = 'bind';
      } else if (v && typeof v === 'object') {
        type = (v as any).type ?? 'volume';
        src = (v as any).source;
        target = (v as any).target;
      }
      if (!target?.startsWith('/')) continue;
      if (type === 'bind') {
        w(`bind mount ${src}:${target} is not mounted (host folders are never exposed) — bake the files into the image or use a volume`);
        continue;
      }
      if (type === 'tmpfs') continue;
      const vname = (src || target.split('/').filter(Boolean).join('-') || 'data').replace(/[^a-zA-Z0-9_.-]/g, '-');
      volumes.push({ name: vname, mountPath: target });
    }
    if (tpl && !volumes.length && tpl.volumes.length) volumes.push(...tpl.volumes);

    // ── command (Compose overrides CMD / ENTRYPOINT separately; the image keeps the other one)
    const cmd = argv(svc.command);
    const entrypoint = argv(svc.entrypoint);

    // ── replicas, health, resources
    let replicas = Number(svc.deploy?.replicas ?? svc.scale ?? 1);
    if (!Number.isFinite(replicas) || replicas < 0) replicas = 1;
    if (volumes.length && replicas > 1) {
      w(`${replicas} replicas with a volume would share its data — running 1`);
      replicas = 1;
    }
    let healthPath: string | null = tpl?.healthPath ?? null;
    const test = svc.healthcheck?.test;
    const testStr = Array.isArray(test) ? test.join(' ') : String(test ?? '');
    const hm = testStr.match(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(\/[^\s"']*)/);
    if (hm && protocol === 'http') healthPath = hm[1];
    else if (testStr && !/NONE/.test(testStr)) w('custom healthcheck command not carried over — Servify probes the port' + (protocol === 'http' ? ' (set an HTTP health path in settings)' : ''));
    const lim = svc.deploy?.resources?.limits ?? {};
    const resources = {
      cpus: lim.cpus ? Number(lim.cpus) || null : svc.cpus ? Number(svc.cpus) || null : null,
      memoryMb: parseMemory(lim.memory ?? svc.mem_limit),
    };

    // ── names
    let slug = slugify(name);
    for (let i = 2; used.has(slug); i++) slug = `${slugify(name)}-${i}`;
    used.add(slug);
    const aliases = [name.toLowerCase(), ...(svc.hostname ? [String(svc.hostname).toLowerCase()] : []), ...(svc.container_name ? [String(svc.container_name).toLowerCase()] : [])]
      .filter((a, i, all) => a !== slug && /^[a-z0-9]([a-z0-9_.-]*[a-z0-9])?$/.test(a) && all.indexOf(a) === i);
    const dependsOn = Array.isArray(svc.depends_on) ? svc.depends_on.map(String) : Object.keys(svc.depends_on ?? {});
    const secretKeys = Object.keys(env).filter((k) => /SECRET|PASSWORD|TOKEN|KEY|PASS$/i.test(k));

    out.push({ name, slug, aliases, source, templateId: tpl?.id ?? null, icon: tpl?.icon ?? null, protocol, port, publishedPort, replicas, env, secretKeys, volumes, cmd, entrypoint, healthPath, resources, dependsOn, x: 0, y: 0 });
  }
  if (!out.length) throw new HttpError(400, 'no importable services in this compose file');

  // Lay out by dependency depth: databases on the right, entry points on the left.
  const depth = new Map<string, number>();
  const visit = (n: string, seen = new Set<string>()): number => {
    if (depth.has(n)) return depth.get(n)!;
    if (seen.has(n)) return 0;
    seen.add(n);
    const s = out.find((x) => x.name === n);
    const d = s && s.dependsOn.length ? 1 + Math.max(...s.dependsOn.map((x) => visit(x, seen))) : 0;
    depth.set(n, d);
    return d;
  };
  for (const s of out) visit(s.name);
  const maxDepth = Math.max(...depth.values());
  const columns = new Map<number, number>();
  for (const s of out) {
    const col = maxDepth - (depth.get(s.name) ?? 0);
    const row = columns.get(col) ?? 0;
    columns.set(col, row + 1);
    s.x = col * 320;
    s.y = row * 230;
  }

  const name = input.name?.trim() || doc.name || (base ? base.split('/').pop() : null) || 'compose';
  return { name, services: out, warnings };
}

/** The plan as a servify.json spec (reuses the regular import path). */
export function planToSpec(plan: ComposePlan) {
  return {
    servify: 1 as const,
    name: plan.name,
    services: plan.services.map((s) => ({
      name: s.slug,
      // Never adopt a template: its generated passwords / start command would change how the image runs.
      templateId: null,
      icon: s.icon ?? undefined,
      source: s.source,
      protocol: s.protocol,
      port: s.port,
      replicas: s.replicas,
      env: s.env,
      secretKeys: s.secretKeys,
      volumes: s.volumes,
      startCommand: null,
      cmd: s.cmd,
      entrypoint: s.entrypoint,
      healthcheck: s.healthPath ? { path: s.healthPath } : undefined,
      resources: s.resources,
      aliases: s.aliases,
      x: s.x,
      y: s.y,
    })) as Array<Partial<Service> & { name: string }>,
  };
}
