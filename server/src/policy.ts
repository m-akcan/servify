/**
 * What every API route and MCP tool needs from the caller: the one table that scoped API tokens are enforced from
 * (see scopes.ts). Pure data with no imports, so the acceptance tests can read it and check that every route
 * registered in api.ts and every tool in mcp.ts is classified here.
 *
 * Levels: read < deploy < write, and owner (the dashboard, a signed-in phone, SERVIFY_AUTH=none) above all tokens.
 * A route reaches a project through its targets: path params, body fields or query params that name a project,
 * service, deployment, volume or backup. A token limited to some projects may only use routes with a target in
 * reach, or routes marked `filtered` (their handler returns only what is in reach). Anything else — no project
 * context — is for tokens without a project list only. A route missing from the table is treated as owner only.
 */

export type Level = 'public' | 'read' | 'deploy' | 'write' | 'owner';
export type TargetKind = 'project' | 'service' | 'deployment' | 'volume' | 'backup';

export type Policy = {
  level: Level;
  /** REST: path params that name what the route acts on. MCP: tool arguments. */
  params?: Record<string, TargetKind>;
  /** REST: JSON body fields naming a second thing it acts on (both ends must be in reach). */
  body?: Record<string, TargetKind>;
  /** REST: query params naming a project (optional; checked when present). */
  query?: Record<string, TargetKind>;
  /** No single project: allowed for project-limited tokens because the handler returns only what is in reach. */
  filtered?: true;
  /** Deploy tokens may not pass skipSafetyBackup: true (going ahead without the safety backup is the user's call). */
  noSkip?: true;
  /** Below write, deploy tokens may use it on a service whose source already is an upload (`servify up` from CI). */
  deployOnUploads?: true;
  /** The 403 message for non-owners (kept as the handlers word it). */
  ownerMessage?: string;
};

const SETTINGS = 'only the owner can change instance settings';
const TOKENS = 'only the owner can manage tokens';
const DEVICES = 'only the owner can manage devices';
const SIGNIN = 'only the owner can manage sign-in';
const SERVERS = 'Managing servers can only be set by the owner in the dashboard, not with an agent token';

const P = { id: 'project' } as const;
const S = { id: 'service' } as const;
const D = { id: 'deployment' } as const;
const V = { id: 'volume' } as const;
const B = { id: 'backup' } as const;

