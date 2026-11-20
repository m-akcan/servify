/**
 * PostgreSQL clusters: one primary + N streaming standbys on per-replica volumes, managed by Servify.
 *
 *  • Roles come from the database itself (pg_is_in_recovery), polled every 2s with short timeouts.
 *  • Writes reach only the primary of record: the service name and the TCP proxy point at it; standbys answer
 *    to `<name>-read`.
 *  • Failover: when the primary has been unreachable for `failoverAfterSec`, Servify FENCES it first (removes its
 *    container and holds its index so the reconciler can't bring it back writable), promotes the most
 *    up-to-date standby, records it as primary, moves the network name, re-points the other standbys, and only
 *    then rebuilds the old primary as a standby (wipe + re-clone).
 *  • A member that claims to be a primary but isn't the primary of record is fenced on sight. When the state
 *    is ambiguous (no healthy primary of record), nothing is wiped — Servify alerts instead.
 *  • Synchronous mode keeps `synchronous_standby_names = 'ANY 1 (*)'` while a standby is streaming, and falls
 *    back to async (with an alert) when none is, so writes never block forever.
 */
import { services as servicesTable } from './db.ts';
import type { Service, Replica } from './types.ts';
import { docker, normalizeImageRef } from './docker.ts';
import { bus, recordActivity, type Actor } from './events.ts';
import { notify } from './notify.ts';
import { busy, holds, replicasOf, replicaAliases, adopt, networkName, requestReconcile, drainAndRemove } from './engine.ts';
import { dockerVolumeFor } from './volumes.ts';
import { setRollingOrder } from './deployer.ts';
import { isRestoring } from './backups.ts';
import { HttpError, sleep } from './util.ts';

const SYSTEM_ACTOR: Actor = { type: 'system', name: 'cluster' };
const HELPER_IMAGE = 'alpine:3.20';

export type MemberRole = 'primary' | 'standby' | 'starting' | 'down' | 'fenced' | 'rebuilding';
export type MemberStatus = { index: number; role: MemberRole; lsn: string | null; lagBytes: number | null; streaming: number | null; syncState: string | null; containerId: string | null };
type State = {
  members: Map<number, MemberStatus>;
  primaryDownSince: number | null;
  lastFailoverAt: number | null;
  degradedAsync: boolean;
  operation: string | null; // failover / switchover / rebuild in progress
  alerted: Set<string>;
};
const states = new Map<string, State>();
const stateOf = (id: string): State => {
  let s = states.get(id);
  if (!s) states.set(id, (s = { members: new Map(), primaryDownSince: null, lastFailoverAt: null, degradedAsync: false, operation: null, alerted: new Set() }));
  return s;
};

export function clusterStatus(svc: Service) {
  if (!svc.cluster) return null;
  const st = stateOf(svc.id);
  return {
    ...svc.cluster,
    members: [...st.members.values()].sort((a, b) => a.index - b.index),
    primaryDownSince: st.primaryDownSince,
    lastFailoverAt: st.lastFailoverAt,
    degradedAsync: st.degradedAsync,
    operation: st.operation,
  };
}

// ───────────────────────────── helpers ─────────────────────────────

const lsnToBig = (lsn: string | null) => {
  if (!lsn || !lsn.includes('/')) return -1n;
  const [hi, lo] = lsn.split('/');
  return (BigInt(`0x${hi}`) << 32n) + BigInt(`0x${lo}`);
};

function runningOf(svc: Service): Replica[] {
  const active = svc.activeDeploymentId;
  return replicasOf(svc.id).filter((r) => r.dockerState === 'running' && (!active || r.deploymentId === active || busy.has(svc.id)));
}

async function sql(cid: string, query: string, timeoutMs = 3000): Promise<string | null> {
  try {
    const r = await docker.exec(cid, ['sh', '-c', `psql -X -U "\${POSTGRES_USER:-postgres}" -d postgres -tAF'|' -c ${JSON.stringify(query)}`], timeoutMs);
    return r.exitCode === 0 ? r.output.trim() : null;
  } catch {
    return null;
  }
}

