/** Scheduled jobs: run a service's active image as a one-off container on its cron schedule. */
import { docker, demuxLines } from './docker.ts';
import { services as servicesTable, deployments as deploymentsTable, projects as projectsTable, runsTable } from './db.ts';
import type { JobRun, Service } from './types.ts';
import { bus, recordActivity, type Actor } from './events.ts';
import { id, HttpError } from './util.ts';
import { networkName, volumeName, LABEL, INSTANCE_ID } from './engine.ts';
import { parseCron, cronMatches } from './cron.ts';

const running = new Set<string>();
const SCHEDULER: Actor = { type: 'system', name: 'scheduler' };

function save(run: JobRun) {
  runsTable.put(run);
  bus.publish({ type: 'job.run', run });
}

export function isJobRunning(serviceId: string) {
  return running.has(serviceId);
}

export async function runJob(svc: Service, trigger: JobRun['trigger'], actor: Actor): Promise<JobRun> {
  if (running.has(svc.id)) throw new HttpError(409, `${svc.name} is already running`);
  const dep = svc.activeDeploymentId ? deploymentsTable.get(svc.activeDeploymentId) : null;
  if (!dep?.image) throw new HttpError(400, `deploy ${svc.name} before running it`);
  const project = projectsTable.get(svc.projectId);
  if (!project) throw new HttpError(404, 'project missing');
  running.add(svc.id);
  const run: JobRun = {
    id: id('run'),
    serviceId: svc.id,
    projectId: svc.projectId,
    status: 'running',
    trigger,
    actor: actor.name,
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    output: '',
    createdAt: Date.now(),
  };
  runsTable.insert(run);
  bus.publish({ type: 'job.run', run });
  let cid: string | null = null;
  try {
    const network = networkName(project.id);
    await docker.ensureNetwork(network, { [LABEL.managed]: 'true', [LABEL.instance]: INSTANCE_ID, [LABEL.project]: project.id });
    const env = { ...((dep as any).resolvedEnv ?? dep.config.env), SERVIFY_JOB_RUN_ID: run.id };
    const spec: any = {
      Image: dep.image,
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      Labels: { 'servify.job': 'true', [LABEL.instance]: INSTANCE_ID, [LABEL.project]: project.id, [LABEL.service]: svc.id, 'servify.run': run.id },
      HostConfig: {
        Mounts: dep.config.volumes.map((v) => ({ Type: 'volume', Source: volumeName(svc.id, v.name), Target: v.mountPath })),
        NanoCpus: dep.config.resources.cpus ? Math.round(dep.config.resources.cpus * 1e9) : undefined,
        Memory: dep.config.resources.memoryMb ? dep.config.resources.memoryMb * 1024 * 1024 : undefined,
        Init: true,
      },
      NetworkingConfig: { EndpointsConfig: { [network]: {} } },
    };
    if (dep.config.startCommand) {
      spec.Entrypoint = ['/bin/sh', '-c'];
      spec.Cmd = [dep.config.startCommand];
    }
    cid = await docker.createContainer(`svf-job-${svc.slug}-${run.id.slice(-6)}`, spec);
    await docker.startContainer(cid);
    const exitCode = await docker.waitContainer(cid);
    const lines: string[] = [];
    const res = await docker.logs(cid, { tail: 400, timestamps: false });
    for await (const f of demuxLines(res)) lines.push(f.text);
    run.exitCode = exitCode;
    run.output = lines.join('\n');
    run.status = exitCode === 0 ? 'succeeded' : 'failed';
  } catch (e) {
    run.status = 'failed';
    run.output = `${run.output}\n${(e as Error).message}`.trim();
  } finally {
    running.delete(svc.id);
    run.finishedAt = Date.now();
    save(run);
    if (cid) await docker.removeContainer(cid, true).catch(() => {});
  }
  if (run.status === 'failed') recordActivity(actor, 'job.failed', `${svc.name} run failed (exit ${run.exitCode ?? '?'})`, svc.projectId, svc.id);
  else if (trigger !== 'schedule') recordActivity(actor, 'job.run', `Ran ${svc.name} (exit 0)`, svc.projectId, svc.id);
  // Keep the run history bounded.
  const old = runsTable.all('WHERE service_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 100', svc.id);
  for (const r of old) runsTable.delete(r.id);
  return run;
}

export function listRuns(serviceId: string, limit = 30): JobRun[] {
  return runsTable.all('WHERE service_id = ? ORDER BY created_at DESC LIMIT ?', serviceId, limit);
}

let lastMinute = -1;
function tick() {
  const now = new Date();
  const minute = Math.floor(now.getTime() / 60_000);
  if (minute === lastMinute) return;
  lastMinute = minute;
  for (const svc of servicesTable.all()) {
    if (!svc.schedule || svc.stopped || !svc.activeDeploymentId || running.has(svc.id)) continue;
    try {
      if (cronMatches(parseCron(svc.schedule), now)) void runJob(svc, 'schedule', SCHEDULER).catch(() => {});
    } catch {}
  }
}

export function startScheduler() {
  // Mark runs interrupted by a restart, then check the clock every few seconds.
  for (const r of runsTable.all(`WHERE json_extract(data, '$.status') = 'running'`)) {
    r.status = 'failed';
    r.finishedAt = Date.now();
    r.output = `${r.output}\ninterrupted: Servify restarted`.trim();
    runsTable.put(r);
  }
  setInterval(tick, 5000);
}