/** Every REST route under /api, keyed `METHOD /path` as registered in api.ts. */
export const ROUTE_POLICIES: Record<string, Policy> = {
  // Sign-in (before authentication).
  'GET /auth/status': { level: 'public' },
  'POST /auth/setup': { level: 'public' },
  'POST /auth/login': { level: 'public' },
  'POST /auth/device': { level: 'public' },
  'POST /auth/logout': { level: 'public' },
  // Passkey sign-in (throttled per address: challenges by a token bucket, failures by the sign-in throttle).
  'POST /auth/passkey/options': { level: 'public' },
  'POST /auth/passkey/login': { level: 'public' },
  // Phone pairing (pairing.ts): starts limited per address and in total, polls rate-limited per address.
  'POST /auth/pair/start': { level: 'public' },
  'GET /auth/pair/:pairingId': { level: 'public' },
  // A signed-in phone signs itself out (device tokens act as the owner and have write scope).
  'DELETE /auth/device': { level: 'write' },

  // Instance-wide: tokens without a project list only.
  'GET /system': { level: 'read' },
  'GET /servers': { level: 'read' },
  'GET /overview': { level: 'read' },
  'GET /settings': { level: 'read' },
  'GET /settings/autostart': { level: 'read' },
  'GET /settings/notifications/health': { level: 'read' },
  'GET /certs': { level: 'read' },
  // The phone app mirrored from the signed release (public on GitHub too, but not an open file server). Instance-wide,
  // like /system: phones (device tokens act as the owner) and the dashboard use it, agents limited to some projects
  // have no business with it.
  'GET /mobile/app': { level: 'read' },
  'GET /mobile/app.apk': { level: 'read' },
  // A new project (or one from a spec or compose file) would be outside a project-limited token's list.
  'POST /projects': { level: 'write' },
  'POST /projects/import': { level: 'write' },
  'POST /projects/import-compose': { level: 'write' },

  // Lists that return only what the token reaches.
  'GET /projects': { level: 'read', filtered: true },
  'GET /activity': { level: 'read', filtered: true },
  'GET /events': { level: 'read', filtered: true, query: { project: 'project' } },
  'GET /access-log/recent': { level: 'read', filtered: true },
  'GET /access-log/totals': { level: 'read', filtered: true },
  // Static or public: the template catalog and the local CA certificate.
  'GET /templates': { level: 'read', filtered: true },
  'GET /certs/local-ca.pem': { level: 'read', filtered: true },
  // The same certificate as JSON with its fingerprint (public information, like the .pem).
  'GET /certs/local-ca': { level: 'read', filtered: true },

  // Projects.
  'GET /projects/:id': { level: 'read', params: P },
  'PATCH /projects/:id': { level: 'write', params: P },
  'DELETE /projects/:id': { level: 'write', params: P },
  'GET /projects/:id/export': { level: 'read', params: P },
  'GET /projects/:id/volumes': { level: 'read', params: P },
  'POST /projects/:id/volumes': { level: 'write', params: P, body: { serviceId: 'service' } },
  'GET /projects/:id/environments': { level: 'read', params: P },
  // The new environment is a child of the project, so it is in reach of the same tokens.
  'POST /projects/:id/environments': { level: 'write', params: P },
  'PATCH /projects/:id/previews': { level: 'write', params: P },
  'POST /projects/:id/demo': { level: 'write', params: P },
  'GET /projects/:id/activity': { level: 'read', params: P },
  'POST /projects/:id/services': { level: 'write', params: P },
  'POST /projects/:id/volumes/adopt': { level: 'owner', params: P, ownerMessage: 'Taking over an existing Docker volume can only be set by the owner in the dashboard, not with an agent token' },

  // Volumes.
  'PATCH /volumes/:id': { level: 'write', params: V },
  'POST /volumes/:id/attach': { level: 'write', params: V, body: { serviceId: 'service' } },
  'POST /volumes/:id/detach': { level: 'write', params: V },
  'DELETE /volumes/:id': { level: 'write', params: V },
  'POST /volumes/:id/share': { level: 'write', params: V, body: { serviceId: 'service' } },
  'GET /servers/:id/docker-volumes': { level: 'owner', ownerMessage: 'Listing other Docker volumes can only be set by the owner in the dashboard, not with an agent token' },
  // Reclaim space: Servify's leftovers on every server (owner only: deletes data).
  'GET /reclaim': { level: 'owner', ownerMessage: 'Reclaiming space can only be done by the owner in the dashboard, not with an agent token' },
  'POST /reclaim/delete': { level: 'owner', ownerMessage: 'Reclaiming space can only be done by the owner in the dashboard, not with an agent token' },

  // Services: reading.
  'GET /services/:id': { level: 'read', params: S },
  'GET /services/:id/deployments': { level: 'read', params: S },
  'GET /services/:id/metrics': { level: 'read', params: S },
  'GET /services/:id/logs': { level: 'read', params: S },
  'GET /services/:id/logs/stream': { level: 'read', params: S },
  'GET /services/:id/access-log': { level: 'read', params: S },
  'GET /services/:id/access-log/summary': { level: 'read', params: S },
  'GET /services/:id/backups': { level: 'read', params: S },
  'GET /services/:id/runs': { level: 'read', params: S },
  // Secrets and data: the handlers also require write (revealSecrets).
  'GET /services/:id/variables/resolved': { level: 'read', params: S },
  'GET /services/:id/volumes/:name/download': { level: 'read', params: S },
  'GET /services/:id/deploy-hook': { level: 'read', params: S },
  'GET /services/:id/db': { level: 'read', params: S },
  'GET /services/:id/db/tables': { level: 'read', params: S },
  'GET /services/:id/db/rows': { level: 'read', params: S },

  // Services: deploying.
  'POST /services/:id/deploy': { level: 'deploy', params: S, noSkip: true },
  'POST /services/:id/restart': { level: 'deploy', params: S, noSkip: true },
  'POST /services/:id/rollback': { level: 'deploy', params: S, noSkip: true },
  'POST /services/:id/update-image': { level: 'deploy', params: S, noSkip: true },
  'POST /services/:id/image-check': { level: 'deploy', params: S },
  'POST /services/:id/upload': { level: 'write', params: S, deployOnUploads: true },

  // Services: changing.
  'PATCH /services/:id': { level: 'write', params: S },
  'DELETE /services/:id': { level: 'write', params: S },
  'POST /services/:id/duplicate': { level: 'write', params: S },
  'POST /services/:id/stop': { level: 'write', params: S },
  'POST /services/:id/start': { level: 'write', params: S },
  'POST /services/:id/scale': { level: 'write', params: S },
  'PUT /services/:id/variables': { level: 'write', params: S },
  'DELETE /services/:id/variables/:key': { level: 'write', params: S },
  'POST /services/:id/unmount': { level: 'write', params: S },
  'POST /services/:id/backups': { level: 'write', params: S },
  'POST /services/:id/add-connected': { level: 'write', params: S },
  'POST /services/:id/track-image': { level: 'write', params: S },
  // Also its dry run (dryRun: true, `project` optional): both ends must be in reach.
  'POST /services/:id/move-project': { level: 'write', params: S, body: { project: 'project' } },
  'POST /services/:id/move': { level: 'write', params: S },
  'GET /services/:id/move-plan': { level: 'write', params: S },
  'DELETE /services/:id/move': { level: 'write', params: S },
  'POST /volumes/:id/discard-move-copy': { level: 'write', params: V },
  'POST /volumes/:id/keep-move-copy': { level: 'write', params: V },
  'POST /services/:id/cluster/switchover': { level: 'write', params: S },
  'POST /services/:id/cluster/rebuild': { level: 'write', params: S },
  'POST /services/:id/run': { level: 'write', params: S },
  'POST /services/:id/db/query': { level: 'write', params: S },
  'POST /services/:id/exec': { level: 'write', params: S },
  'POST /services/:id/loadtest': { level: 'write', params: S },
  'DELETE /services/:id/loadtest': { level: 'write', params: S },

  // Backups.
  'POST /backups/:id/restore': { level: 'write', params: B },
  'POST /backups/:id/test': { level: 'write', params: B },
  'DELETE /backups/:id': { level: 'write', params: B },
  'GET /backups/:id/download': { level: 'read', params: B },
  // One backup record: status, checksum, the last test restore and the last restore's progress (servify restore follows it).
  'GET /backups/:id': { level: 'read', params: B },

  // Deployments.
  'GET /deployments/:id': { level: 'read', params: D },
  'GET /deployments/:id/logs': { level: 'read', params: D },
  'GET /deployments/:id/logs/stream': { level: 'read', params: D },
  'POST /deployments/:id/cancel': { level: 'deploy', params: D },

  // Owner only.
  'POST /servers': { level: 'owner', ownerMessage: SERVERS },
  'PATCH /servers/:id': { level: 'owner', ownerMessage: SERVERS },
  'POST /servers/:id/token': { level: 'owner', ownerMessage: SERVERS },
  'POST /servers/:id/agent/upgrade': { level: 'owner', ownerMessage: SERVERS },
  'DELETE /servers/:id': { level: 'owner', ownerMessage: SERVERS },
  'GET /system/update': { level: 'owner', ownerMessage: SETTINGS },
  'POST /system/update/check': { level: 'owner', ownerMessage: SETTINGS },
  'POST /system/update': { level: 'owner', ownerMessage: SETTINGS },
  'POST /mobile/app/check': { level: 'owner', ownerMessage: SETTINGS },
  'PUT /settings/autostart': { level: 'owner', ownerMessage: SETTINGS },
  'PATCH /settings/general': { level: 'owner', ownerMessage: SETTINGS },
  'PATCH /settings/alerts': { level: 'owner', ownerMessage: SETTINGS },
  'PATCH /settings/disk': { level: 'owner', ownerMessage: SETTINGS },
  'PATCH /settings/https': { level: 'owner', ownerMessage: SETTINGS },
  'POST /settings/notifications/channels': { level: 'owner', ownerMessage: SETTINGS },
  'DELETE /settings/notifications/channels/:id': { level: 'owner', ownerMessage: SETTINGS },
  'POST /settings/notifications/channels/:id/test': { level: 'owner', ownerMessage: SETTINGS },
  'GET /settings/notifications/deliveries': { level: 'owner', ownerMessage: SETTINGS },
  'POST /settings/backups/destinations': { level: 'owner', ownerMessage: SETTINGS },
  'POST /settings/backups/destinations/:id/test': { level: 'owner', ownerMessage: SETTINGS },
  'DELETE /settings/backups/destinations/:id': { level: 'owner', ownerMessage: SETTINGS },
  'GET /settings/webhooks/deliveries': { level: 'owner', ownerMessage: SETTINGS },
  'GET /settings/registries': { level: 'owner', ownerMessage: SETTINGS },
  'POST /settings/registries': { level: 'owner', ownerMessage: SETTINGS },
  'DELETE /settings/registries/:id': { level: 'owner', ownerMessage: SETTINGS },
  'POST /settings/registries/:id/test': { level: 'owner', ownerMessage: SETTINGS },
  'POST /settings/webhooks/rotate': { level: 'owner', ownerMessage: SETTINGS },
  'POST /certs/:host/retry': { level: 'owner', ownerMessage: SETTINGS },
  'GET /tokens': { level: 'owner', ownerMessage: TOKENS },
  'POST /tokens': { level: 'owner', ownerMessage: TOKENS },
  'DELETE /tokens/:id': { level: 'owner', ownerMessage: TOKENS },
  'GET /devices': { level: 'owner', ownerMessage: DEVICES },
  // Sign-in methods and sessions (Settings → Security). Passkeys and the password policy also need a fresh dashboard
  // session (the handlers check); approving phones and signing out everywhere work from a signed-in phone too.
  'GET /auth/security': { level: 'owner', ownerMessage: SIGNIN },
  'POST /auth/reauth': { level: 'owner', ownerMessage: SIGNIN },
  'POST /auth/passkeys/options': { level: 'owner', ownerMessage: SIGNIN },
  'POST /auth/passkeys': { level: 'owner', ownerMessage: SIGNIN },
  'PATCH /auth/passkeys/:id': { level: 'owner', ownerMessage: SIGNIN },
  'DELETE /auth/passkeys/:id': { level: 'owner', ownerMessage: SIGNIN },
  'PUT /auth/password-policy': { level: 'owner', ownerMessage: SIGNIN },
  'POST /auth/signout-all': { level: 'owner', ownerMessage: SIGNIN },
  'GET /auth/pairings': { level: 'owner', ownerMessage: DEVICES },
  'POST /auth/pairings/deny-all': { level: 'owner', ownerMessage: DEVICES },
  'POST /auth/pairings/:id/approve': { level: 'owner', ownerMessage: DEVICES },
  'POST /auth/pairings/:id/deny': { level: 'owner', ownerMessage: DEVICES },
  'DELETE /devices/:id': { level: 'owner', ownerMessage: DEVICES },
};

