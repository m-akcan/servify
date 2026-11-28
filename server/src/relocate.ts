/**
 * "Move to <server>…" for services with volumes: the data goes along.
 *
 *   1. The service stops on its server (downtime starts; deploys queued meanwhile wait, then give way to the move).
 *   2. Each volume is copied as a plain tar stream: a throwaway helper reads it on the old server, another writes it
 *      into a fresh Docker volume on the new one; the bytes pass through this machine (agent streams). Both ends must
 *      exit cleanly and the file counts must match.
 *   3. The volume records and the service switch to the new server in one step, and the running version is rolled out
 *      there (images are copied across like any move). Routing, health checks and the mesh follow the replicas.
 *   4. Only a healthy start finishes the move. The old Docker volumes are never touched: they stay on the old server as
 *      detached "source copies" until someone deletes them. Any failure before that switches everything back and the
 *      service starts again on its old server, on its untouched data.
 *
 * The move is written to the service record before anything happens, so a restart in the middle rolls it back at boot.
 */
import { Transform } from 'node:stream';
import { services as servicesTable, volumesTable, deployments as deploymentsTable, projects as projectsTable, kv } from './db.ts';
import type { Service, ServiceMove, VolumeRecord } from './types.ts';
import { dockerFor, isOnline, nodeName, nodeOf, LOCAL, onNodeChange } from './nodes.ts';
import { busy, drainAndRemove, replicasOf, requestReconcile, refreshServiceStatus, INSTANCE_ID, LABEL } from './engine.ts';
import { bus, recordActivity, type Actor } from './events.ts';
import { notify } from './notify.ts';
import { HttpError, assert, id, sleep } from './util.ts';
import { ensureDockerVolume, membersOf, measureVolumes, knownVolumeSize, borrowersOf, freeSpot, ownedMounts, legacyDockerName } from './volumes.ts';
import { diskBlock, dockerDisk } from './diskguard.ts';
import { queueDeployment, deployPending } from './deployer.ts';
import { backupLockHeld, isRestoring, cli, cliText, ensureHelper, HELPER_IMAGE } from './backups.ts';
import { killJobs, isJobRunning } from './cronjobs.ts';
import { referencedServices } from './vars.ts';

const MARK = 'move'; // in engine.busy: the reconciler leaves the service alone while it moves
const ACTIVE: ServiceMove['phase'][] = ['stopping', 'copying', 'starting', 'rolling-back'];
const DEPLOY_WAIT_MS = 45 * 60_000;
const LEFTOVERS = 'move_leftovers';

/** Services whose data is being copied: their deploys wait (runDeployment). */
const copying = new Set<string>();
export const isCopyingData = (serviceId: string) => copying.has(serviceId);
export const isMoving = (s: Service | null | undefined) => !!s?.move && ACTIVE.includes(s.move.phase);

