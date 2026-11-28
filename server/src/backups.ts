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
 *
 * Safety backups guard the operations that can't be undone by a rollback: a new image starting on a service's data
 * (it may migrate it), and deleting volumes. They reuse a recent successful backup (the nightly one, typically) and
 * only take a new one when there is none — after checking that it fits on the disk.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statfsSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Transform, Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { backupsTable, deployments as deploymentsTable, projects as projectsTable, services as servicesTable, volumesTable } from './db.ts';
import { databaseOf, normalizeImageRef } from './docker.ts';
import { dockerFor, dockerForContainer, isOnline, LOCAL, nodeName, nodeOf } from './nodes.ts';
import { busy, drainAndRemove, INSTANCE_ID, LABEL, replicasOf, requestReconcile, volumeName, refreshServiceStatus } from './engine.ts';
import { bus, recordActivity, type Actor } from './events.ts';
import { notify } from './notify.ts';
import { dockerVolumeFor, knownVolumeSize, measureVolumes, membersOf, ownedMounts } from './volumes.ts';
import { assertDisk, backupDiskBlock, diskBlock, DiskFullError, restoreFitProblem } from './diskguard.ts';
import { destinationById, type Destination } from './settings.ts';
import { s3AbortUpload, s3Delete, s3Get, s3Size, s3Upload } from './s3.ts';
import { tarWalker, type TarListing } from './tar.ts';
import { config } from './config.ts';
import { HttpError, id, KeyedLock, secret, shortId, sleep } from './util.ts';
import { minuteOf } from './cron.ts';
import { anyPending, dropPending, readBeat, reportOutcome, stepSchedule, writeBeat, type CatchUpInfo } from './schedstate.ts';
import type { BackupMethod, BackupRecord, BackupTest, DatabaseKind, SafetyBackupConfig, Service, VolumeRecord } from './types.ts';

export const HELPER_IMAGE = 'alpine:3.20';
// Docker's default log driver keeps a copy of everything a container prints. For a helper that prints the archive
// itself that is a second copy of the whole volume under /var/lib/docker until it exits. We read the output over
// the attached stream, which doesn't need the log.
const NO_LOG = ['--log-driver', 'none'];
const lock = new KeyedLock();
const SCHEDULER: Actor = { type: 'system', name: 'backup-scheduler' };

// ───────────────────────────── strategy ─────────────────────────────

function deployedImage(svc: Service): string {
  const dep = svc.activeDeploymentId ? deploymentsTable.get(svc.activeDeploymentId) : null;
  return (dep?.image ?? (svc.source.type === 'image' ? svc.source.image : '')).toLowerCase();
}

function volumesOf(svc: Service) {
  // Only volumes this service owns: never a host folder (a media library!) or another service's shared volume —
  // those are neither archived nor wiped on restore.
  return ownedMounts(svc.volumes);
}

const DUMP_FOR: Record<DatabaseKind, BackupMethod> = { postgres: 'pg_dumpall', mysql: 'mysqldump', mongo: 'mongodump' };

function kindFromName(ref: string): DatabaseKind | null {
  const name = ref.toLowerCase().split('@')[0].replace(/:[^/]*$/, '').split('/').pop() ?? '';
  if (['postgres', 'postgis', 'timescaledb', 'timescaledb-ha', 'pgvector'].includes(name)) return 'postgres';
  if (['mysql', 'mariadb', 'percona-server'].includes(name)) return 'mysql';
  if (['mongo', 'mongodb-community-server'].includes(name)) return 'mongo';
  return null;
}

export function backupMethod(svc: Service): BackupMethod | null {
  if (svc.templateId === 'postgres') return 'pg_dumpall';
  if (svc.templateId === 'mysql') return 'mysqldump';
  if (svc.templateId === 'mongo') return 'mongodump';
  // The engine detected from the deployed image; then the image names (the deployed image is often
  // Servify's own per-deployment name, so the source's name counts first).
  const dep = svc.activeDeploymentId ? deploymentsTable.get(svc.activeDeploymentId) : null;
  const kind = dep?.database ?? kindFromName(svc.source.type === 'image' ? svc.source.image : '') ?? kindFromName(deployedImage(svc));
  // A sidecar built on a database image (e.g. a pg_dump loop) runs its own command and holds no data: not a server.
  const ownCommand = !!(svc.startCommand || svc.cmd?.length || svc.entrypoint?.length);
  if (kind && (volumesOf(svc).length || !ownCommand)) return DUMP_FOR[kind];
  if (volumesOf(svc).length) return 'volume';
  return null;
}

/** Detect the engine of deployments made before detection existed (once, at startup). */
export async function backfillDatabaseKinds() {
  for (const svc of servicesTable.all()) {
    const dep = svc.activeDeploymentId ? deploymentsTable.get(svc.activeDeploymentId) : null;
    if (!dep?.image || dep.database !== undefined || !isOnline(nodeOf(svc))) continue;
    const img = await dockerFor(nodeOf(svc)).inspectImage(dep.image).catch(() => null);
    if (!img) continue;
    dep.database = databaseOf(img);
    deploymentsTable.put(dep);
  }
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

/** The docker CLI against the server of a service or volume (backup helpers and dumps run there; data streams back here). */
export function cli(svc: { nodeId?: string | null }, args: string[], io: { stdin?: Readable; stdout?: Writable; env?: Record<string, string> } = {}): Promise<{ code: number; stderr: string }> {
  const hostEnv = dockerFor(nodeOf(svc)).hostEnv;
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env: { ...process.env, ...io.env, DOCKER_HOST: hostEnv }, stdio: [io.stdin ? 'pipe' : 'ignore', io.stdout ? 'pipe' : 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr!.on('data', (b: Buffer) => {
      stderr += b.toString();
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.on('error', (e) => reject(new Error(`could not run the docker CLI: ${e.message}`)));
    let exited = false;
    let outError: Error | null = null;
    if (io.stdout) {
      const out = io.stdout;
      child.stdout!.pipe(out, { end: false });
      // The file (or gzip) we write to failed, typically a full disk. Without a listener that error would take the
      // whole process down, and the command would stay blocked on a pipe nobody reads, holding the service's
      // backup lock forever: stop it, and keep draining until it has gone.
      const failed = (e?: Error) => {
        if (exited || outError) return;
        outError = e ?? new Error('the output closed early');
        child.stdout!.unpipe(out);
        child.stdout!.resume();
        child.kill();
        setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
      };
      out.on('error', failed);
      out.on('close', () => failed());
    }
    let inError: Error | null = null;
    if (io.stdin) {
      // A failed source (a damaged or cut-off backup) only looks like the end of the input to the command, which
      // may then exit 0: remember it, so a half-replayed restore is never reported as done.
      io.stdin.on('error', (e) => {
        inError ??= e;
        child.stdin!.destroy(e);
      });
      io.stdin.pipe(child.stdin!);
      child.stdin!.on('error', () => {});
    }
    child.on('close', (code) => {
      exited = true;
      if (outError) reject(new Error(`could not write the data: ${outError.message}`));
      else if (inError) reject(new Error(`could not read the data: ${inError.message}`));
      else resolve({ code: code ?? -1, stderr: stderr.trim() });
    });
  });
}

export async function ensureHelper(svc: { nodeId?: string | null }) {
  const d = dockerFor(nodeOf(svc));
  if (!(await d.inspectImage(HELPER_IMAGE))) await d.pullImage(normalizeImageRef(HELPER_IMAGE));
}

function runningReplica(svc: Service) {
  // Clusters: always the primary (consistent dumps; restores replay into it).
  if (svc.cluster) return replicasOf(svc.id).find((r) => r.dockerState === 'running' && r.index === svc.cluster!.primary);
  return replicasOf(svc.id).find((r) => r.dockerState === 'running' && r.deploymentId === svc.activeDeploymentId) ?? replicasOf(svc.id).find((r) => r.dockerState === 'running');
}

// ───────────────────────────── storage ─────────────────────────────

/** `<project>/<folder>/<name>-<stamp>-<rand>.<ext>`: folder and name are the service's slug, or "volumes" and a volume's name. */
function objectKey(d: Destination, of: { projectId: string; folder: string; name: string }, method: BackupMethod, at: number) {
  const project = projectsTable.get(of.projectId);
  const stamp = new Date(at).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const base = `${project?.slug ?? 'project'}/${of.folder}/${of.name}-${stamp}-${id().slice(0, 4)}.${EXT[method]}`;
  const prefix = d.type === 's3' ? (d.prefix ?? '').replace(/^\/+|\/+$/g, '') : '';
  return prefix ? `${prefix}/${base}` : base;
}

/** A folder destination writes here first and renames when the backup is complete: never a partial file under a backup's name. */
const PARTIAL = '.part';

/** Where a backup streams to: `commit()` publishes it (rename, or the last S3 part and "complete"), `abort()` removes every trace. */
type Sink = { stream: Writable; commit(): Promise<void>; abort(): Promise<void> };

function openSink(d: Destination, rec: BackupRecord, sizeHint: number | null): Sink {
  const key = rec.key!;
  if (d.type === 'local') {
    const dest = join(d.path!, key);
    mkdirSync(dirname(dest), { recursive: true });
    const part = dest + PARTIAL;
    // flush: fsync before close, so a power cut right after the rename can't leave an empty "backup".
    const stream = createWriteStream(part, { flush: true });
    let renamed = false;
    return {
      stream,
      async commit() {
        renameSync(part, dest);
        renamed = true;
      },
      async abort() {
        if (!stream.closed) {
          const closed = new Promise((r) => stream.once('close', r));
          stream.destroy();
          await closed;
        }
        rmSync(part, { force: true });
        if (renamed) rmSync(dest, { force: true });
      },
    };
  }
  return s3Upload(d, key, {
    sizeHint,
    // Recorded at once: if Servify stops mid-upload, the upload can still be aborted (startBackups, cleanLeftovers).
    onUploadId: (uploadId) => {
      rec.uploadId = uploadId;
      save(rec);
    },
  });
}

/** SHA-256 and length of whatever streams through. */
function meter() {
  const hash = createHash('sha256');
  let size = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  });
  let digest: string | null = null;
  return { stream, size: () => size, sha256: () => (digest ??= hash.digest('hex')) };
}

