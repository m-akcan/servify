/**
 * Low disk space protection. A full disk breaks SQLite, Docker and every service, so Servify watches the disks it
 * writes to and backs off before they fill up:
 *
 *  • the data disk (SERVIFY_DATA_DIR: the database, logs store, metrics, access log, build checkouts, uploads and the
 *    built-in backup folder);
 *  • Docker's data root on this machine (`docker info` → DockerRootDir: images, containers, volumes). It may be the
 *    same disk (one entry then), another disk, or inside a VM (Docker Desktop, OrbStack, Colima): measured with a
 *    throwaway helper's `df` then;
 *  • the Docker disk of every connected server, from the usage its agent reports.
 *
 * Each disk has two lines, the smaller of a share of the disk and a size (so a 4 TB disk isn't warned at 400 GB free,
 * nor a 32 GB one at a third free): warn below 10% or 10 GB, protect below 5% or 3 GB. Setting only one of a level's
 * two numbers (env or instance settings) uses that one alone. Protection is lifted once the disk is back above the
 * warn line, so a disk hovering at the line doesn't flap.
 *
 * In protect mode Servify only refuses or pauses what fills the disk — never what frees it (deletes, image clean-up,
 * stopping services, log pruning):
 *  • data disk: container logs, metric samples and access-log rows are no longer stored (the live log tail stays in
 *    memory, so logs still show in the dashboard); builds, uploads and backups to folders on that disk are refused;
 *  • Docker disk: builds, image pulls and copies, and test restores (they need a scratch volume or container) are
 *    refused for that server. Restarts of what is already there go on.
 *
 * This module is a leaf: everything that writes asks it, and it imports none of them.
 */