async function probeMember(r: Replica): Promise<Omit<MemberStatus, 'index' | 'containerId' | 'lagBytes' | 'syncState'> | null> {
  const out = await sql(
    r.containerId,
    "select pg_is_in_recovery(), coalesce(case when pg_is_in_recovery() then pg_last_wal_replay_lsn() else pg_current_wal_lsn() end::text, ''), (select count(*) from pg_stat_replication)",
  );
  if (!out) return null;
  const [rec, lsn, n] = out.split('|');
  return { role: rec === 't' ? 'standby' : 'primary', lsn: lsn || null, streaming: Number(n) || 0 };
}

async function fence(svc: Service, index: number, why: string) {
  const set = holds.get(svc.id) ?? new Set<number>();
  set.add(index);
  holds.set(svc.id, set);
  const cids = replicasOf(svc.id).filter((r) => r.index === index).map((r) => r.containerId);
  for (const cid of cids) await docker.removeContainer(cid, true).catch(() => {});
  await drainAndRemove(cids, 0).catch(() => {});
  stateOf(svc.id).members.set(index, { index, role: 'fenced', lsn: null, lagBytes: null, streaming: null, syncState: null, containerId: null });
  recordActivity(SYSTEM_ACTOR, 'cluster.fenced', `Fenced ${svc.name} #${index}: ${why}`, svc.projectId, svc.id);
}

function release(svc: Service, index: number) {
  holds.get(svc.id)?.delete(index);
  requestReconcile();
}

async function ensureHelper() {
  if (!(await docker.inspectImage(HELPER_IMAGE))) await docker.pullImage(normalizeImageRef(HELPER_IMAGE));
}

/** Empty one member's data volume (it then re-clones from the primary on start). */
async function wipeMember(svc: Service, index: number) {
  const mount = svc.volumes.find((m) => m.perReplica);
  if (!mount) throw new Error('cluster has no per-replica volume');
  const vol = dockerVolumeFor(svc.id, mount, index);
  if (!vol) throw new Error(`volume of #${index} not found`);
  await ensureHelper();
  const cid = await docker.createContainer(`svf-wipe-${svc.slug}-${index}-${Date.now().toString(36)}`, {
    Image: HELPER_IMAGE,
    Cmd: ['sh', '-c', 'find /v -mindepth 1 -delete'],
    HostConfig: { Mounts: [{ Type: 'volume', Source: vol, Target: '/v' }], NetworkMode: 'none' },
    Labels: { 'servify.helper': 'wipe' },
  });
  try {
    await docker.startContainer(cid);
    const code = await docker.waitContainer(cid);
    if (code !== 0) throw new Error(`wipe exited ${code}`);
  } finally {
    await docker.removeContainer(cid, true).catch(() => {});
  }
}

/** Give the primary the service name; standbys `<name>-read`. Reconnects containers whose names are wrong. */
async function syncAliases(svc: Service) {
  const net = networkName(svc.projectId);
  for (const r of runningOf(svc)) {
    const want = replicaAliases(svc, r.index);
    let have: string[] = [];
    try {
      const info = await docker.inspectContainer(r.containerId);
      have = info.NetworkSettings?.Networks?.[net]?.Aliases ?? [];
    } catch {
      continue;
    }
    const managed = (list: string[]) => list.filter((a) => a === svc.slug || a === `${svc.slug}-read`).sort().join(',');
    if (managed(want) === managed(have) && have.includes(`${svc.slug}-${r.index}`)) continue;
    await docker.disconnectNetwork(net, r.containerId);
    await docker.connectNetwork(net, r.containerId, want);
    await adopt(r.containerId); // container mode routes by IP: refresh it
  }
}

/** Re-point standbys via a shell so the password comes from the container's env, never from Servify's logs. */
async function repoint(svc: Service, primary: number) {
  const host = `${svc.slug}-${primary}`;
  for (const r of runningOf(svc)) {
    if (r.index === primary) continue;
    const script = `psql -X -U "\${POSTGRES_USER:-postgres}" -d postgres -v ON_ERROR_STOP=1 -c "alter system set primary_conninfo = 'host=${host} port=5432 user=\${POSTGRES_USER:-postgres} password=\${POSTGRES_PASSWORD} application_name=${svc.slug}-${r.index}'" -c "select pg_reload_conf()"`;
    await docker.exec(r.containerId, ['sh', '-c', script], 8000).catch(() => {});
  }
}

