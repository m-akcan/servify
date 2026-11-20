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
} from '../../../server/src/types.ts';

import type { Service, Project, Deployment, Replica, VolumeRecord } from '../../../server/src/types.ts';

export type DomainInfo = { domain: string; url: string; tls: 'issued' | 'pending' | 'failed' | 'off' | 'local'; expiresAt: number | null; error: string | null };

export type ServiceView = Service & {
  url: string | null;
  tcpAddress: string | null;
  pendingChanges: string[];
  nextRunAt?: number | null;
  jobRunning?: boolean;
  deployedSchedule?: string | null;
  domainInfo: DomainInfo[];
  backupMethod: 'pg_dumpall' | 'mysqldump' | 'mongodump' | 'volume' | null;
  restoring: boolean;
  clusterStatus: ClusterStatus | null;
};

export type ClusterMember = { index: number; role: 'primary' | 'standby' | 'starting' | 'down' | 'fenced' | 'rebuilding'; lsn: string | null; lagBytes: number | null; streaming: number | null; syncState: string | null; containerId: string | null };
export type ClusterStatus = { kind: 'postgres'; primary: number; failoverAfterSec: number; synchronous: boolean; members: ClusterMember[]; primaryDownSince: number | null; lastFailoverAt: number | null; degradedAsync: boolean; operation: string | null };

export type ProjectListItem = Project & {
  serviceCount: number;
  environments: number;
  running: number;
  services: { id: string; name: string; icon: string; status: Service['status'] }[];
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
