/**
 * External routes: a service whose "replica" is an address on another machine (e.g. a NAS, a VM, a box Servify
 * doesn't manage). The router sends its domains (or its TCP proxy port) there; Servify only health-checks it.
 * Nothing is deployed, so there are no containers, logs, exec or backups for it.
 *
 * Targets are kept out of the engine's replica map on purpose: everything there is a Docker container.
 */
import net from 'node:net';
import http from 'node:http';
import { services as servicesTable, projects as projectsTable } from './db.ts';
import { bus } from './events.ts';
import { notify } from './notify.ts';
import { HttpError } from './util.ts';
import type { Service, SourceExternal } from './types.ts';

type Target = { host: string; port: number; healthy: boolean | null; lastProbe: number; probing: boolean; downSince: number | null; noticed: boolean };
const targets = new Map<string, Target>();

export const isExternal = (s: Pick<Service, 'source'> | null | undefined): boolean => s?.source.type === 'external';

/** "http://10.0.0.5:8080", "10.0.0.5:8080", "tcp://nas.lan:5432" → host + port. */
export function parseExternalUrl(raw: string, protocol: 'http' | 'tcp' | 'none'): { url: string; host: string; port: number } {
  const s = raw?.trim();
  if (!s) throw new HttpError(400, 'give the address, e.g. http://192.168.1.20:8080');
  const withScheme = /^[a-z]+:\/\//i.test(s) ? s : `${protocol === 'tcp' ? 'tcp' : 'http'}://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme.replace(/^tcp:/i, 'http:'));
  } catch {
    throw new HttpError(400, `not an address: ${s}`);
  }
  if (/^https:/i.test(withScheme)) throw new HttpError(400, 'the target must speak plain HTTP (Servify terminates HTTPS); use http://');
  if (u.pathname !== '/' || u.search) throw new HttpError(400, 'just host and port, no path');
  const port = Number(u.port || 80);
  if (!port || port > 65535) throw new HttpError(400, 'which port?');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return { url: `${/^tcp:/i.test(withScheme) ? 'tcp' : 'http'}://${host.includes(':') ? `[${host}]` : host}:${port}`, host, port };
}

function targetOf(svc: Service): Target | null {
  if (!isExternal(svc)) return null;
  const src = svc.source as SourceExternal;
  let t = targets.get(svc.id);
  if (!t || t.host !== src.host || t.port !== src.port) {
    t = { host: src.host, port: src.port, healthy: null, lastProbe: 0, probing: false, downSince: null, noticed: false };
    targets.set(svc.id, t);
  }
  return t;
}

/** The router's view: one upstream, unless the last probe failed. */
export function externalUpstreams(svc: Service): any[] {
  const t = targetOf(svc);
  if (!t || svc.stopped || t.healthy === false) return [];
  return [{ containerId: `ext:${svc.id}`, nodeId: 'local', name: svc.name, serviceId: svc.id, deploymentId: '', index: 0, state: 'healthy', dockerState: 'running', host: t.host, port: t.port, startedAt: null, restarts: 0, cpu: null, memMb: null, rps: 0, activeConns: 0 }];
}

export function externalTarget(svc: Service) {
  const t = targetOf(svc);
  return t ? { host: t.host, port: t.port, healthy: t.healthy, lastProbe: t.lastProbe || null } : null;
}

function tcpOk(host: string, port: number, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function httpOk(host: string, port: number, path: string, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    const req = http.get({ host, port, path, timeout: timeoutMs, headers: { 'user-agent': 'servify-health' } }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

async function probe(svc: Service) {
  const t = targetOf(svc)!;
  if (t.probing) return;
  t.probing = true;
  try {
    const timeout = svc.healthcheck.timeoutSec * 1000;
    let ok = svc.protocol === 'http' && svc.healthcheck.path ? await httpOk(t.host, t.port, svc.healthcheck.path, timeout) : await tcpOk(t.host, t.port, timeout);
    // One retry before calling it down: a single dropped SYN shouldn't flip the route.
    if (!ok && t.healthy) ok = await tcpOk(t.host, t.port, timeout);
    t.lastProbe = Date.now();
    t.healthy = ok;
    const fresh = servicesTable.get(svc.id);
    if (!fresh || fresh.stopped) return;
    const next = ok ? 'running' : 'crashed';
    if (fresh.status !== next) {
      fresh.status = next;
      servicesTable.put(fresh);
      bus.publish({ type: 'service.updated', service: fresh });
    }
    const project = projectsTable.get(fresh.projectId);
    if (!ok) {
      t.downSince ??= Date.now();
      if (!t.noticed && Date.now() - t.downSince > 60_000) {
        t.noticed = true;
        notify({ event: 'service.crashed', level: 'error', title: `${fresh.name} is unreachable`, message: `${project?.name ?? ''}: ${t.host}:${t.port} isn't answering.`, projectId: fresh.projectId, serviceId: fresh.id });
      }
    } else {
      if (t.noticed) notify({ event: 'service.recovered', level: 'success', title: `${fresh.name} is reachable again`, message: `${project?.name ?? ''}: ${t.host}:${t.port} answers again.`, projectId: fresh.projectId, serviceId: fresh.id });
      t.downSince = null;
      t.noticed = false;
    }
  } finally {
    t.probing = false;
  }
}

export function startExternal() {
  setInterval(() => {
    const now = Date.now();
    for (const svc of servicesTable.all()) {
      if (!isExternal(svc) || svc.stopped) continue;
      const t = targetOf(svc)!;
      const every = (t.healthy ? svc.healthcheck.intervalSec : 3) * 1000;
      if (now - t.lastProbe >= every) void probe(svc);
    }
    for (const id of targets.keys()) if (!isExternal(servicesTable.get(id))) targets.delete(id);
  }, 1000).unref();
}
