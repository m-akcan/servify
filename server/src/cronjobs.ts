/** Scheduled jobs: run a service's active image as a one-off container on its cron schedule. */
import { demuxLines } from './docker.ts';
import { dockerFor, nodeOf, onlineNodes } from './nodes.ts';
import { services as servicesTable, deployments as deploymentsTable, projects as projectsTable, runsTable } from './db.ts';
import type { JobRun, Service } from './types.ts';
import { bus, recordActivity, type Actor } from './events.ts';
import { id, HttpError } from './util.ts';
import { networkName, volumeName, LABEL, INSTANCE_ID, deployedSchedule } from './engine.ts';

/** A run that outlives this is killed (a long-lived server image armed as a job by mistake, a hang…). */
const MAX_RUNTIME_MS = Number(process.env.SERVIFY_JOB_MAX_SECONDS ?? 3600) * 1000;
import { parseCron, cronMatches } from './cron.ts';
import { notify } from './notify.ts';
import { mountsFor } from './volumes.ts';

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
  if (!deployedSchedule(svc, dep)) throw new HttpError(400, `${svc.name} is not a scheduled job (set a schedule and deploy first)`);
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
  bus.publish({ type: 'service.updated', service: svc });
  let cid: string | null = null;
  const docker = dockerFor(nodeOf(svc)); // jobs run on the service's server
  try {
    const network = networkName(project.id);
    await docker.ensureNetwork(network, { [LABEL.managed]: 'true', [LABEL.instance]: INSTANCE_ID, [LABEL.project]: project.id });
    const env = { ...((dep as any).resolvedEnv ?? dep.config.env), SERVIFY_JOB_RUN_ID: run.id };
    const spec: any = {
      Image: dep.image,
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      Labels: { 'servify.job': 'true', [LABEL.instance]: INSTANCE_ID, [LABEL.project]: project.id, [LABEL.service]: svc.id, 'servify.run': run.id },
      HostConfig: {
        Mounts: mountsFor(svc.id, dep.config.volumes, 0),
        NanoCpus: dep.config.resources.cpus ? Math.round(dep.config.resources.cpus * 1e9) : undefined,
        Memory: dep.config.resources.memoryMb ? dep.config.resources.memoryMb * 1024 * 1024 : undefined,
        Init: true,
      },
      NetworkingConfig: { EndpointsConfig: { [network]: {} } },
    };
    if (dep.config.startCommand) {
      spec.Entrypoint = ['/bin/sh', '-c'];
      spec.Cmd = [dep.config.startCommand];
    } else {
      if (dep.config.entrypoint?.length) spec.Entrypoint = dep.config.entrypoint;
      if (dep.config.cmd?.length) spec.Cmd = dep.config.cmd;
    }
    cid = await docker.createContainer(`svf-job-${svc.slug}-${run.id.slice(-6)}`, spec);
    await docker.startContainer(cid);
    const startedCid = cid;
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      void docker.killContainer(startedCid).catch(() => {});
    }, MAX_RUNTIME_MS);
    const exitCode = await docker.waitContainer(cid).finally(() => clearTimeout(killer));
    if (timedOut) run.output = `killed after ${Math.round(MAX_RUNTIME_MS / 1000)}s (max runtime)\n`;
    const lines: string[] = [];
    const res = await docker.logs(cid, { tail: 400, timestamps: false });
    for await (const f of demuxLines(res)) lines.push(f.text);
    run.exitCode = exitCode;
    run.output = run.output + lines.join('\n');
    run.status = exitCode === 0 ? 'succeeded' : 'failed';
  } catch (e) {
    run.status = 'failed';
    run.output = `${run.output}\n${(e as Error).message}`.trim();
  } finally {
    running.delete(svc.id);
    run.finishedAt = Date.now();
    save(run);
    const latest = servicesTable.get(svc.id);
    if (latest) bus.publish({ type: 'service.updated', service: latest });
    if (cid) await docker.removeContainer(cid, true).catch(() => {});
  }
  if (run.status === 'failed') {
    recordActivity(actor, 'job.failed', `${svc.name} run failed (exit ${run.exitCode ?? '?'})`, svc.projectId, svc.id);
    notify({
      event: 'job.failed',
      level: 'error',
      title: `Cron job ${svc.name} failed`,
      message: `${project.name}: exit code ${run.exitCode ?? '?'} (${trigger} run).\n\n${run.output.split('\n').slice(-10).join('\n')}`,
      projectId: svc.projectId,
      serviceId: svc.id,
    });
  }
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
    const schedule = deployedSchedule(svc);
    if (!schedule || svc.stopped || running.has(svc.id)) continue;
    try {
      if (cronMatches(parseCron(schedule), now)) void runJob(svc, 'schedule', SCHEDULER).catch(() => {});
    } catch {}
  }
}

/** Kill and remove any job containers of a service (used by stop / delete). */
export async function killJobs(serviceId: string) {
  for (const n of onlineNodes()) {
    const d = dockerFor(n);
    const list = await d.listContainers([`servify.job=true`, `${LABEL.service}=${serviceId}`]).catch(() => []);
    await Promise.allSettled(list.map((c) => d.removeContainer(c.Id, true)));
  }
}

export function startScheduler() {
  // Job containers can't be resumed after a restart: clean up this instance's leftovers.
  const local = dockerFor(null);
  void local
    .listContainers([`servify.job=true`, `${LABEL.instance}=${INSTANCE_ID}`])
    .then((list) => Promise.allSettled(list.map((c) => local.removeContainer(c.Id, true))))
    .catch(() => {});
  // Mark runs interrupted by a restart, then check the clock every few seconds.
  for (const r of runsTable.all(`WHERE json_extract(data, '$.status') = 'running'`)) {
    r.status = 'failed';
    r.finishedAt = Date.now();
    r.output = `${r.output}\ninterrupted: Servify restarted`.trim();
    runsTable.put(r);
  }
  setInterval(tick, 5000);
}
