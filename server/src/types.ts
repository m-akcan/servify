/** Shared domain types. Imported (type-only) by the web app too. */

export type SourceImage = { type: 'image'; image: string };
/** `user`: the name sent with the token (default x-access-token); '' = the token is sent as the user name. */
export type SourceGit = { type: 'git'; repo: string; branch?: string; rootDir?: string; dockerfile?: string; token?: string; user?: string };
export type SourceLocal = { type: 'local'; path: string; dockerfile?: string };
/** An address on another machine: nothing is deployed, the router just sends traffic there. */
export type SourceExternal = {
  type: 'external';
  url: string;
  host: string;
  port: number;
  /** TCP routes: forward UDP on the same proxy port too (game servers, voice). */
  udp?: boolean;
};
/** A domain that only redirects (e.g. a bare domain to its www, an old name to the new one). */
export type SourceRedirect = { type: 'redirect'; to: string; code: 301 | 302 | 307 | 308; keepPath: boolean };
/** A folder uploaded with `servify up`, kept under the data directory. */
export type SourceUpload = { type: 'upload'; uploadId: string | null; uploadedAt: number | null; files: number; bytes: number; label?: string | null; commitSha?: string | null; commitMessage?: string | null; dockerfile?: string; rootDir?: string };
export type Source = SourceImage | SourceGit | SourceLocal | SourceUpload | SourceExternal | SourceRedirect;

export type Protocol = 'http' | 'tcp' | 'none';
export type LbStrategy = 'round-robin' | 'least-conn' | 'ip-hash' | 'random';

export type ServiceStatus =
  | 'idle' // never deployed
  | 'building'
  | 'deploying'
  | 'running'
  | 'degraded' // some replicas unhealthy
  | 'crashed'
  | 'stopped'
  | 'sleeping' // idle: containers stopped until the next request wakes it
  | 'failed';

/** A mount of a volume into a service. */
export interface Volume {
  name: string;
  mountPath: string;
  /** The VolumeRecord this mount refers to (volumes are first-class and can move between services). */
  volumeId?: string;
  /** One volume per replica (a "volume set") instead of one shared volume — for databases that replicate themselves. */
  perReplica?: boolean;
  /** A folder on the server instead of a volume. Owner-only, and only under SERVIFY_HOST_MOUNTS. Never wiped or deleted. */
  hostPath?: string;
  /** SELinux relabel for a host folder ('z' shared, 'Z' private). Opt-in: relabelling a shared folder can break other users of it. */
  selinux?: 'z' | 'Z' | null;
  /** Mount read-only. */
  readOnly?: boolean;
  /** Another service's volume, mounted read-only (e.g. a backup sidecar). Never wiped, backed up or deleted from here. */
  borrowed?: boolean;
  /** A share (`borrowed`) mounted read and write: both services write the same files. Without it a share is read-only. */
  writable?: boolean;
}

/** A persistent volume. Lives in a project; attached to at most one service at a time. */
export interface VolumeRecord {
  id: string;
  projectId: string;
  name: string;
  /** Docker volume name — fixed for the volume's lifetime, independent of which service uses it. */
  dockerName: string;
  /** Attached service, or null when detached (data kept). */
  serviceId: string | null;
  /** Per-replica sets: all members share a setId (= member 0's id); replicaIndex says whose data it is. */
  setId?: string | null;
  replicaIndex?: number | null;
  /** The server whose Docker holds the data (null/undefined = this machine). Volumes never cross servers. */
  nodeId?: string | null;
  /** An existing Docker volume Servify took over (its data predates Servify). */
  adopted?: boolean;
  /** Where it is (or was last) mounted. */
  mountPath: string;
  /** The service it was last attached to, and when it was detached (its data hasn't changed since): safety backups. */
  lastServiceId?: string | null;
  detachedAt?: number | null;
  /** Canvas position while detached. */
  x: number;
  y: number;
  sizeBytes: number | null;
  /** The data a service left behind on its old server when it moved with its volumes (kept until someone deletes it). */
  moveCopy?: MoveCopy | null;
  createdAt: number;
  updatedAt: number;
}