async function applySyncPolicy(svc: Service, primaryCid: string, streamingStandbys: number) {
  const st = stateOf(svc.id);
  const want = svc.cluster!.synchronous && streamingStandbys > 0 ? 'ANY 1 (*)' : '';
  const have = (await sql(primaryCid, 'show synchronous_standby_names')) ?? '';
  if (have === want) return;
  await sql(primaryCid, `alter system set synchronous_standby_names = '${want}'`);
  await sql(primaryCid, 'select pg_reload_conf()');
  const degraded = svc.cluster!.synchronous && !want;
  if (degraded && !st.degradedAsync) {
    notify({ event: 'service.crashed', level: 'error', title: `${svc.name}: no standby streaming`, message: 'Synchronous replication is paused so writes keep working. A failover now could lose the most recent commits.', projectId: svc.projectId, serviceId: svc.id });
    recordActivity(SYSTEM_ACTOR, 'cluster.async', `${svc.name}: no standby streaming — writes continue asynchronously`, svc.projectId, svc.id);
  }
  st.degradedAsync = degraded;
}

function savePrimary(svc: Service, index: number) {
  const fresh = servicesTable.get(svc.id)!;
  fresh.cluster = { ...fresh.cluster!, primary: index };
  fresh.updatedAt = Date.now();
  servicesTable.put(fresh);
  bus.publish({ type: 'service.updated', service: fresh });
  return fresh;
}

async function waitWritable(cid: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await sql(cid, 'select pg_is_in_recovery()')) === 'f') return true;
    await sleep(500);
  }
  return false;
}

/** Rebuild a fenced member as a standby: only once a writable primary of record exists. */
async function rebuild(svc: Service, index: number) {
  const fresh = servicesTable.get(svc.id)!;
  const st = stateOf(svc.id);
  const primary = runningOf(fresh).find((r) => r.index === fresh.cluster!.primary);
  if (!primary || (await sql(primary.containerId, 'select pg_is_in_recovery()')) !== 'f') {
    throw new Error(`no writable primary to clone from — #${index} stays fenced`);
  }
  if (index === fresh.cluster!.primary) throw new Error('refusing to wipe the primary of record');
  st.members.set(index, { index, role: 'rebuilding', lsn: null, lagBytes: null, streaming: null, syncState: null, containerId: null });
  await wipeMember(fresh, index);
  release(fresh, index);
  recordActivity(SYSTEM_ACTOR, 'cluster.rebuild', `Rebuilding ${svc.name} #${index} as a standby of #${fresh.cluster!.primary}`, svc.projectId, svc.id);
}

// ───────────────────────────── failover / switchover ─────────────────────────────

async function promote(svc: Service, target: Replica, reason: string, oldPrimary: number) {
  await sql(target.containerId, 'select pg_promote(true, 30)', 35_000);
  if (!(await waitWritable(target.containerId))) throw new Error(`#${target.index} did not become writable`);
  const fresh = savePrimary(svc, target.index);
  await syncAliases(fresh);
  await repoint(fresh, target.index);
  stateOf(svc.id).lastFailoverAt = Date.now();
  recordActivity(SYSTEM_ACTOR, 'cluster.promoted', `${svc.name}: #${target.index} is now the primary (${reason})`, svc.projectId, svc.id);
  notify({ event: 'service.recovered', level: 'success', title: `${svc.name}: #${target.index} promoted to primary`, message: `${reason}. #${oldPrimary} is being rebuilt as a standby.`, projectId: svc.projectId, serviceId: svc.id });
  return fresh;
}

async function bestStandby(svc: Service, exclude: number[]): Promise<Replica | null> {
  let best: { r: Replica; lsn: bigint } | null = null;
  for (const r of runningOf(svc)) {
    if (exclude.includes(r.index)) continue;
    const p = await probeMember(r);
    if (!p || p.role !== 'standby') continue;
    const lsn = lsnToBig(p.lsn);
    if (!best || lsn > best.lsn) best = { r, lsn };
  }
  return best?.r ?? null;
}