import { spawn } from 'node:child_process';
import { existsSync, statfsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.ts';
import { docker, dockerHostEnv } from './docker.ts';
import { listServers, LOCAL } from './nodes.ts';
import { getSettings } from './settings.ts';
import { notify } from './notify.ts';
import { bus } from './events.ts';
import { HttpError } from './util.ts';
import type { DiskLevel, DiskState, DiskStatus } from './types.ts';

const GB = 1024 ** 3;
const HELPER_IMAGE = 'alpine:3.20';
const INTERVAL = Number(process.env.SERVIFY_DISK_INTERVAL_MS) || 30_000;
/** The helper container (a VM's Docker disk) runs at most this often, unless thresholds change. */
const DOCKER_EVERY = Number(process.env.SERVIFY_DISK_DOCKER_INTERVAL_MS) || 60_000;

// ───────────────────────────── thresholds ─────────────────────────────

type Level = { pct: number | null; gb: number | null };
export type DiskThresholds = { warn: Level; protect: Level; autoClean: boolean };

function envNum(name: string): number | null {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Instance settings first, then env, then the defaults. A level with only one number set uses that one alone. */
export function diskThresholds(): DiskThresholds {
  const s = getSettings().disk;
  const pick = (v: number | null | undefined, env: string) => v ?? envNum(env);
  const level = (pct: number | null, gb: number | null, dPct: number, dGb: number): Level => (pct == null && gb == null ? { pct: dPct, gb: dGb } : { pct, gb });
  return {
    warn: level(pick(s.warnPct, 'SERVIFY_DISK_WARN_PCT'), pick(s.warnGb, 'SERVIFY_DISK_WARN_GB'), 10, 10),
    protect: level(pick(s.protectPct, 'SERVIFY_DISK_PROTECT_PCT'), pick(s.protectGb, 'SERVIFY_DISK_PROTECT_GB'), 5, 3),
    autoClean: s.autoClean ?? process.env.SERVIFY_DISK_AUTO_CLEAN !== '0',
  };
}

function lineBytes(l: Level, total: number): number {
  const a = l.pct != null ? (total * l.pct) / 100 : Infinity;
  const b = l.gb != null ? l.gb * GB : Infinity;
  const v = Math.min(a, b);
  return Number.isFinite(v) ? v : 0;
}

function lines(total: number) {
  const t = diskThresholds();
  const protect = lineBytes(t.protect, total);
  const warn = Math.max(lineBytes(t.warn, total), protect);
  // Back to ok a little above the warn line (hysteresis): 2% of the disk, at most 2 GB.
  return { warn, protect, clear: warn + Math.min(2 * GB, total * 0.02) };
}

// ───────────────────────────── measuring ─────────────────────────────

type Reading = { total: number; free: number; at: number } | null;

function statfs(path: string): Reading {
  try {
    const s = statfsSync(path);
    return { total: Number(s.blocks) * Number(s.bsize), free: Number(s.bavail) * Number(s.bsize), at: Date.now() };
  } catch {
    return null;
  }
}

function existing(p: string) {
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  return p;
}

const devOf = (p: string): number | null => {
  try {
    return statSync(existing(p)).dev;
  } catch {
    return null;
  }
};

/** Whether a folder (a backup destination, say) is on the data disk. */
export function onDataDisk(path: string): boolean {
  const a = devOf(path);
  return a !== null && a === devOf(config.dataDir);
}

/** This machine's Docker: where it keeps its data, and how it can be measured. */
let dockerRoot: { path: string; mode: 'shared' | 'statfs' | 'helper'; at: number } | null = null;
let dockerReading: Reading = null;
let dockerError: string | null = null;
let dockerBusy = false;
let helperPulled = false;

async function resolveDockerRoot() {
  if (dockerRoot && Date.now() - dockerRoot.at < 10 * 60_000) return dockerRoot;
  const info = await Promise.race([docker.info(), new Promise((r) => setTimeout(() => r(null), 5000))]).catch(() => null) as any;
  const path = typeof info?.DockerRootDir === 'string' && info.DockerRootDir ? info.DockerRootDir : '/var/lib/docker';
  let mode: 'shared' | 'statfs' | 'helper' = 'helper';
  // On a Linux host the root is a folder here (statfs only needs to reach it); elsewhere it is inside a VM.
  if (process.platform === 'linux' && !config.inContainer && existsSync(path)) mode = devOf(path) === devOf(config.dataDir) ? 'shared' : 'statfs';
  dockerRoot = { path, mode, at: Date.now() };
  return dockerRoot;
}

function helperDf(root: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const args = ['run', '--rm', '--pull=never', '--name', `servify-diskcheck-${randomBytes(3).toString('hex')}`, '--log-driver', 'none', '--network', 'none', '-v', `${root}:/docker-root:ro`, HELPER_IMAGE, 'df', '-Pk', '/docker-root'];
    const child = spawn('docker', args, { env: { ...process.env, DOCKER_HOST: dockerHostEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    child.stderr.on('data', (b: Buffer) => (err += b.toString()));
    const t = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, out, err: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, out, err });
    });
  });
}

async function measureDocker(force = false) {
  if (dockerBusy || (!force && dockerReading && Date.now() - dockerReading.at < DOCKER_EVERY)) return;
  dockerBusy = true;
  try {
    const root = await resolveDockerRoot();
    if (root.mode === 'shared') {
      dockerReading = null;
      dockerError = null;
      return;
    }
    if (root.mode === 'statfs') {
      dockerReading = statfs(root.path);
      dockerError = dockerReading ? null : `could not read the free space of ${root.path}`;
      return;
    }
    let r = await helperDf(root.path);
    if (r.code !== 0 && /No such image|not found/i.test(r.err) && !helperPulled && stateOf('docker')?.level !== 'protect') {
      helperPulled = true; // a few MB, once (backups use the same helper)
      await docker.pullImage(HELPER_IMAGE).catch(() => {});
      r = await helperDf(root.path);
    }
    const cols = r.out.trim().split('\n').pop()?.trim().split(/\s+/) ?? [];
    const total = Number(cols[1]) * 1024;
    const free = Number(cols[3]) * 1024;
    if (r.code === 0 && Number.isFinite(total) && Number.isFinite(free) && total > 0) {
      dockerReading = { total, free, at: Date.now() };
      dockerError = null;
    } else {
      dockerError = `could not measure Docker's disk: ${(r.err || r.out).trim().slice(-200) || `exit ${r.code}`}`;
      // A reading older than 5 minutes is no reading: never block on stale numbers.
      if (dockerReading && Date.now() - dockerReading.at > 5 * 60_000) dockerReading = null;
    }
  } finally {
    dockerBusy = false;
  }
}