/** A source copy left by "Move to <server>": the moved volume's data as it was before the move. */
export interface MoveCopy {
  serviceId: string;
  serviceName: string;
  /** The live volume it is a copy of, and where that one went (null = this machine). */
  volumeId: string;
  toNodeId: string | null;
  movedAt: number;
  /** Someone chose to keep it (the offer to delete it is no longer shown). */
  keptAt?: number | null;
  /** When the service started healthy on the new server after this move (the copy may be deleted from then on). */
  provenAt?: number | null;
}

/** A service moving to another server with its volumes' data (relocate.ts). The last outcome stays until dismissed. */
export interface ServiceMove {
  phase: 'stopping' | 'copying' | 'starting' | 'rolling-back' | 'done' | 'failed';
  /** Server ids (null = this machine) and their names at the time. */
  from: string | null;
  to: string | null;
  fromName: string;
  toName: string;
  /** It was running: it is started on the new server (and, on failure, on the old one again). */
  wasRunning: boolean;
  startedAt: number;
  finishedAt: number | null;
  /** Bytes of volume data to copy (null = unknown) and copied so far. */
  bytesTotal: number | null;
  bytesDone: number;
  /** The volume being copied now. */
  current: string | null;
  /** Every volume record that moves (members of per-replica sets too), with its Docker volume on each side. */
  volumes: { id: string; name: string; fromDocker: string; toDocker: string; copyId: string | null; existed: boolean }[];
  deploymentId: string | null;
  message: string | null;
  error: string | null;
  actor: string;
}

export interface ClusterConfig {
  kind: 'postgres';
  /** Replica index of the primary of record. */
  primary: number;
  /** Promote a standby when the primary has been unreachable this long. 0 = manual only. */
  failoverAfterSec: number;
  /** Wait for at least one standby to confirm each commit (no data loss on failover). */
  synchronous: boolean;
}

export interface Healthcheck {
  /** HTTP path to probe; null = TCP connect only. */
  path: string | null;
  intervalSec: number;
  timeoutSec: number;
  /** How long a fresh replica may take to become healthy during a deploy. */
  graceSec: number;
  /** Restart a replica that keeps failing its health check while it runs (hung). Absent = the instance default (on). */
  autoRestart?: boolean;
  /** How long it must keep failing before it is restarted. Absent = the instance default (SERVIFY_RESTART_AFTER_SECONDS). */
  restartAfterSec?: number;
}

export interface Autoscale {
  enabled: boolean;
  min: number;
  max: number;
  metric: 'cpu' | 'rps';
  /** CPU % per replica, or requests/second per replica. */
  target: number;
}

/**
 * Who may reach a service through the router (see access.ts). Unset = anyone, as before. IP rules also apply to its TCP
 * proxy port and UDP relay (at connect time); basic auth and rate limits only to HTTP.
 */
export interface AccessControl {
  /** Only these addresses or CIDRs (IPv4/IPv6) may connect; `private` = RFC 1918, loopback, ULA, link-local, CGNAT. Empty = anyone. */
  allow?: string[];
  /** These addresses or CIDRs are refused (checked first). */
  deny?: string[];
  /** HTTP basic auth. The password is stored hashed (scrypt) apart from the service record; `setAt` changes with it. */
  basicAuth?: { username: string; setAt: number; exemptPaths?: string[] } | null;
  /** Requests per client address per window (token bucket: bursts up to `requests`, refilled evenly over `perSeconds`). */
  rateLimit?: { requests: number; perSeconds: number } | null;
}

