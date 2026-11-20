/** Background jobs: autoscaling, git auto-deploy polling, image garbage collection. */
import { services as servicesTable, deployments as deploymentsTable } from './db.ts';
import { metricsHistory } from './metrics.ts';
import { recordActivity, SYSTEM, type Actor } from './events.ts';
import { updateService, deployService } from './ops.ts';
import { latestCommit } from './builder.ts';
import { isDeploying } from './deployer.ts';
import { docker } from './docker.ts';
import { db } from './db.ts';
import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';

const AUTOSCALER: Actor = { type: 'system', name: 'autoscaler' };
const GIT: Actor = { type: 'system', name: 'git-watcher' };
const lastScale = new Map<string, number>();

async function autoscale() {
  for (const svc of servicesTable.all()) {
    const a = svc.autoscale;
    if (!a?.enabled || svc.stopped || !svc.activeDeploymentId || isDeploying(svc.id) || svc.volumes.length) continue;
    const pts = metricsHistory(svc.id, 30);
    if (pts.length < 10) continue;
    const current = Math.max(1, svc.replicas);
    const avgTotal = pts.reduce((s, p) => s + (a.metric === 'cpu' ? p.cpu : p.rps), 0) / pts.length;
    const perReplica = avgTotal / current;
    let desired = Math.ceil(avgTotal / Math.max(0.001, a.target));
    desired = Math.min(a.max, Math.max(a.min, desired || a.min));
    // Step down gently (at most halve per step) so a quiet minute doesn't drop all capacity at once.
    if (desired < current) desired = Math.max(desired, Math.floor(current / 2), a.min);
    if (desired === current) continue;
    const since = Date.now() - (lastScale.get(svc.id) ?? 0);
    // Scale up quickly, scale down conservatively.
    if (desired > current && since < 20_000) continue;
    if (desired < current && (since < 60_000 || perReplica > a.target * 0.6)) continue;
    lastScale.set(svc.id, Date.now());
    try {
      await updateService(AUTOSCALER, svc.id, { replicas: desired }, { quiet: true });
      recordActivity(
        AUTOSCALER,
        'service.autoscaled',
        `Autoscaled ${svc.name} ${current} → ${desired} (${a.metric === 'cpu' ? `${perReplica.toFixed(0)}% CPU` : `${perReplica.toFixed(1)} req/s`} per replica)`,
        svc.projectId,
        svc.id,
      );
    } catch (e) {
      console.error('[autoscale]', (e as Error).message);
    }
  }
}

async function gitWatch() {
  for (const svc of servicesTable.all()) {
    if (!svc.autoDeploy || svc.source.type !== 'git' || svc.stopped || isDeploying(svc.id)) continue;
    const deps = deploymentsTable.all('WHERE service_id = ? ORDER BY created_at DESC LIMIT 5', svc.id);
    const latestDep = deps[0];
    if (!latestDep || ['queued', 'building', 'deploying'].includes(latestDep.status)) continue;
    const lastSha = deps.find((d) => d.commitSha)?.commitSha;
    if (!lastSha) continue;
    const head = await latestCommit(svc.source.repo, svc.source.branch, svc.source.token);
    if (!head || head === lastSha) continue;
    if (deps.some((d) => d.commitSha === head && d.status === 'failed')) continue; // don't loop on a broken commit
    recordActivity(GIT, 'git.push', `New commit ${head.slice(0, 7)} on ${svc.name} — deploying`, svc.projectId, svc.id);
    deployService(GIT, svc.id, 'git');
  }
}

async function imageGc() {
  // Keep the 5 most recent built images per service for instant rollbacks.
  for (const svc of servicesTable.all()) {
    const deps = deploymentsTable.all('WHERE service_id = ? ORDER BY created_at DESC', svc.id).filter((d) => d.image?.startsWith('servify/'));
    const keep = new Set(deps.slice(0, 5).map((d) => d.image));
    if (svc.activeDeploymentId) keep.add(deploymentsTable.get(svc.activeDeploymentId)?.image ?? null);
    for (const d of deps.slice(5)) if (d.image && !keep.has(d.image)) await docker.removeImage(d.image);
  }
}

function housekeeping() {
  // Keep the audit trail bounded.
  db.prepare('DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY created_at DESC LIMIT 5000)').run();
  // Drop build logs whose deployment no longer exists (deleted services/projects).
  const known = new Set((db.prepare('SELECT id FROM deployments').all() as { id: string }[]).map((r) => r.id));
  for (const f of readdirSync(config.logsDir)) {
    const m = f.match(/^deploy-(dep_[a-z0-9]+)\.log$/);
    if (m && !known.has(m[1])) {
      try {
        unlinkSync(join(config.logsDir, f));
      } catch {}
    }
  }
}

export function startBackgroundJobs() {
  setTimeout(() => housekeeping(), 30_000);
  setInterval(() => housekeeping(), 60 * 60_000);
  setInterval(() => void autoscale().catch(() => {}), 10_000);
  setInterval(() => void gitWatch().catch(() => {}), 60_000);
  setInterval(() => void imageGc().catch(() => {}), 30 * 60_000);
  void SYSTEM;
}