// ───────────────────────────── state ─────────────────────────────

type Track = { level: DiskLevel; since: number };
const track = new Map<string, Track>();
let disks: DiskStatus[] = [];
let lastCleanup: DiskState['lastCleanup'] = null;
const skipped = { logLines: 0, metricRows: 0, accessRows: 0 };
let skippedSince: number | null = null;
let cleanupHook: (() => Promise<string[]>) | null = null;

const stateOf = (id: string) => disks.find((d) => d.id === id) ?? null;

function nextLevel(prev: DiskLevel, free: number, l: ReturnType<typeof lines>): DiskLevel {
  if (free < l.protect) return 'protect';
  if (prev === 'protect') return free >= l.warn ? (free >= l.clear ? 'ok' : 'warn') : 'protect';
  if (prev === 'warn') return free >= l.clear ? 'ok' : 'warn';
  return free < l.warn ? 'warn' : 'ok';
}

function serverName(nodeId: string) {
  return listServers().find((s) => s.id === nodeId)?.name ?? nodeId;
}

function evaluate(): { id: string; from: DiskLevel; to: DiskLevel }[] {
  const out: DiskStatus[] = [];
  const changes: { id: string; from: DiskLevel; to: DiskLevel }[] = [];
  const add = (base: Omit<DiskStatus, 'level' | 'since' | 'warnBytes' | 'protectBytes' | 'clearBytes' | 'totalBytes' | 'freeBytes' | 'measuredAt'>, r: Reading) => {
    const prev = track.get(base.id) ?? { level: 'ok' as DiskLevel, since: Date.now() };
    if (!r || r.total <= 0) {
      // No reading (a server offline, the helper failing): nothing is refused on unknown numbers, but the last known
      // level is remembered, so a reading coming back in the same state isn't announced again.
      track.set(base.id, prev);
      out.push({ ...base, totalBytes: null, freeBytes: null, measuredAt: null, warnBytes: null, protectBytes: null, clearBytes: null, level: 'ok', since: prev.since });
      return;
    }
    const l = lines(r.total);
    const level = nextLevel(prev.level, r.free, l);
    if (level !== prev.level) changes.push({ id: base.id, from: prev.level, to: level });
    const t = level === prev.level ? prev : { level, since: Date.now() };
    track.set(base.id, t);
    out.push({ ...base, totalBytes: r.total, freeBytes: r.free, measuredAt: r.at, warnBytes: Math.round(l.warn), protectBytes: Math.round(l.protect), clearBytes: Math.round(l.clear), level, since: t.since });
  };
  const shared = dockerRoot?.mode === 'shared';
  add({ id: 'data', name: shared ? 'data disk (also Docker’s)' : 'data disk', nodeId: null, path: config.dataDir, roles: shared ? ['data', 'docker'] : ['data'], error: null }, statfs(config.dataDir));
  if (!shared) add({ id: 'docker', name: 'Docker disk', nodeId: null, path: dockerRoot?.path ?? null, roles: ['docker'], error: dockerError }, dockerReading);
  for (const srv of listServers()) {
    if (srv.local) continue;
    const st = srv.status === 'online' ? srv.stats : null;
    add({ id: `docker:${srv.id}`, name: `Docker disk of ${srv.name}`, nodeId: srv.id, path: null, roles: ['docker'], error: st ? null : 'no recent usage from its agent' }, st && st.diskTotal && st.diskFree != null ? { total: st.diskTotal, free: st.diskFree, at: st.at } : null);
  }
  for (const id of track.keys()) if (!out.some((d) => d.id === id)) track.delete(id); // a removed server
  disks = out;
  return changes;
}