export interface Service {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  icon: string;
  templateId: string | null;
  source: Source;
  protocol: Protocol;
  port: number | null;
  /** Cron expression: the service runs as a scheduled one-off job instead of long-lived replicas. */
  schedule?: string | null;
  /** IANA time zone the schedule is read in (e.g. Europe/Berlin). Empty = the server's local time. */
  scheduleTz?: string | null;
  /** Run once, late, for a start missed while Servify was down or the job's server offline (within the catch-up window).
   * Unset = off: a job may not be safe to run late or twice (mails, billing…). */
  scheduleCatchUp?: boolean | null;
  /** Port detected from the image on the last successful deploy (used when `port` is auto). */
  detectedPort?: number | null;
  replicas: number;
  strategy: LbStrategy;
  healthcheck: Healthcheck;
  autoscale: Autoscale;
  publicHttp: boolean;
  domains: string[];
  publicTcpPort: number | null;
  volumes: Volume[];
  env: Record<string, string>;
  secretKeys: string[];
  startCommand: string | null;
  /** Runs once per new deploy in a one-off container from the new image (e.g. migrations); a failure stops the deploy. */
  preDeployCommand?: string | null;
  /** Docker build arguments (`--build-arg`); values may use ${VAR} from the service's variables. */
  buildArgs?: Record<string, string> | null;
  /** Multi-stage build target (`--target`). */
  buildTarget?: string | null;
  /** Git deploys only when a push changes files matching these globs; a leading ! excludes (see watchpaths.ts). */
  watchPaths?: string[] | null;
  /** Stop after this many minutes without a request through the router; the next request starts it again. */
  sleepAfterMinutes?: number | null;
  /** Asleep right now (set by the sleeper, cleared by a request, a deploy, a start or a stop). */
  sleeping?: boolean;
  /** Image services: redeploy automatically when a new image is published under the same tag. */
  imageAutoUpdate?: boolean;
  /** Record the router's HTTP access log for this service (on unless set to false; no IPs, only a daily-salted visitor key). */
  accessLog?: boolean;
  /** Router access control: IP allow/deny lists, basic auth, rate limit (unset = open to anyone). */
  access?: AccessControl | null;
  /** Docker-style overrides (e.g. from Compose): replace only CMD / only ENTRYPOINT. Ignored when startCommand is set. */
  cmd?: string[] | null;
  entrypoint?: string[] | null;
  buildCommand: string | null;
  resources: { cpus: number | null; memoryMb: number | null };
  autoDeploy: boolean;
  /** Scheduled backups of this service's data. */
  backup?: BackupConfig | null;
  /** Safety backups before risky operations (a new image on a service with data, deleting its volumes). Unset = the default (see backups.ts safetyPolicy). */
  safetyBackup?: SafetyBackupConfig | null;
  /** Extra hostnames on the project network (e.g. the original Docker Compose service name). */
  aliases?: string[];
  /** Replicated database cluster managed by Servify (primary + standbys, failover). */
  cluster?: ClusterConfig | null;
  /** The server it runs on (null/undefined = this machine). */
  nodeId?: string | null;
  /** Ports published straight on the server (owner only). Forces one replica and stop-first deploys. */
  ports?: PublishedPort[];
  /** A move to another server with its data, running or just finished (relocate.ts). */
  move?: ServiceMove | null;
  x: number;
  y: number;
  status: ServiceStatus;
  activeDeploymentId: string | null;
  stopped: boolean;
  createdAt: number;
  updatedAt: number;
}

export type DeploymentStatus =
  | 'queued'
  | 'building'
  | 'deploying'
  | 'active'
  | 'failed'
  | 'superseded'
  | 'cancelled'
  | 'removed';

export type DeployTrigger = 'create' | 'manual' | 'agent' | 'git' | 'rollback' | 'config' | 'restart' | 'update';

export interface DeploymentConfig {
  env: Record<string, string>;
  port: number | null;
  protocol: Protocol;
  startCommand: string | null;
  preDeployCommand?: string | null;
  cmd?: string[] | null;
  entrypoint?: string[] | null;
  volumes: Volume[];
  /** Ports published straight on the server (today's, like volumes, also for rollbacks). */
  ports?: PublishedPort[];
  resources: { cpus: number | null; memoryMb: number | null };
  source: Source;
}

/** A container port published directly on the server's network (game servers, UDP, anything not HTTP-routed). */
export interface PublishedPort {
  container: number;
  host: number;
  protocol: 'tcp' | 'udp';
  /** Interface to listen on (default every interface). */
  hostIp?: string | null;
}

/** A database engine Servify knows how to dump (detected from the image, whatever it is called). */
export type DatabaseKind = 'postgres' | 'mysql' | 'mongo';

