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
  DeploymentStatus,
  ApiToken,
  LbStrategy,
  Protocol,
} from '../../../server/src/types.ts';

import type { Service, Project, Deployment, Replica } from '../../../server/src/types.ts';

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
};

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