export const fmt = (n: number) => (n >= 100 * GB ? `${Math.round(n / GB)} GB` : n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);
const where = (d: DiskStatus) => (d.nodeId ? d.name : `the ${d.name}${d.path ? ` (${d.path})` : ''}`);
const nameOf = (d: DiskStatus) => (d.nodeId ? d.name : `the ${d.name}`);

const PAUSED_DATA = 'storing container logs, metric samples and access-log rows (live logs still show)';
const REFUSED_DATA = 'builds, uploads and backups to folders on the data disk';
const REFUSED_DOCKER = 'image pulls, builds and test restores';
const HOW = 'Free space by deleting services, volumes or old backups you no longer need, or unused Docker images (docker image prune) — Servify resumes on its own once the disk is back above the warn line.';

function effects(d: DiskStatus): { paused: string[]; refused: string[] } {
  if (d.level !== 'protect') return { paused: [], refused: [] };
  const paused = d.roles.includes('data') ? [PAUSED_DATA] : [];
  const refused = [...(d.roles.includes('data') ? [REFUSED_DATA] : []), ...(d.roles.includes('docker') ? [`${REFUSED_DOCKER}${d.nodeId ? ` on ${serverName(d.nodeId)}` : ' on this machine'}`] : [])];
  return { paused, refused };
}

function announce(changes: { id: string; from: DiskLevel; to: DiskLevel }[]) {
  const rank = { ok: 0, warn: 1, protect: 2 } as const;
  const worse = changes.filter((c) => rank[c.to] > rank[c.from]);
  const better = changes.filter((c) => rank[c.to] < rank[c.from]);
  const local = listServers().find((s) => s.local);
  const host = local?.info?.hostname || 'This machine';
  if (worse.length) {
    const ds = worse.map((c) => stateOf(c.id)!).filter(Boolean);
    const protect = ds.filter((d) => d.level === 'protect');
    const parts = ds.map((d) => `${where(d)} has ${fmt(d.freeBytes ?? 0)} free of ${fmt(d.totalBytes ?? 0)}, below its ${d.level === 'protect' ? `${fmt(d.protectBytes ?? 0)} protection` : `${fmt(d.warnBytes ?? 0)} warning`} line`);
    const fx = protect.map(effects);
    const paused = [...new Set(fx.flatMap((f) => f.paused))];
    const refused = [...new Set(fx.flatMap((f) => f.refused))];
    const doing = protect.length ? ` Servify ${paused.length ? `paused ${paused.join('; ')} and ` : ''}refuses ${refused.join('; ')} until there is room again.` : ` If it keeps filling, Servify starts protecting it below ${fmt(ds[0].protectBytes ?? 0)}.`;
    notify({
      event: 'server.usage',
      level: 'error',
      title: protect.length ? `${host}: low disk space — protecting ${protect.map(nameOf).join(' and ')}` : `${host}: disk space getting low on ${ds.map(nameOf).join(' and ')}`,
      message: `${parts.join('; ')}.${doing} ${HOW}`,
    });
  }
  if (better.length) {
    const ds = better.map((c) => ({ c, d: stateOf(c.id)! })).filter((x) => x.d);
    const lifted = ds.filter((x) => x.c.from === 'protect');
    const parts = ds.map(({ d }) => `${where(d)} has ${fmt(d.freeBytes ?? 0)} free${d.level === 'warn' ? ` (still below the ${fmt(d.warnBytes ?? 0)} warning line)` : ''}`);
    notify({
      event: 'server.usage',
      level: 'success',
      title: lifted.length ? `${host}: low-disk protection lifted on ${lifted.map((x) => nameOf(x.d)).join(' and ')}` : `${host}: disk space back on ${ds.map((x) => nameOf(x.d)).join(' and ')}`,
      message: `${parts.join('; ')}.${lifted.length ? ' Logs, metrics and the access log are stored again, and builds, pulls and backups are allowed.' : ''}`,
    });
  }
}

let checking = false;
let again = false;