export interface Deployment {
  id: string;
  serviceId: string;
  projectId: string;
  status: DeploymentStatus;
  image: string | null;
  /** The database engine in the image (null = none; missing = not detected yet, from before detection existed). */
  database?: DatabaseKind | null;
  /** Registry digests of a pulled image (repo@sha256:…), recorded at deploy time — Docker's own list follows the tags. */
  repoDigests?: string[] | null;
  /** Built deployments: the registry image their Dockerfile starts from and the digest(s) the build used (update checks). */
  baseImage?: { ref: string; tagArg: string | null; digests: string[] } | null;
  /** The server it was rolled out on (null = this machine). */
  nodeId?: string | null;
  /** Asked for: if the registry pull fails, deploy the copy of the image already on the server instead of failing. */
  useCachedImage?: boolean;
  /** Set when the pull failed: whether a copy of the image is on the server (so "deploy the cached image" can work). */
  cachedImageAvailable?: boolean;
  /** Asked for (never honoured for unattended deploys): deploy a new image of a service with data without a safety backup. */
  skipSafetyBackup?: boolean;
  /** Set when the deploy was refused because no safety backup could be found or taken (the running version stayed). */
  safetyRefused?: boolean;
  /** The backup this deploy relied on (reused or taken just before). */
  safetyBackupId?: string | null;
  /** Detected/used port for this image. */
  port: number | null;
  sourceLabel: string;
  commitSha: string | null;
  commitMessage: string | null;
  builder: string | null;
  trigger: DeployTrigger;
  actor: string;
  config: DeploymentConfig;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  color: string;
  /** Optional icon shown with the color: 'i:<line icon>', 'b:<brand logo>' or 'e:<emoji>'. */
  icon?: string | null;
  /** Shared variables services reference as ${{shared.NAME}}; an environment's own override its base project's. */
  variables?: Record<string, string> | null;
  /** Which shared variables are secrets (masked for read-only access). */
  secretKeys?: string[] | null;
  /** Set on environments: the base ("production") project this one belongs to. */
  parentId?: string | null;
  /** Environment name; the base project is "production". */
  envName?: string | null;
  /** Set on pull-request preview environments. */
  preview?: PreviewInfo | null;
  /** Base projects: open a preview environment for each same-repo pull request. */
  previews?: { enabled: boolean } | null;
  createdAt: number;
  updatedAt: number;
}

export interface PreviewInfo {
  provider: 'github' | 'gitlab' | 'gitea';
  /** Normalized clone URL of the base repository. */
  repo: string;
  number: number;
  branch: string;
  title?: string;
  url?: string;
}

export interface BackupConfig {
  enabled: boolean;
  /** Cron expression. */
  schedule: string;
  /** How many successful backups to keep per destination. */
  retention: number;
  destinationId: string;
  /** Cron expression for test restores of the newest backup (e.g. weekly). Unset or null: none scheduled. */
  testSchedule?: string | null;
  /** Run a scheduled backup (and test restore) missed while Servify was down once, late, within the catch-up window. Unset = on. */
  catchUp?: boolean | null;
}

/**
 * Safety backups: before a new image starts on a service's data, or before its volumes are deleted, Servify makes sure
 * a recent successful backup exists — and, in `auto`, takes one when there is none (refusing the operation if that fails).
 */
export interface SafetyBackupConfig {
  /** off: never. auto: reuse a recent backup, else take one. require: reuse a recent backup, else refuse (never takes one). */
  mode: 'off' | 'auto' | 'require';
  /** How old a successful backup may be and still count as recent. 0 = always take a fresh one (auto only). */
  maxAgeHours: number;
}

export type BackupMethod = 'pg_dumpall' | 'mysqldump' | 'mongodump' | 'volume';

