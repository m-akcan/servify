import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** The root package.json (a release package ships it too); server/package.json if it's missing. */
function readVersion(): string {
  for (const f of ['../../package.json', '../package.json']) {
    try {
      const v = JSON.parse(readFileSync(resolve(import.meta.dirname, f), 'utf8')).version;
      if (typeof v === 'string' && v) return v;
    } catch {}
  }
  return '0.0.0';
}

const dataDir = resolve(process.env.SERVIFY_DATA_DIR ?? join(homedir(), '.servify'));

export const config = {
  /** Where the SQLite database, build caches and logs live. */
  dataDir,
  dbPath: join(dataDir, 'servify.db'),
  buildsDir: join(dataDir, 'builds'),
  logsDir: join(dataDir, 'logs'),
  /** Dashboard + REST + MCP. */
  host: process.env.SERVIFY_HOST ?? '127.0.0.1',
  port: envInt('SERVIFY_PORT', 7700),
  /** Public HTTP load balancer / router. */
  proxyHost: process.env.SERVIFY_PROXY_HOST ?? '127.0.0.1',
  proxyPort: envInt('SERVIFY_PROXY_PORT', 8080),
  /** HTTPS router (ACME certificates for real domains, the local CA for everything else). */
  httpsPort: envInt('SERVIFY_HTTPS_PORT', 8443),
  /** Base domain for generated service URLs: <service>.<project>.<baseDomain> */
  baseDomain: process.env.SERVIFY_BASE_DOMAIN ?? 'localhost',
  /** Range used when auto-assigning public TCP ports for databases etc. */
  tcpPortStart: envInt('SERVIFY_TCP_PORT_START', 15400),
  /** Extra hostnames allowed to reach the dashboard (DNS-rebinding protection). */
  allowedHosts: (process.env.SERVIFY_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  /** Set to "none" to disable dashboard auth entirely (only sensible on a single-user machine). */
  authMode: (process.env.SERVIFY_AUTH ?? 'password') as 'password' | 'none',
  /** When Servify itself runs inside Docker it talks to replicas over the bridge network. */
  /** Where `servify agent` on other servers connects (TLS). Started only once a server is added. */
  agentHost: process.env.SERVIFY_AGENT_HOST ?? '0.0.0.0',
  agentPort: envInt('SERVIFY_AGENT_PORT', 7701),
  /** Address other servers use to reach this one (shown in the join command). Defaults to the first LAN IPv4. */
  agentPublicHost: process.env.SERVIFY_AGENT_PUBLIC_HOST ?? '',
  /** Folders services may mount from the host (comma-separated). Empty = host folders are off. */
  hostMounts: (process.env.SERVIFY_HOST_MOUNTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => resolve(s.replace(/^~(?=$|\/)/, homedir()))),
  /** Proxies in front of Servify (IPs or IPv4 CIDRs, comma-separated) whose X-Forwarded-Proto is believed. */
  trustedProxies: (process.env.SERVIFY_TRUSTED_PROXIES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  inContainer: existsSync('/.dockerenv') || process.env.SERVIFY_IN_CONTAINER === '1',
  webDist: resolve(import.meta.dirname, '../../web/dist'),
  /** One source for the version: the root package.json (a release package ships it too). */
  version: readVersion(),
};

for (const dir of [config.dataDir, config.buildsDir, config.logsDir]) {
  mkdirSync(dir, { recursive: true });
}