const fmt = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`);
const nid = (n: string) => (n === LOCAL ? null : n);

// ───────────────────────────── what moves, and whether it can ─────────────────────────────

/** The volume records a service owns (per-replica sets with all their members). */
function ownedRecords(svc: Service): VolumeRecord[] {
  const out: VolumeRecord[] = [];
  for (const m of ownedMounts(svc.volumes)) {
    const rec = m.volumeId ? volumesTable.get(m.volumeId) : volumesTable.all().find((r) => r.dockerName === legacyDockerName(svc.id, m.name));
    if (rec) out.push(...membersOf(rec));
  }
  return out;
}

export type MovePlan = {
  service: { id: string; name: string; stopped: boolean };
  from: { id: string; name: string; online: boolean };
  to: { id: string; name: string; online: boolean };
  volumes: { id: string; name: string; mountPath: string; members: number; sizeBytes: number | null }[];
  /** Bytes to copy (null = Docker couldn't measure them) and room on the new server's Docker disk (null = unknown). */
  bytesTotal: number | null;
  targetFreeBytes: number | null;
  /** Reasons it can't move now; empty = it can. */
  blockers: string[];
  warnings: string[];
};

/** What a move would take: the data, the room on the new server, and what stands in the way. Changes nothing. */
export async function movePlan(svc: Service, target: string): Promise<MovePlan> {
  const from = nodeOf(svc);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const toName = nodeName(target);
  const fromName = nodeName(from);
  if (target === from) blockers.push(`${svc.name} already runs on ${toName}`);
  if (!isOnline(target)) blockers.push(`${toName} is offline`);
  if (!isOnline(from)) blockers.push(`${fromName} is offline, so its data can't be read`);
  if (svc.source.type === 'external' || svc.source.type === 'redirect') blockers.push(`${svc.name} is a route: it has no data to move`);
  if (svc.cluster) blockers.push(`${svc.name} is a replicated database cluster: its members keep their own copies of the data, which Servify doesn't move — back it up and restore it into a new database on ${toName} instead`);
  if (isMoving(svc)) blockers.push(`${svc.name} is already moving`);
  else if (deployPending(svc.id)) blockers.push(`${svc.name} is deploying — move it when that's done`);
  if (backupLockHeld(svc.id) || isRestoring(svc.id)) blockers.push(`a backup or restore of ${svc.name} is running — move it when that's done`);
  if (isJobRunning(svc.id)) warnings.push(`a scheduled run of ${svc.name} is in progress: it is stopped for the move`);

  for (const m of svc.volumes) {
    if (m.hostPath) blockers.push(`${svc.name} mounts the host folder ${m.hostPath} at ${m.mountPath}. A host folder is part of ${fromName}'s own disk, so Servify can't take it along — copy the folder to the other machine yourself and point the mount there, or replace it with a volume first.`);
    else if (m.borrowed) {
      const owner = m.volumeId ? volumesTable.get(m.volumeId) : null;
      blockers.push(`${svc.name} mounts ${m.name}${owner?.serviceId ? ` (owned by ${servicesTable.get(owner.serviceId)?.name ?? 'another service'})` : ''} read-only at ${m.mountPath}. Read-only shares only work on one server — remove that mount first.`);
    }
  }
  const records = ownedRecords(svc);
  const leaders = records.filter((r) => !r.setId || r.setId === r.id);
  for (const v of leaders) {
    if (v.adopted) blockers.push(`${v.name} was taken over from an existing Docker volume on ${fromName}: its data predates Servify and may still be used outside it, so Servify doesn't copy it to another machine. Back it up and restore it into a service on ${toName} instead.`);
    const borrowers = borrowersOf(v);
    if (borrowers.length) blockers.push(`${borrowers.map((b) => b.name).join(', ')} mount${borrowers.length === 1 ? 's' : ''} ${v.name} read-only. Shares only work on one server — remove ${borrowers.length === 1 ? 'that mount' : 'those mounts'} first.`);
    if (nodeOf(v) !== from) blockers.push(`${v.name} is stored on ${nodeName(nodeOf(v))}, not on ${fromName} where ${svc.name} runs — fix that first`);
  }

  // How much there is, and whether it fits.
  let bytesTotal: number | null = null;
  if (records.length && isOnline(from)) bytesTotal = await measureVolumes(nid(from), records.map((r) => r.dockerName)).catch(() => null);
  const disk = isOnline(target) ? dockerDisk(nid(target)) : null;
  const targetFreeBytes = disk?.freeBytes ?? null;
  const protect = disk?.protectBytes ?? 0;
  const full = isOnline(target) ? diskBlock('pull', nid(target)) : null;
  if (full) blockers.push(full.replace('image pulls are refused', 'copying data onto it is refused'));
  else if (bytesTotal != null && targetFreeBytes != null) {
    if (bytesTotal > targetFreeBytes - protect) blockers.push(`the data needs ${fmt(bytesTotal)}, and ${toName}'s Docker disk has ${fmt(targetFreeBytes)} free${protect ? ` (Servify keeps ${fmt(protect)} of it in reserve)` : ''} — free space there first`);
    else if (disk?.warnBytes != null && targetFreeBytes - bytesTotal < disk.warnBytes) warnings.push(`after the copy ${toName}'s Docker disk is low on space (${fmt(targetFreeBytes - bytesTotal)} left)`);
  } else if (records.length) {
    warnings.push(bytesTotal == null ? `Docker couldn't tell how big the data is, so Servify can't check that it fits on ${toName}` : `${toName} hasn't reported its free disk space, so Servify can't check that ${fmt(bytesTotal)} fits there`);
  }

  // What changes for the people and services using it.
  const running = !svc.stopped && !!svc.activeDeploymentId;
  if (running) warnings.push(`${svc.name} is down while it moves: it stops on ${fromName}, its data${bytesTotal != null ? ` (${fmt(bytesTotal)})` : ''} is copied, and it starts on ${toName}. If it doesn't start healthy there, it goes back to ${fromName}.`);
  else if (svc.stopped) warnings.push(`${svc.name} is stopped: its data moves now, and it starts on ${toName} the next time you start it`);
  else warnings.push(`${svc.name} hasn't been deployed yet: only its volumes move`);
  for (const p of svc.ports ?? []) warnings.push(`the published port ${p.host}/${p.protocol} moves to ${toName}: clients have to connect to that machine's address instead of ${fromName}'s. If the port is taken there, the move rolls back.`);
  const siblings = servicesTable.all('WHERE project_id = ?', svc.projectId);
  const linked = new Set([...referencedServices(svc, siblings), ...siblings.filter((s) => referencedServices(s, siblings).includes(svc.id)).map((s) => s.id)]);
  const apart = siblings.filter((s) => linked.has(s.id) && nodeOf(s) !== target).map((s) => s.name);
  if (apart.length) warnings.push(`${apart.join(', ')} ${apart.length === 1 ? 'stays' : 'stay'} on another server: connections between them and ${svc.name} are relayed through this machine (main port only), a little slower`);

  return {
    service: { id: svc.id, name: svc.name, stopped: !!svc.stopped },
    from: { id: from, name: fromName, online: isOnline(from) },
    to: { id: target, name: toName, online: isOnline(target) },
    volumes: leaders.map((v) => {
      const members = records.filter((r) => (v.setId ? r.setId === v.setId : r.id === v.id));
      return { id: v.id, name: v.name, mountPath: v.mountPath, members: members.length, sizeBytes: knownVolumeSize(members.map((x) => x.dockerName)) ?? v.sizeBytes };
    }),
    bytesTotal,
    targetFreeBytes,
    blockers,
    warnings,
  };
}