export interface BackupRecord {
  id: string;
  /** The service backed up — or, for the safety backup of a detached volume before it is deleted, that volume's id. */
  serviceId: string;
  projectId: string;
  serviceName: string;
  status: 'running' | 'succeeded' | 'failed';
  method: BackupMethod;
  trigger: 'schedule' | 'manual' | 'agent' | 'pre-restore' | 'safety';
  /** Safety backups: what it was taken for ("deploying nextcloud:31", "deleting volume data"). */
  purpose?: string;
  /** The volumes (VolumeRecord ids; a set by its leader) whose data it holds. Missing on backups made before safety backups existed. */
  volumeIds?: string[];
  actor: string;
  destinationId: string;
  destinationName: string;
  /** Object key / file name at the destination (while running: where it is being written, under a temporary name for folders). */
  key: string | null;
  /** Bytes stored at the destination (the compressed archive or dump). */
  sizeBytes: number | null;
  /** SHA-256 (hex) of the stored bytes, computed while they streamed to the destination; restores and test restores
   * check it. Missing on backups made before checksums existed: those restore unverified. */
  sha256?: string;
  /** Database dumps: the image the data came from (test restores load the dump into a throwaway server of that image). */
  image?: string;
  /** S3: the multipart upload in progress, or one a failed backup left behind that could not be aborted yet. */
  uploadId?: string | null;
  /** A failed backup whose leftovers at the destination (a partial file, an unfinished upload) are still to be removed: retried in the background. */
  cleanupPending?: boolean;
  /** A scheduled backup run late, for a start missed while Servify was down (or the server offline). */
  catchUp?: { dueAt: number; missed: number } | null;
  /** The last test restore: the archive checked end to end and restored into a scratch volume or a throwaway database. */
  test?: BackupTest | null;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  restoredAt?: number | null;
  /** The last restore from this backup: where it is (step), and how it ended. */
  restore?: BackupRestore | null;
  createdAt: number;
}

export interface BackupRestore {
  status: 'running' | 'succeeded' | 'failed';
  /** What it is doing now (while running), e.g. "taking a safety backup of the current data". */
  step: string;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  actor: string;
  /** The safety backup of the data as it was before (to go back to). */
  safetyBackupId?: string | null;
}

export interface BackupTest {
  /** checked: the archive is sound end to end, but there was no room to restore a scratch copy of it. */
  status: 'running' | 'passed' | 'checked' | 'failed';
  startedAt: number;
  finishedAt: number | null;
  /** What was checked and found ("checksum ok; 1,204 files, 3.1 GB unpacked; …"), or why it failed. */
  message: string;
  actor: string;
}

export interface CertRecord {
  /** = host */
  id: string;
  host: string;
  status: 'pending' | 'issued' | 'failed';
  /** imported: taken over from elsewhere — kept until an ACME renewal replaces it. */
  issuer: 'acme' | 'internal' | 'imported';
  expiresAt: number | null;
  issuedAt: number | null;
  lastAttemptAt: number | null;
  nextAttemptAt: number | null;
  attempts: number;
  error: string | null;
  /** PEM chain (public). The private key is stored sealed in `keySealed`. */
  certPem?: string | null;
  keySealed?: string | null;
  createdAt: number;
}

export type PublicCert = Omit<CertRecord, 'certPem' | 'keySealed'>;

export type ReplicaState = 'starting' | 'healthy' | 'unhealthy' | 'draining' | 'exited';

export interface Replica {
  containerId: string;
  /** The server running it ('local' = this machine). */
  nodeId: string;
  name: string;
  serviceId: string;
  deploymentId: string;
  index: number;
  state: ReplicaState;
  dockerState: string;
  host: string | null;
  port: number | null;
  startedAt: number | null;
  restarts: number;
  cpu: number | null;
  memMb: number | null;
  rps: number;
  activeConns: number;
}

export interface ActivityEntry {
  id: string;
  ts: number;
  actorType: 'user' | 'agent' | 'system';
  actor: string;
  projectId: string | null;
  serviceId: string | null;
  action: string;
  summary: string;
}

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  scope: 'read' | 'deploy' | 'write';
  /** Limited to these project ids (and their environments); missing = all projects. */
  projects?: string[];
  kind?: 'agent' | 'device';
  createdAt: number;
  lastUsedAt: number | null;
}