async function failover(svc: Service) {
  const st = stateOf(svc.id);
  const old = svc.cluster!.primary;
  st.operation = 'failover';
  try {
    const target = await bestStandby(svc, [old]);
    if (!target) {
      if (!st.alerted.has('no-standby')) {
        st.alerted.add('no-standby');
        notify({ event: 'service.crashed', level: 'error', title: `${svc.name}: primary down, no standby to promote`, message: 'Waiting for the primary to come back.', projectId: svc.projectId, serviceId: svc.id });
      }
      return;
    }
    // Fence first: the old primary must never come back writable.
    await fence(svc, old, 'primary unreachable — fencing before promotion');
    const fresh = await promote(svc, target, `primary #${old} unreachable for ${svc.cluster!.failoverAfterSec}s`, old);
    st.primaryDownSince = null;
    st.alerted.delete('no-standby');
    await rebuild(fresh, old).catch((e) => recordActivity(SYSTEM_ACTOR, 'cluster.rebuild_failed', `${svc.name} #${old}: ${(e as Error).message}`, svc.projectId, svc.id));
  } finally {
    st.operation = null;
  }
}

export async function switchover(actor: Actor, serviceId: string, to?: number) {
  const svc = servicesTable.get(serviceId);
  if (!svc?.cluster) throw new HttpError(404, 'not a cluster');
  const st = stateOf(svc.id);
  if (st.operation) throw new HttpError(409, `a ${st.operation} is in progress`);
  if (busy.has(svc.id)) throw new HttpError(409, `${svc.name} is deploying`);
  const old = svc.cluster.primary;
  const reps = runningOf(svc);
  const target = to !== undefined ? reps.find((r) => r.index === to) : await bestStandby(svc, [old]);
  if (!target || target.index === old) throw new HttpError(400, 'pick a running standby to promote');
  const probe = await probeMember(target);
  if (probe?.role !== 'standby') throw new HttpError(409, `#${target.index} is not a healthy standby`);
  st.operation = 'switchover';
  try {
    recordActivity(actor, 'cluster.switchover', `Switching ${svc.name}'s primary #${old} → #${target.index}`, svc.projectId, svc.id);
    const primary = reps.find((r) => r.index === old);
    let finalLsn = -1n;
    if (primary) {
      await sql(primary.containerId, 'checkpoint', 30_000);
      finalLsn = lsnToBig(await sql(primary.containerId, 'select pg_current_wal_lsn()'));
    }
    // A clean shutdown streams everything to the standbys before the primary exits; then fence it.
    await fence(svc, old, 'switchover');
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      const lsn = lsnToBig(await sql(target.containerId, 'select pg_last_wal_replay_lsn()'));
      if (lsn >= finalLsn) break;
      await sleep(300);
    }
    const fresh = await promote(svc, target, 'switchover', old);
    await rebuild(fresh, old);
    return clusterStatus(fresh);
  } finally {
    st.operation = null;
  }
}

export async function rebuildMember(actor: Actor, serviceId: string, index: number) {
  const svc = servicesTable.get(serviceId);
  if (!svc?.cluster) throw new HttpError(404, 'not a cluster');
  if (index === svc.cluster.primary) throw new HttpError(400, 'the primary cannot be rebuilt — switch it over first');
  const st = stateOf(svc.id);
  if (st.operation) throw new HttpError(409, `a ${st.operation} is in progress`);
  st.operation = 'rebuild';
  try {
    recordActivity(actor, 'cluster.rebuild', `Rebuilding ${svc.name} #${index} from the primary`, svc.projectId, svc.id);
    await fence(svc, index, 'rebuild requested');
    await rebuild(servicesTable.get(svc.id)!, index);
  } finally {
    st.operation = null;
  }
}

// ───────────────────────────── the loop ─────────────────────────────

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    for (const svc of servicesTable.all()) {
      if (!svc.cluster || svc.stopped || !svc.activeDeploymentId) continue;
      await manage(svc).catch((e) => console.error(`[cluster] ${svc.name}:`, (e as Error).message));
    }
  } finally {
    running = false;
  }
}

