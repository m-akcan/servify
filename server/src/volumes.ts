/**
 * First-class volumes. A volume belongs to a project and is attached to at most one service at a time; it can
 * be detached (data kept), attached to another service, renamed and deleted. Its Docker volume name is fixed
 * at creation, so moving it never copies data.
 *
 * Attach and detach take effect immediately (the service is redeployed) so a volume is never mounted by two
 * services at once, and replicas only ever mount volumes currently attached to their own service.
 */
import { volumesTable, services as servicesTable, projects as projectsTable } from './db.ts';
import type { Service, Volume, VolumeRecord } from './types.ts';
import { docker } from './docker.ts';
import { bus, recordActivity, type Actor } from './events.ts';
import { HttpError, id, slugify } from './util.ts';
import { INSTANCE_ID, LABEL, busy, drainAndRemove, replicasOf, requestReconcile, refreshServiceStatus } from './engine.ts';

const NAME_RE = /^[a-zA-Z0-9_.-]{1,48}$/;

/** Docker volume name used before volumes were first-class (kept for migrated volumes). */
export function legacyDockerName(serviceId: string, name: string) {
  return `servify_${serviceId}_${name.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
}

function publish(v: VolumeRecord) {
  bus.publish({ type: 'volume.updated', volume: v });
}

function save(v: VolumeRecord) {
  v.updatedAt = Date.now();
  if (volumesTable.get(v.id)) volumesTable.put(v);
  else volumesTable.insert(v);
  publish(v);
  return v;
}

export function listVolumes(projectId: string): VolumeRecord[] {
  return volumesTable.all('WHERE project_id = ? ORDER BY created_at ASC', projectId).map(withSize);
}

export function getVolumeOrThrow(ref: string, projectId?: string): VolumeRecord {
  const v = volumesTable.get(ref);
  if (v) return v;
  // "project/volume" or a bare name (unique within the project).
  const [p, name] = ref.includes('/') ? ref.split('/') : [projectId ?? null, ref];
  const candidates = volumesTable.all().filter((x) => x.name === name);
  const filtered = p ? candidates.filter((x) => x.projectId === p || projectsTable.get(x.projectId)?.slug === p) : candidates;
  if (filtered.length === 1) return filtered[0];
  if (filtered.length > 1) throw new HttpError(409, `ambiguous volume "${ref}" — use its id or "project/volume"`);
  throw new HttpError(404, `volume not found: ${ref}`);
}

/**
 * The Docker volume to mount for a service's mount entry — or null when that volume is no longer attached
 * to this service (never mount someone else's data).
 */
export function dockerVolumeFor(serviceId: string, mount: Volume): string | null {
  if (mount.volumeId) {
    const rec = volumesTable.get(mount.volumeId);
    if (!rec) return null;
    return rec.serviceId === serviceId ? rec.dockerName : null;
  }
  // Mount entries written before migration (old deployment snapshots): resolve through the legacy name.
  const legacy = legacyDockerName(serviceId, mount.name);
  const rec = volumesTable.all().find((r) => r.dockerName === legacy);
  if (rec && rec.serviceId !== serviceId) return null;
  return legacy;
}

/** Docker mounts for a list of mount entries, skipping volumes that moved away. */
export function mountsFor(serviceId: string, mounts: Volume[]) {
  const out: { Type: 'volume'; Source: string; Target: string }[] = [];
  for (const m of mounts) {
    const src = dockerVolumeFor(serviceId, m);
    if (src) out.push({ Type: 'volume', Source: src, Target: m.mountPath });
    else console.warn(`[volumes] ${m.name} is no longer attached to ${serviceId} — not mounting it`);
  }
  return out;
}

export async function ensureDockerVolume(v: VolumeRecord) {
  await docker.createVolume(v.dockerName, { [LABEL.managed]: 'true', [LABEL.instance]: INSTANCE_ID, 'servify.volume': v.id, [LABEL.project]: v.projectId });
}

/**
 * Give every mount entry of a service a volume record (new entries → new volumes), keep mount paths in sync.
 * Called after a service is created or its volumes change.
 */
export function syncServiceVolumes(svc: Service): Service {
  let changed = false;
  const next = svc.volumes.map((m) => {
    if (m.volumeId && volumesTable.get(m.volumeId)) {
      const rec = volumesTable.get(m.volumeId)!;
      if (rec.mountPath !== m.mountPath || rec.serviceId !== svc.id) {
        rec.mountPath = m.mountPath;
        rec.serviceId = svc.id;
        save(rec);
      }
      return m;
    }
    changed = true;
    const vid = id('vol');
    const taken = new Set(volumesTable.all('WHERE project_id = ?', svc.projectId).map((v) => v.name));
    let name = m.name.match(NAME_RE) ? `${svc.slug}-${m.name}` : `${svc.slug}-data`;
    if (name.length > 48) name = name.slice(0, 48);
    for (let i = 2; taken.has(name); i++) name = `${svc.slug}-${m.name}-${i}`.slice(0, 48);
    save({
      id: vid,
      projectId: svc.projectId,
      name,
      dockerName: `svf-vol-${vid.slice(4)}`,
      serviceId: svc.id,
      mountPath: m.mountPath,
      x: svc.x,
      y: svc.y + 240,
      sizeBytes: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { ...m, volumeId: vid };
  });
  if (changed) {
    svc.volumes = next;
    servicesTable.put(svc);
  }
  return svc;
}

/** Boot: turn every existing service volume into a record that keeps its current Docker volume. */
export function migrateVolumes() {
  let n = 0;
  for (const svc of servicesTable.all()) {
    if (!svc.volumes.some((m) => !m.volumeId)) continue;
    const taken = new Set(volumesTable.all('WHERE project_id = ?', svc.projectId).map((v) => v.name));
    svc.volumes = svc.volumes.map((m) => {
      if (m.volumeId) return m;
      const vid = id('vol');
      let name = `${svc.slug}-${m.name}`.slice(0, 48);
      for (let i = 2; taken.has(name); i++) name = `${svc.slug}-${m.name}-${i}`.slice(0, 48);
      taken.add(name);
      volumesTable.insert({
        id: vid,
        projectId: svc.projectId,
        name,
        dockerName: legacyDockerName(svc.id, m.name),
        serviceId: svc.id,
        mountPath: m.mountPath,
        x: svc.x,
        y: svc.y + 240,
        sizeBytes: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      n++;
      return { ...m, volumeId: vid };
    });
    servicesTable.put(svc);
  }
  if (n) console.log(`  [volumes] ${n} existing volume(s) are now first-class (data untouched)`);
}

/** A free canvas spot for a detached volume near (x, y): clear of service cards and other volumes. */
export function freeSpot(projectId: string, x: number, y: number, exceptId?: string): { x: number; y: number } {
  const boxes = [
    ...servicesTable.all('WHERE project_id = ?', projectId).map((s) => ({ x: s.x - 10, y: s.y - 10, w: 276, h: 230 + s.volumes.length * 26 })),
    ...volumesTable.all('WHERE project_id = ?', projectId).filter((v) => !v.serviceId && v.id !== exceptId).map((v) => ({ x: v.x - 10, y: v.y - 10, w: 200, h: 72 })),
  ];
  const free = (px: number, py: number) => boxes.every((b) => px + 180 < b.x || px > b.x + b.w || py + 52 < b.y || py > b.y + b.h);
  for (let ring = 0; ring < 30; ring++) {
    for (const [dx, dy] of [[0, 0], [0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      if (ring === 0 && (dx || dy)) continue;
      const px = Math.round(x + dx * ring * 60);
      const py = Math.round(y + dy * ring * 40);
      if (free(px, py)) return { x: px, y: py };
    }
  }
  return { x, y: y + 300 };
}

// ───────────────────────────── operations ─────────────────────────────

function cleanName(raw: string | undefined, projectId: string, exceptId?: string): string {
  const name = slugify(raw?.trim() || 'volume').slice(0, 48);
  if (!NAME_RE.test(name)) throw new HttpError(400, 'volume names use letters, digits, dot, dash and underscore');
  if (volumesTable.all('WHERE project_id = ?', projectId).some((v) => v.name === name && v.id !== exceptId)) throw new HttpError(409, `a volume called ${name} already exists in this project`);
  return name;
}

function checkMountPath(p: string) {
  if (!p?.startsWith('/') || p === '/' || p.includes('..')) throw new HttpError(400, 'mount path must be an absolute path like /data');
}

export async function createVolume(actor: Actor, projectId: string, input: { name?: string; serviceId?: string; mountPath?: string; x?: number; y?: number }) {
  const project = projectsTable.get(projectId) ?? projectsTable.all().find((p) => p.slug === projectId);
  if (!project) throw new HttpError(404, 'project not found');
  const name = cleanName(input.name, project.id);
  const vid = id('vol');
  const v = save({
    id: vid,
    projectId: project.id,
    name,
    dockerName: `svf-vol-${vid.slice(4)}`,
    serviceId: null,
    mountPath: input.mountPath?.trim() || '/data',
    ...freeSpot(project.id, input.x ?? 0, input.y ?? 0),
    sizeBytes: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await ensureDockerVolume(v);
  recordActivity(actor, 'volume.created', `Created volume ${name}`, project.id);
  if (input.serviceId) return attachVolume(actor, v.id, input.serviceId, input.mountPath ?? '/data');
  return withSize(v);
}

export async function attachVolume(actor: Actor, volumeRef: string, serviceId: string, mountPath: string) {
  const v = getVolumeOrThrow(volumeRef);
  const svc = servicesTable.get(serviceId) ?? servicesTable.all().find((s) => s.projectId === v.projectId && (s.slug === serviceId || s.name === serviceId));
  if (!svc) throw new HttpError(404, `service not found: ${serviceId}`);
  if (svc.projectId !== v.projectId) throw new HttpError(400, 'volumes can only be attached to services in the same project');
  if (v.serviceId === svc.id) throw new HttpError(409, `${v.name} is already attached to ${svc.name}`);
  if (v.serviceId) throw new HttpError(409, `${v.name} is attached to ${servicesTable.get(v.serviceId)?.name ?? 'another service'} — detach it first`);
  const path = mountPath?.trim() || v.mountPath;
  checkMountPath(path);
  if (svc.volumes.some((m) => m.mountPath === path)) throw new HttpError(409, `${svc.name} already has a volume at ${path}`);
  // A deploy in flight is fine: it keeps its own snapshot, and the redeploy below queues behind it.
  const inUse = await docker.containersUsingVolume(v.dockerName);
  if (inUse.length) throw new HttpError(409, `${v.name} is still mounted by a running container — wait a moment and retry`);

  await ensureDockerVolume(v);
  v.serviceId = svc.id;
  v.mountPath = path;
  save(v);
  svc.volumes = [...svc.volumes, { name: v.name, mountPath: path, volumeId: v.id }];
  const scaledDown = svc.replicas > 1;
  if (scaledDown) svc.replicas = 1; // shared data → one replica
  if (svc.autoscale.enabled) svc.autoscale = { ...svc.autoscale, enabled: false };
  svc.updatedAt = Date.now();
  servicesTable.put(svc);
  bus.publish({ type: 'service.updated', service: svc });
  recordActivity(actor, 'volume.attached', `Attached ${v.name} to ${svc.name} at ${path}${scaledDown ? ' (scaled to 1 replica)' : ''}`, svc.projectId, svc.id);
  const deployment = svc.activeDeploymentId && !svc.stopped ? await redeploy(actor, svc.id) : null;
  return { volume: withSize(v), deployment };
}

export async function detachVolume(actor: Actor, volumeRef: string) {
  const v = getVolumeOrThrow(volumeRef);
  if (!v.serviceId) throw new HttpError(409, `${v.name} is not attached`);
  const svc = servicesTable.get(v.serviceId);
  if (svc && busy.has(svc.id)) throw new HttpError(409, `${svc.name} is deploying — try again when it's done`);
  // Mark it detached first: from here on no replica of the old service can mount it (mountsFor checks).
  v.serviceId = null;
  if (svc) Object.assign(v, freeSpot(v.projectId, svc.x + 38, svc.y + 250, v.id));
  save(v);
  if (svc) {
    // Take the service over, stop what still mounts the volume, then let it come back without it.
    busy.set(svc.id, new Set(['volume']));
    try {
      svc.status = 'deploying';
      svc.volumes = svc.volumes.filter((m) => m.volumeId !== v.id);
      svc.updatedAt = Date.now();
      servicesTable.put(svc);
      bus.publish({ type: 'service.updated', service: svc });
      await drainAndRemove(replicasOf(svc.id).map((r) => r.containerId), 3000);
    } finally {
      busy.delete(svc.id);
    }
    refreshServiceStatus(svc.id);
  }
  recordActivity(actor, 'volume.detached', `Detached ${v.name}${svc ? ` from ${svc.name}` : ''} — its data is kept`, v.projectId, svc?.id ?? null);
  let deployment = null;
  if (svc?.activeDeploymentId && !svc.stopped) deployment = await redeploy(actor, svc.id);
  else requestReconcile();
  return { volume: withSize(v), deployment };
}