export interface ServiceMetricsPoint {
  t: number;
  rps: number;
  p50: number;
  p95: number;
  errors: number;
  cpu: number;
  memMb: number;
  replicas: number;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: 'database' | 'cache' | 'queue' | 'storage' | 'app' | 'tool';
  image: string;
  protocol: Protocol;
  port: number;
  volumes: Volume[];
  env: Record<string, string>;
  secretKeys: string[];
  /** Stateful templates cannot be scaled beyond one replica. */
  singleton: boolean;
  healthPath?: string | null;
  startCommand?: string | null;
  /** Default replica count (clusters). */
  replicas?: number;
  /** Seconds a fresh replica may take to become healthy (a standby clone can take a while). */
  graceSec?: number;
  cluster?: Omit<import('./types.ts').ClusterConfig, 'primary'>;
  /**
   * What an app gets when it connects to a service made from this template: app variable → this template's variable
   * (referenced as ${{ <service>.VAR }}), or a value with {svc} standing in for the service's name.
   */
  connect?: Record<string, string>;
}

export interface JobRun {
  id: string;
  serviceId: string;
  projectId: string;
  /** skipped: a scheduled start that didn't run (still running from before, server offline, missed while Servify was down…). */
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  trigger: 'schedule' | 'manual' | 'agent';
  actor: string;
  /** Skipped runs: when (the first of them, when several in a row were skipped for the same reason). */
  startedAt: number;
  /** Skipped runs: the last of them. */
  finishedAt: number | null;
  exitCode: number | null;
  output: string;
  /** Skipped runs: why. */
  reason?: string;
  /** Skipped runs: how many starts in a row this record stands for (same reason). */
  skipCount?: number;
  /** A run late, for a start missed while Servify was down or the server offline: when it was due, and how many were missed. */
  catchUp?: { dueAt: number; missed: number } | null;
  createdAt: number;
}

/** Server → client realtime events. */
export type ServerEvent =
  | { type: 'project.updated'; project: Project }
  | { type: 'project.deleted'; projectId: string }
  | { type: 'service.updated'; service: Service }
  | { type: 'service.deleted'; serviceId: string; projectId: string }
  | { type: 'deployment.updated'; deployment: Deployment }
  | { type: 'deployment.log'; deploymentId: string; serviceId: string; line: string; ts: number }
  | { type: 'replicas'; serviceId: string; projectId: string; replicas: Replica[] }
  | { type: 'traffic'; tick: number; services: Record<string, { rps: number; errors: number; p95: number; replicas: Record<string, number> }> }
  | { type: 'activity'; entry: ActivityEntry }
  | { type: 'job.run'; run: JobRun }
  | { type: 'backup.updated'; backup: BackupRecord }
  | { type: 'cert.updated'; cert: PublicCert }
  | { type: 'settings.updated' }
  | { type: 'disk.updated'; disk: DiskState }
  | { type: 'volume.updated'; volume: VolumeRecord }
  | { type: 'volume.deleted'; volumeId: string; projectId: string }
  | { type: 'hello'; version: string }
  /** A phone's sign-in request arrived or was decided: the owner's dashboard reloads the list (no payload). */
  | { type: 'auth.pairing' };

/** Another machine whose Docker runs services for this Servify (connected through `servify agent`). */
export interface ServerNode {
  id: string;
  name: string;
  /** sha256 of the agent token; the token itself is shown once. */
  tokenHash: string;
  tokenPrefix: string;
  createdAt: number;
  lastSeenAt: number | null;
  info: ServerInfo | null;
}

export interface ServerInfo {
  hostname: string;
  os: string;
  arch: string;
  cpus: number;
  memBytes: number;
  dockerVersion: string;
  agentVersion: string;
  address: string | null;
}

export interface PublicServer {
  id: string;
  name: string;
  local: boolean;
  status: 'online' | 'offline' | 'pending';
  lastSeenAt: number | null;
  connectedAt: number | null;
  info: ServerInfo | null;
  services: number;
  replicas: number;
  /** Live usage, when the server reports it (this machine always; agents from 0.2.0). */
  stats?: HostStats | null;
  /** Its agent is older than the one this Servify ships (it can be updated in place). */
  agentOutdated?: boolean;
}

