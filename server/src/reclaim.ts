/**
 * Reclaim space: what Servify created on a machine that nothing uses any more — volumes kept when their service was
 * deleted, built images and stopped containers of deleted services, networks of deleted projects.
 *
 * Safety first. Something is only ever offered when ALL of these hold:
 *  - it carries this instance's `servify.instance` label (other Servify instances on the same Docker, and everything
 *    that isn't Servify's, are never looked at — so registry images Servify pulled, which carry no label, aren't either);
 *  - the service (or project) it belonged to no longer exists in the database;
 *  - no container uses it, running or stopped (a stopped container of a deleted service is listed itself, first);
 *  - for volumes: not adopted (that data predates Servify), not forgotten-with-its-data-kept, not mounted read-only by
 *    another service, not a backup's scratch volume, and not parked next to a live service (detached from a service
 *    that still exists, or never attached): only volumes whose last service, or whose project, was deleted;
 *  - for images: no deployment or image source of an existing service names it (that covers the ones kept for
 *    rollbacks), and it has no tag other than Servify's own;
 *  - Docker-level leftovers are at least a couple of minutes old (nothing mid-creation).
 * Deleting runs the same classifier again on the server and only touches what is still in its fresh result.
 */
import { volumesTable, services as servicesTable, projects as projectsTable, activityTable, nodesTable, db } from './db.ts';
import type { VolumeRecord } from './types.ts';
import { INSTANCE_ID, LABEL } from './engine.ts';
import { LOCAL, dockerFor, isOnline, nodeOf, nodeName } from './nodes.ts';
import { keptVolumes, deleteVolume } from './volumes.ts';
import { normalizeImageRef, type DockerClient } from './docker.ts';
import { recordActivity, type Actor } from './events.ts';
import { HttpError } from './util.ts';

export type ReclaimKind = 'container' | 'volume' | 'image' | 'network';

export type ReclaimItem = {
  /** `kind:node:ref` — what the delete call names. */
  key: string;
  kind: ReclaimKind;
  nodeId: string;
  /** Docker id or name; for a volume Servify still has a record of, the record id. */
  ref: string;
  name: string;
  sizeBytes: number | null;
  createdAt: number | null;
  /** What it belonged to (names when Servify still knows them, else ids), or null. */
  project: string | null;
  service: string | null;
  /** Why it is offered. */
  note: string;
  /** Set for volumes Servify has a record of (detached volumes of a deleted service). */
  volumeId?: string;
};

export type ReclaimMachine = { nodeId: string; name: string; online: boolean; error: string | null; items: ReclaimItem[]; totalBytes: number };
export type ReclaimReport = { instanceId: string; scannedAt: number; machines: ReclaimMachine[]; totalBytes: number };

const MIN_AGE_MS = 2 * 60_000;
const TESTRESTORE = 'servify.testrestore';
const ORDER: ReclaimKind[] = ['container', 'volume', 'image', 'network'];

// ───────────────────────────── names of deleted things ─────────────────────────────

function serviceName(id: string | null | undefined): string | null {
  if (!id) return null;
  const s = servicesTable.get(id);
  if (s) return s.name;
  const created = activityTable.all('WHERE service_id = ?', id).find((a) => a.action === 'service.created');
  return created?.summary.match(/^Created (.+?) from /)?.[1] ?? id;
}
function projectName(id: string | null | undefined): string | null {
  if (!id) return null;
  const p = projectsTable.get(id);
  if (p) return p.name;
  const created = activityTable.all('WHERE project_id = ?', id).find((a) => a.action === 'project.created');
  return created?.summary.match(/^Created project (.+)$/)?.[1] ?? id;
}

const tsOf = (v: unknown): number | null => {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
};
const oldEnough = (created: number | null, now: number) => created !== null && now - created >= MIN_AGE_MS;

// ───────────────────────────── the classifier ─────────────────────────────