// ───────────────────────────── state ─────────────────────────────

let lastPublish = 0;
/** Update the move on the service record (persisted: boot recovery reads it) and tell the dashboards. */
function setMove(serviceId: string, patch: Partial<ServiceMove>, force = true) {
  const s = servicesTable.get(serviceId);
  if (!s?.move) return;
  s.move = { ...s.move, ...patch };
  if (!force && Date.now() - lastPublish < 1000) return void servicesTable.put(s);
  lastPublish = Date.now();
  servicesTable.put(s);
  bus.publish({ type: 'service.updated', service: s });
}

function saveVolume(v: VolumeRecord) {
  v.updatedAt = Date.now();
  if (volumesTable.get(v.id)) volumesTable.put(v);
  else volumesTable.insert(v);
  bus.publish({ type: 'volume.updated', volume: v });
}

function hold(serviceId: string) {
  const set = busy.get(serviceId) ?? new Set<string>();
  set.add(MARK);
  busy.set(serviceId, set);
}
function release(serviceId: string) {
  const set = busy.get(serviceId);
  if (!set) return;
  set.delete(MARK);
  if (!set.size) busy.delete(serviceId);
}

// ───────────────────────────── the move ─────────────────────────────

/** Start moving a service with its data. Returns at once; progress is on `service.move`. */
export async function startDataMove(actor: Actor, svc: Service, target: string): Promise<Service> {
  const plan = await movePlan(svc, target);
  if (plan.blockers.length) throw new HttpError(409, `${svc.name} can't move to ${plan.to.name}: ${plan.blockers.join('; ')}`);
  const fresh = servicesTable.get(svc.id)!;
  assert(!isMoving(fresh) && !deployPending(fresh.id), 409, `${fresh.name} is busy — try again in a moment`);
  const from = nodeOf(fresh);
  const records = ownedRecords(fresh);
  fresh.move = {
    phase: 'stopping',
    from: nid(from),
    to: nid(target),
    fromName: nodeName(from),
    toName: nodeName(target),
    wasRunning: !fresh.stopped && !!fresh.activeDeploymentId,
    startedAt: Date.now(),
    finishedAt: null,
    bytesTotal: plan.bytesTotal,
    bytesDone: 0,
    current: null,
    volumes: records.map((r) => ({ id: r.id, name: r.name, fromDocker: r.dockerName, toDocker: `svf-vol-${id('vol').slice(4)}`, copyId: null, existed: true })),
    deploymentId: null,
    message: null,
    error: null,
    actor: actor.name,
  };
  fresh.status = 'deploying';
  fresh.updatedAt = Date.now();
  hold(fresh.id); // before the record says it moves: from here on the reconciler keeps its hands off
  copying.add(fresh.id);
  servicesTable.put(fresh);
  bus.publish({ type: 'service.updated', service: fresh });
  recordActivity(actor, 'service.moving', `Moving ${fresh.name} with its data from ${nodeName(from)} to ${nodeName(target)} (${plan.bytesTotal != null ? fmt(plan.bytesTotal) : 'size unknown'}) — it is down while it moves`, fresh.projectId, fresh.id);
  void runMove(actor, fresh.id).catch((e) => console.error(`[move] ${fresh.name}:`, (e as Error).message));
  return fresh;
}