/** Live usage of a machine. */
export interface HostStats {
  /** Busy share of all CPUs since the previous sample, 0–100 (null until two samples exist). */
  cpuPct: number | null;
  load: [number, number, number];
  memTotal: number;
  memAvailable: number;
  diskTotal: number | null;
  diskFree: number | null;
  uptimeSec: number;
  at: number;
}

export type DiskLevel = 'ok' | 'warn' | 'protect';

/** A disk Servify writes to, watched by the low-disk guard (diskguard.ts). */
export interface DiskStatus {
  /** 'data' (SERVIFY_DATA_DIR), 'docker' (this machine's Docker data root) or 'docker:<server id>'. */
  id: string;
  name: string;
  /** null: this machine. */
  nodeId: string | null;
  path: string | null;
  /** What lives on it: Servify's data, Docker's (both when they share a disk). */
  roles: ('data' | 'docker')[];
  totalBytes: number | null;
  freeBytes: number | null;
  /** Below this: warn. Below protectBytes: protect. Back to ok at clearBytes; protection is lifted above warnBytes. */
  warnBytes: number | null;
  protectBytes: number | null;
  clearBytes: number | null;
  level: DiskLevel;
  /** When it entered its level. */
  since: number;
  measuredAt: number | null;
  /** Why it has no reading (its level is then ok: nothing is refused on unknown numbers). */
  error: string | null;
}

export interface DiskState {
  /** The worst level of all disks. */
  level: DiskLevel;
  disks: DiskStatus[];
  /** What Servify stopped storing, and what it refuses, right now. */
  paused: string[];
  refused: string[];
  thresholds: { warnPct: number | null; warnGb: number | null; protectPct: number | null; protectGb: number | null; autoClean: boolean };
  /** While in protect mode: what was not stored since it started. */
  skipped: { logLines: number; metricRows: number; accessRows: number; since: number | null } | null;
  /** The automatic clean-up when a disk last entered protect mode. */
  lastCleanup: { at: number; steps: string[]; freedBytes: number } | null;
  howToFree: string | null;
}

/** The projects page's overview: every server's usage and Servify's own. */
export interface Overview {
  servers: (PublicServer & {
    containers: { running: number; total: number } | null;
    /** What Servify's own containers on this server use right now. */
    managed: { cpuPct: number; memMb: number };
    os: string | null;
    dockerVersion: string | null;
  })[];
  /** Low disk space protection. */
  disk: DiskState;
  servify: {
    version: string;
    uptimeSec: number;
    cpuPct: number;
    rssBytes: number;
    projects: number;
    services: number;
    replicas: number;
    rps: number;
    errorsPerSec: number;
    certificates: { total: number; expiringSoon: number };
    backups24h: { succeeded: number; failed: number };
  };
}

/** Something about moving a service to another project ("Move to project…", see moveproject.ts). */
export interface MoveIssue {
  /** Blockers: same_project, environment, environment_target, cluster, borrows_volume, shared_volume, busy, name_taken.
   * Warnings: used_by, uses, shared_missing (these break something: refused unless forced), url_changes, renamed, environments. */
  code: string;
  message: string;
  /** References: the services on the other end and their variables that name it (`how`: ${{…}}, a host name, or both). */
  services?: { id: string; name: string; keys: string[]; how: 'variable' | 'hostname' | 'both' }[];
}

/** What a move would do, before it happens (POST /services/:id/move-project with dryRun). */
export interface MovePlan {
  service: { id: string; name: string; slug: string };
  from: { id: string; name: string; slug: string };
  /** null: a project still to be created for it. */
  target: { id: string; name: string; slug: string } | null;
  /** The name (and private host name) it would have there. */
  name: string;
  slug: string;
  /** When the name is taken there: a free one. */
  suggestedName: string | null;
  blockers: MoveIssue[];
  warnings: MoveIssue[];
  /** Its containers are recreated on the new project's network (a brief restart). */
  restart: boolean;
  /** Its generated address now and after the move (null after: not known until the project exists). */
  url: { before: string; after: string | null } | null;
  volumes: string[];
  deployments: number;
  backups: number;
}
