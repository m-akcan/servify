/** The projects page's overview: each server's live usage and Servify's own numbers. */
import { backupsTable, projects as projectsTable, services as servicesTable } from './db.ts';
import { dockerFor, listServers, nodeOf } from './nodes.ts';
import { latestMetrics } from './metrics.ts';
import { listCertificates } from './certs.ts';
import { localInfo, servifyProcessStats } from './hoststats.ts';
import { replicasOf } from './engine.ts';
import type { Overview } from './types.ts';

const DAY = 86_400_000;
const infoCache = new Map<string, { at: number; info: any }>();

/** `docker info` per server, cached for 15 s and given up on after 3 s. */
async function dockerInfo(nodeId: string): Promise<any | null> {
  const hit = infoCache.get(nodeId);
  if (hit && Date.now() - hit.at < 15_000) return hit.info;
  const info = await Promise.race([dockerFor(nodeId).info(), new Promise((r) => setTimeout(() => r(null), 3000))]).catch(() => null);
  infoCache.set(nodeId, { at: Date.now(), info });
  return info;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export async function overview(): Promise<Overview> {
  const services = servicesTable.all();
  const metrics = new Map(services.map((s) => [s.id, latestMetrics(s.id)]));
  const servers = await Promise.all(
    listServers().map(async (srv) => {
      const info = srv.status === 'online' ? await dockerInfo(srv.id) : null;
      const facts = srv.local ? { ...localInfo(), dockerVersion: info?.ServerVersion ?? '', agentVersion: '', address: null } : srv.info;
      // Container CPU counts like Docker (100 = one core); share of the whole machine is that over its cores.
      let cpu = 0;
      let mem = 0;
      for (const s of services) {
        if (nodeOf(s) !== srv.id) continue;
        const m = metrics.get(s.id);
        if (m) {
          cpu += m.cpu;
          mem += m.memMb;
        }
      }
      return {
        ...srv,
        info: facts,
        containers: info ? { running: Number(info.ContainersRunning) || 0, total: Number(info.Containers) || 0 } : null,
        managed: { cpuPct: round1(cpu / Math.max(1, facts?.cpus ?? 1)), memMb: Math.round(mem) },
        os: info?.OperatingSystem ?? facts?.os ?? null,
        dockerVersion: info?.ServerVersion ?? facts?.dockerVersion ?? null,
      };
    }),
  );

  let rps = 0;
  let errors = 0;
  for (const m of metrics.values()) {
    if (!m) continue;
    rps += m.rps;
    errors += m.errors;
  }
  const certs = listCertificates();
  const recentBackups = backupsTable.all('WHERE created_at > ?', Date.now() - DAY);
  const proc = servifyProcessStats();
  return {
    servers,
    servify: {
      version: proc.version,
      uptimeSec: proc.uptimeSec,
      cpuPct: proc.cpuPct,
      rssBytes: proc.rssBytes,
      projects: projectsTable.all().filter((p) => !p.parentId).length,
      services: services.length,
      replicas: services.reduce((n, s) => n + replicasOf(s.id).length, 0),
      rps: round1(rps),
      errorsPerSec: round1(errors),
      certificates: { total: certs.length, expiringSoon: certs.filter((c) => c.status === 'issued' && c.expiresAt != null && c.expiresAt - Date.now() < 14 * DAY).length },
      backups24h: { succeeded: recentBackups.filter((b) => b.status === 'succeeded').length, failed: recentBackups.filter((b) => b.status === 'failed').length },
    },
  };
}