const svc = { service: 'service' } as const;
const proj = { project: 'project' } as const;

/** Every MCP tool, by name as registered in mcp.ts; `params` are its arguments. */
export const TOOL_POLICIES: Record<string, Policy> = {
  overview: { level: 'read', filtered: true },
  list_templates: { level: 'read', filtered: true },
  get_activity: { level: 'read', filtered: true, params: proj },
  // Instance-wide.
  create_project: { level: 'write' },
  import_project: { level: 'write' },
  // Even a dry run reads files under base_path.
  import_compose: { level: 'write' },
  list_servers: { level: 'read' },
  list_certificates: { level: 'read' },

  get_project: { level: 'read', params: proj },
  delete_project: { level: 'write', params: proj },
  export_project: { level: 'read', params: proj },
  create_service: { level: 'write', params: proj },
  list_environments: { level: 'read', params: proj },
  create_environment: { level: 'write', params: proj },
  set_previews: { level: 'write', params: proj },
  list_volumes: { level: 'read', params: proj },
  create_volume: { level: 'write', params: { project: 'project', service: 'service' } },

  get_service: { level: 'read', params: svc },
  list_deployments: { level: 'read', params: svc },
  get_service_logs: { level: 'read', params: svc },
  get_access_log: { level: 'read', params: svc },
  get_access_summary: { level: 'read', params: svc },
  get_metrics: { level: 'read', params: svc },
  list_runs: { level: 'read', params: svc },
  list_backups: { level: 'read', params: svc },
  cluster_status: { level: 'read', params: svc },
  wait_for_deployment: { level: 'read', params: { deployment: 'deployment' } },
  get_deployment_logs: { level: 'read', params: { deployment: 'deployment' } },

  deploy_service: { level: 'deploy', params: svc, noSkip: true },
  restart_service: { level: 'deploy', params: svc, noSkip: true },
  rollback_service: { level: 'deploy', params: svc, noSkip: true },
  update_image: { level: 'deploy', params: svc, noSkip: true },

  update_service: { level: 'write', params: svc },
  scale_service: { level: 'write', params: svc },
  stop_service: { level: 'write', params: svc },
  start_service: { level: 'write', params: svc },
  delete_service: { level: 'write', params: svc },
  set_variables: { level: 'write', params: svc },
  delete_variable: { level: 'write', params: svc },
  exec_command: { level: 'write', params: svc },
  run_job: { level: 'write', params: svc },
  load_test: { level: 'write', params: svc },
  backup_service: { level: 'write', params: svc },
  unmount: { level: 'write', params: svc },
  switchover: { level: 'write', params: svc },
  move_service: { level: 'write', params: svc },
  // Both ends must be in reach (the service's project and the one it moves to).
  move_service_to_project: { level: 'write', params: { service: 'service', project: 'project' } },
  restore_backup: { level: 'write', params: { backup_id: 'backup' } },
  test_restore: { level: 'write', params: { backup_id: 'backup' } },
  attach_volume: { level: 'write', params: { volume: 'volume', service: 'service' } },
  detach_volume: { level: 'write', params: { volume: 'volume' } },
  delete_volume: { level: 'write', params: { volume: 'volume' } },
  share_volume: { level: 'write', params: { volume: 'volume', service: 'service' } },
};

/** Token scopes, weakest first. */
export const TOKEN_SCOPES = ['read', 'deploy', 'write'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