async function storedSize(d: Destination, key: string): Promise<number | null> {
  if (d.type === 'local') {
    try {
      return statSync(join(d.path!, key)).size;
    } catch {
      return null;
    }
  }
  return s3Size(d, key);
}

/**
 * Stream a backup straight to its destination: `produce` writes the archive or dump into the stream it is given and
 * ends it once the source finished cleanly. Nothing is staged on this machine's disk. The bytes are hashed on the way;
 * only after the source succeeded and the result isn't empty is the backup published, and its stored size is read
 * back. Any failure removes what was written (or, when the destination can't be reached, marks the record so the
 * leftovers are removed later).
 */
async function writeBackup(d: Destination, rec: BackupRecord, produce: (out: Writable) => Promise<void>, sizeHint: number | null): Promise<{ size: number; sha256: string }> {
  save(rec); // the key is known while it runs: a restart in the middle can still find what to clean up
  const m = meter();
  let sink: Sink | null = null;
  try {
    sink = openSink(d, rec, sizeHint);
    const flowing = pipeline(m.stream, sink.stream);
    flowing.catch(() => {}); // awaited below; a destination failure arrives through produce() first
    await produce(m.stream);
    await flowing;
    if (m.size() <= 20) throw new Error('the backup came out empty'); // 20 bytes = a gzip of nothing
    await sink.commit();
    const stored = await storedSize(d, rec.key!);
    if (stored !== m.size()) throw new Error(`the stored backup has ${stored === null ? 'no' : stored} bytes, ${m.size()} were written`);
    delete rec.uploadId;
    return { size: m.size(), sha256: m.sha256() };
  } catch (e) {
    m.stream.destroy();
    try {
      await sink?.abort();
      rec.key = null;
      delete rec.uploadId;
    } catch (err) {
      rec.cleanupPending = true;
      console.error(`[backups] could not remove the partial backup ${rec.key} yet (retried later):`, (err as Error).message);
    }
    throw e;
  }
}

/** The stored archive as a stream: a file, or an S3 download that resumes when the connection drops. */
export async function openBackupStream(b: BackupRecord): Promise<Readable> {
  const d = destinationById(b.destinationId);
  if (!d || !b.key) throw new HttpError(404, 'backup destination no longer exists');
  if (d.type === 'local') {
    const p = join(d.path!, b.key);
    if (!existsSync(p)) throw new HttpError(404, `backup file is missing: ${p}`);
    return createReadStream(p);
  }
  // A missing object is a 404 before anything streams (a download would otherwise start with a 200 and break).
  if ((await s3Size(d, b.key)) === null) throw new HttpError(404, `backup object is missing at ${d.name}: ${b.key}`);
  return s3Get(d, b.key);
}

async function removeObject(b: BackupRecord) {
  const d = destinationById(b.destinationId);
  if (!d || !b.key) return;
  if (d.type === 'local') {
    try {
      unlinkSync(join(d.path!, b.key));
    } catch {}
    rmSync(join(d.path!, b.key) + PARTIAL, { force: true });
  } else {
    if (b.uploadId) await s3AbortUpload(d, b.key, b.uploadId);
    await s3Delete(d, b.key);
  }
}

/** Remove what a failed or interrupted backup left at its destination; the record then points nowhere. */
async function cleanLeftovers(b: BackupRecord) {
  await removeObject(b);
  const fresh = backupsTable.get(b.id);
  if (!fresh) return;
  fresh.key = null;
  delete fresh.uploadId;
  delete fresh.cleanupPending;
  backupsTable.put(fresh);
}