async function runMove(actor: Actor, serviceId: string) {
  const start = servicesTable.get(serviceId)!;
  const m = start.move!;
  const from = m.from ?? LOCAL;
  const to = m.to ?? LOCAL;
  let switched = false;
  try {
    // ─── 1. stop ───
    await drainAndRemove(replicasOf(serviceId).map((r) => r.containerId), 3000);
    await killJobs(serviceId);
    // Whatever the old server still runs of it (a container the reconciler hasn't seen yet) must not write meanwhile.
    for (const v of m.volumes) {
      const users = await dockerFor(from).containersUsingVolume(v.fromDocker, true);
      const ours = users.filter((c) => c.Labels?.[LABEL.instance] === INSTANCE_ID);
      for (const c of ours) await dockerFor(from).removeContainer(c.Id, true).catch(() => {});
      const foreign = users.filter((c) => c.Labels?.[LABEL.instance] !== INSTANCE_ID);
      if (foreign.length) throw new Error(`${v.name} is used by ${foreign.map((c) => c.Names?.[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12)).join(', ')} outside Servify — stop that first`);
    }

    // ─── 2. copy ───
    setMove(serviceId, { phase: 'copying' });
    await Promise.all([ensureHelper({ nodeId: nid(from) }), ensureHelper({ nodeId: nid(to) })]);
    const existing = new Set(((await dockerFor(from).listVolumes()) as any[]).map((v) => v.Name as string));
    let done = 0;
    const volumes = m.volumes.map((v) => ({ ...v, existed: existing.has(v.fromDocker) }));
    setMove(serviceId, { volumes });
    for (const v of volumes) {
      const rec = volumesTable.get(v.id);
      if (!rec) throw new Error(`volume ${v.name} disappeared during the move`);
      await ensureDockerVolume({ ...rec, nodeId: nid(to), dockerName: v.toDocker });
      if (!v.existed) continue; // never used yet: an empty volume on the new server is all it needs
      setMove(serviceId, { current: v.name });
      await copyVolume(from, to, v.fromDocker, v.toDocker, (n) => {
        done += n;
        setMove(serviceId, { bytesDone: done }, false);
      });
      const [a, b] = await Promise.all([countEntries(from, v.fromDocker), countEntries(to, v.toDocker)]);
      if (a !== b) throw new Error(`the copy of ${v.name} is incomplete (${b} of ${a} files and folders arrived)`);
    }
    setMove(serviceId, { bytesDone: done, current: null });

    // ─── 3. switch (one synchronous step) ───
    switchOver(serviceId, to);
    switched = true;
    copying.delete(serviceId);

    const svc = servicesTable.get(serviceId)!;
    const active = svc.activeDeploymentId ? deploymentsTable.get(svc.activeDeploymentId) : null;
    if (!m.wasRunning || !active) {
      finish(actor, serviceId, `${svc.name} and its data are on ${m.toName}. ${m.wasRunning || !svc.stopped ? '' : `It starts there the next time you start it. `}The old data stays on ${m.fromName} as a copy until you delete it.`);
      return;
    }
    // ─── 4. start there ───
    setMove(serviceId, { phase: 'starting' });
    const dep = active.image ? queueDeployment(svc, 'config', actor, { image: active.image, port: active.port, fromDeployment: active }) : queueDeployment(svc, 'config', actor);
    setMove(serviceId, { deploymentId: dep.id });
    const deadline = Date.now() + DEPLOY_WAIT_MS;
    let status = dep.status;
    while (Date.now() < deadline) {
      status = deploymentsTable.get(dep.id)?.status ?? 'cancelled';
      if (!['queued', 'building', 'deploying'].includes(status)) break;
      await sleep(1000);
    }
    if (status !== 'active' && status !== 'superseded') {
      const err = deploymentsTable.get(dep.id)?.error;
      throw new Error(status === 'cancelled' ? `the deploy on ${m.toName} was cancelled` : ['queued', 'building', 'deploying'].includes(status) ? `${svc.name} didn't come up on ${m.toName} within ${DEPLOY_WAIT_MS / 60_000} minutes` : `it didn't start healthy on ${m.toName}: ${err ?? 'the deploy failed'}`);
    }
    finish(actor, serviceId, `${svc.name} runs on ${m.toName} with its data. The old data stays on ${m.fromName} as a copy until you delete it.`);
  } catch (e) {
    await rollBack(actor, serviceId, switched, (e as Error).message || String(e));
  } finally {
    copying.delete(serviceId);
    release(serviceId);
    refreshServiceStatus(serviceId);
    requestReconcile();
  }
}

