/**
 * Variable references, Railway-style:
 *   ${{ KEY }}               → another variable of the same service
 *   ${{ postgres.KEY }}      → a variable of another service in the same project (by slug or name)
 * Built-ins available to every service: PORT, SERVIFY_PRIVATE_DOMAIN, SERVIFY_PUBLIC_DOMAIN,
 * SERVIFY_PUBLIC_URL, SERVIFY_SERVICE_NAME, SERVIFY_PROJECT_NAME, SERVIFY_TCP_PROXY_PORT.
 */
import type { Service, Project } from './types.ts';
import { config } from './config.ts';

const REF = /\$\{\{\s*([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_]+))?\s*\}\}/g;

export function publicDomain(svc: Service, project: Project): string {
  return `${svc.slug}.${project.slug}.${config.baseDomain}`;
}

export function publicUrl(svc: Service, project: Project): string {
  const port = config.proxyPort === 80 ? '' : `:${config.proxyPort}`;
  return `http://${publicDomain(svc, project)}${port}`;
}

export function builtins(svc: Service, project: Project, port: number | null): Record<string, string> {
  const b: Record<string, string> = {
    SERVIFY_PRIVATE_DOMAIN: svc.slug,
    SERVIFY_SERVICE_NAME: svc.name,
    SERVIFY_PROJECT_NAME: project.name,
  };
  if (port) b.PORT = String(port);
  if (svc.protocol === 'http') {
    b.SERVIFY_PUBLIC_DOMAIN = publicDomain(svc, project);
    b.SERVIFY_PUBLIC_URL = publicUrl(svc, project);
  }
  if (svc.publicTcpPort) b.SERVIFY_TCP_PROXY_PORT = String(svc.publicTcpPort);
  return b;
}

/** Return the services that `svc` references (used for canvas edges). */
export function referencedServices(svc: Service, siblings: Service[]): string[] {
  const out = new Set<string>();
  for (const v of Object.values(svc.env)) {
    for (const m of v.matchAll(REF)) {
      if (!m[2]) continue;
      const target = siblings.find((s) => s.id !== svc.id && (s.slug === m[1] || s.name === m[1]));
      if (target) out.add(target.id);
    }
  }
  return [...out];
}

export function resolveEnv(
  svc: Service,
  env: Record<string, string>,
  project: Project,
  siblings: Service[],
  port: number | null,
): { env: Record<string, string>; unresolved: string[] } {
  const unresolved: string[] = [];
  const cache = new Map<string, Record<string, string>>();

  const scopeFor = (s: Service, rawEnv: Record<string, string>, depth: number): Record<string, string> => {
    const key = s.id;
    if (cache.has(key)) return cache.get(key)!;
    const base = { ...builtins(s, project, s.id === svc.id ? port : s.port ?? s.detectedPort ?? null), ...rawEnv };
    const out: Record<string, string> = {};
    cache.set(key, out);
    const resolveValue = (val: string, d: number): string =>
      val.replace(REF, (whole, a: string, b?: string) => {
        if (d > 8) return whole;
        if (!b) {
          // self reference
          if (a in out) return out[a];
          if (a in base) return resolveValue(base[a], d + 1);
          unresolved.push(a);
          return '';
        }
        const target = siblings.find((x) => x.slug === a || x.name === a);
        if (!target) {
          unresolved.push(`${a}.${b}`);
          return '';
        }
        const tScope = target.id === s.id ? out : scopeFor(target, target.env, depth + 1);
        if (b in tScope) return tScope[b];
        const tBase = { ...builtins(target, project, target.port ?? target.detectedPort ?? null), ...target.env };
        if (b in tBase) return resolveValue(tBase[b], d + 1);
        unresolved.push(`${a}.${b}`);
        return '';
      });
    for (const [k, v] of Object.entries(base)) out[k] = resolveValue(v, depth);
    return out;
  };

  return { env: scopeFor(svc, env, 0), unresolved: [...new Set(unresolved)] };
}
