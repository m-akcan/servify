export type {
  Service,
  Deployment,
  Project,
  Replica,
  ActivityEntry,
  Template,
  ServiceMetricsPoint,
  ServerEvent,
  ServiceStatus,
  JobRun,
  BackupRecord,
  PublicCert,
  PreviewInfo,
  VolumeRecord,
  DeploymentStatus,
  ApiToken,
  LbStrategy,
  Protocol,
  PublicServer,
  ServerInfo,
  HostStats,
  Overview,
} from '../../../server/src/types.ts';

import type { Service, Project, Deployment, Replica, VolumeRecord, PublicServer } from '../../../server/src/types.ts';

export type ImageUpdate = { ref: string; checkedAt: number; status: 'current' | 'changed' | 'unknown'; reason?: string; newerTag?: string | null; newerMajor?: string | null };

export type DomainInfo = { domain: string; url: string; tls: 'issued' | 'pending' | 'failed' | 'off' | 'local'; expiresAt: number | null; error: string | null };

export type ServiceView = Service & {
  url: string | null;
  tcpAddress: string | null;
  pendingChanges: string[];
  imageUpdate?: ImageUpdate | null;
  nextRunAt?: number | null;
  jobRunning?: boolean;
  deployedSchedule?: string | null;
  domainInfo: DomainInfo[];
  backupMethod: 'pg_dumpall' | 'mysqldump' | 'mongodump' | 'volume' | null;
  restoring: boolean;
  clusterStatus: ClusterStatus | null;
  /** Where it runs. */
  server?: { id: string; name: string; online: boolean };
  /** Services it references by variable that run on another server (reached through mesh relays). */
  crossServerRefs?: string[];
  /** External routes: the target and whether it answered the last probe. */
  external?: { host: string; port: number; healthy: boolean | null; lastProbe: number | null } | null;
};

export type JoinCommand = { url: string; fingerprint: string; docker: string; node: string };
export type ServerCreated = { server: PublicServer; token: string; join: JoinCommand };

export type ClusterMember = { index: number; role: 'primary' | 'standby' | 'starting' | 'down' | 'fenced' | 'rebuilding'; lsn: string | null; lagBytes: number | null; streaming: number | null; syncState: string | null; containerId: string | null };
export type ClusterStatus = { kind: 'postgres'; primary: number; failoverAfterSec: number; synchronous: boolean; members: ClusterMember[]; primaryDownSince: number | null; lastFailoverAt: number | null; degradedAsync: boolean; operation: string | null };

export type ProjectListItem = Project & {
  serviceCount: number;
  environments: number;
  running: number;
  /** When any service of the project was last deployed. */
  lastDeployAt?: number | null;
  /** The servers its services run on ('local' = this machine). */
  servers?: { id: string; name: string }[];
  services: ProjectListService[];
};

/** A service as the project list (and the traffic board) sees it. */
export type ProjectListService = {
  id: string;
  name: string;
  icon: string;
  status: Service['status'];
  server?: string;
  kind?: Service['source']['type'];
  protocol?: Service['protocol'];
  publicHttp?: boolean;
  domains?: string[];
  publicTcpPort?: number | null;
};

export type Snapshot = {
  project: Project;
  services: ServiceView[];
  deployments: Deployment[];
  replicas: Record<string, Replica[]>;
  edges: { from: string; to: string }[];
  volumes: VolumeRecord[];
  proxyPort: number;
};

export type SystemInfo = {
  version: string;
  docker: { ok: boolean; version?: string; os?: string; cpus?: number; memGb?: number; containers?: number; endpoint?: string; error?: string };
  proxy: { host: string; port: number; httpsPort: number; baseDomain: string };
  api: { host: string; port: number };
  dataDir: string;
  masterKey?: { source: 'env' | 'file' | 'created'; path: string | null };
  binPath?: string;
  authMode: 'password' | 'none';
  actor: { type: string; name: string };
  scope: 'read' | 'write';
};

export type LogLine = { ts: number; replica: number; deploymentId: string; stream: 'stdout' | 'stderr'; text: string };