/** Stream one Docker volume from a server into another (plain tar, so the bytes counted match the measured size). */
async function copyVolume(from: string, to: string, src: string, dst: string, onBytes: (n: number) => void) {
  const pipe = new Transform({
    transform(chunk: Buffer, _e, cb) {
      onBytes(chunk.length);
      cb(null, chunk);
    },
  });
  let readerDone = false;
  const run = ['run', '--rm', '--log-driver', 'none', '--network', 'none'];
  const reader = cli({ nodeId: nid(from) }, [...run, '-v', `${src}:/from:ro`, HELPER_IMAGE, 'tar', 'cf', '-', '-C', '/from', '.'], { stdout: pipe }).then(
    (r) => {
      readerDone = true;
      if (r.code !== 0) {
        const err = new Error(`reading the data on ${nodeName(from)} failed (tar exited with ${r.code}): ${r.stderr.slice(-300)}`);
        pipe.destroy(err); // never a clean end: the writer must not take a cut-off archive for a whole one
        throw err;
      }
      pipe.end();
    },
    (e) => {
      readerDone = true;
      pipe.destroy(e);
      throw e;
    },
  );
  const writer = cli({ nodeId: nid(to) }, [...run, '-i', '-v', `${dst}:/to`, HELPER_IMAGE, 'tar', 'xf', '-', '--numeric-owner', '-C', '/to'], { stdin: pipe })
    .then((r) => {
      if (r.code !== 0) throw new Error(`writing the data on ${nodeName(to)} failed (tar exited with ${r.code}): ${r.stderr.slice(-300)}`);
    })
    .finally(() => {
      if (!readerDone) pipe.destroy(); // the reader stops when its output goes away
    });
  const [a, b] = await Promise.allSettled([reader, writer]);
  // The first real cause: a writer failure also breaks the reader's output, and the other way round.
  if (b.status === 'rejected' && (a.status === 'fulfilled' || /could not write the data/.test(String((a.reason as Error)?.message)))) throw b.reason;
  if (a.status === 'rejected') throw a.reason;
  if (b.status === 'rejected') throw b.reason;
}

async function countEntries(node: string, volume: string): Promise<number> {
  const r = await cliText({ nodeId: nid(node) }, ['run', '--rm', '--log-driver', 'none', '--network', 'none', '-v', `${volume}:/v:ro`, HELPER_IMAGE, 'sh', '-c', 'find /v | wc -l']);
  if (r.code !== 0) throw new Error(`could not check ${volume} on ${nodeName(node)}: ${r.stderr.slice(-200)}`);
  return Number(r.stdout.trim());
}

