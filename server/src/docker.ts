/**
 * Minimal Docker Engine API client over the unix socket.
 * No dockerode: we only need a focused subset, and owning it keeps the stream handling explicit.
 */
import http from 'node:http';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Readable } from 'node:stream';

export type DockerTarget = { socketPath: string } | { host: string; port: number };

function resolveTarget(): DockerTarget {
  const env = process.env.DOCKER_HOST;
  if (env) {
    if (env.startsWith('unix://')) return { socketPath: env.slice(7) };
    if (env.startsWith('tcp://')) {
      const u = new URL(env.replace('tcp://', 'http://'));
      return { host: u.hostname, port: Number(u.port || 2375) };
    }
  }
  // Ask the docker CLI which context is active (OrbStack, Colima, Docker Desktop all differ).
  try {
    const out = execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
    }).trim();
    if (out.startsWith('unix://') && existsSync(out.slice(7))) return { socketPath: out.slice(7) };
  } catch {}
  const candidates = [
    '/var/run/docker.sock',
    join(homedir(), '.orbstack/run/docker.sock'),
    join(homedir(), '.docker/run/docker.sock'),
    join(homedir(), '.colima/default/docker.sock'),
    join(homedir(), '.rd/docker.sock'),
  ];
  for (const c of candidates) if (existsSync(c)) return { socketPath: c };
  return { socketPath: '/var/run/docker.sock' };
}

export const dockerTarget = resolveTarget();
export const dockerHostEnv =
  'socketPath' in dockerTarget ? `unix://${dockerTarget.socketPath}` : `tcp://${dockerTarget.host}:${dockerTarget.port}`;

let apiPrefix = '';

export class DockerError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type ReqOpts = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  rawBody?: Readable;
  headers?: Record<string, string>;
  timeout?: number;
};

function buildPath(path: string, query?: ReqOpts['query']): string {
  let p = apiPrefix + path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
    const s = qs.toString();
    if (s) p += (p.includes('?') ? '&' : '?') + s;
  }
  return p;
}

function rawRequest(method: string, path: string, opts: ReqOpts = {}): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...opts.headers };
    let payload: string | undefined;
    if (opts.body !== undefined) {
      payload = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request(
      { ...dockerTarget, method, path: buildPath(path, opts.query), headers, timeout: opts.timeout },
      (res) => resolve(res),
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`docker ${method} ${path} timed out`)));
    if (opts.rawBody) {
      opts.rawBody.pipe(req);
      opts.rawBody.on('error', (e) => req.destroy(e));
    } else {
      if (payload) req.write(payload);
      req.end();
    }
  });
}