/** Everything reclaimable on one server (it must be online). Used for the list and, again, right before deleting. */
export async function scanNode(nodeId: string): Promise<ReclaimItem[]> {
  const d = dockerFor(nodeId);
  const now = Date.now();
  const mine = `${LABEL.instance}=${INSTANCE_ID}`;
  const [containers, dockerVolumes, images, networks] = await Promise.all([
    d.listContainers([], true) as Promise<any[]>,
    d.listVolumes(),
    d.listImages([mine]),
    d.listNetworks([mine]),
  ]);
  const services = servicesTable.all();
  const serviceIds = new Set(services.map((s) => s.id));
  const projectIds = new Set(projectsTable.all().map((p) => p.id));
  const records = volumesTable.all();
  const items: ReclaimItem[] = [];
  const add = (it: Omit<ReclaimItem, 'key' | 'nodeId'>) => items.push({ ...it, nodeId, key: `${it.kind}:${nodeId}:${it.ref}` });

  // What every container on this Docker (anyone's, any state) uses.
  const volumeUsers = new Set<string>();
  const imageUsers = new Set<string>();
  for (const c of containers) {
    for (const m of c.Mounts ?? []) if (m.Type === 'volume' && m.Name) volumeUsers.add(m.Name);
    if (c.ImageID) imageUsers.add(c.ImageID);
    if (c.Image) imageUsers.add(c.Image);
  }

  // Stopped containers of deleted services (or of deleted projects, for ones without a service).
  for (const c of containers) {
    const l = c.Labels ?? {};
    if (l[LABEL.instance] !== INSTANCE_ID || l[TESTRESTORE]) continue;
    if (!['exited', 'created', 'dead'].includes(c.State)) continue;
    const sid = l[LABEL.service];
    const pid = l[LABEL.project];
    if (sid ? serviceIds.has(sid) : !pid || projectIds.has(pid)) continue;
    const created = tsOf(c.Created);
    if (!oldEnough(created, now)) continue;
    add({
      kind: 'container',
      ref: c.Id,
      name: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ''),
      sizeBytes: null,
      createdAt: created,
      project: projectName(pid),
      service: sid ? serviceName(sid) : null,
      note: `Stopped (${c.State}); its ${sid ? 'service' : 'project'} was deleted`,
    });
  }

  // Volumes Servify still has a record of: left detached when their service (or project) was deleted.
  const byName = new Map(dockerVolumes.map((v) => [v.Name, v]));
  const usageWanted: string[] = [];
  const pendingVolumes: { it: Omit<ReclaimItem, 'key' | 'nodeId'>; names: string[] }[] = [];
  const claimed = new Set(records.map((r) => r.dockerName)); // on any server: never guess across servers
  for (const v of records) {
    if (nodeOf(v) !== nodeId || (v.setId && v.setId !== v.id)) continue; // sets go by their leader
    const members = v.setId ? records.filter((x) => x.setId === v.setId) : [v];
    if (members.some((m) => m.serviceId || m.adopted || nodeOf(m) !== nodeId)) continue;
    const projectGone = !projectIds.has(v.projectId);
    const serviceGone = !!v.lastServiceId && !serviceIds.has(v.lastServiceId);
    if (!projectGone && !serviceGone) continue; // parked on purpose (detached from a live service, or never attached)
    if (services.some((s) => s.volumes.some((m) => m.volumeId && members.some((x) => x.id === m.volumeId)))) continue; // shared read-only, or still referenced
    if (members.some((m) => volumeUsers.has(m.dockerName))) continue;
    const names = members.map((m) => m.dockerName).filter((n) => byName.has(n));
    usageWanted.push(...names);
    pendingVolumes.push({
      names,
      it: {
        kind: 'volume',
        ref: v.id,
        volumeId: v.id,
        name: members.length > 1 ? `${v.name} (${members.length} replica volumes)` : v.name,
        sizeBytes: null,
        createdAt: v.createdAt ?? tsOf(byName.get(v.dockerName)?.CreatedAt),
        project: projectName(v.projectId),
        service: serviceName(v.lastServiceId),
        note: projectGone ? 'Its project was deleted' : `Detached; last attached to ${serviceName(v.lastServiceId)}, which was deleted`,
      },
    });
  }

  // Docker volumes with our label that no record claims (e.g. a removal that failed while a server was offline).
  const kept = keptVolumes();
  let forgotten: string[] | null = null;
  for (const v of dockerVolumes) {
    const l = v.Labels ?? {};
    if (l[LABEL.instance] !== INSTANCE_ID || l[TESTRESTORE]) continue;
    if (!/^(svf-vol-|servify_)/.test(v.Name)) continue;
    if (claimed.has(v.Name) || (l['servify.volume'] && volumesTable.get(l['servify.volume']))) continue;
    if (kept.has(`${nodeId}:${v.Name}`)) continue;
    // Forgotten (data kept) before kept-volumes were recorded: the activity line names the Docker volume.
    forgotten ??= activityTable.all(`WHERE data LIKE ?`, '%Forgot%').map((a) => a.summary);
    if (forgotten.some((s) => s.includes(v.Name))) continue;
    const legacy = /^servify_(svc_[a-z0-9]+)_/.exec(v.Name);
    if (legacy && serviceIds.has(legacy[1])) continue;
    if (volumeUsers.has(v.Name)) continue;
    const created = tsOf(v.CreatedAt);
    if (!oldEnough(created, now)) continue;
    usageWanted.push(v.Name);
    const pid = l[LABEL.project] ?? null;
    pendingVolumes.push({
      names: [v.Name],
      it: {
        kind: 'volume',
        ref: v.Name,
        name: v.Name,
        sizeBytes: null,
        createdAt: created,
        project: projectName(pid),
        service: legacy ? serviceName(legacy[1]) : null,
        note: 'No Servify volume record points at it any more',
      },
    });
  }
  if (pendingVolumes.length) {
    const usage = usageWanted.length ? await d.volumeUsage().catch(() => new Map<string, number>()) : new Map<string, number>();
    for (const { it, names } of pendingVolumes) {
      const sizes = names.map((n) => usage.get(n) ?? -1);
      add({ ...it, sizeBytes: sizes.length && sizes.every((s) => s >= 0) ? sizes.reduce((a, b) => a + b, 0) : names.length ? null : 0 });
    }
  }

  // Built images of deleted services.
  const referenced = new Set<string>();
  for (const r of db.prepare(`SELECT json_extract(data, '$.image') AS image FROM deployments`).all() as { image: string | null }[]) if (r.image) referenced.add(r.image);
  for (const s of services) if (s.source.type === 'image' && (s.source as any).image) referenced.add(normalizeImageRef((s.source as any).image));
  for (const img of images as any[]) {
    const l = img.Labels ?? {};
    if (l[LABEL.instance] !== INSTANCE_ID) continue;
    const sid = l[LABEL.service];
    if (!sid || serviceIds.has(sid)) continue;
    const tags: string[] = (img.RepoTags ?? []).filter((t: string) => t && t !== '<none>:<none>');
    if (tags.some((t) => !t.startsWith('servify/'))) continue; // someone tagged it for something else
    if (referenced.has(img.Id) || tags.some((t) => referenced.has(t))) continue;
    if (imageUsers.has(img.Id) || tags.some((t) => imageUsers.has(t))) continue;
    const created = tsOf(img.Created);
    if (!oldEnough(created, now)) continue;
    add({
      kind: 'image',
      ref: img.Id,
      name: tags[0] ?? `untagged ${String(img.Id).replace(/^sha256:/, '').slice(0, 12)}`,
      sizeBytes: typeof img.Size === 'number' ? img.Size : null,
      createdAt: created,
      project: null,
      service: serviceName(sid),
      note: 'Built for a service that was deleted',
    });
  }

  // Networks of deleted projects, with nothing attached.
  for (const n of networks) {
    const l = n.Labels ?? {};
    if (l[LABEL.instance] !== INSTANCE_ID) continue;
    const pid = l[LABEL.project];
    if (!pid || projectIds.has(pid) || n.Name !== `servify_${pid}`) continue;
    const created = tsOf(n.Created);
    if (!oldEnough(created, now)) continue;
    const full = await d.inspectNetwork(n.Id).catch(() => null);
    if (!full || Object.keys(full.Containers ?? {}).length) continue;
    add({ kind: 'network', ref: n.Id, name: n.Name, sizeBytes: 0, createdAt: created, project: projectName(pid), service: null, note: 'Its project was deleted; nothing is attached' });
  }

  return items.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
}