/** Point the volumes and the service at the new server; the old Docker volumes become detached source copies. */
function switchOver(serviceId: string, to: string) {
  const svc = servicesTable.get(serviceId)!;
  const m = svc.move!;
  const now = Date.now();
  const copyIds = new Map<string, string>();
  for (const v of m.volumes) if (v.existed) copyIds.set(v.id, id('vol'));
  const names = new Map<string, string>();
  const taken = new Set(volumesTable.all('WHERE project_id = ?', svc.projectId).map((v) => v.name));
  const spot = freeSpot(svc.projectId, svc.x + 300, svc.y + 250);
  const volumes = m.volumes.map((v) => {
    const rec = volumesTable.get(v.id)!;
    const copyId = copyIds.get(v.id) ?? null;
    // Both sides hold the same bytes now (the new Docker volume is measured at the next size poll).
    rec.sizeBytes = knownVolumeSize([v.fromDocker]) ?? rec.sizeBytes;
    if (copyId) {
      const group = rec.setId ?? rec.id;
      let name = names.get(group);
      if (!name) {
        const base = `${rec.name}-before-move`.slice(0, 48);
        name = base;
        for (let i = 2; taken.has(name); i++) name = `${base.slice(0, 44)}-${i}`;
        taken.add(name);
        names.set(group, name);
      }
      saveVolume({
        ...rec,
        id: copyId,
        name,
        dockerName: v.fromDocker,
        nodeId: m.from,
        serviceId: null,
        lastServiceId: svc.id,
        detachedAt: now,
        adopted: false,
        setId: rec.setId ? (copyIds.get(rec.setId) ?? copyId) : null,
        ...spot,
        moveCopy: { serviceId: svc.id, serviceName: svc.name, volumeId: rec.setId ?? rec.id, toNodeId: m.to, movedAt: now },
        createdAt: now,
      });
    }
    rec.dockerName = v.toDocker;
    rec.nodeId = nid(to);
    saveVolume(rec);
    return { ...v, copyId };
  });
  svc.nodeId = nid(to);
  svc.move = { ...m, volumes };
  svc.updatedAt = now;
  servicesTable.put(svc);
  bus.publish({ type: 'service.updated', service: svc });
}

/** Undo the switch (records back to the old server, source copies forgotten — they are the live data again). */
function switchBack(svc: Service) {
  const m = svc.move!;
  for (const v of m.volumes) {
    const rec = volumesTable.get(v.id);
    if (rec) {
      rec.dockerName = v.fromDocker;
      rec.nodeId = m.from;
      saveVolume(rec);
    }
    const copy = v.copyId ? volumesTable.get(v.copyId) : null;
    if (copy) {
      volumesTable.delete(copy.id);
      bus.publish({ type: 'volume.deleted', volumeId: copy.id, projectId: copy.projectId });
    }
  }
  svc.nodeId = m.from;
  svc.move = { ...m, volumes: m.volumes.map((v) => ({ ...v, copyId: null })) };
  svc.updatedAt = Date.now();
  servicesTable.put(svc);
  bus.publish({ type: 'service.updated', service: svc });
}

function finish(actor: Actor, serviceId: string, message: string) {
  setMove(serviceId, { phase: 'done', finishedAt: Date.now(), message, current: null });
  const svc = servicesTable.get(serviceId)!;
  const m = svc.move!;
  recordActivity(actor, 'service.moved', `Moved ${svc.name} with its data from ${m.fromName} to ${m.toName} (${fmt(m.bytesDone)} copied in ${Math.round((Date.now() - m.startedAt) / 1000)}s)`, svc.projectId, svc.id);
  notify({ event: 'deploy.succeeded', level: 'success', title: `${svc.name} moved to ${m.toName}`, message: `${projectsTable.get(svc.projectId)?.name ?? ''}: ${message}`, projectId: svc.projectId, serviceId: svc.id });
}