async function manage(svc: Service) {
  const st = stateOf(svc.id);
  if (st.operation) return;
  if (isRestoring(svc.id)) return; // a restore wipes and re-initialises every member
  const deploying = busy.has(svc.id);
  const reps = runningOf(svc);
  const held = holds.get(svc.id) ?? new Set<number>();
  const probes = new Map<number, Awaited<ReturnType<typeof probeMember>>>();
  await Promise.all(reps.map(async (r) => probes.set(r.index, await probeMember(r))));

  const primaryIdx = svc.cluster!.primary;
  const primaryRep = reps.find((r) => r.index === primaryIdx);
  const primaryProbe = probes.get(primaryIdx);
  const primaryOk = !!primaryProbe && primaryProbe.role === 'primary';
  const primaryLsn = primaryOk ? lsnToBig(primaryProbe!.lsn) : -1n;

  // Replication stats from the primary's point of view.
  const repl = new Map<string, { lag: number; sync: string }>();
  if (primaryOk && primaryRep) {
    const rows = (await sql(primaryRep.containerId, "select application_name, coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn), 0)::bigint, sync_state from pg_stat_replication")) ?? '';
    for (const line of rows.split('\n').filter(Boolean)) {
      const [app, lag, sync] = line.split('|');
      repl.set(app, { lag: Number(lag), sync });
    }
  }

  // Member table.
  const want = svc.replicas;
  for (let i = 0; i < want; i++) {
    if (held.has(i)) continue; // fence/rebuild owns it
    const r = reps.find((x) => x.index === i);
    const p = probes.get(i);
    const stats = repl.get(`${svc.slug}-${i}`);
    st.members.set(i, {
      index: i,
      role: !r ? 'down' : !p ? 'starting' : p.role,
      lsn: p?.lsn ?? null,
      lagBytes: p?.role === 'standby' ? stats?.lag ?? (primaryOk ? Number(primaryLsn - lsnToBig(p.lsn)) : null) : p?.role === 'primary' ? 0 : null,
      streaming: p?.streaming ?? null,
      syncState: p?.role === 'standby' ? stats?.sync ?? 'not streaming' : null,
      containerId: r?.containerId ?? null,
    });
  }
  for (const k of [...st.members.keys()]) if (k >= want && !held.has(k)) st.members.delete(k);

  if (deploying) return; // a deploy owns the containers; never fail over mid-roll

  // Split-brain guard: anyone else claiming to be a primary is fenced. Only rebuilt when the primary of record is healthy.
  for (const [i, p] of probes) {
    if (i === primaryIdx || p?.role !== 'primary') continue;
    await fence(svc, i, `#${i} is writable but #${primaryIdx} is the primary of record`);
    if (primaryOk) await rebuild(servicesTable.get(svc.id)!, i).catch(() => {});
    else if (!st.alerted.has(`ambiguous-${i}`)) {
      st.alerted.add(`ambiguous-${i}`);
      notify({ event: 'service.crashed', level: 'error', title: `${svc.name}: two possible primaries`, message: `#${i} claimed to be primary while #${primaryIdx} is unreachable. #${i} is fenced and kept untouched for you to inspect.`, projectId: svc.projectId, serviceId: svc.id });
    }
  }

  if (primaryOk) {
    st.primaryDownSince = null;
    await syncAliases(svc);
    const streaming = [...repl.values()].length;
    await applySyncPolicy(svc, primaryRep!.containerId, streaming);
    return;
  }

  // Primary unreachable. A crash restart usually brings it back within seconds; fail over only if it doesn't.
  st.primaryDownSince ??= Date.now();
  const after = svc.cluster!.failoverAfterSec;
  if (!after || Date.now() - st.primaryDownSince < after * 1000) return;
  await failover(svc);
}

/** Boot: register the rolling order (standbys first, primary last) and start watching. */
export function startClusters() {
  setRollingOrder((svc, want) => {
    if (!svc.cluster) return null;
    const p = svc.cluster.primary;
    const others = Array.from({ length: want }, (_, i) => i).filter((i) => i !== p);
    // A running cluster rolls standbys first and the primary last (one short write pause). A fresh cluster
    // (or one whose primary isn't running) needs the primary first: standbys clone from it.
    const primaryRunning = replicasOf(svc.id).some((r) => r.index === p && r.dockerState === 'running');
    return primaryRunning ? [...others, ...(p < want ? [p] : [])] : [...(p < want ? [p] : []), ...others];
  });
  setInterval(() => void tick(), 2000);
}