const total = (items: ReclaimItem[]) => items.reduce((s, i) => s + (i.sizeBytes ?? 0), 0);

/** Every server: this machine, and each added server that is online. */
export async function scanReclaimable(opts: { localOnly?: boolean } = {}): Promise<ReclaimReport> {
  const nodes = [LOCAL, ...(opts.localOnly ? [] : nodesTable.all().map((n) => n.id))];
  const machines = await Promise.all(
    nodes.map(async (nodeId): Promise<ReclaimMachine> => {
      const base = { nodeId, name: nodeName(nodeId), online: isOnline(nodeId), error: null as string | null, items: [] as ReclaimItem[], totalBytes: 0 };
      if (!base.online) return base;
      try {
        const items = await scanNode(nodeId);
        return { ...base, items, totalBytes: total(items) };
      } catch (e) {
        return { ...base, error: (e as Error).message };
      }
    }),
  );
  return { instanceId: INSTANCE_ID, scannedAt: Date.now(), machines, totalBytes: machines.reduce((s, m) => s + m.totalBytes, 0) };
}

// ───────────────────────────── deleting ─────────────────────────────

export type ReclaimResult = { key: string; ok: boolean; name?: string; freedBytes?: number; error?: string; code?: string };

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

async function deleteItem(d: DockerClient, it: ReclaimItem, actor: Actor, opts: { skipSafetyBackup?: boolean }) {
  const gone = (still: boolean) => {
    if (still) throw new Error('Docker did not remove it (in use, or referenced by something else)');
  };
  if (it.kind === 'container') {
    const c = await d.inspectContainer(it.ref).catch(() => null);
    if (!c) return;
    if (c.State?.Running || c.State?.Restarting || c.State?.Paused) throw new Error('it is running again');
    if (c.Config?.Labels?.[LABEL.instance] !== INSTANCE_ID) throw new Error('not a container of this Servify');
    await d.removeContainer(it.ref, false);
    gone(!!(await d.inspectContainer(it.ref).catch(() => null)));
  } else if (it.kind === 'volume') {
    if (it.volumeId) {
      const rec = volumesTable.get(it.volumeId) as VolumeRecord | null;
      if (!rec) return;
      const members = rec.setId ? volumesTable.all('WHERE project_id = ?', rec.projectId).filter((x) => x.setId === rec.setId) : [rec];
      for (const m of members) if ((await dockerFor(m.nodeId).containersUsingVolume(m.dockerName, true)).length) throw new Error(`${m.dockerName} is used by a container`);
      await deleteVolume(actor, rec.id, { skipSafetyBackup: !!opts.skipSafetyBackup });
      return; // deleteVolume records the activity
    }
    if ((await d.containersUsingVolume(it.ref, true)).length) throw new Error('a container uses it');
    await d.removeVolume(it.ref);
    gone((await d.listVolumes()).some((v) => v.Name === it.ref));
  } else if (it.kind === 'image') {
    const img = await d.inspectImage(it.ref);
    if (!img) return;
    if ((img.Config?.Labels ?? {})[LABEL.instance] !== INSTANCE_ID) throw new Error('not an image of this Servify');
    const tags: string[] = (img.RepoTags ?? []).filter((t: string) => t.startsWith('servify/'));
    // Untag Servify's tags (never forced); the last one removes the image. Untagged leftovers go by id.
    for (const t of tags) await d.removeImage(t);
    if (!tags.length) await d.removeImage(it.ref);
    gone(!!(await d.inspectImage(it.ref).catch(() => null)));
  } else if (it.kind === 'network') {
    const n = await d.inspectNetwork(it.ref);
    if (!n) return;
    if (Object.keys(n.Containers ?? {}).length) throw new Error('a container is attached to it');
    await d.removeNetwork(it.ref);
    gone(!!(await d.inspectNetwork(it.ref).catch(() => null)));
  }
  const size = it.sizeBytes ? ` (${(it.sizeBytes / 1e6).toFixed(1)} MB)` : '';
  recordActivity(actor, 'reclaim.deleted', `Reclaimed ${it.kind} ${it.name}${it.nodeId !== LOCAL ? ` on ${nodeName(it.nodeId)}` : ''}${size}`, null, null);
}