async function rollBack(actor: Actor, serviceId: string, switched: boolean, reason: string) {
  copying.delete(serviceId);
  setMove(serviceId, { phase: 'rolling-back', error: reason, current: null });
  let svc = servicesTable.get(serviceId);
  if (!svc?.move) return;
  const m = svc.move;
  const to = m.to ?? LOCAL;
  const from = m.from ?? LOCAL;
  console.error(`[move] ${svc.name} → ${m.toName} failed, moving it back: ${reason}`);
  if (switched) switchBack(svc);
  // Whatever started on the new server goes, then the copies there (best effort: the old data was never touched).
  if (isOnline(to)) {
    await drainAndRemove(replicasOf(serviceId).filter((r) => r.nodeId === to).map((r) => r.containerId), 0).catch(() => {});
    for (const v of m.volumes) await removeOurVolume(to, v.toDocker).catch(() => rememberLeftover(to, v.toDocker));
  } else for (const v of m.volumes) rememberLeftover(to, v.toDocker);
  svc = servicesTable.get(serviceId)!;
  // Start it again where it was (the reconciler does, once the move lets go of it), and see that it comes back.
  let back = '';
  if (m.wasRunning && !svc.stopped) {
    release(serviceId);
    requestReconcile();
    const deadline = Date.now() + 120_000;
    let ok = false;
    while (Date.now() < deadline) {
      if (replicasOf(serviceId).some((r) => r.nodeId === from && r.state === 'healthy')) {
        ok = true;
        break;
      }
      await sleep(1500);
    }
    back = ok ? ` It runs on ${m.fromName} again.` : ` Servify is starting it on ${m.fromName} again — check that it came back.`;
  }
  const message = `${svc.name} stays on ${m.fromName} with its data untouched: ${reason}.${back}`;
  setMove(serviceId, { phase: 'failed', finishedAt: Date.now(), message });
  recordActivity(actor, 'service.move-failed', `Moving ${svc.name} to ${m.toName} failed and was rolled back: ${reason.slice(0, 200)}`, svc.projectId, svc.id);
  notify({ event: 'deploy.failed', level: 'error', title: `Moving ${svc.name} to ${m.toName} failed`, message: `${projectsTable.get(svc.projectId)?.name ?? ''}: ${message}`, projectId: svc.projectId, serviceId: svc.id });
}

/** Remove a Docker volume this move created (and containers of this Servify still holding it). */
async function removeOurVolume(node: string, dockerName: string) {
  const d = dockerFor(node);
  for (const c of await d.containersUsingVolume(dockerName, true)) {
    if (c.Labels?.[LABEL.instance] === INSTANCE_ID) await d.removeContainer(c.Id, true).catch(() => {});
  }
  const left = await d.containersUsingVolume(dockerName, true);
  if (left.length) throw new Error('still in use');
  await d.removeVolume(dockerName);
  if (((await d.listVolumes()) as any[]).some((v) => v.Name === dockerName)) throw new Error('not removed');
}

function rememberLeftover(node: string, dockerName: string) {
  const list = leftovers();
  if (!list.some((l) => l.node === node && l.dockerName === dockerName)) list.push({ node, dockerName });
  kv.set(LEFTOVERS, JSON.stringify(list));
  console.warn(`[move] the partial copy ${dockerName} on ${nodeName(node)} is removed once that server is reachable`);
}
function leftovers(): { node: string; dockerName: string }[] {
  try {
    return JSON.parse(kv.get(LEFTOVERS) ?? '[]');
  } catch {
    return [];
  }
}
async function cleanLeftovers(node: string) {
  const list = leftovers();
  const mine = list.filter((l) => l.node === node);
  if (!mine.length) return;
  const keep = list.filter((l) => l.node !== node);
  for (const l of mine) {
    // Never one a volume record points at (a later move may have reused nothing, but check anyway).
    if (volumesTable.all().some((v) => v.dockerName === l.dockerName && nodeOf(v) === node)) continue;
    await removeOurVolume(node, l.dockerName).then(
      () => console.log(`[move] removed the partial copy ${l.dockerName} on ${nodeName(node)}`),
      () => keep.push(l),
    );
  }
  kv.set(LEFTOVERS, JSON.stringify(keep));
}

// ───────────────────────────── boot, and what is left afterwards ─────────────────────────────

/**
 * Boot, before the reconciler starts: a move cut short by a restart is rolled back (records to the old server, whose
 * data was never touched) — unless its new deployment had already gone live there, which finishes it.
 */