async function redeploy(actor: Actor, serviceId: string) {
  const { deployService } = await import('./ops.ts');
  return deployService(actor, serviceId, actor.type === 'agent' ? 'agent' : 'config');
}

export function updateVolume(actor: Actor, volumeRef: string, patch: { name?: string; x?: number; y?: number }) {
  const v = getVolumeOrThrow(volumeRef);
  if (patch.name !== undefined && patch.name !== v.name) {
    const name = cleanName(patch.name, v.projectId, v.id);
    recordActivity(actor, 'volume.renamed', `Renamed volume ${v.name} → ${name}`, v.projectId, v.serviceId);
    v.name = name;
    if (v.serviceId) {
      const svc = servicesTable.get(v.serviceId);
      if (svc) {
        svc.volumes = svc.volumes.map((m) => (m.volumeId === v.id ? { ...m, name } : m));
        servicesTable.put(svc);
        bus.publish({ type: 'service.updated', service: svc });
      }
    }
  }
  if (patch.x !== undefined) v.x = Math.round(patch.x);
  if (patch.y !== undefined) v.y = Math.round(patch.y);
  return withSize(save(v));
}

export async function deleteVolume(actor: Actor, volumeRef: string) {
  const v = getVolumeOrThrow(volumeRef);
  if (v.serviceId) throw new HttpError(409, `${v.name} is attached to ${servicesTable.get(v.serviceId)?.name ?? 'a service'} — detach it first`);
  const inUse = await docker.containersUsingVolume(v.dockerName, true);
  for (const c of inUse) await docker.removeContainer(c.Id, true);
  await docker.removeVolume(v.dockerName);
  volumesTable.delete(v.id);
  bus.publish({ type: 'volume.deleted', volumeId: v.id, projectId: v.projectId });
  recordActivity(actor, 'volume.deleted', `Deleted volume ${v.name} and its data`, v.projectId);
}

