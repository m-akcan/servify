/** Shared domain types. Imported (type-only) by the web app too. */

export type SourceImage = { type: 'image'; image: string };
export type SourceGit = { type: 'git'; repo: string; branch?: string; rootDir?: string; dockerfile?: string; token?: string };
export type SourceLocal = { type: 'local'; path: string; dockerfile?: string };
export type Source = SourceImage | SourceGit | SourceLocal;

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
  | 'failed';

export interface Volume {
  name: string;
  mountPath: string;
}

export interface Healthcheck {
  /** HTTP path to probe; null = TCP connect only. */
  path: string | null;
  intervalSec: number;
  timeoutSec: number;
  /** How long a fresh replica may take to become healthy during a deploy. */
  graceSec: number;
}

export interface Autoscale {
  enabled: boolean;
  min: number;
  max: number;
  metric: 'cpu' | 'rps';
  /** CPU % per replica, or requests/second per replica. */
  target: number;
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
  /** Docker-style overrides (e.g. from Compose): replace only CMD / only ENTRYPOINT. Ignored when startCommand is set. */
  cmd?: string[] | null;
  entrypoint?: string[] | null;
  buildCommand: string | null;
  resources: { cpus: number | null; memoryMb: number | null };
  autoDeploy: boolean;
  /** Scheduled backups of this service's data. */
  backup?: BackupConfig | null;
  /** Extra hostnames on the project network (e.g. the original Docker Compose service name). */
  aliases?: string[];
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

export type DeployTrigger = 'create' | 'manual' | 'agent' | 'git' | 'rollback' | 'config' | 'restart';

export interface DeploymentConfig {
  env: Record<string, string>;
  port: number | null;
  protocol: Protocol;
  startCommand: string | null;
  cmd?: string[] | null;
  entrypoint?: string[] | null;
  volumes: Volume[];
  resources: { cpus: number | null; memoryMb: number | null };
  source: Source;
}

export interface Deployment {
  id: string;
  serviceId: string;
  projectId: string;
  status: DeploymentStatus;
  image: string | null;
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
}

export type BackupMethod = 'pg_dumpall' | 'mysqldump' | 'mongodump' | 'volume';

export interface BackupRecord {
  id: string;
  serviceId: string;
  projectId: string;
  serviceName: string;
  status: 'running' | 'succeeded' | 'failed';
  method: BackupMethod;
  trigger: 'schedule' | 'manual' | 'agent' | 'pre-restore';
  actor: string;
  destinationId: string;
  destinationName: string;
  /** Object key / file name at the destination. */
  key: string | null;
  sizeBytes: number | null;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  restoredAt?: number | null;
  createdAt: number;
}

export interface CertRecord {
  /** = host */
  id: string;
  host: string;
  status: 'pending' | 'issued' | 'failed';
  issuer: 'acme' | 'internal';
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
  scope: 'read' | 'write';
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
  category: 'database' | 'cache' | 'storage' | 'app' | 'tool';
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
}

export interface JobRun {
  id: string;
  serviceId: string;
  projectId: string;
  status: 'running' | 'succeeded' | 'failed';
  trigger: 'schedule' | 'manual' | 'agent';
  actor: string;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  output: string;
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
  | { type: 'hello'; version: string };