export function recoverMoves() {
  for (const svc of servicesTable.all()) {
    if (!isMoving(svc)) continue;
    const m = svc.move!;
    const active = svc.activeDeploymentId ? deploymentsTable.get(svc.activeDeploymentId) : null;
    if ((svc.nodeId ?? null) === m.to && m.deploymentId && active?.id === m.deploymentId && active.status === 'active') {
      svc.move = { ...m, phase: 'done', finishedAt: Date.now(), message: `${svc.name} runs on ${m.toName} with its data. The old data stays on ${m.fromName} as a copy until you delete it.` };
      servicesTable.put(svc);
      continue;
    }
    if ((svc.nodeId ?? null) === m.to) switchBack(svc);
    for (const v of m.volumes) rememberLeftover(m.to ?? LOCAL, v.toDocker);
    const fresh = servicesTable.get(svc.id)!;
    fresh.move = { ...fresh.move!, phase: 'failed', finishedAt: Date.now(), error: 'Servify restarted during the move', message: `Servify restarted while ${svc.name} was moving: it stays on ${m.fromName} with its data untouched. Move it again when you like.` };
    servicesTable.put(fresh);
    console.log(`[move] ${svc.name}: the move to ${m.toName} was cut short by a restart — rolled back to ${m.fromName}`);
  }
  onNodeChange((node, online) => {
    if (online) void cleanLeftovers(node).catch(() => {});
  });
  setTimeout(() => void cleanLeftovers(LOCAL).catch(() => {}), 15_000).unref();
}

/** Forget a finished move's outcome (the banner in the dashboard). */
export function dismissMove(svc: Service) {
  assert(!isMoving(svc), 409, `${svc.name} is still moving`);
  const fresh = servicesTable.get(svc.id)!;
  fresh.move = null;
  servicesTable.put(fresh);
  bus.publish({ type: 'service.updated', service: fresh });
  return fresh;
}

function copyOrThrow(ref: string): VolumeRecord[] {
  const v = volumesTable.get(ref);
  assert(v, 404, 'volume not found');
  const leader = v.setId && v.setId !== v.id ? (volumesTable.get(v.setId) ?? v) : v;
  assert(leader.moveCopy, 400, `${leader.name} isn't a copy left behind by a move`);
  assert(!leader.serviceId, 409, `${leader.name} is attached to a service now — it's an ordinary volume; detach it to delete it`);
  const owner = servicesTable.get(leader.moveCopy.serviceId);
  assert(!isMoving(owner), 409, `${owner?.name ?? 'the service'} is still moving: this copy is what it goes back to if the move fails`);
  return membersOf(leader);
}

/** Delete the data a move left on the old server (asked for: never automatic). */
export async function discardMoveCopy(actor: Actor, ref: string) {
  const members = copyOrThrow(ref);
  const leader = members.find((x) => !x.setId || x.setId === x.id) ?? members[0];
  const node = nodeOf(leader);
  assert(isOnline(node), 409, `${nodeName(node)} is offline — delete the copy once it's back`);
  for (const x of members) {
    const users = await dockerFor(node).containersUsingVolume(x.dockerName, true);
    assert(!users.length, 409, `${leader.name} is still used by ${users.map((c) => c.Names?.[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12)).join(', ')}`);
  }
  for (const x of members) {
    await dockerFor(node).removeVolume(x.dockerName);
    volumesTable.delete(x.id);
    bus.publish({ type: 'volume.deleted', volumeId: x.id, projectId: x.projectId });
  }
  recordActivity(actor, 'volume.deleted', `Deleted ${leader.name}, the copy of ${leader.moveCopy!.serviceName}'s data left on ${nodeName(node)} by its move`, leader.projectId, leader.moveCopy!.serviceId);
  return { ok: true };
}

/** Keep the copy (it stays a detached volume; the offer to delete it goes away). */
export function keepMoveCopy(actor: Actor, ref: string) {
  const members = copyOrThrow(ref);
  for (const x of members) saveVolume({ ...x, moveCopy: { ...x.moveCopy!, keptAt: Date.now() } });
  const leader = members.find((x) => !x.setId || x.setId === x.id) ?? members[0];
  recordActivity(actor, 'volume.kept', `Keeping ${leader.name} on ${nodeName(nodeOf(leader))} as a copy of ${leader.moveCopy!.serviceName}'s data from before its move`, leader.projectId, leader.moveCopy!.serviceId);
  return volumesTable.get(leader.id);
}