/** Service deleted: its volumes are deleted too, or kept as detached volumes. */
export async function releaseServiceVolumes(svc: Service, keep: boolean) {
  for (const m of svc.volumes) {
    const rec = m.volumeId ? volumesTable.get(m.volumeId) : volumesTable.all().find((r) => r.dockerName === legacyDockerName(svc.id, m.name));
    if (!rec) {
      if (!keep) await docker.removeVolume(legacyDockerName(svc.id, m.name));
      continue;
    }
    if (keep) {
      rec.serviceId = null;
      Object.assign(rec, freeSpot(rec.projectId, svc.x + 38, svc.y, rec.id));
      save(rec);
    } else {
      await docker.removeVolume(rec.dockerName);
      volumesTable.delete(rec.id);
      bus.publish({ type: 'volume.deleted', volumeId: rec.id, projectId: rec.projectId });
    }
  }
}

/** Project deleted: remove its detached volumes too. */
export async function deleteProjectVolumes(projectId: string) {
  for (const v of volumesTable.all('WHERE project_id = ?', projectId)) {
    await docker.removeVolume(v.dockerName);
    volumesTable.delete(v.id);
  }
}

/** The mounts a deployment should use: always the service's current attachments. */
export function currentMounts(svc: Service): Volume[] {
  return structuredClone(svc.volumes);
}

// ───────────────────────────── sizes ─────────────────────────────

const sizes = new Map<string, number>();
function withSize(v: VolumeRecord): VolumeRecord {
  const s = sizes.get(v.dockerName);
  return { ...v, sizeBytes: s !== undefined && s >= 0 ? s : v.sizeBytes };
}

async function pollSizes() {
  if (!volumesTable.all().length) return;
  try {
    const usage = await docker.volumeUsage();
    for (const v of volumesTable.all()) {
      const s = usage.get(v.dockerName);
      if (s === undefined || s < 0) continue;
      if (sizes.get(v.dockerName) !== s) {
        sizes.set(v.dockerName, s);
        publish(withSize(v));
      }
    }
  } catch (e) {
    console.error('[volumes] size poll failed:', (e as Error).message);
  }
}

export function startVolumes() {
  setTimeout(() => void pollSizes(), 5000);
  setInterval(() => void pollSizes(), 60_000);
}
