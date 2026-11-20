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
  buildCommand: string | null;
  resources: { cpus: number | null; memoryMb: number | null };
  autoDeploy: boolean;
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
  createdAt: number;
  updatedAt: number;
}

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
  | { type: 'hello'; version: string };
