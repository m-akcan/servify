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
import type { DatabaseKind } from './types.ts';

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
  stream?: boolean;
};

async function readBody(res: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
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


function filtersParam(f: Record<string, string[]>) {
  return JSON.stringify(f);
}

/** A Docker Engine API client bound to one endpoint (the local daemon, or a remote server through its tunnel). */
export function createDockerClient(target: DockerTarget) {
  const hostEnv = 'socketPath' in target ? `unix://${target.socketPath}` : `tcp://${target.host}:${target.port}`;
  const networkInflight = new Map<string, Promise<string>>();
  let apiPrefix = '';

  // Node's global agent kills sockets after 5s idle — fatal for pulls, builds, log follows and the
  // event stream, which can be silent for much longer. Calls reuse sockets; streams get their own.
  const callAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const streamAgent = new http.Agent({ keepAlive: false, maxSockets: Infinity });

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
        { ...target, method, path: buildPath(path, opts.query), headers, timeout: opts.timeout, agent: opts.stream ? streamAgent : callAgent },
        (res) => {
          if (opts.stream) {
            res.socket?.setTimeout(0);
            res.socket?.setKeepAlive(true, 30_000);
          }
          resolve(res);
        },
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
    const res = await rawRequest(method, path, { ...opts, stream: true });
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

  const client = {
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
    /** Containers (running or not) that mount a given volume. */
    listVolumes: async (): Promise<{ Name: string; Labels: Record<string, string> | null; CreatedAt?: string }[]> => ((await call<any>('GET', '/volumes')).Volumes ?? []),
    containersUsingVolume: (volume: string, all = false): Promise<ContainerSummary[]> =>
      call('GET', '/containers/json', { query: { all, filters: filtersParam({ volume: [volume] }) } }),
    /** Disk usage per volume (can be slow on big volumes — poll sparingly). */
    volumeUsage: async (): Promise<Map<string, number>> => {
      const r = await call<any>('GET', '/system/df', { query: { type: 'volume' }, timeout: 120_000 });
      return new Map(((r?.Volumes ?? []) as any[]).map((v) => [v.Name as string, Number(v.UsageData?.Size ?? -1)]));
    },
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
    /** The image as a tar stream (`docker save`). */
    exportImage: (ref: string) => stream('GET', `/images/${encodeURIComponent(ref)}/get`),
    /** Load a `docker save` tar stream. */
    async loadImage(tar: Readable): Promise<void> {
      const res = await stream('POST', '/images/load', { query: { quiet: true }, rawBody: tar, headers: { 'Content-Type': 'application/x-tar' } });
      for await (const msg of jsonLines(res)) if (msg.errorDetail || msg.error) throw new Error(msg.errorDetail?.message ?? msg.error);
    },
    removeImage: (ref: string) => call('DELETE', `/images/${encodeURIComponent(ref)}`, { query: { force: false } }).catch(() => {}),
    /** Add a `repo:tag` name to an image (`docker tag`). */
    tagImage: (ref: string, repoTag: string) => {
      const i = repoTag.lastIndexOf(':');
      return call('POST', `/images/${encodeURIComponent(ref)}/tag`, { query: { repo: repoTag.slice(0, i), tag: repoTag.slice(i + 1) } });
    },
    listImages: (labels: string[] = []) => call<any[]>('GET', '/images/json', { query: { filters: filtersParam({ label: labels }) } }),

    async buildFromTar(tar: Readable, tag: string, dockerfile: string, onLine: (l: string) => void, labels: Record<string, string> = {}, opts: { args?: Record<string, string>; target?: string | null } = {}) {
      const res = await stream('POST', '/build', {
        query: { t: tag, dockerfile, rm: true, forcerm: true, labels: JSON.stringify(labels), ...(opts.args && Object.keys(opts.args).length ? { buildargs: JSON.stringify(opts.args) } : {}), ...(opts.target ? { target: opts.target } : {}) },
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
    disconnectNetwork: (network: string, container: string) =>
      call('POST', `/networks/${network}/disconnect`, { body: { Container: container, Force: true } }).catch((e) => {
        if (e instanceof DockerError && (e.status === 404 || /is not connected/.test(e.message))) return;
        throw e;
      }),
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

    /** Block until the container exits; returns its exit code. */
    async waitContainer(id: string): Promise<number> {
      const res = await stream('POST', `/containers/${id}/wait`);
      let body = '';
      for await (const c of res) body += c.toString('utf8');
      try {
        return JSON.parse(body).StatusCode ?? -1;
      } catch {
        return -1;
      }
    },

    /** Tar stream of a path inside a container (GET /containers/{id}/archive). */
    archive: (id: string, path: string) => stream('GET', `/containers/${id}/archive`, { query: { path } }),

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

    /** Run a command with extra env, keeping stdout and stderr apart and stopping at maxBytes of stdout. */
    async execCapture(id: string, cmd: string[], opts: { env?: Record<string, string>; timeoutMs?: number; maxBytes?: number } = {}): Promise<{ exitCode: number; stdout: string; stderr: string; truncated: boolean }> {
      const timeoutMs = opts.timeoutMs ?? 60_000;
      const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
      const ex = await call<{ Id: string }>('POST', `/containers/${id}/exec`, {
        body: { AttachStdout: true, AttachStderr: true, Tty: false, Cmd: cmd, Env: Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`) },
        timeout: 10_000,
      });
      let res: http.IncomingMessage | undefined;
      let timedOut = false;
      let truncated = false;
      const timer = setTimeout(() => {
        timedOut = true;
        res?.destroy();
      }, timeoutMs);
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      try {
        res = await stream('POST', `/exec/${ex.Id}/start`, { body: { Detach: false, Tty: false }, timeout: timeoutMs });
        let buf = Buffer.alloc(0);
        try {
          for await (const chunk of res) {
            buf = Buffer.concat([buf, chunk as Buffer]);
            while (buf.length >= 8) {
              const size = buf.readUInt32BE(4);
              if (buf.length < 8 + size) break;
              const frame = buf.subarray(8, 8 + size);
              if (buf[0] === 2) {
                if (errBytes < 64 * 1024) err.push(frame);
                errBytes += size;
              } else {
                out.push(frame);
                outBytes += size;
              }
              buf = buf.subarray(8 + size);
            }
            if (outBytes > maxBytes) {
              truncated = true;
              res.destroy();
              break;
            }
          }
        } catch (e) {
          if (!timedOut && !truncated) throw e;
        }
        if (timedOut) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`);
        const info = truncated ? { ExitCode: 0 } : await call<any>('GET', `/exec/${ex.Id}/json`, { timeout: 5000 });
        return { exitCode: info.ExitCode ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), truncated };
      } finally {
        clearTimeout(timer);
      }
    },
    async exec(id: string, cmd: string[], timeoutMs = 30000): Promise<{ exitCode: number; output: string }> {
      const ex = await call<{ Id: string }>('POST', `/containers/${id}/exec`, {
        body: { AttachStdout: true, AttachStderr: true, Tty: false, Cmd: cmd },
        timeout: Math.min(timeoutMs, 10_000),
      });
      // A hard deadline: once the stream is open the socket has no idle timeout, so a command that never exits (or a
      // daemon that never answers) would otherwise hang the caller forever.
      let res: http.IncomingMessage | undefined;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        res?.destroy(new Error(`exec timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      try {
        res = await stream('POST', `/exec/${ex.Id}/start`, { body: { Detach: false, Tty: false }, timeout: timeoutMs });
        if (timedOut) res.destroy();
        const lines: string[] = [];
        for await (const f of demuxLines(res)) {
          lines.push(f.text);
          if (lines.length > 2000) lines.shift();
        }
        if (timedOut) throw new Error(`exec timed out after ${timeoutMs} ms`);
        const info = await call<any>('GET', `/exec/${ex.Id}/json`, { timeout: 5000 });
        return { exitCode: info.ExitCode ?? -1, output: lines.join('\n') };
      } catch (e) {
        if (timedOut) throw new Error(`exec timed out after ${timeoutMs} ms`);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
  };
  return Object.assign(client, { target, hostEnv });
}

export type DockerClient = ReturnType<typeof createDockerClient>;

/** The Docker daemon on this machine. */
export const docker = createDockerClient(dockerTarget);

export function splitImageRef(ref: string): [string, string] {
  // Handles registry:port/name:tag and name@sha256:...
  if (ref.includes('@')) return [ref, ''];
  const lastSlash = ref.lastIndexOf('/');
  const lastColon = ref.lastIndexOf(':');
  if (lastColon > lastSlash) return [ref.slice(0, lastColon), ref.slice(lastColon + 1)];
  return [ref, 'latest'];
}

/** The database engine an image runs, from the variables the official images set (works for renamed or pinned copies). */
export function databaseOf(image: { Config?: { Env?: string[] | null } } | null): DatabaseKind | null {
  const env = new Set((image?.Config?.Env ?? []).map((e) => e.split('=')[0]));
  if (env.has('PG_VERSION') || env.has('PG_MAJOR')) return 'postgres';
  if (env.has('MARIADB_VERSION') || env.has('MYSQL_VERSION') || env.has('MARIADB_MAJOR') || env.has('MYSQL_MAJOR')) return 'mysql';
  if (env.has('MONGO_VERSION') || env.has('MONGO_MAJOR')) return 'mongo';
  return null;
}

export function normalizeImageRef(ref: string): string {
  const [image, tag] = splitImageRef(ref.trim());
  return tag ? `${image}:${tag}` : image;
}
