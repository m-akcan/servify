/**
 * Backups and restores of service data.
 *
 *  • Postgres / MySQL / MariaDB / MongoDB: a logical dump streamed out of the running container
 *    (pg_dumpall, mysqldump, mongodump) — consistent while the database keeps serving.
 *  • Anything else with volumes: a tar.gz of every volume, taken by a throwaway helper container.
 *
 * Restoring always takes a safety backup first, then rebuilds the data: logical dumps are replayed into a
 * freshly initialised database (so the result matches the backup exactly), volume archives replace the
 * volume contents. Destinations: this machine, any folder, or any S3-compatible bucket.
 */
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Transform, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { backupsTable, deployments as deploymentsTable, projects as projectsTable, services as servicesTable, volumesTable } from './db.ts';
import { docker, dockerHostEnv, normalizeImageRef } from './docker.ts';
import { busy, drainAndRemove, replicasOf, requestReconcile, volumeName, refreshServiceStatus } from './engine.ts';
import { bus, recordActivity, type Actor } from './events.ts';
import { notify } from './notify.ts';
import { dockerVolumeFor, membersOf } from './volumes.ts';
import { destinationById, type Destination } from './settings.ts';
import { s3Delete, s3Get, s3Put } from './s3.ts';
import { config } from './config.ts';
import { HttpError, id, KeyedLock, sleep } from './util.ts';
import { parseCron, cronMatches } from './cron.ts';
import type { BackupMethod, BackupRecord, Service } from './types.ts';

const HELPER_IMAGE = 'alpine:3.20';
const lock = new KeyedLock();
const tmpDir = join(config.dataDir, 'tmp');
const SCHEDULER: Actor = { type: 'system', name: 'backup-scheduler' };

// ───────────────────────────── strategy ─────────────────────────────

function deployedImage(svc: Service): string {
  const dep = svc.activeDeploymentId ? deploymentsTable.get(svc.activeDeploymentId) : null;
  return (dep?.image ?? (svc.source.type === 'image' ? svc.source.image : '')).toLowerCase();
}

function volumesOf(svc: Service) {
  // The service's current attachments (volumes are first-class and can move between services).
  return svc.volumes;
}

export function backupMethod(svc: Service): BackupMethod | null {
  const img = deployedImage(svc);
  const repo = img.split('@')[0].replace(/:[^/]*$/, '');
  const name = repo.split('/').pop() ?? '';
  if (svc.templateId === 'postgres' || ['postgres', 'postgis', 'timescaledb', 'timescaledb-ha', 'pgvector'].includes(name)) return 'pg_dumpall';
  if (svc.templateId === 'mysql' || name === 'mysql' || name === 'mariadb' || name === 'percona-server') return 'mysqldump';
  if (svc.templateId === 'mongo' || name === 'mongo' || name === 'mongodb-community-server') return 'mongodump';
  if (volumesOf(svc).length) return 'volume';
  return null;
}

const EXT: Record<BackupMethod, string> = { pg_dumpall: 'sql.gz', mysqldump: 'sql.gz', mongodump: 'archive.gz', volume: 'tar.gz' };

const MYSQL_BIN = (tool: 'dump' | 'client') =>
  tool === 'dump' ? '"$(command -v mysqldump || command -v mariadb-dump)"' : '"$(command -v mysql || command -v mariadb)"';
const MYSQL_PW = '"${MYSQL_ROOT_PASSWORD:-${MARIADB_ROOT_PASSWORD:-}}"';
const MONGO_AUTH =
  'if [ -n "$MONGO_INITDB_ROOT_USERNAME" ]; then set -- --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin; fi;';

const DUMP: Record<Exclude<BackupMethod, 'volume'>, string> = {
  pg_dumpall: 'pg_dumpall --clean --if-exists -U "${POSTGRES_USER:-postgres}"',
  mysqldump: `${MYSQL_BIN('dump')} -uroot -p${MYSQL_PW} --all-databases --single-transaction --routines --events --triggers`,
  mongodump: `${MONGO_AUTH} mongodump --archive --quiet "$@"`,
};
const RESTORE: Record<Exclude<BackupMethod, 'volume'>, string> = {
  pg_dumpall: 'psql -q -v ON_ERROR_STOP=0 -U "${POSTGRES_USER:-postgres}" -d postgres',
  mysqldump: `${MYSQL_BIN('client')} -uroot -p${MYSQL_PW}`,
  mongodump: `${MONGO_AUTH} mongorestore --archive --drop --quiet "$@"`,
};
const READY: Record<Exclude<BackupMethod, 'volume'>, string> = {
  pg_dumpall: 'pg_isready -q -U "${POSTGRES_USER:-postgres}"',
  mysqldump: `"$(command -v mysqladmin || command -v mariadb-admin)" ping -uroot -p${MYSQL_PW} --silent`,
  mongodump: `${MONGO_AUTH} "$(command -v mongosh || command -v mongo)" --quiet --eval "db.adminCommand('ping')" "$@"`,
};