/** One look at every disk; `force` re-measures Docker's disk now (thresholds changed). */
export async function checkDisks(force = false): Promise<void> {
  if (checking) {
    if (force) again = true; // new thresholds while a look is running: one more right after it
    return;
  }
  checking = true;
  try {
    await measureDocker(force).catch(() => {});
    const wasProtect = disks.some((d) => d.level === 'protect');
    const changes = evaluate();
    const isProtect = disks.some((d) => d.level === 'protect');
    if (isProtect && !wasProtect) {
      skippedSince = Date.now();
      skipped.logLines = skipped.metricRows = skipped.accessRows = 0;
    }
    if (changes.length) {
      for (const c of changes) {
        const d = stateOf(c.id);
        if (d) console.log(`[disk] ${d.name}${d.nodeId ? '' : d.path ? ` (${d.path})` : ''}: ${c.from} → ${c.to}, ${fmt(d.freeBytes ?? 0)} free (warn below ${fmt(d.warnBytes ?? 0)}, protect below ${fmt(d.protectBytes ?? 0)})`);
      }
      announce(changes);
    }
    // A disk that just entered protect mode: run the safe clean-ups once (unused images, expired rows).
    const entered = changes.filter((c) => c.to === 'protect' && c.from !== 'protect');
    if (entered.length && cleanupHook && diskThresholds().autoClean) void runCleanup();
    if (changes.length || isProtect || disks.some((d) => d.level === 'warn')) bus.publish({ type: 'disk.updated', disk: diskState() });
  } finally {
    checking = false;
  }
  if (again) {
    again = false;
    return checkDisks(true);
  }
}

async function runCleanup() {
  const before = disks.map((d) => ({ id: d.id, free: d.freeBytes ?? 0 }));
  const steps = await cleanupHook!().catch((e) => [`clean-up failed: ${(e as Error).message}`]);
  await checkDisks(true); // measured again (and announced, should it have freed enough)
  const freed = disks.reduce((n, d) => n + Math.max(0, (d.freeBytes ?? 0) - (before.find((b) => b.id === d.id)?.free ?? d.freeBytes ?? 0)), 0);
  lastCleanup = { at: Date.now(), steps, freedBytes: freed };
  console.log(`[disk] automatic clean-up: ${steps.join('; ') || 'nothing to do'} (${fmt(freed)} freed)`);
  bus.publish({ type: 'disk.updated', disk: diskState() });
}

/** The clean-ups to run once when a disk enters protect mode (registered by main: jobs and stores live elsewhere). */
export function onProtectCleanup(fn: () => Promise<string[]>) {
  cleanupHook = fn;
}

export function startDiskGuard() {
  void checkDisks(true);
  setInterval(() => void checkDisks().catch((e) => console.error('[disk]', e)), INTERVAL).unref();
  let pending: NodeJS.Timeout | null = null;
  bus.subscribe((ev) => {
    // New thresholds count at once (and Docker's disk is measured again for them).
    if (ev.type === 'settings.updated' && !pending) {
      pending = setTimeout(() => {
        pending = null;
        void checkDisks(true);
      }, 200);
    }
  });
}

export function diskState(): DiskState {
  const rank = { ok: 0, warn: 1, protect: 2 } as const;
  const level = disks.reduce<DiskLevel>((a, d) => (rank[d.level] > rank[a] ? d.level : a), 'ok');
  const fx = disks.map(effects);
  const t = diskThresholds();
  return {
    level,
    disks,
    paused: [...new Set(fx.flatMap((f) => f.paused))],
    refused: [...new Set(fx.flatMap((f) => f.refused))],
    thresholds: { warnPct: t.warn.pct, warnGb: t.warn.gb, protectPct: t.protect.pct, protectGb: t.protect.gb, autoClean: t.autoClean },
    skipped: level === 'protect' ? { ...skipped, since: skippedSince } : null,
    lastCleanup,
    howToFree: level === 'ok' ? null : HOW,
  };
}

/** The same without host paths, for agents and tokens limited to some projects. */
export function diskSummary() {
  const s = diskState();
  return { level: s.level, disks: s.disks.map((d) => ({ name: d.name, level: d.level, freeBytes: d.freeBytes, totalBytes: d.totalBytes, warnBytes: d.warnBytes, protectBytes: d.protectBytes })), paused: s.paused, refused: s.refused, howToFree: s.howToFree };
}