let cleaning = false;
/** Retry the cleanups that failed (the destination was down): every minute, and right after a restart. */
async function cleanPending() {
  if (cleaning) return;
  cleaning = true;
  try {
    for (const b of backupsTable.all(`WHERE json_extract(data, '$.status') = 'failed' AND json_extract(data, '$.cleanupPending') = 1`)) {
      await cleanLeftovers(b).catch((e) => console.error(`[backups] cleanup of ${b.key} failed (retried later):`, (e as Error).message));
    }
  } finally {
    cleaning = false;
  }
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

/** A backup, restore or safety backup of the service runs or waits under its backup lock. */
export const backupLockHeld = (serviceId: string) => lock.held(serviceId);

export function isBackingUp(serviceId: string) {
  return backupsTable.all(`WHERE service_id = ? AND json_extract(data, '$.status') = 'running'`, serviceId).length > 0;
}

type Trigger = BackupRecord['trigger'];

export function backupService(svc: Service, trigger: Trigger, actor: Actor, destinationId?: string, opts: { catchUp?: CatchUpInfo | null } = {}): Promise<BackupRecord> {
  return lock.run(svc.id, () => runBackup(svc, trigger, actor, destinationId, opts.catchUp ? { catchUp: opts.catchUp } : {}));
}

/** A tar.gz of Docker volumes (`-v name:/backup/<dir>:ro` arguments) into `out`, by a throwaway helper on their server. */
async function archiveVolumes(on: { nodeId?: string | null }, mounts: string[], out: Writable) {
  const r = await cli(on, ['run', '--rm', ...NO_LOG, '--network', 'none', ...mounts, HELPER_IMAGE, 'tar', 'czf', '-', '-C', '/backup', '.'], { stdout: out });
  if (r.code !== 0) throw new Error(`tar exited with ${r.code}: ${r.stderr.slice(-400)}`);
  out.end();
}

/** A logical dump out of the running database, gzipped here on its way to `out`. */
async function dumpDatabase(svc: Service, containerId: string, method: Exclude<BackupMethod, 'volume'>, out: Writable) {
  const gz = createGzip({ level: 6 });
  const zipped = pipeline(gz, out);
  zipped.catch(() => {}); // awaited below; a destination failure arrives before that
  const r = await cli(svc, ['exec', containerId, 'sh', '-c', DUMP[method]], { stdout: gz });
  if (r.code !== 0) {
    gz.destroy();
    throw new Error(`${method} exited with ${r.code}: ${r.stderr.slice(-400) || 'no output'}`);
  }
  gz.end();
  await zipped;
}

/** The size of the last backup like this one: S3 uploads pick a part size from it (big archives, big parts). */
function lastSize(serviceId: string, method: BackupMethod): number | null {
  return backupsTable.all(`WHERE service_id = ? AND json_extract(data, '$.status') = 'succeeded' ORDER BY created_at DESC LIMIT 20`, serviceId).find((b) => b.method === method)?.sizeBytes ?? null;
}

/** `extra.method`: a volume archive instead of a dump (safety backups of a stopped database: its files are consistent then). */
async function runBackup(svc: Service, trigger: Trigger, actor: Actor, destinationId?: string, extra: { method?: BackupMethod; purpose?: string; sizeHint?: number; catchUp?: CatchUpInfo } = {}): Promise<BackupRecord> {
  const method = extra.method ?? backupMethod(svc);
  if (!method) throw new HttpError(400, `${svc.name} has no data to back up (no volumes and not a known database)`);
  const d = destinationById(destinationId ?? svc.backup?.destinationId ?? 'local');
  if (!d) throw new HttpError(400, 'backup destination not found');
  // Low-disk protection on the data disk: nothing new is written to a folder on it (S3 needs no disk here). The
  // backup a restore takes first is the exception — restores stay possible; it is held to the reserve check instead.
  const full = trigger === 'pre-restore' ? null : backupDiskBlock(d);
  if (full) {
    if (trigger === 'schedule') recordActivity(actor, 'backup.skipped', `Scheduled backup of ${svc.name} to ${d.name} skipped: ${full.split(' — ')[0]}`, svc.projectId, svc.id);
    throw new DiskFullError(full);
  }
  const project = projectsTable.get(svc.projectId);
  const now = Date.now();
  const image = method !== 'volume' ? deployedImage(svc) : '';
  const rec: BackupRecord = {
    id: id('bak'),
    serviceId: svc.id,
    projectId: svc.projectId,
    serviceName: svc.name,
    status: 'running',
    method,
    trigger,
    ...(extra.purpose ? { purpose: extra.purpose } : {}),
    ...(extra.catchUp ? { catchUp: extra.catchUp } : {}),
    // Only archives hold volumes as such: a dump holds the database, not the service's other volumes (uploads…).
    ...(method === 'volume' ? { volumeIds: volumesOf(svc).map((v) => v.volumeId).filter((v): v is string => !!v) } : {}),
    ...(image ? { image } : {}),
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
  try {
    let produce: (out: Writable) => Promise<void>;
    if (method === 'volume') {
      await ensureHelper(svc);
      const vols = volumesOf(svc);
      if (svc.templateId === 'redis') {
        const r = runningReplica(svc);
        if (r) await dockerForContainer(r.containerId).exec(r.containerId, ['/bin/sh', '-c', 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning SAVE >/dev/null 2>&1 || true'], 10 * 60_000).catch(() => {});
      }
      const mounts = vols.flatMap((v) => {
        const src = dockerVolumeFor(svc.id, v);
        return src ? ['-v', `${src}:/backup/${v.name}:ro`] : [];
      });
      produce = (out) => archiveVolumes(svc, mounts, out);
    } else {
      const rep = runningReplica(svc);
      if (!rep) throw new Error(`${svc.name} isn't running — start it to take a database backup`);
      produce = (out) => dumpDatabase(svc, rep.containerId, method, out);
    }
    rec.key = objectKey(d, { projectId: svc.projectId, folder: svc.slug, name: svc.slug }, method, now);
    const { size, sha256 } = await writeBackup(d, rec, produce, extra.sizeHint ?? lastSize(svc.id, method));
    rec.sizeBytes = size;
    rec.sha256 = sha256;
    rec.status = 'succeeded';
    rec.finishedAt = Date.now();
    save(rec);
    if (trigger === 'safety') {
      recordActivity(actor, 'backup.succeeded', `Safety backup of ${svc.name}${extra.purpose ? ` before ${extra.purpose}` : ''} stored on ${d.name} (${formatSize(size)})`, svc.projectId, svc.id);
    } else if (trigger !== 'pre-restore') {
      recordActivity(actor, 'backup.succeeded', `Backed up ${svc.name} to ${d.name} (${formatSize(size)})${rec.catchUp ? ' — run late, for the scheduled backup missed while Servify was down' : ''}`, svc.projectId, svc.id);
      // Scheduled backups that were failing work again (a manual backup that works says so too).
      reportOutcome('backup', svc.id, true, backupNotice(svc, project?.name, ''));
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
    rec.status = 'failed';
    rec.error = (e as Error).message.slice(0, 800);
    rec.finishedAt = Date.now();
    save(rec);
    recordActivity(actor, 'backup.failed', `${trigger === 'safety' ? 'Safety backup' : 'Backup'} of ${svc.name} failed: ${rec.error.slice(0, 140)}`, svc.projectId, svc.id);
    // A failed safety backup refuses the operation it was for, and that refusal is what gets reported. Scheduled
    // backups that keep failing notify once (then a reminder now and then); one asked for notifies every time.
    if (trigger === 'schedule') reportOutcome('backup', svc.id, false, backupNotice(svc, project?.name, rec.error));
    else if (trigger !== 'safety') notify(backupNotice(svc, project?.name, rec.error).failure);
    if (trigger === 'pre-restore') throw new Error(`safety backup before restore failed: ${rec.error}`);
    return rec;
  }
}

function backupNotice(svc: Service, project: string | undefined, error: string) {
  return {
    subject: `Scheduled backups of ${svc.name}`,
    project,
    failure: { event: 'backup.failed' as const, level: 'error' as const, title: `Backup of ${svc.name} failed`, message: `${project ?? ''}: ${error}`, projectId: svc.projectId, serviceId: svc.id },
  };
}

async function applyRetention(svc: Service, destinationId: string) {
  const keep = Math.max(1, svc.backup?.retention ?? 7);
  const done = backupsTable
    .all(`WHERE service_id = ? AND json_extract(data, '$.status') = 'succeeded' ORDER BY created_at DESC`, svc.id)
    .filter((b) => b.destinationId === destinationId);
  // Safety backups have buckets of their own: a run of deploys must never push the scheduled backups out.
  const regular = done.filter((b) => b.trigger !== 'pre-restore' && b.trigger !== 'safety');
  const preRestore = done.filter((b) => b.trigger === 'pre-restore');
  const safety = done.filter((b) => b.trigger === 'safety');
  for (const b of [...regular.slice(keep), ...preRestore.slice(2), ...safety.slice(2)]) {
    if (testing.has(b.id)) continue; // being test-restored: the next run removes it
    await removeObject(b); // only keys we recorded ourselves
    backupsTable.delete(b.id);
  }
}

export async function deleteBackup(actor: Actor, backupId: string) {
  const b = backupsTable.get(backupId);
  if (!b) throw new HttpError(404, 'backup not found');
  if (b.status === 'running') throw new HttpError(409, 'that backup is still running');
  if (testing.has(b.id)) throw new HttpError(409, 'that backup is being test-restored — wait for it to finish');
  try {
    await removeObject(b);
  } catch (e) {
    // Never forget an object (or an unfinished upload) we can still name: it would stay at the destination for good.
    throw new HttpError(502, `could not delete the backup at ${b.destinationName}: ${(e as Error).message}`);
  }
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
      const r = await dockerForContainer(rep.containerId).exec(rep.containerId, ['/bin/sh', '-c', READY[method as Exclude<BackupMethod, 'volume'>]], 15_000).catch(() => ({ exitCode: 1 }));
      if (r.exitCode === 0) return rep;
    }
    await sleep(1500);
  }
  throw new Error('the service did not come back healthy after resetting its data');
}

const restoring = new Set<string>();
export const isRestoring = (serviceId: string) => restoring.has(serviceId);
/** Restores running anywhere right now. */
export const restoresRunning = () => restoring.size;

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
  // A restore replaces the data, so it is allowed on a low disk — unless it clearly can't fit: the stored backup
  // (compressed: a lower bound of what it unpacks to) against the free space plus what wiping the current data frees.
  const tooBig = restoreFitProblem(svc.nodeId, b.sizeBytes ?? 0, currentDataSize(svc), `restoring this ${formatSize(b.sizeBytes ?? 0)} backup`);
  if (tooBig) throw new DiskFullError(tooBig);
  restoring.add(svc.id);
  // The restore's progress and outcome live on the backup (the CLI and agents follow it there).
  b.restore = { status: 'running', step: 'checking the backup', startedAt: Date.now(), finishedAt: null, error: null, actor: actor.name, safetyBackupId: null };
  save(b);
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

/** Updates the restore state on the backup record (a fresh copy: it may have changed meanwhile). */
function restoreState(backupId: string, patch: Partial<NonNullable<BackupRecord['restore']>>) {
  const rec = backupsTable.get(backupId);
  if (!rec?.restore) return;
  rec.restore = { ...rec.restore, ...patch };
  save(rec);
}

/** A backup for the API: a restore that a restart of Servify cut off is reported as such, not as running forever. */
export function publicBackup(b: BackupRecord): BackupRecord {
  if (b.restore?.status === 'running' && !restoring.has(b.serviceId)) {
    return { ...b, restore: { ...b.restore, status: 'failed', finishedAt: b.restore.finishedAt ?? null, error: b.restore.error ?? 'interrupted (Servify restarted during the restore)' } };
  }
  return b;
}

export type Verified = { bytes: number; sha256: string; checksum: boolean; listing: TarListing | null; unpacked: number };

/** The stored bytes against the record: same length, and the same SHA-256 when the backup has one. */
function checkIntegrity(b: BackupRecord, size: number, sha256: string) {
  if (b.sizeBytes != null && size !== b.sizeBytes) throw new Error(`the backup is incomplete: ${size} bytes stored, ${b.sizeBytes} expected`);
  if (b.sha256 && sha256 !== b.sha256) throw new Error(`checksum mismatch: the stored backup is not the one that was written (sha256 ${sha256.slice(0, 12)}…, expected ${b.sha256.slice(0, 12)}…)`);
}

/**
 * Read a backup all the way through without writing anything: its length and SHA-256 (when it has one), the gzip
 * stream to its end (its CRC catches a damaged byte), and for volume archives every tar header up to the
 * end-of-archive marker. A second download for S3, but no disk — and nothing has changed yet when it fails.
 */
export async function verifyBackup(b: BackupRecord): Promise<Verified> {
  const src = await openBackupStream(b);
  const m = meter();
  let readError: Error | null = null;
  src.on('error', (e) => (readError ??= e));
  const walker = b.method === 'volume' ? tarWalker() : null;
  let unpacked = 0;
  const sink = walker ?? new Writable({ write: (c: Buffer, _e, cb) => ((unpacked += c.length), cb()) });
  try {
    await pipeline(src, m.stream, createGunzip(), sink);
  } catch (e) {
    if (readError) throw new Error(`could not read the backup: ${(readError as Error).message}`);
    throw new Error(`the backup is damaged or incomplete: ${(e as Error).message}`);
  }
  checkIntegrity(b, m.size(), m.sha256());
  const listing = walker?.listing() ?? null;
  return { bytes: m.size(), sha256: m.sha256(), checksum: !!b.sha256, listing, unpacked: listing ? listing.bytes : unpacked };
}

/**
 * The stored archive streamed into a consumer, hashed on the way. `done()`, once the consumer finished, reads what it
 * left unread (tar stops at its end marker) and checks length and checksum: a mismatch fails whatever was restored.
 */
async function hashedSource(b: BackupRecord) {
  const src = await openBackupStream(b);
  const m = meter();
  src.on('error', (e) => m.stream.destroy(e));
  src.pipe(m.stream);
  return {
    stream: m.stream as Readable,
    async done() {
      const out = m.stream;
      if (!out.readableEnded) {
        out.unpipe();
        await new Promise<void>((res, rej) => {
          out.on('end', res);
          out.on('error', rej);
          out.resume();
        });
      }
      checkIntegrity(b, m.size(), m.sha256());
    },
  };
}

/** What the service's own volumes hold now (freed when a restore wipes them), from the last measurement; null if unknown. */
function currentDataSize(svc: Service): number | null {
  const names = volumesOf(svc).map((v) => dockerVolumeFor(svc.id, v)).filter((n): n is string => !!n);
  return names.length ? knownVolumeSize(names) : 0;
}

async function runRestore(actor: Actor, svc: Service, b: BackupRecord) {
  const when = new Date(b.createdAt).toLocaleString();
  recordActivity(actor, 'backup.restore', `Restoring ${svc.name} from the backup of ${when}`, svc.projectId, svc.id);
  let owned = false;
  let reset = false; // the live data has been touched
  let safety: BackupRecord | null = null;
  try {
    // 1. Check the whole backup before anything changes: a damaged or cut-off archive is refused here, with the live
    //    data untouched and no safety backup taken for nothing. Backups without a checksum get the gzip/tar check only.
    const v = await verifyBackup(b);
    // …and now that its unpacked size is known: whether it fits on the Docker disk.
    const tooBig = restoreFitProblem(svc.nodeId, v.unpacked, currentDataSize(svc), `the backup unpacks to ${formatSize(v.unpacked)}: restoring it`);
    if (tooBig) throw new Error(tooBig);

    // 2. A safety backup of the current data (to the backup's own destination), when it fits there.
    const d = destinationById(b.destinationId);
    if (d?.type === 'local') {
      const vols = volumesOf(svc);
      const names = vols.map((v) => dockerVolumeFor(svc.id, v)).filter((n): n is string => !!n);
      const estimate = await estimateSize(svc.name, svc.nodeId, b.method, names, backupsTable.all(`WHERE service_id = ? AND json_extract(data, '$.status') = 'succeeded' ORDER BY created_at DESC LIMIT 20`, svc.id).find((x) => x.method === b.method) ?? null).catch(() => null);
      const problem = estimate !== null ? spaceProblem(estimate, d, { restore: true }) : null;
      if (problem) throw new Error(`no safety backup before the restore: ${problem} — nothing was changed`);
    }
    restoreState(b.id, { step: 'taking a safety backup of the current data' });
    safety = await runBackup(svc, 'pre-restore', actor, b.destinationId);
    restoreState(b.id, { safetyBackupId: safety.id });
    await ensureHelper(svc);

    // 3. Take the service over from the reconciler, stop it and empty its volumes. A deploy that started during the
    //    safety backup would start replicas on the volumes while they are wiped: nothing is touched yet, so stop here.
    if (busy.has(svc.id)) throw new Error(`${svc.name} started deploying meanwhile — nothing was changed, restore again when it's done`);
    busy.set(svc.id, new Set(['restore']));
    owned = true;
    const fresh = servicesTable.get(svc.id)!;
    fresh.status = 'deploying';
    servicesTable.put(fresh);
    bus.publish({ type: 'service.updated', service: fresh });
    reset = true;
    restoreState(b.id, { step: `stopping ${svc.name} and clearing its data` });
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
    // No volumes (a database keeping its data in the container): removing the container already reset it.
    if (mounts.length) {
      const wipe = await cli(svc, ['run', '--rm', ...NO_LOG, '--network', 'none', ...mounts, HELPER_IMAGE, 'sh', '-c', 'for d in /backup/*/; do find "$d" -mindepth 1 -delete; done']);
      if (wipe.code !== 0) throw new Error(`could not clear the volumes: ${wipe.stderr.slice(-300)}`);
    }
    // 4. Stream the backup in (from S3: a second download, never a copy on this disk), hashing it again.
    if (b.method === 'volume') {
      restoreState(b.id, { step: 'unpacking the backup into the volumes' });
      const src = await hashedSource(b);
      const r = await cli(svc, ['run', '--rm', '-i', ...NO_LOG, '--network', 'none', ...mounts, HELPER_IMAGE, 'tar', 'xzf', '-', '-C', '/backup'], { stdin: src.stream });
      if (r.code !== 0) throw new Error(`extracting the archive failed: ${r.stderr.slice(-400)}`);
      await src.done();
    }
    busy.delete(svc.id);
    owned = false;
    refreshServiceStatus(svc.id);
    requestReconcile();
    restoreState(b.id, { step: `waiting for ${svc.name} to come back` });
    const rep = await waitReady(svc, b.method);
    if (b.method !== 'volume') {
      restoreState(b.id, { step: 'replaying the dump' });
      // Errors of the download and of gunzip (a damaged backup) are passed down the chain: unhandled, they would crash
      // the process right after the data was reset.
      const src = await hashedSource(b);
      const gunzip = createGunzip();
      const input = b.method === 'pg_dumpall' ? gunzip.pipe(forceDrops()) : gunzip;
      src.stream.on('error', (e) => input.destroy(e));
      if (input !== gunzip) gunzip.on('error', (e) => input.destroy(e));
      src.stream.pipe(gunzip);
      const r = await cli(svc, ['exec', '-i', rep.containerId, 'sh', '-c', RESTORE[b.method]], { stdin: input });
      if (r.code !== 0) throw new Error(`replaying the dump failed (exit ${r.code}): ${r.stderr.slice(-400)}`);
      await src.done();
    }
    const rec = backupsTable.get(b.id);
    if (rec) {
      rec.restoredAt = Date.now();
      if (rec.restore) rec.restore = { ...rec.restore, status: 'succeeded', step: 'done', finishedAt: rec.restoredAt };
      save(rec);
    }
    recordActivity(actor, 'backup.restored', `Restored ${svc.name} from the backup of ${when}`, svc.projectId, svc.id);
  } catch (e) {
    const msg = (e as Error).message;
    const back = safety?.status === 'succeeded';
    const tail = reset
      ? back
        ? ` — ${svc.name}'s data may be incomplete: restore the safety backup from just before (in the list) to go back`
        : ` — ${svc.name}'s data may be incomplete`
      : /nothing was changed/.test(msg)
        ? ''
        : ' — nothing was changed';
    recordActivity(actor, 'backup.restore_failed', `Restore of ${svc.name} failed: ${msg.slice(0, 160)}${tail}`, svc.projectId, svc.id);
    restoreState(b.id, { status: 'failed', finishedAt: Date.now(), error: `${msg}${tail}`.slice(0, 1000) });
    notify({ event: 'backup.failed', level: 'error', title: `Restore of ${svc.name} failed`, message: `${msg}${tail}`, projectId: svc.projectId, serviceId: svc.id });
    throw e;
  } finally {
    if (owned) {
      busy.delete(svc.id);
      refreshServiceStatus(svc.id);
      requestReconcile();
    }
  }
}

// ───────────────────────────── safety backups ─────────────────────────────

/** How old a backup may be and still count as recent, unless a service says otherwise (the nightly one counts). */
export const SAFETY_MAX_AGE_HOURS = 24;

/**
 * What a safety backup is for. `deploy`: a new image starting on a service's data (deploys, rollbacks, auto-updates).
 * `switch`: switching an image service to another tag, or a build to another base image tag. `delete`: deleting volumes.
 */
export type SafetyPurpose = 'deploy' | 'switch' | 'delete';
export type SafetyPolicy = SafetyBackupConfig & { explicit: boolean; why: string };

/**
 * The policy in force: the service's own setting, else the default for the purpose.
 *  • deploy: on (reuse a backup up to 24 h old, else take one) when the service has scheduled backups — they say where
 *    backups go and that they fit there. Off when it has none: Servify won't pick a destination (the data disk!) and
 *    start a backup of unknown size in the middle of a deploy, a git push or an auto-update that has no way to say
 *    "go ahead anyway". The deploy log says so instead.
 *  • switch: always (it is someone's explicit request): reuse a backup up to 24 h old, else take one. It used to take a
 *    fresh one every time — for a 207 GB volume that is hours, on the data disk.
 *  • delete: always — deleting data is the one thing nothing can undo, and it is always someone's explicit request.
 */
export function safetyPolicy(svc: Service | null, purpose: SafetyPurpose): SafetyPolicy {
  const own = svc?.safetyBackup;
  if (own) return { mode: own.mode, maxAgeHours: own.maxAgeHours, explicit: true, why: 'set for this service' };
  if (purpose === 'switch') return { mode: 'auto', maxAgeHours: SAFETY_MAX_AGE_HOURS, explicit: false, why: 'switching versions always needs a recent backup' };
  if (purpose === 'delete') return { mode: 'auto', maxAgeHours: SAFETY_MAX_AGE_HOURS, explicit: false, why: 'deleting data always needs a recent backup' };
  return svc?.backup?.enabled
    ? { mode: 'auto', maxAgeHours: SAFETY_MAX_AGE_HOURS, explicit: false, why: 'on because scheduled backups are on' }
    : { mode: 'off', maxAgeHours: SAFETY_MAX_AGE_HOURS, explicit: false, why: 'off because scheduled backups are off' };
}

/** Data a new image could change in place: a service with volumes or a database of its own. Clusters roll standbys first and stop at the first failure, scheduled jobs start nothing long-lived. */
export const keepsData = (svc: Service) => !!backupMethod(svc) && !svc.cluster && !svc.schedule;

/** An operation refused for want of a safety backup (nothing was changed). Clients retry with skipSafetyBackup. */
export class SafetyBackupError extends HttpError {
  constructor(message: string) {
    super(409, message, 'safety_backup');
  }
}

export type SafetyOutcome = { status: 'off' | 'nothing' | 'reused' | 'taken'; backup?: BackupRecord; message: string };

const hoursText = (h: number) => (h % 24 === 0 && h >= 48 ? `${h / 24} days` : `${h} h`);
function ageText(at: number) {
  const m = Math.max(0, Math.round((Date.now() - at) / 60_000));
  return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
}
const kindText = (b: BackupRecord) => ({ schedule: 'scheduled', manual: 'manual', agent: 'manual', safety: 'safety', 'pre-restore': 'safety' })[b.trigger] ?? '';
const describe = (b: BackupRecord) => `the ${kindText(b)} backup from ${ageText(b.startedAt)} ago (${formatSize(b.sizeBytes ?? 0)} on ${b.destinationName})`;

/**
 * The newest successful backup of the service's current data at most `maxAgeHours` old: same method (or a volume archive
 * holding all of its volumes), still at an existing destination. Pre-restore backups hold data a restore then replaced.
 */
function recentBackup(svc: Service, maxAgeHours: number): BackupRecord | null {
  if (!(maxAgeHours > 0)) return null;
  const since = Date.now() - maxAgeHours * 3_600_000;
  const method = backupMethod(svc);
  const owned = volumesOf(svc).map((v) => v.volumeId).filter((v): v is string => !!v);
  const holdsAll = (b: BackupRecord) => !b.volumeIds || owned.every((v) => b.volumeIds!.includes(v));
  return (
    backupsTable
      .all(`WHERE service_id = ? AND json_extract(data, '$.status') = 'succeeded' ORDER BY created_at DESC LIMIT 100`, svc.id)
      .find(
        (b) =>
          b.startedAt >= since &&
          b.trigger !== 'pre-restore' &&
          !!b.key &&
          !!destinationById(b.destinationId) &&
          ((b.method === method && (method !== 'volume' || holdsAll(b))) || (b.method === 'volume' && !!b.volumeIds && owned.length > 0 && holdsAll(b))),
      ) ?? null
  );
}

/** Unattended operations (auto-updates) never take a backup themselves: null when one may go ahead, else why not. */
export function safetyBlocker(svc: Service): string | null {
  if (!keepsData(svc)) return null;
  const p = safetyPolicy(svc, 'deploy');
  if (p.mode === 'off') return null;
  if (!destinationById(svc.backup?.destinationId ?? 'local')) return `${svc.name}'s backup destination no longer exists`;
  if (recentBackup(svc, p.maxAgeHours)) return null;
  return p.maxAgeHours > 0 ? `there is no successful backup of ${svc.name} from the last ${hoursText(p.maxAgeHours)}` : `${svc.name} is set to take a fresh backup every time`;
}

const GB = 1024 ** 3;
/** The nearest folder of `p` that exists (a destination folder is created on its first backup). */
function existing(p: string) {
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  return p;
}

/**
 * Whether a backup of up to `estimate` bytes fits, keeping a reserve free (SERVIFY_BACKUP_RESERVE_GB, default 5% of
 * the disk, at least 2 GB and at most 20 GB). Backups stream straight to their destination (also from other servers:
 * their data passes through this machine without being stored): an S3 bucket needs no disk here at all — one part at a
 * time in memory — and a folder needs room on its own disk only, whichever disk that is.
 */
function spaceProblem(estimate: number, d: Destination, opts: { restore?: boolean } = {}): string | null {
  if (d.type !== 'local' || !d.path) return null;
  const full = opts.restore ? null : backupDiskBlock(d);
  if (full) return full;
  const p = d.path;
  let free: number;
  let total: number;
  try {
    const st = statfsSync(existing(p));
    free = Number(st.bavail) * Number(st.bsize);
    total = Number(st.blocks) * Number(st.bsize);
  } catch (e) {
    return `the free space on ${p} could not be read (${(e as Error).message})`;
  }
  const set = Number(process.env.SERVIFY_BACKUP_RESERVE_GB);
  const reserve = process.env.SERVIFY_BACKUP_RESERVE_GB && Number.isFinite(set) && set >= 0 ? set * GB : Math.min(20 * GB, Math.max(2 * GB, total * 0.05));
  let onDataDisk = false;
  try {
    onDataDisk = statSync(existing(p)).dev === statSync(existing(config.dataDir)).dev;
  } catch {}
  if (free - estimate < reserve)
    return `a backup of up to ${formatSize(estimate)} doesn't fit on ${onDataDisk ? `the data disk (${p})` : p}: ${formatSize(Math.max(0, free))} free, and Servify keeps ${formatSize(reserve)} free`;
  return null;
}

/** An upper bound for a backup's size: the volumes as they are (archives compress, media doesn't), or 1.5× the last dump. */
async function estimateSize(name: string, nodeId: string | null | undefined, method: BackupMethod, dockerNames: string[], lastDump: BackupRecord | null): Promise<number> {
  if (method !== 'volume' && lastDump?.sizeBytes) return Math.ceil(lastDump.sizeBytes * 1.5);
  if (!dockerNames.length) return 0; // a database keeping its data in the container: no volume to measure, dumps are small
  const n = await measureVolumes(nodeId ?? null, dockerNames);
  if (n === null) throw new SafetyBackupError(`no safety backup: the size of ${name}'s volumes could not be measured, so Servify can't tell whether a backup fits`);
  return n;
}

/**
 * Make sure a recent backup of the service's data exists before `what` (e.g. "deploying nginx:1.27"): reuse one, or —
 * when the policy allows — take one now. Throws SafetyBackupError when there is none and none can be taken (nothing
 * changed then). Runs under the service's backup lock, so it waits for a backup or restore already running and then
 * looks again: two deploys in a row, or a deploy during the nightly backup, share one backup.
 */
export async function ensureSafetyBackup(svc: Service, opts: { purpose: SafetyPurpose; actor: Actor; what: string; log?: (l: string) => void }): Promise<SafetyOutcome> {
  const say = opts.log ?? (() => {});
  if (!backupMethod(svc)) return { status: 'nothing', message: `${svc.name} has no data to back up` };
  const policy = safetyPolicy(svc, opts.purpose);
  if (policy.mode === 'off') return { status: 'off', message: `safety backups are off for ${svc.name} (${policy.why})` };
  return lock.run(svc.id, async () => {
    const fresh = servicesTable.get(svc.id) ?? svc;
    const method = backupMethod(fresh);
    if (!method) return { status: 'nothing' as const, message: `${fresh.name} has no data to back up` };
    const d = destinationById(fresh.backup?.destinationId ?? 'local');
    if (!d) throw new SafetyBackupError(`no safety backup: ${fresh.name}'s backup destination no longer exists — choose another one in its Backups tab`);
    const recent = recentBackup(fresh, policy.maxAgeHours);
    if (recent) {
      say(`▸ Safety backup: reusing ${describe(recent)}`);
      return { status: 'reused' as const, backup: recent, message: `reused ${describe(recent)}` };
    }
    const none = policy.maxAgeHours > 0 ? `no successful backup of ${fresh.name} from the last ${hoursText(policy.maxAgeHours)}` : '';
    if (policy.mode === 'require') throw new SafetyBackupError(`no safety backup: there is ${none}, and ${fresh.name} is set to require one rather than take one`);
    // A stopped database can't be dumped, but its files are consistent: archive the volumes instead.
    const vols = volumesOf(fresh);
    const use: BackupMethod = method !== 'volume' && !runningReplica(fresh) && vols.length ? 'volume' : method;
    const lastDump = backupsTable.all(`WHERE service_id = ? AND json_extract(data, '$.status') = 'succeeded' ORDER BY created_at DESC LIMIT 20`, fresh.id).find((b) => b.method === use) ?? null;
    const names = vols.map((v) => dockerVolumeFor(fresh.id, v)).filter((n): n is string => !!n);
    // Only a folder needs room for it; for S3 the estimate merely picks the part size.
    const estimate = d.type === 'local' ? await estimateSize(fresh.name, fresh.nodeId, use, names, lastDump) : await estimateSize(fresh.name, fresh.nodeId, use, names, lastDump).catch(() => 0);
    const problem = spaceProblem(estimate, d);
    if (problem) throw new SafetyBackupError(`no safety backup: ${problem}`);
    say(`▸ Safety backup: ${none ? `${none} — backing it up` : 'backing it up'} to ${d.name} first${estimate ? ` (up to about ${formatSize(estimate)})` : ''}${use !== method ? ' as a volume archive (it is stopped)' : ''}`);
    const rec = await runBackup(fresh, 'safety', opts.actor, d.id, { method: use, purpose: opts.what, ...(estimate ? { sizeHint: estimate } : {}) });
    if (rec.status !== 'succeeded') throw new SafetyBackupError(`no safety backup: the backup failed (${rec.error ?? 'unknown error'})`);
    say(`✓ Safety backup stored on ${d.name} (${formatSize(rec.sizeBytes ?? 0)})`);
    return { status: 'taken' as const, backup: rec, message: `took a safety backup (${formatSize(rec.sizeBytes ?? 0)} on ${d.name})` };
  });
}

/**
 * The same for a detached volume about to be deleted, with the policy and destination of the service it was last
 * attached to (else the defaults and this machine). Any backup holding the volume counts if it is recent, or was taken
 * after the volume was detached (its data hasn't changed since). A new one is an archive of just this volume, listed
 * under the volume's id (GET /services/<volume id>/backups) and downloadable; restoring it means extracting it by hand.
 */
export async function ensureVolumeSafetyBackup(v: VolumeRecord, opts: { actor: Actor; what: string }): Promise<SafetyOutcome> {
  const last = v.lastServiceId ? servicesTable.get(v.lastServiceId) ?? null : null;
  const policy = safetyPolicy(last, 'delete');
  if (policy.mode === 'off') return { status: 'off', message: `safety backups are off for ${last?.name ?? 'its service'}` };
  return lock.run(v.id, async () => {
    const d = destinationById(last?.backup?.destinationId ?? 'local');
    if (!d) throw new SafetyBackupError(`no safety backup: the backup destination of ${last?.name ?? 'its service'} no longer exists`);
    const since = policy.maxAgeHours > 0 ? Date.now() - policy.maxAgeHours * 3_600_000 : Infinity;
    const recent = backupsTable
      .all(`WHERE json_extract(data, '$.status') = 'succeeded' ORDER BY created_at DESC LIMIT 1000`)
      .find((b) => !!b.volumeIds?.includes(v.id) && b.trigger !== 'pre-restore' && !!b.key && !!destinationById(b.destinationId) && (b.startedAt >= since || (!!v.detachedAt && b.startedAt >= v.detachedAt)));
    if (recent) return { status: 'reused' as const, backup: recent, message: `reused ${describe(recent)}` };
    if (policy.mode === 'require') throw new SafetyBackupError(`no safety backup: no recent backup holds volume ${v.name}, and ${last?.name ?? 'its service'} is set to require one rather than take one`);
    const members = membersOf(v);
    const measure = () => estimateSize(`volume ${v.name}`, v.nodeId, 'volume', members.map((m) => m.dockerName), null);
    const estimate = d.type === 'local' ? await measure() : await measure().catch(() => 0);
    const problem = spaceProblem(estimate, d);
    if (problem) throw new SafetyBackupError(`no safety backup: ${problem}`);
    const rec = await runVolumeBackup(v, members, d, opts.actor, opts.what, estimate);
    if (rec.status !== 'succeeded') throw new SafetyBackupError(`no safety backup: the backup of volume ${v.name} failed (${rec.error ?? 'unknown error'})`);
    return { status: 'taken' as const, backup: rec, message: `took a safety backup (${formatSize(rec.sizeBytes ?? 0)} on ${d.name})` };
  });
}

async function runVolumeBackup(v: VolumeRecord, members: VolumeRecord[], d: Destination, actor: Actor, purpose: string, sizeHint: number): Promise<BackupRecord> {
  const now = Date.now();
  const rec: BackupRecord = {
    id: id('bak'),
    serviceId: v.id,
    projectId: v.projectId,
    serviceName: `volume ${v.name}`,
    status: 'running',
    method: 'volume',
    trigger: 'safety',
    purpose,
    volumeIds: [v.id],
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
  const safeName = v.name.replace(/[^A-Za-z0-9_.-]/g, '_');
  try {
    await ensureHelper(v);
    const mounts = members.flatMap((m) => ['-v', `${m.dockerName}:/backup/${members.length > 1 ? `${safeName}-${m.replicaIndex ?? 0}` : safeName}:ro`]);
    rec.key = objectKey(d, { projectId: v.projectId, folder: 'volumes', name: safeName }, 'volume', now);
    const { size, sha256 } = await writeBackup(d, rec, (out) => archiveVolumes(v, mounts, out), sizeHint || null);
    rec.sizeBytes = size;
    rec.sha256 = sha256;
    rec.status = 'succeeded';
    rec.finishedAt = Date.now();
    save(rec);
    recordActivity(actor, 'backup.succeeded', `Safety backup of volume ${v.name} before ${purpose} stored on ${d.name} (${formatSize(size)})`, v.projectId);
  } catch (e) {
    rec.status = 'failed';
    rec.error = (e as Error).message.slice(0, 800);
    rec.finishedAt = Date.now();
    save(rec);
    recordActivity(actor, 'backup.failed', `Safety backup of volume ${v.name} failed: ${rec.error.slice(0, 140)}`, v.projectId);
  }
  return rec;
}

// ───────────────────────────── test restores ─────────────────────────────

/** Backups being test-restored now (never deleted meanwhile, also not by retention). */
const testing = new Set<string>();
const TEST_LABEL = 'servify.testrestore';

/** Readiness over TCP: the official images first start a socket-only server to initialise, then restart it. */
const SCRATCH_READY: Record<Exclude<BackupMethod, 'volume'>, string> = {
  pg_dumpall: 'pg_isready -q -h 127.0.0.1 -U "${POSTGRES_USER:-postgres}"',
  mysqldump: `"$(command -v mysqladmin || command -v mariadb-admin)" ping -h 127.0.0.1 --protocol=TCP -uroot -p${MYSQL_PW} --silent`,
  mongodump: READY.mongodump,
};
/** A trivial query on what was restored: the server version on the first line, then what it holds, one number per line. */
const SCRATCH_QUERY: Record<Exclude<BackupMethod, 'volume'>, string> = {
  pg_dumpall:
    'U="${POSTGRES_USER:-postgres}"; psql -U "$U" -d postgres -tAc "show server_version" && psql -U "$U" -d postgres -tAc "select datname from pg_database where not datistemplate" | while IFS= read -r db; do ' +
    `psql -U "$U" -d "$db" -tAc "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')" || echo x; done`,
  mysqldump: `${MYSQL_BIN('client')} -uroot -p${MYSQL_PW} -N -e "select version(); select count(*) from information_schema.schemata where schema_name not in ('mysql','sys','information_schema','performance_schema'); select count(*) from information_schema.tables where table_schema not in ('mysql','sys','information_schema','performance_schema')"`,
  mongodump: `${MONGO_AUTH} "$(command -v mongosh || command -v mongo)" --quiet --eval "print(db.version()); print(db.adminCommand({listDatabases: 1}).databases.length)" "$@"`,
};
/** psql errors a full-cluster dump always produces in a fresh server (the role it runs as, the database it is connected to). */
const EXPECTED_PG_ERRORS = /already exists|current user cannot be dropped|cannot drop the currently open database/;

/** The docker CLI's output as text (small outputs: df, wc). */
export async function cliText(on: { nodeId?: string | null }, args: string[], env?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  const out = new Writable({
    write(c: Buffer, _e, cb) {
      if (stdout.length < 100_000) stdout += c.toString();
      cb();
    },
  });
  const r = await cli(on, args, { stdout: out, env });
  return { ...r, stdout: stdout.trim() };
}

const scratchName = (b: BackupRecord) => `servify-testrestore-${b.id.replace(/^bak_/, '').slice(0, 10)}-${shortId(4)}`;
const scratchLabels = (b: BackupRecord) => ['--label', `${TEST_LABEL}=${b.id}`, '--label', `${LABEL.instance}=${INSTANCE_ID}`];

/** The archive checked out, but there is no room to restore a scratch copy: recorded as "checked", not as a failure. */
class NoRoom extends Error {}

/** The volume archive extracted into a scratch volume on the service's server, then the files counted against the archive. */
async function scratchVolumeRestore(on: { nodeId?: string | null }, b: BackupRecord, v: Verified): Promise<string> {
  await ensureHelper(on);
  const vol = scratchName(b);
  const mk = await cli(on, ['volume', 'create', ...scratchLabels(b), vol]);
  if (mk.code !== 0) throw new Error(`could not create a scratch volume: ${mk.stderr.slice(-300)}`);
  try {
    const run = ['run', '--rm', ...NO_LOG, '--network', 'none', ...scratchLabels(b)];
    // Room for it on that server's Docker disk (the archive's listing says how much it unpacks to), with a reserve.
    const df = await cliText(on, [...run, '-v', `${vol}:/restore`, HELPER_IMAGE, 'df', '-Pk', '/restore']);
    const cols = df.stdout.split('\n').pop()?.trim().split(/\s+/) ?? [];
    const totalK = Number(cols[1]);
    const availK = Number(cols[3]);
    const need = v.listing?.bytes ?? 0;
    if (df.code === 0 && Number.isFinite(availK)) {
      const reserve = Math.min(20 * GB, Math.max(2 * GB, totalK * 1024 * 0.05));
      if (availK * 1024 - need < reserve) throw new NoRoom(`not restored into a scratch volume: it unpacks to ${formatSize(need)}, and the Docker disk has ${formatSize(availK * 1024)} free (Servify keeps ${formatSize(reserve)} free)`);
    }
    const src = await hashedSource(b);
    const x = await cli(on, [...run, '-i', '-v', `${vol}:/restore`, HELPER_IMAGE, 'tar', 'xzf', '-', '-C', '/restore'], { stdin: src.stream });
    if (x.code !== 0) throw new Error(`extracting the archive failed: ${x.stderr.slice(-400)}`);
    await src.done();
    const count = await cliText(on, [...run, '-v', `${vol}:/restore:ro`, HELPER_IMAGE, 'sh', '-c', "find /restore -type f -print0 | tr -cd '\\0' | wc -c; du -sk /restore | cut -f1"]);
    const [files, kb] = count.stdout.split('\n').map((n) => Number(n.trim()));
    if (count.code !== 0 || !Number.isFinite(files)) throw new Error(`could not look at the scratch copy: ${count.stderr.slice(-300)}`);
    if (v.listing && files !== v.listing.files) throw new Error(`the scratch copy holds ${files} files, the archive lists ${v.listing.files}`);
    return `restored into a scratch volume: ${files.toLocaleString('en')} files, ${formatSize((kb || 0) * 1024)}`;
  } finally {
    await cli(on, ['volume', 'rm', '-f', vol]).catch(() => {});
  }
}

/** The environment a throwaway server of the service's engine starts with: its superuser name and root password, else random ones. */
function scratchEnv(method: Exclude<BackupMethod, 'volume'>, svc: Service | null): Record<string, string> {
  const dep = svc?.activeDeploymentId ? deploymentsTable.get(svc.activeDeploymentId) : null;
  const env: Record<string, string> = { ...(svc?.env ?? {}), ...(((dep as any)?.resolvedEnv as Record<string, string> | undefined) ?? {}) };
  if (method === 'pg_dumpall') return { POSTGRES_PASSWORD: secret(18), ...(env.POSTGRES_USER ? { POSTGRES_USER: env.POSTGRES_USER } : {}) };
  if (method === 'mysqldump') {
    // The dump replaces the grant tables: the same root password keeps the query after it working either way.
    const root = env.MYSQL_ROOT_PASSWORD || env.MARIADB_ROOT_PASSWORD || secret(18);
    return { MYSQL_ROOT_PASSWORD: root, MARIADB_ROOT_PASSWORD: root };
  }
  return {}; // mongo: no auth in the throwaway server
}

/** The dump loaded into a throwaway container of the same image (engine and version), then a trivial query. */
async function scratchDatabaseRestore(on: { nodeId?: string | null }, svc: Service | null, b: BackupRecord): Promise<string> {
  const method = b.method as Exclude<BackupMethod, 'volume'>;
  // The exact image the dump came from while it is still on that server (Servify keeps the images of the last 5
  // deployments), else the service's current one; else its registry image, pulled.
  const docker = dockerFor(nodeOf(on));
  const candidates = [...new Set([b.image, svc ? deployedImage(svc) : '', svc?.source.type === 'image' ? svc.source.image : ''].filter((x): x is string => !!x))];
  let image = '';
  for (const c of candidates) if (!image && (await docker.inspectImage(c).catch(() => null))) image = c;
  const registryImage = svc?.source.type === 'image' ? svc.source.image : '';
  const pull = !image && !!registryImage;
  if (pull) image = registryImage;
  if (!image) throw new Error(`the database image of this backup (${b.image ?? 'unknown'}) is no longer on the server, so there is nothing to load it into`);
  const env = scratchEnv(method, svc);
  const name = scratchName(b);
  // Secrets reach the container as `-e NAME` from the CLI's environment, never on its command line. Servify's own
  // per-deployment tags exist on no registry: never try to pull those.
  const started = await cli(on, ['run', '-d', '--name', name, ...(pull ? [] : ['--pull=never']), ...NO_LOG, '--network', 'none', ...scratchLabels(b), ...Object.keys(env).flatMap((k) => ['-e', k]), image], { env });
  if (started.code !== 0) throw new Error(`could not start a throwaway ${image} container: ${started.stderr.slice(-300)}`);
  try {
    const deadline = Date.now() + 240_000;
    for (;;) {
      const r = await cli(on, ['exec', name, 'sh', '-c', SCRATCH_READY[method]]);
      if (r.code === 0) break;
      const state = await cliText(on, ['inspect', '-f', '{{.State.Running}}', name]);
      if (state.stdout !== 'true') throw new Error(`the throwaway ${image} container stopped while starting`);
      if (Date.now() > deadline) throw new Error(`the throwaway ${image} container did not get ready in 4 minutes`);
      await sleep(1500);
    }
    const src = await hashedSource(b);
    const gunzip = createGunzip();
    const input = method === 'pg_dumpall' ? gunzip.pipe(forceDrops()) : gunzip;
    src.stream.on('error', (e) => input.destroy(e));
    if (input !== gunzip) gunzip.on('error', (e) => input.destroy(e));
    src.stream.pipe(gunzip);
    const r = await cli(on, ['exec', '-i', name, 'sh', '-c', RESTORE[method]], { stdin: input });
    if (r.code !== 0) throw new Error(`loading the dump failed (exit ${r.code}): ${r.stderr.slice(-400)}`);
    await src.done();
    if (method === 'pg_dumpall') {
      const errors = r.stderr.split('\n').filter((l) => /ERROR:/.test(l) && !EXPECTED_PG_ERRORS.test(l));
      if (errors.length) throw new Error(`loading the dump reported ${errors.length} error(s): ${errors.slice(0, 3).join(' | ').slice(0, 400)}`);
    }
    const q = await cliText(on, ['exec', name, 'sh', '-c', SCRATCH_QUERY[method]]);
    const [version = '', ...nums] = q.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    if (q.code !== 0 || !nums.length || nums.some((n) => !/^\d+$/.test(n))) throw new Error(`the query on the loaded data failed: ${(q.stderr || q.stdout).slice(-300)}`);
    const n = nums.map(Number);
    const server = `${{ pg_dumpall: 'PostgreSQL', mysqldump: 'MySQL/MariaDB', mongodump: 'MongoDB' }[method]} ${version.split(' ')[0]}`;
    if (method === 'pg_dumpall') return `loaded into a throwaway ${server} container: ${n.length} databases, ${n.reduce((a, x) => a + x, 0)} tables`;
    if (method === 'mysqldump') return `loaded into a throwaway ${server} container: ${n[0]} databases, ${n[1] ?? 0} tables`;
    return `loaded into a throwaway ${server} container: ${n[0]} databases`;
  } finally {
    await cli(on, ['rm', '-f', '-v', name]).catch(() => {});
  }
}

/**
 * Prove a backup can be restored, without touching the service: read it end to end (download, checksum, gunzip and
 * the tar listing all the way through), then restore it into a scratch volume or a throwaway database container of
 * the same image, and remove everything that created. The result is kept on the backup; a failure is notified.
 * Runs in the background unless `wait`.
 */
export function testRestore(actor: Actor, backupId: string, opts: { wait?: boolean; scheduled?: boolean; catchUp?: CatchUpInfo | null } = {}): Promise<BackupRecord> | { started: true } {
  const b = backupsTable.get(backupId);
  if (!b || b.status !== 'succeeded' || !b.key) throw new HttpError(404, 'backup not found');
  if (!destinationById(b.destinationId)) throw new HttpError(404, 'backup destination no longer exists');
  if (testing.has(b.id)) throw new HttpError(409, 'a test restore of this backup is already running');
  // Low disk space on the Docker disk where the scratch copy would go (a scheduled one is skipped: this throws in tick).
  const svc = servicesTable.get(b.serviceId);
  assertDisk('test-restore', svc?.nodeId ?? volumesTable.get(b.serviceId)?.nodeId ?? null);
  testing.add(b.id);
  b.test = { status: 'running', startedAt: Date.now(), finishedAt: null, message: 'checking the archive', actor: actor.name };
  save(b);
  const job = runTestRestore(actor, b, opts).finally(() => testing.delete(b.id));
  if (opts.wait) return job;
  job.catch(() => {});
  return { started: true };
}

async function runTestRestore(actor: Actor, b: BackupRecord, opts: { scheduled?: boolean; catchUp?: CatchUpInfo | null } = {}): Promise<BackupRecord> {
  const t0 = Date.now();
  const svc = servicesTable.get(b.serviceId);
  // Scratch data goes where the service runs (its image is there); a deleted volume's backup: where the volume was, else here.
  const on = { nodeId: svc?.nodeId ?? volumesTable.get(b.serviceId)?.nodeId ?? null };
  const steps: string[] = [];
  let error: string | null = null;
  let noRoom = false;
  try {
    if (svc || on.nodeId) {
      const node = nodeOf(svc ?? on);
      if (!isOnline(node)) throw new Error(`the server ${node} is offline`);
    }
    const v = await verifyBackup(b);
    steps.push(v.checksum ? 'checksum ok' : 'no checksum recorded (an older backup): gzip and archive checked only');
    steps.push(v.listing ? `${v.listing.files.toLocaleString('en')} files, ${formatSize(v.listing.bytes)} unpacked` : `${formatSize(v.unpacked)} dump`);
    steps.push(b.method === 'volume' ? await scratchVolumeRestore(on, b, v) : await scratchDatabaseRestore(on, svc, b));
  } catch (e) {
    if (e instanceof NoRoom) {
      noRoom = true;
      steps.push(e.message);
    } else error = (e as Error).message.slice(0, 600);
  }
  const fresh = backupsTable.get(b.id);
  const result: BackupTest = { status: error ? 'failed' : noRoom ? 'checked' : 'passed', startedAt: t0, finishedAt: Date.now(), message: error ?? steps.join('; '), actor: actor.name };
  if (!fresh) return { ...b, test: result }; // deleted meanwhile (it can't be, but never resurrect a record)
  fresh.test = result;
  save(fresh);
  const when = new Date(b.createdAt).toLocaleString();
  const late = opts.catchUp ? ' (run late, for the scheduled test restore missed while Servify was down)' : '';
  // Scheduled test restores that keep failing notify once (then a reminder now and then), and once when one passes.
  const notice = {
    subject: `Scheduled test restores of ${b.serviceName}`,
    failure: { event: 'backup.failed' as const, level: 'error' as const, title: `Test restore of ${b.serviceName} failed`, message: `The backup of ${when} on ${b.destinationName} could not be restored: ${error}`, projectId: b.projectId, serviceId: svc?.id },
  };
  if (error) {
    recordActivity(actor, 'backup.test_failed', `Test restore of ${b.serviceName}'s backup of ${when} failed${late}: ${error.slice(0, 160)}`, b.projectId, svc?.id);
    if (opts.scheduled) reportOutcome('test', b.serviceId, false, notice);
    else notify(notice.failure);
  } else {
    recordActivity(actor, 'backup.tested', `Test restore of ${b.serviceName}'s backup of ${when} ${noRoom ? 'checked the archive only' : 'passed'}${late} (${duration(result.finishedAt! - t0)}): ${result.message.slice(0, 200)}`, b.projectId, svc?.id);
    reportOutcome('test', b.serviceId, true, notice);
  }
  return fresh;
}

/** Scratch volumes and containers of test restores that a restart interrupted. */
async function sweepScratch() {
  const d = dockerFor(LOCAL);
  for (const c of await d.listContainers([TEST_LABEL, `${LABEL.instance}=${INSTANCE_ID}`]).catch(() => [])) await d.removeContainer(c.Id, true, true).catch(() => {});
  for (const v of await d.listVolumes().catch(() => [])) if (v.Labels?.[TEST_LABEL] && v.Labels?.[LABEL.instance] === INSTANCE_ID) await d.removeVolume(v.Name).catch(() => {});
}

const duration = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

// ───────────────────────────── schedule ─────────────────────────────

let lastMinute = -1;
/** As for cron jobs (schedstate.ts): the minute this scheduler last looked, from the previous process until the first tick. */
let prevMinute: number | null = null;
const skipped = (svc: Service, what: string, reason: string) => recordActivity(SCHEDULER, 'backup.skipped', `${what} of ${svc.name} skipped: ${reason}`, svc.projectId, svc.id);
const STILL_RUNNING = 'the previous backup is still running';
const offline = (svc: Service) => (isOnline(nodeOf(svc)) ? null : `its server ${nodeName(nodeOf(svc))} is offline`);

/** The newest scheduled or manual backup at the configured destination (what a restore would most likely use). */
function newestBackup(svc: Service) {
  return backupsTable
    .all(`WHERE service_id = ? AND json_extract(data, '$.status') = 'succeeded' ORDER BY created_at DESC LIMIT 50`, svc.id)
    .find((b) => b.destinationId === svc.backup?.destinationId && b.trigger !== 'safety' && b.trigger !== 'pre-restore' && !!b.key);
}

function tick() {
  const now = new Date();
  const minute = Math.floor(now.getTime() / 60_000);
  const newMinute = minute !== lastMinute;
  if (!newMinute && !anyPending('backup') && !anyPending('test')) return;
  lastMinute = minute;
  for (const svc of servicesTable.all()) {
    const cfg = svc.backup;
    if (!cfg?.enabled || svc.stopped || !svc.activeDeploymentId) {
      dropPending('backup', svc.id);
      dropPending('test', svc.id);
      continue;
    }
    // Catch-up is on unless turned off: a backup is safe to take late, and a missed nightly one is a day of data at risk.
    const catchUp = cfg.catchUp !== false;
    try {
      stepSchedule({ kind: 'backup', id: svc.id, expr: cfg.schedule, tz: null, catchUp }, now, prevMinute, newMinute, {
        busy: () => (isBackingUp(svc.id) ? STILL_RUNNING : null),
        blocked: () => offline(svc),
        // A dump needs the database up: right after a restart it may still be starting.
        notReady: () => (backupMethod(svc) !== 'volume' && !runningReplica(svc) ? 'the database is not running yet' : null),
        // Refused before it started (no data to back up, destination gone…): said in the activity log. Low disk says so itself.
        start: (late) => void backupService(svc, 'schedule', SCHEDULER, undefined, { catchUp: late }).catch((e) => e instanceof DiskFullError || skipped(svc, 'Scheduled backup', (e as Error).message)),
        // No backup taken (its server offline, missed and not caught up…) counts as a failure of the schedule: notified
        // once per streak, like a backup that failed. One skipped because the last is still running doesn't.
        skip: (reason) => {
          skipped(svc, 'Scheduled backup', reason);
          if (reason !== STILL_RUNNING) reportOutcome('backup', svc.id, false, backupNotice(svc, projectsTable.get(svc.projectId)?.name, `no backup was taken: ${reason}`));
        },
      });
    } catch {}
    if (!cfg.testSchedule) {
      dropPending('test', svc.id);
      continue;
    }
    try {
      stepSchedule({ kind: 'test', id: svc.id, expr: cfg.testSchedule, tz: null, catchUp }, now, prevMinute, newMinute, {
        busy: () => {
          const newest = newestBackup(svc);
          return newest && testing.has(newest.id) ? 'the previous test restore is still running' : null;
        },
        blocked: () => offline(svc) ?? diskBlock('test-restore', svc.nodeId ?? null),
        // A late test restore waits for a backup that is running (a late one, typically): it tests that one then.
        notReady: () => (isBackingUp(svc.id) ? 'a backup is running' : null),
        start: (late) => {
          const newest = newestBackup(svc);
          if (newest) void Promise.resolve(testRestore(SCHEDULER, newest.id, { wait: true, scheduled: true, catchUp: late })).catch((e) => skipped(svc, 'Scheduled test restore', (e as Error).message));
        },
        skip: (reason) => skipped(svc, 'Scheduled test restore', reason),
      });
    } catch {}
  }
  if (newMinute) {
    prevMinute = minuteOf(now.getTime());
    writeBeat('backups', prevMinute);
  }
}

export function startBackups() {
  // Runs a restart interrupted can't be resumed: what they left at the destination is removed (cleanPending, below).
  for (const b of backupsTable.all(`WHERE json_extract(data, '$.status') = 'running'`)) {
    b.status = 'failed';
    b.error = 'interrupted: Servify restarted during this backup';
    b.finishedAt = Date.now();
    if (b.key) b.cleanupPending = true;
    backupsTable.put(b);
  }
  for (const b of backupsTable.all(`WHERE json_extract(data, '$.test.status') = 'running'`)) {
    b.test = { ...b.test!, status: 'failed', finishedAt: Date.now(), message: 'interrupted: Servify restarted during this test restore' };
    backupsTable.put(b);
  }
  // Older versions staged every backup and restore here.
  rmSync(join(config.dataDir, 'tmp'), { recursive: true, force: true });
  void sweepScratch();
  void cleanPending();
  setInterval(() => void cleanPending(), 60_000).unref();
  prevMinute = readBeat('backups');
  setInterval(tick, 5000);
}

export function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