// ───────────────────────────── docker CLI plumbing ─────────────────────────────

function cli(args: string[], io: { stdin?: Readable; stdout?: Writable } = {}): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env: { ...process.env, DOCKER_HOST: dockerHostEnv }, stdio: [io.stdin ? 'pipe' : 'ignore', io.stdout ? 'pipe' : 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr!.on('data', (b: Buffer) => {
      stderr += b.toString();
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.on('error', (e) => reject(new Error(`could not run the docker CLI: ${e.message}`)));
    if (io.stdout) child.stdout!.pipe(io.stdout, { end: false });
    if (io.stdin) {
      io.stdin.on('error', (e) => child.stdin!.destroy(e));
      io.stdin.pipe(child.stdin!);
      child.stdin!.on('error', () => {});
    }
    child.on('close', (code) => resolve({ code: code ?? -1, stderr: stderr.trim() }));
  });
}

async function ensureHelper() {
  if (!(await docker.inspectImage(HELPER_IMAGE))) await docker.pullImage(normalizeImageRef(HELPER_IMAGE));
}

function runningReplica(svc: Service) {
  // Clusters: always the primary (consistent dumps; restores replay into it).
  if (svc.cluster) return replicasOf(svc.id).find((r) => r.dockerState === 'running' && r.index === svc.cluster!.primary);
  return replicasOf(svc.id).find((r) => r.dockerState === 'running' && r.deploymentId === svc.activeDeploymentId) ?? replicasOf(svc.id).find((r) => r.dockerState === 'running');
}

// ───────────────────────────── storage ─────────────────────────────

function objectKey(d: Destination, svc: Service, method: BackupMethod, at: number) {
  const project = projectsTable.get(svc.projectId);
  const stamp = new Date(at).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const base = `${project?.slug ?? 'project'}/${svc.slug}/${svc.slug}-${stamp}-${id().slice(0, 4)}.${EXT[method]}`;
  const prefix = d.type === 's3' ? (d.prefix ?? '').replace(/^\/+|\/+$/g, '') : '';
  return prefix ? `${prefix}/${base}` : base;
}

async function store(d: Destination, key: string, file: string) {
  if (d.type === 'local') {
    const dest = join(d.path!, key);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(file, dest);
    return;
  }
  try {
    await s3Put(d, key, file);
  } finally {
    rmSync(file, { force: true });
  }
}

export async function openBackupStream(b: BackupRecord): Promise<Readable> {
  const d = destinationById(b.destinationId);
  if (!d || !b.key) throw new HttpError(404, 'backup destination no longer exists');
  if (d.type === 'local') {
    const p = join(d.path!, b.key);
    if (!existsSync(p)) throw new HttpError(404, `backup file is missing: ${p}`);
    return createReadStream(p);
  }
  return s3Get(d, b.key);
}

async function removeObject(b: BackupRecord) {
  const d = destinationById(b.destinationId);
  if (!d || !b.key) return;
  if (d.type === 'local') {
    try {
      unlinkSync(join(d.path!, b.key));
    } catch {}
  } else await s3Delete(d, b.key);
}

// ───────────────────────────── backup ─────────────────────────────

function save(b: BackupRecord) {
  if (backupsTable.get(b.id)) backupsTable.put(b);
  else backupsTable.insert(b);
  bus.publish({ type: 'backup.updated', backup: b });
}

export function listBackups(serviceId: string, limit = 50): BackupRecord[] {
  return backupsTable.all('WHERE service_id = ? ORDER BY created_at DESC LIMIT ?', serviceId, limit);
}

export function isBackingUp(serviceId: string) {
  return backupsTable.all(`WHERE service_id = ? AND json_extract(data, '$.status') = 'running'`, serviceId).length > 0;
}

type Trigger = BackupRecord['trigger'] | 'pre-restore';

export function backupService(svc: Service, trigger: Trigger, actor: Actor, destinationId?: string): Promise<BackupRecord> {
  return lock.run(svc.id, () => runBackup(svc, trigger, actor, destinationId));
}