// ───────────────────────────── gates ─────────────────────────────

const dataDisk = () => disks.find((d) => d.roles.includes('data')) ?? null;
const dockerDisk = (nodeId: string | null | undefined) => (!nodeId || nodeId === LOCAL ? disks.find((d) => !d.nodeId && d.roles.includes('docker')) : disks.find((d) => d.nodeId === nodeId)) ?? null;

/** Persistence of logs, metrics and access-log rows is paused (the data disk is in protect mode). */
export const persistPaused = () => dataDisk()?.level === 'protect';

/** Count what wasn't stored, for the state shown in the dashboard. */
export function noteSkipped(kind: keyof typeof skipped, n: number) {
  skipped[kind] += n;
}

export type DiskWork = 'build' | 'pull' | 'upload' | 'backup' | 'test-restore';
const WORK: Record<DiskWork, string> = {
  build: 'builds are refused',
  pull: 'image pulls are refused',
  upload: 'uploads are refused',
  backup: 'backups to folders on this disk are refused',
  'test-restore': 'test restores are refused (they need a scratch volume or container)',
};

function message(d: DiskStatus, work: DiskWork) {
  return `Low disk space: ${where(d)} has ${fmt(d.freeBytes ?? 0)} free, below its ${fmt(d.protectBytes ?? 0)} protection line — ${WORK[work]} until it is back above ${fmt(d.warnBytes ?? 0)}. ${HOW}`;
}

/** Why `work` on a server (null: this machine) can't run now, or null. Builds need both disks: the checkout and the image. */
export function diskBlock(work: DiskWork, nodeId?: string | null): string | null {
  const data = dataDisk();
  const dock = dockerDisk(nodeId);
  if ((work === 'build' || work === 'upload') && data?.level === 'protect') return message(data, work);
  if ((work === 'build' || work === 'pull' || work === 'test-restore') && dock?.level === 'protect') return message(dock, work);
  return null;
}

/** A backup into a folder: refused while that folder's disk is the protected data disk. */
export function backupDiskBlock(dest: { type: string; path?: string }): string | null {
  const data = dataDisk();
  if (dest.type !== 'local' || !dest.path || data?.level !== 'protect' || !onDataDisk(dest.path)) return null;
  return message(data, 'backup');
}

export class DiskFullError extends HttpError {
  constructor(message: string) {
    super(507, message, 'low_disk');
  }
}

export function assertDisk(work: DiskWork, nodeId?: string | null) {
  const why = diskBlock(work, nodeId);
  if (why) throw new DiskFullError(why);
}

/**
 * Whether restoring `needBytes` onto a server's Docker disk clearly can't fit: more than its free space plus what
 * wiping the current data frees (`freedBytes`; null = unknown, then everything used on the disk counts as freeable,
 * so only a restore bigger than the whole disk's room is refused). Null when it may fit, or nothing is measured.
 */
export function restoreFitProblem(nodeId: string | null | undefined, needBytes: number, freedBytes: number | null, what: string): string | null {
  const d = dockerDisk(nodeId);
  if (!d || d.freeBytes == null || d.totalBytes == null || !needBytes) return null;
  const freed = freedBytes ?? d.totalBytes - d.freeBytes;
  if (needBytes <= d.freeBytes + freed) return null;
  return `${what} needs at least ${fmt(needBytes)}, and ${where(d)} has ${fmt(d.freeBytes)} free${freedBytes ? ` (plus ${fmt(freedBytes)} the current data frees)` : ''} — it can't fit; nothing was changed. Free space on that disk first.`;
}

/** The usage alert for a server's disk stays quiet while this guard speaks for that disk. */
export function diskAlertSuppressed(serverId: string): boolean {
  if (serverId === LOCAL) return disks.some((d) => !d.nodeId && d.level !== 'ok');
  return disks.some((d) => d.nodeId === serverId && d.level !== 'ok');
}