/**
 * Delete these items (keys from a scan). Each server is scanned again first and only what is still reclaimable in
 * that fresh result is touched; containers go first, then volumes, images and networks.
 */
export function reclaimItems(actor: Actor, keys: string[], opts: { skipSafetyBackup?: boolean } = {}): Promise<{ results: ReclaimResult[]; freedBytes: number }> {
  if (!Array.isArray(keys) || !keys.length || keys.some((k) => typeof k !== 'string')) throw new HttpError(400, 'which items? (keys from GET /reclaim)');
  return serial(async () => {
    const results: ReclaimResult[] = [];
    const byNode = new Map<string, string[]>();
    for (const key of new Set(keys)) {
      const node = key.split(':')[1] ?? '';
      if (!byNode.has(node)) byNode.set(node, []);
      byNode.get(node)!.push(key);
    }
    for (const [node, nodeKeys] of byNode) {
      const known = node === LOCAL || !!nodesTable.get(node);
      if (!known || !isOnline(node)) {
        for (const key of nodeKeys) results.push({ key, ok: false, error: known ? `${nodeName(node)} is offline` : 'unknown server' });
        continue;
      }
      let fresh: Map<string, ReclaimItem>;
      try {
        fresh = new Map((await scanNode(node)).map((i) => [i.key, i]));
      } catch (e) {
        for (const key of nodeKeys) results.push({ key, ok: false, error: (e as Error).message });
        continue;
      }
      const d = dockerFor(node);
      const ordered = nodeKeys.map((k) => ({ k, it: fresh.get(k) })).sort((a, b) => ORDER.indexOf(a.it?.kind ?? 'container') - ORDER.indexOf(b.it?.kind ?? 'container'));
      for (const { k, it } of ordered) {
        if (!it) {
          results.push({ key: k, ok: false, error: "not reclaimable now (in use, not this Servify's, or already gone): refresh the list" });
          continue;
        }
        try {
          await deleteItem(d, it, actor, opts);
          results.push({ key: k, ok: true, name: it.name, freedBytes: it.sizeBytes ?? 0 });
        } catch (e) {
          results.push({ key: k, ok: false, name: it.name, error: (e as Error).message, code: (e as any).code });
        }
      }
    }
    return { results, freedBytes: results.reduce((s, r) => s + (r.ok ? (r.freedBytes ?? 0) : 0), 0) };
  });
}