async function runBackup(svc: Service, trigger: Trigger, actor: Actor, destinationId?: string): Promise<BackupRecord> {
  const method = backupMethod(svc);
  if (!method) throw new HttpError(400, `${svc.name} has no data to back up (no volumes and not a known database)`);
  const d = destinationById(destinationId ?? svc.backup?.destinationId ?? 'local');
  if (!d) throw new HttpError(400, 'backup destination not found');
  const project = projectsTable.get(svc.projectId);
  const now = Date.now();
  const rec: BackupRecord = {
    id: id('bak'),
    serviceId: svc.id,
    projectId: svc.projectId,
    serviceName: svc.name,
    status: 'running',
    method,
    trigger: trigger as BackupRecord['trigger'],
    actor: actor.name,
    destinationId: d.id,
    destinationName: d.name,
    key: null,
    sizeBytes: null,
    startedAt: now,
    finishedAt: null,
    error: null,
    createdAt: now,
  };
  save(rec);
  mkdirSync(tmpDir, { recursive: true });
  const tmp = join(tmpDir, `${rec.id}.part`);
  try {
    if (method === 'volume') {
      await ensureHelper();
      const vols = volumesOf(svc);
      if (svc.templateId === 'redis') {
        const r = runningReplica(svc);
        if (r) await docker.exec(r.containerId, ['/bin/sh', '-c', 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning SAVE >/dev/null 2>&1 || true'], 30_000).catch(() => {});
      }
      const mounts = vols.flatMap((v) => {
        const src = dockerVolumeFor(svc.id, v);
        return src ? ['-v', `${src}:/backup/${v.name}:ro`] : [];
      });
      const out = createWriteStream(tmp);
      const r = await cli(['run', '--rm', '--network', 'none', ...mounts, HELPER_IMAGE, 'tar', 'czf', '-', '-C', '/backup', '.'], { stdout: out });
      await new Promise<void>((res) => out.end(res));
      if (r.code !== 0) throw new Error(`tar exited with ${r.code}: ${r.stderr.slice(-400)}`);
    } else {
      const rep = runningReplica(svc);
      if (!rep) throw new Error(`${svc.name} isn't running — start it to take a database backup`);
      const gz = createGzip({ level: 6 });
      const out = createWriteStream(tmp);
      const done = pipeline(gz, out);
      const r = await cli(['exec', rep.containerId, 'sh', '-c', DUMP[method]], { stdout: gz });
      gz.end();
      await done;
      if (r.code !== 0) throw new Error(`${method} exited with ${r.code}: ${r.stderr.slice(-400) || 'no output'}`);
    }
    const size = statSync(tmp).size;
    if (size < 20) throw new Error('the backup came out empty');
    rec.key = objectKey(d, svc, method, now);
    await store(d, rec.key, tmp);
    rec.sizeBytes = size;
    rec.status = 'succeeded';
    rec.finishedAt = Date.now();
    save(rec);
    if (trigger !== 'pre-restore') {
      recordActivity(actor, 'backup.succeeded', `Backed up ${svc.name} to ${d.name} (${formatSize(size)})`, svc.projectId, svc.id);
      notify({
        event: 'backup.succeeded',
        level: 'success',
        title: `Backed up ${svc.name}`,
        message: `${project?.name ?? ''}: ${formatSize(size)} ${method === 'volume' ? 'volume archive' : 'dump'} stored on ${d.name}.`,
        projectId: svc.projectId,
        serviceId: svc.id,
      });
    }
    await applyRetention(svc, d.id).catch((e) => console.error('[backups] retention', (e as Error).message));
    return rec;
  } catch (e) {
    rmSync(tmp, { force: true });
    rec.status = 'failed';
    rec.error = (e as Error).message.slice(0, 800);
    rec.finishedAt = Date.now();
    save(rec);
    recordActivity(actor, 'backup.failed', `Backup of ${svc.name} failed: ${rec.error.slice(0, 140)}`, svc.projectId, svc.id);
    notify({
      event: 'backup.failed',
      level: 'error',
      title: `Backup of ${svc.name} failed`,
      message: `${project?.name ?? ''}: ${rec.error}`,
      projectId: svc.projectId,
      serviceId: svc.id,
    });
    if (trigger === 'pre-restore') throw new Error(`safety backup before restore failed: ${rec.error}`);
    return rec;
  }
}

async function applyRetention(svc: Service, destinationId: string) {
  const keep = Math.max(1, svc.backup?.retention ?? 7);
  const done = backupsTable
    .all(`WHERE service_id = ? AND json_extract(data, '$.status') = 'succeeded' ORDER BY created_at DESC`, svc.id)
    .filter((b) => b.destinationId === destinationId);
  const regular = done.filter((b) => (b.trigger as string) !== 'pre-restore');
  const safety = done.filter((b) => (b.trigger as string) === 'pre-restore');
  for (const b of [...regular.slice(keep), ...safety.slice(2)]) {
    await removeObject(b); // only keys we recorded ourselves
    backupsTable.delete(b.id);
  }
}

export async function deleteBackup(actor: Actor, backupId: string) {
  const b = backupsTable.get(backupId);
  if (!b) throw new HttpError(404, 'backup not found');
  if (b.status === 'running') throw new HttpError(409, 'that backup is still running');
  await removeObject(b);
  backupsTable.delete(b.id);
  recordActivity(actor, 'backup.deleted', `Deleted a backup of ${b.serviceName}`, b.projectId, b.serviceId);
}

// ───────────────────────────── restore ─────────────────────────────

/** Postgres ≥13: make DROP DATABASE succeed even if a client reconnected in the meantime. */
function forceDrops() {
  let carry = '';
  return new Transform({
    transform(chunk, _enc, cb) {
      const text = carry + chunk.toString('utf8');
      const lines = text.split('\n');
      carry = lines.pop() ?? '';
      cb(null, lines.map((l) => l.replace(/^DROP DATABASE IF EXISTS (.+);$/, 'DROP DATABASE IF EXISTS $1 WITH (FORCE);')).join('\n') + '\n');
    },
    flush(cb) {
      cb(null, carry);
    },
  });
}

async function waitReady(svc: Service, method: BackupMethod, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fresh = servicesTable.get(svc.id)!;
    const rep = replicasOf(svc.id).find((r) => r.deploymentId === fresh.activeDeploymentId && r.state === 'healthy' && (!fresh.cluster || r.index === fresh.cluster.primary));
    if (rep) {
      if (method === 'volume') return rep;
      const r = await docker.exec(rep.containerId, ['/bin/sh', '-c', READY[method as Exclude<BackupMethod, 'volume'>]], 15_000).catch(() => ({ exitCode: 1 }));
      if (r.exitCode === 0) return rep;
    }
    await sleep(1500);
  }
  throw new Error('the service did not come back healthy after resetting its data');
}

const restoring = new Set<string>();
export const isRestoring = (serviceId: string) => restoring.has(serviceId);

export function restoreBackup(actor: Actor, backupId: string) {
  const b = backupsTable.get(backupId);
  if (!b || b.status !== 'succeeded') throw new HttpError(404, 'backup not found');
  const svc = servicesTable.get(b.serviceId);
  if (!svc) throw new HttpError(404, 'the service of this backup no longer exists');
  if (busy.has(svc.id)) throw new HttpError(409, `${svc.name} is deploying — wait for it to finish`);
  if (!svc.activeDeploymentId || svc.stopped) throw new HttpError(409, `start ${svc.name} before restoring into it`);
  if (b.method === 'volume' && svc.volumes.some((v) => v.perReplica)) throw new HttpError(400, `${svc.name} keeps one volume per replica — restoring a single archive into it is ambiguous; attach a fresh volume set instead`);
  if (backupMethod(svc) !== b.method) throw new HttpError(400, `this ${b.method} backup doesn't match how ${svc.name} is backed up now (${backupMethod(svc) ?? 'nothing'})`);
  if (restoring.has(svc.id)) throw new HttpError(409, 'a restore is already running');
  restoring.add(svc.id);
  const announce = () => {
    const fresh = servicesTable.get(svc.id);
    if (fresh) bus.publish({ type: 'service.updated', service: fresh });
  };
  announce();
  const job = lock.run(svc.id, () => runRestore(actor, svc, b)).finally(() => {
    restoring.delete(svc.id);
    announce();
  });
  job.catch(() => {});
  return { started: true };
}

async function runRestore(actor: Actor, svc: Service, b: BackupRecord) {
  const when = new Date(b.createdAt).toLocaleString();
  recordActivity(actor, 'backup.restore', `Restoring ${svc.name} from the backup of ${when}`, svc.projectId, svc.id);
  mkdirSync(tmpDir, { recursive: true });
  const tmp = join(tmpDir, `restore-${b.id}.gz`);
  let owned = false;
  let safety: BackupRecord | null = null;
  try {
    safety = await runBackup(svc, 'pre-restore', actor, b.destinationId);
    await pipeline(await openBackupStream(b), createWriteStream(tmp));
    await ensureHelper();

    // Take the service over from the reconciler, stop it and empty its volumes.
    busy.set(svc.id, new Set(['restore']));
    owned = true;
    const fresh = servicesTable.get(svc.id)!;
    fresh.status = 'deploying';
    servicesTable.put(fresh);
    bus.publish({ type: 'service.updated', service: fresh });
    await drainAndRemove(replicasOf(svc.id).map((r) => r.containerId), 2000);
    const vols = volumesOf(svc);
    // Per-replica sets (clusters): every member is wiped — the primary re-initialises, standbys re-clone from it.
    const mounts = vols.flatMap((v) => {
      if (v.perReplica && v.volumeId) {
        const leader = volumesTable.get(v.volumeId);
        return leader ? membersOf(leader).flatMap((m) => ['-v', `${m.dockerName}:/backup/${v.name}-${m.replicaIndex ?? 0}`]) : [];
      }
      const src = dockerVolumeFor(svc.id, v);
      return src ? ['-v', `${src}:/backup/${v.name}`] : [];
    });
    const wipe = await cli(['run', '--rm', '--network', 'none', ...mounts, HELPER_IMAGE, 'sh', '-c', 'for d in /backup/*/; do find "$d" -mindepth 1 -delete; done']);
    if (wipe.code !== 0) throw new Error(`could not clear the volumes: ${wipe.stderr.slice(-300)}`);
    if (b.method === 'volume') {
      const r = await cli(['run', '--rm', '-i', '--network', 'none', ...mounts, HELPER_IMAGE, 'tar', 'xzf', '-', '-C', '/backup'], { stdin: createReadStream(tmp) });
      if (r.code !== 0) throw new Error(`extracting the archive failed: ${r.stderr.slice(-400)}`);
    }
    busy.delete(svc.id);
    owned = false;
    refreshServiceStatus(svc.id);
    requestReconcile();
    const rep = await waitReady(svc, b.method);
    if (b.method !== 'volume') {
      const input = b.method === 'pg_dumpall' ? createReadStream(tmp).pipe(createGunzip()).pipe(forceDrops()) : createReadStream(tmp).pipe(createGunzip());
      const r = await cli(['exec', '-i', rep.containerId, 'sh', '-c', RESTORE[b.method]], { stdin: input });
      if (r.code !== 0) throw new Error(`replaying the dump failed (exit ${r.code}): ${r.stderr.slice(-400)}`);
    }
    const rec = backupsTable.get(b.id);
    if (rec) {
      rec.restoredAt = Date.now();
      save(rec);
    }
    recordActivity(actor, 'backup.restored', `Restored ${svc.name} from the backup of ${when}`, svc.projectId, svc.id);
  } catch (e) {
    const msg = (e as Error).message;
    recordActivity(
      actor,
      'backup.restore_failed',
      `Restore of ${svc.name} failed: ${msg.slice(0, 160)}${safety?.status === 'succeeded' ? ' — a safety backup from just before is in the list' : ''}`,
      svc.projectId,
      svc.id,
    );
    notify({ event: 'backup.failed', level: 'error', title: `Restore of ${svc.name} failed`, message: msg, projectId: svc.projectId, serviceId: svc.id });
    throw e;
  } finally {
    if (owned) {
      busy.delete(svc.id);
      refreshServiceStatus(svc.id);
      requestReconcile();
    }
    rmSync(tmp, { force: true });
  }
}

// ───────────────────────────── schedule ─────────────────────────────

let lastMinute = -1;
function tick() {
  const now = new Date();
  const minute = Math.floor(now.getTime() / 60_000);
  if (minute === lastMinute) return;
  lastMinute = minute;
  for (const svc of servicesTable.all()) {
    const cfg = svc.backup;
    if (!cfg?.enabled || svc.stopped || !svc.activeDeploymentId) continue;
    try {
      if (cronMatches(parseCron(cfg.schedule), now) && !isBackingUp(svc.id)) void backupService(svc, 'schedule', SCHEDULER).catch(() => {});
    } catch {}
  }
}

export function startBackups() {
  mkdirSync(tmpDir, { recursive: true });
  // Partial files and runs interrupted by a restart can't be resumed.
  for (const b of backupsTable.all(`WHERE json_extract(data, '$.status') = 'running'`)) {
    b.status = 'failed';
    b.error = 'interrupted: Servify restarted during this backup';
    b.finishedAt = Date.now();
    backupsTable.put(b);
  }
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  setInterval(tick, 5000);
}

export function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