async function readBody(res: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function call<T = any>(method: string, path: string, opts: ReqOpts = {}): Promise<T> {
  const res = await rawRequest(method, path, opts);
  const text = await readBody(res);
  const status = res.statusCode ?? 500;
  if (status >= 400) {
    let msg = text;
    try {
      msg = JSON.parse(text).message ?? text;
    } catch {}
    throw new DockerError(status, msg.trim() || `docker ${method} ${path} failed (${status})`);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

async function stream(method: string, path: string, opts: ReqOpts = {}): Promise<http.IncomingMessage> {
  const res = await rawRequest(method, path, opts);
  const status = res.statusCode ?? 500;
  if (status >= 400) {
    const text = await readBody(res);
    let msg = text;
    try {
      msg = JSON.parse(text).message ?? text;
    } catch {}
    throw new DockerError(status, msg.trim());
  }
  return res;
}

/** Iterate newline-delimited JSON objects from a stream. */
export async function* jsonLines(res: Readable): AsyncGenerator<any> {
  let buf = '';
  for await (const chunk of res) {
    buf += chunk.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {}
    }
  }
  if (buf.trim()) {
    try {
      yield JSON.parse(buf.trim());
    } catch {}
  }
}

export type LogFrame = { stream: 'stdout' | 'stderr'; text: string };

/** Demultiplex Docker's 8-byte-header framed stdout/stderr stream into lines. */
export async function* demuxLines(res: Readable): AsyncGenerator<LogFrame> {
  let buf = Buffer.alloc(0);
  const partial: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  for await (const chunk of res) {
    buf = Buffer.concat([buf, chunk as Buffer]);
    while (buf.length >= 8) {
      const type = buf[0];
      const size = buf.readUInt32BE(4);
      if (type > 2 || buf[1] !== 0 || buf[2] !== 0 || buf[3] !== 0) {
        // Not multiplexed (TTY container) — treat everything as stdout.
        partial.stdout += buf.toString('utf8');
        buf = Buffer.alloc(0);
        break;
      }
      if (buf.length < 8 + size) break;
      const s: 'stdout' | 'stderr' = type === 2 ? 'stderr' : 'stdout';
      partial[s] += buf.subarray(8, 8 + size).toString('utf8');
      buf = buf.subarray(8 + size);
    }
    for (const s of ['stdout', 'stderr'] as const) {
      let i: number;
      while ((i = partial[s].indexOf('\n')) >= 0) {
        yield { stream: s, text: partial[s].slice(0, i).replace(/\r$/, '') };
        partial[s] = partial[s].slice(i + 1);
      }
    }
  }
  for (const s of ['stdout', 'stderr'] as const) if (partial[s]) yield { stream: s, text: partial[s] };
}

export type ContainerSummary = {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Labels: Record<string, string>;
  Created: number;
};

const networkInflight = new Map<string, Promise<string>>();

function filtersParam(f: Record<string, string[]>) {
  return JSON.stringify(f);
}

export const docker = {
  async init(): Promise<{ version: string; apiVersion: string; os: string }> {
    apiPrefix = '';
    const v = await call<any>('GET', '/version', { timeout: 5000 });
    apiPrefix = `/v${v.ApiVersion}`;
    return { version: v.Version, apiVersion: v.ApiVersion, os: `${v.Os}/${v.Arch}` };
  },
  async ping(): Promise<boolean> {
    try {
      await call('GET', '/_ping', { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  },
  info: () => call<any>('GET', '/info'),

  listContainers(labels: string[] = [], all = true): Promise<ContainerSummary[]> {
    return call('GET', '/containers/json', {
      query: { all, filters: filtersParam({ label: labels }) },
    });
  },
  inspectContainer: (id: string) => call<any>('GET', `/containers/${id}/json`),
  async createContainer(name: string, spec: unknown): Promise<string> {
    const r = await call<{ Id: string }>('POST', '/containers/create', { query: { name }, body: spec });
    return r.Id;
  },
  startContainer: (id: string) => call('POST', `/containers/${id}/start`),
  stopContainer: (id: string, t = 10) => call('POST', `/containers/${id}/stop`, { query: { t }, timeout: (t + 15) * 1000 }),
  restartContainer: (id: string, t = 5) => call('POST', `/containers/${id}/restart`, { query: { t } }),
  killContainer: (id: string) => call('POST', `/containers/${id}/kill`),
  removeContainer: (id: string, force = true) =>
    call('DELETE', `/containers/${id}`, { query: { force, v: false } }).catch((e) => {
      if (e instanceof DockerError && (e.status === 404 || e.status === 409)) return;
      throw e;
    }),

  async inspectImage(ref: string): Promise<any | null> {
    try {
      return await call('GET', `/images/${encodeURIComponent(ref)}/json`);
    } catch (e) {
      if (e instanceof DockerError && e.status === 404) return null;
      throw e;
    }
  },
  async pullImage(ref: string, onLine?: (line: string) => void): Promise<void> {
    let [image, tag] = splitImageRef(ref);
    const res = await stream('POST', '/images/create', { query: { fromImage: image, tag } });
    const lastStatus = new Map<string, string>();
    for await (const msg of jsonLines(res)) {
      if (msg.errorDetail || msg.error) throw new Error(msg.errorDetail?.message ?? msg.error);
      if (!onLine) continue;
      const key = msg.id ?? '';
      const status = `${msg.status ?? ''}`;
      // Collapse noisy progress updates into a single line per layer state.
      if (lastStatus.get(key) === status) continue;
      lastStatus.set(key, status);
      onLine(key ? `${key}: ${status}` : status);
    }
  },
  removeImage: (ref: string) => call('DELETE', `/images/${encodeURIComponent(ref)}`, { query: { force: false } }).catch(() => {}),
  listImages: (labels: string[] = []) => call<any[]>('GET', '/images/json', { query: { filters: filtersParam({ label: labels }) } }),

  async buildFromTar(tar: Readable, tag: string, dockerfile: string, onLine: (l: string) => void, labels: Record<string, string> = {}) {
    const res = await stream('POST', '/build', {
      query: { t: tag, dockerfile, rm: true, forcerm: true, labels: JSON.stringify(labels) },
      rawBody: tar,
      headers: { 'Content-Type': 'application/x-tar' },
    });
    for await (const msg of jsonLines(res)) {
      if (msg.errorDetail || msg.error) throw new Error(msg.errorDetail?.message ?? msg.error);
      if (msg.stream) for (const l of String(msg.stream).split('\n')) if (l.trim()) onLine(l);
      if (msg.status) onLine(String(msg.status));
    }
  },

  ensureNetwork(name: string, labels: Record<string, string>): Promise<string> {
    // Memoize in-flight creation so concurrent replica starts don't race.
    const pending = networkInflight.get(name);
    if (pending) return pending;
    const p = (async () => {
      try {
        const n = await call<any>('GET', `/networks/${name}`);
        return n.Id as string;
      } catch (e) {
        if (!(e instanceof DockerError && e.status === 404)) throw e;
      }
      try {
        const r = await call<any>('POST', '/networks/create', {
          body: { Name: name, Driver: 'bridge', CheckDuplicate: true, Labels: labels },
        });
        return r.Id as string;
      } catch (e) {
        if (e instanceof DockerError && e.status === 409) return (await call<any>('GET', `/networks/${name}`)).Id as string;
        throw e;
      }
    })().finally(() => networkInflight.delete(name));
    networkInflight.set(name, p);
    return p;
  },
  removeNetwork: (name: string) => call('DELETE', `/networks/${name}`).catch(() => {}),
  connectNetwork: (network: string, container: string, aliases: string[] = []) =>
    call('POST', `/networks/${network}/connect`, {
      body: { Container: container, EndpointConfig: { Aliases: aliases } },
    }).catch((e) => {
      if (e instanceof DockerError && /already exists|is already/.test(e.message)) return;
      throw e;
    }),

  createVolume: (name: string, labels: Record<string, string>) =>
    call('POST', '/volumes/create', { body: { Name: name, Labels: labels } }),
  removeVolume: (name: string) => call('DELETE', `/volumes/${name}`).catch(() => {}),

  stats: (id: string) => call<any>('GET', `/containers/${id}/stats`, { query: { stream: false, 'one-shot': true }, timeout: 8000 }),

  logs(id: string, opts: { follow?: boolean; tail?: number | 'all'; since?: number; timestamps?: boolean }) {
    return stream('GET', `/containers/${id}/logs`, {
      query: {
        stdout: true,
        stderr: true,
        follow: opts.follow ?? false,
        tail: opts.tail ?? 200,
        since: opts.since,
        timestamps: opts.timestamps ?? true,
      },
    });
  },

  events(labels: string[]) {
    return stream('GET', '/events', {
      query: { filters: filtersParam({ type: ['container'], label: labels }) },
    });
  },

  async exec(id: string, cmd: string[], timeoutMs = 30000): Promise<{ exitCode: number; output: string }> {
    const ex = await call<{ Id: string }>('POST', `/containers/${id}/exec`, {
      body: { AttachStdout: true, AttachStderr: true, Tty: false, Cmd: cmd },
    });
    const res = await stream('POST', `/exec/${ex.Id}/start`, { body: { Detach: false, Tty: false }, timeout: timeoutMs });
    let output = '';
    const lines: string[] = [];
    for await (const f of demuxLines(res)) {
      lines.push(f.text);
      if (lines.length > 2000) lines.shift();
    }
    output = lines.join('\n');
    const info = await call<any>('GET', `/exec/${ex.Id}/json`);
    return { exitCode: info.ExitCode ?? -1, output };
  },
};

export function splitImageRef(ref: string): [string, string] {
  // Handles registry:port/name:tag and name@sha256:...
  if (ref.includes('@')) return [ref, ''];
  const lastSlash = ref.lastIndexOf('/');
  const lastColon = ref.lastIndexOf(':');
  if (lastColon > lastSlash) return [ref.slice(0, lastColon), ref.slice(lastColon + 1)];
  return [ref, 'latest'];
}

export function normalizeImageRef(ref: string): string {
  const [image, tag] = splitImageRef(ref.trim());
  return tag ? `${image}:${tag}` : image;
}
