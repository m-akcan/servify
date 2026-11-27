/**
 * Instance-wide settings (HTTPS, notifications, backup destinations, git webhooks), stored sealed in kv.
 * Credentials are masked whenever settings leave the server; a masked value sent back means "unchanged".
 */
import { z } from 'zod';
import { join } from 'node:path';
import { kv, services as servicesTable, projects as projectsTable } from './db.ts';
import { parseRules, PRIVATE, untrustedProxy, untrustedProxyMessage } from './access.ts';
import { sealJson, openJson, isSealed } from './crypto.ts';
import { secret, HttpError, id } from './util.ts';
import { config } from './config.ts';
import { bus, recordActivity, type Actor } from './events.ts';

export const MASK = '••••••••';

export const NOTIFY_EVENTS = [
  'deploy.succeeded',
  'deploy.failed',
  'service.crashed',
  'service.recovered',
  'job.failed',
  'backup.succeeded',
  'backup.failed',
  'cert.failed',
  'preview.ready',
  'server.usage',
  'image.update',
  'servify.update',
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

const channelSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(60),
  type: z.enum(['webhook', 'slack', 'discord', 'telegram', 'ntfy', 'email']),
  enabled: z.boolean().default(true),
  events: z.array(z.enum(NOTIFY_EVENTS)).default(['deploy.failed', 'service.crashed', 'job.failed', 'backup.failed', 'cert.failed', 'server.usage']),
  /** webhook / slack / discord: endpoint URL. ntfy: server URL (default https://ntfy.sh). */
  url: z.string().optional(),
  /** webhook: HMAC-SHA256 signing secret (X-Servify-Signature). ntfy: access token. */
  secret: z.string().optional(),
  /** telegram */
  botToken: z.string().optional(),
  chatId: z.string().optional(),
  /** ntfy */
  topic: z.string().optional(),
  /** email */
  smtp: z
    .object({
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535).default(587),
      secure: z.boolean().default(false),
      user: z.string().optional(),
      pass: z.string().optional(),
      from: z.string().min(3),
      to: z.string().min(3),
    })
    .optional(),
});
export type Channel = z.infer<typeof channelSchema> & { id: string };

const destinationSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(60),
  type: z.enum(['local', 's3']),
  /** local: absolute folder */
  path: z.string().optional(),
  /** s3-compatible (AWS S3, Cloudflare R2, MinIO, Backblaze B2, …) */
  endpoint: z.string().optional(),
  region: z.string().optional(),
  bucket: z.string().optional(),
  prefix: z.string().optional(),
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  forcePathStyle: z.boolean().optional(),
});
export type Destination = z.infer<typeof destinationSchema> & { id: string };

const httpsSchema = z.object({
  enabled: z.boolean(),
  email: z.string(),
  staging: z.boolean(),
  /** Custom ACME directory (e.g. a private CA or a test server). Overrides `staging`. */
  directoryUrl: z.string().nullable(),
  redirectHttp: z.boolean(),
});

export type Settings = {
  /** Public URL of the dashboard, used for links in notifications. */
  dashboardUrl: string | null;
  /** The router serves the dashboard, /api and /mcp for this host over HTTPS (plain HTTP redirects). Owner only. */
  dashboardDomain: string | null;
  /** Who may use the dashboard domain: addresses/CIDRs or "private" (the default). Empty = anyone. */
  dashboardAllow: string[];
  https: z.infer<typeof httpsSchema>;
  notifications: { channels: Channel[] };
  backups: { destinations: Destination[] };
  webhooks: { secret: string };
  /** Notify (event server.usage) when a server's disk, memory or CPU stays above these percentages. */
  alerts: z.infer<typeof alertsSchema>;
  /** Low disk space protection: lines per level (null: SERVIFY_DISK_* env, else the defaults), automatic clean-up. */
  disk: z.infer<typeof diskSchema>;
  /** Channels subscribed to failures got server.usage added once, when it was introduced. */
  usageEventAdded?: boolean;
  /** …and servify.update (updates of Servify itself), when that was introduced. */
  updateEventAdded?: boolean;
};

const alertsSchema = z.object({
  enabled: z.boolean(),
  diskPct: z.number().int().min(50).max(99),
  memPct: z.number().int().min(50).max(99),
  cpuPct: z.number().int().min(50).max(100),
  /** Scheduled jobs, backups and test restores that keep failing: remind every this many hours (0 = only the first failure and the recovery). */
  failureRemindHours: z.number().min(0).max(24 * 30),
});

const diskSchema = z.object({
  warnPct: z.number().min(0).max(90).nullable(),
  warnGb: z.number().min(0).max(1_000_000).nullable(),
  protectPct: z.number().min(0).max(90).nullable(),
  protectGb: z.number().min(0).max(1_000_000).nullable(),
  autoClean: z.boolean().nullable(),
});

export const LOCAL_DESTINATION: Destination = { id: 'local', name: 'This machine', type: 'local', path: join(config.dataDir, 'backups') };

function defaults(): Settings {
  return {
    dashboardUrl: null,
    dashboardDomain: null,
    dashboardAllow: [PRIVATE],
    https: { enabled: false, email: '', staging: false, directoryUrl: null, redirectHttp: true },
    notifications: { channels: [] },
    backups: { destinations: [] },
    webhooks: { secret: secret(24) },
    alerts: { enabled: true, diskPct: 90, memPct: 90, cpuPct: 95, failureRemindHours: 24 },
    disk: { warnPct: null, warnGb: null, protectPct: null, protectGb: null, autoClean: null },
  };
}

let cache: Settings | null = null;

export function getSettings(): Settings {
  if (cache) return cache;
  const raw = kv.get('settings');
  const base = defaults();
  let stored: Partial<Settings> = {};
  if (raw) stored = isSealed(raw) ? openJson<Partial<Settings>>(raw) : JSON.parse(raw);
  cache = {
    ...base,
    ...stored,
    https: { ...base.https, ...(stored.https ?? {}) },
    notifications: { channels: stored.notifications?.channels ?? [] },
    backups: { destinations: stored.backups?.destinations ?? [] },
    webhooks: { secret: stored.webhooks?.secret || base.webhooks.secret },
    alerts: { ...base.alerts, ...(stored.alerts ?? {}) },
    disk: { ...base.disk, ...(stored.disk ?? {}) },
  };
  if (!raw || !stored.webhooks?.secret) save(cache);
  // server.usage arrived later: channels that already get failure alerts get it once.
  if (!cache.usageEventAdded) {
    for (const ch of cache.notifications.channels) if (ch.events.includes('service.crashed') && !ch.events.includes('server.usage')) ch.events.push('server.usage');
    cache.usageEventAdded = true;
    save(cache);
  }
  if (!cache.updateEventAdded) {
    for (const ch of cache.notifications.channels) if (ch.events.includes('deploy.failed') && !ch.events.includes('servify.update')) ch.events.push('servify.update');
    cache.updateEventAdded = true;
    save(cache);
  }
  return cache;
}

function save(s: Settings) {
  cache = s;
  kv.set('settings', sealJson(s));
  bus.publish({ type: 'settings.updated' });
}

export function destinations(): Destination[] {
  return [LOCAL_DESTINATION, ...getSettings().backups.destinations];
}

export function destinationById(id: string): Destination | null {
  return destinations().find((d) => d.id === id) ?? null;
}

// ───────────────────────────── masking ─────────────────────────────

const mask = (v: string | undefined | null) => (v ? MASK : v);

/** `owner`: false also hides where a channel points (an ntfy topic is all it takes to read or fake the alerts). */
function maskChannel(c: Channel, owner = true): Channel {
  return {
    ...c,
    ...(owner ? {} : { topic: mask(c.topic) ?? undefined, chatId: mask(c.chatId) ?? undefined }),
    // Slack/Discord/webhook URLs embed their credentials.
    url: c.type === 'ntfy' && owner ? c.url : mask(c.url) ?? undefined,
    secret: mask(c.secret) ?? undefined,
    botToken: mask(c.botToken) ?? undefined,
    smtp: c.smtp ? { ...c.smtp, pass: mask(c.smtp.pass) ?? undefined, ...(owner ? {} : { user: mask(c.smtp.user) ?? undefined }) } : undefined,
  };
}

function maskDestination(d: Destination): Destination {
  return { ...d, secretAccessKey: mask(d.secretAccessKey) ?? undefined };
}

export function publicSettings(reveal: boolean) {
  const s = getSettings();
  return {
    dashboardUrl: s.dashboardUrl,
    dashboardDomain: s.dashboardDomain,
    dashboardAllow: s.dashboardAllow,
    /** A proxy in front that Servify doesn't trust sent requests for the dashboard domain (they are refused). */
    dashboardWarning: s.dashboardDomain && untrustedProxy('dashboard') ? untrustedProxyMessage(untrustedProxy('dashboard')!.peer) : null,
    https: s.https,
    // Channel and destination credentials are write-only, even for the owner; only the webhook
    // secret is shown (it has to be pasted into the git host).
    notifications: { channels: s.notifications.channels.map((c) => maskChannel(c, reveal)) },
    backups: { destinations: [LOCAL_DESTINATION, ...s.backups.destinations.map(maskDestination)] },
    webhooks: { secret: reveal ? s.webhooks.secret : MASK },
    alerts: s.alerts,
    disk: s.disk,
  };
}

/** Keep stored secrets where the client sent back the mask. */
function unmask<T extends Record<string, any>>(next: T, prev: T | undefined, keys: string[]): T {
  const out: any = { ...next };
  for (const k of keys) if (out[k] === MASK) out[k] = prev?.[k];
  return out;
}

// ───────────────────────────── updates ─────────────────────────────

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** A dashboard domain: a host name (or an IPv4 address of this machine) that no service routes. */
function checkDashboardDomain(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '').replace(/\.$/, '');
  if (!v) return null;
  if (config.authMode === 'none') throw new HttpError(400, 'a dashboard domain needs sign-in: Servify runs with SERVIFY_AUTH=none, which would hand the dashboard to anyone who reaches it');
  if (!HOST_NAME.test(v)) throw new HttpError(400, `not a host name: ${raw}`);
  if (v === 'localhost') throw new HttpError(400, 'pick a name other than localhost (the dashboard port already answers there)');
  const projects = new Map(projectsTable.all().map((p) => [p.id, p]));
  for (const svc of servicesTable.all()) {
    const p = projects.get(svc.projectId);
    if (svc.domains.includes(v) || (p && `${svc.slug}.${p.slug}.${config.baseDomain}` === v)) throw new HttpError(409, `${v} is already routed to the service ${svc.name}`);
  }
  return v;
}

export function updateGeneral(actor: Actor, patch: { dashboardUrl?: string | null; dashboardDomain?: string | null; dashboardAllow?: string[] | null }) {
  const s = structuredClone(getSettings());
  const said: string[] = [];
  if (patch.dashboardUrl !== undefined) {
    const v = patch.dashboardUrl?.trim().replace(/\/+$/, '') || null;
    if (v && !/^https?:\/\//.test(v)) throw new HttpError(400, 'dashboard URL must start with http:// or https://');
    s.dashboardUrl = v;
    said.push('general settings');
  }
  if (patch.dashboardDomain !== undefined) {
    const v = checkDashboardDomain(patch.dashboardDomain);
    // A newly chosen domain starts private-only unless the same request says otherwise.
    if (v && v !== s.dashboardDomain && patch.dashboardAllow === undefined) s.dashboardAllow = [PRIVATE];
    s.dashboardDomain = v;
    said.push(v ? `dashboard domain ${v}` : 'no dashboard domain');
  }
  if (patch.dashboardAllow !== undefined) {
    s.dashboardAllow = parseRules(patch.dashboardAllow, 'dashboardAllow');
    said.push(s.dashboardAllow.length ? `dashboard domain open to ${s.dashboardAllow.join(', ')}` : 'dashboard domain open to anyone');
  }
  save(s);
  recordActivity(actor, 'settings.updated', `Updated ${said.join('; ') || 'general settings'}`);
}

export function updateAlerts(actor: Actor, patch: Partial<z.infer<typeof alertsSchema>>) {
  const s = structuredClone(getSettings());
  s.alerts = alertsSchema.parse({ ...s.alerts, ...patch });
  save(s);
  const remind = s.alerts.failureRemindHours ? `every ${s.alerts.failureRemindHours} h` : 'never';
  recordActivity(actor, 'settings.updated', patch.failureRemindHours !== undefined && Object.keys(patch).length === 1 ? `Reminders for scheduled runs that keep failing: ${remind}` : `Usage alerts ${s.alerts.enabled ? `at disk ${s.alerts.diskPct}%, memory ${s.alerts.memPct}%, CPU ${s.alerts.cpuPct}%` : 'off'}`);
  return s.alerts;
}

export function updateDisk(actor: Actor, patch: Partial<z.infer<typeof diskSchema>>) {
  const s = structuredClone(getSettings());
  s.disk = diskSchema.parse({ ...s.disk, ...patch });
  save(s);
  const d = s.disk;
  const lvl = (pct: number | null, gb: number | null) => [pct != null && `${pct}%`, gb != null && `${gb} GB`].filter(Boolean).join(' / ') || 'default';
  recordActivity(actor, 'settings.updated', `Low disk space: warn below ${lvl(d.warnPct, d.warnGb)}, protect below ${lvl(d.protectPct, d.protectGb)}, automatic clean-up ${d.autoClean === false ? 'off' : 'on'}`);
  return s.disk;
}

export function updateHttps(actor: Actor, patch: Partial<z.infer<typeof httpsSchema>>) {
  const s = structuredClone(getSettings());
  const next = httpsSchema.parse({ ...s.https, ...patch });
  if (next.enabled && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(next.email)) throw new HttpError(400, 'a contact email is required for certificates (Let’s Encrypt sends expiry notices there)');
  if (next.directoryUrl && !/^https?:\/\//.test(next.directoryUrl)) throw new HttpError(400, 'ACME directory must be a URL');
  s.https = next;
  save(s);
  recordActivity(actor, 'settings.https', `HTTPS ${next.enabled ? 'enabled' : 'disabled'}`);
  return s.https;
}

export function upsertChannel(actor: Actor, raw: unknown): Channel {
  const input = channelSchema.parse(raw);
  const s = structuredClone(getSettings());
  const prev = input.id ? s.notifications.channels.find((c) => c.id === input.id) : undefined;
  if (input.id && !prev) throw new HttpError(404, 'channel not found');
  let ch = unmask({ ...input, id: prev?.id ?? id('ch') } as Channel, prev, ['url', 'secret', 'botToken']);
  if (ch.smtp) ch.smtp = unmask(ch.smtp, prev?.smtp, ['pass']);
  validateChannel(ch);
  s.notifications.channels = prev ? s.notifications.channels.map((c) => (c.id === ch.id ? ch : c)) : [...s.notifications.channels, ch];
  save(s);
  recordActivity(actor, 'settings.notifications', `${prev ? 'Updated' : 'Added'} notification channel ${ch.name}`);
  return maskChannel(ch);
}

function validateChannel(c: Channel) {
  const needUrl = c.type === 'webhook' || c.type === 'slack' || c.type === 'discord';
  if (needUrl && !/^https?:\/\//.test(c.url ?? '')) throw new HttpError(400, `${c.type} channels need a URL`);
  if (c.type === 'telegram' && (!c.botToken || !c.chatId)) throw new HttpError(400, 'telegram channels need a bot token and chat id');
  if (c.type === 'ntfy' && !c.topic) throw new HttpError(400, 'ntfy channels need a topic');
  if (c.type === 'email' && !c.smtp) throw new HttpError(400, 'email channels need SMTP settings');
}

export function deleteChannel(actor: Actor, channelId: string) {
  const s = structuredClone(getSettings());
  const ch = s.notifications.channels.find((c) => c.id === channelId);
  if (!ch) throw new HttpError(404, 'channel not found');
  s.notifications.channels = s.notifications.channels.filter((c) => c.id !== channelId);
  save(s);
  recordActivity(actor, 'settings.notifications', `Removed notification channel ${ch.name}`);
}

export function upsertDestination(actor: Actor, raw: unknown): Destination {
  const input = destinationSchema.parse(raw);
  if (input.id === 'local') throw new HttpError(400, 'the built-in local destination cannot be changed');
  const s = structuredClone(getSettings());
  const prev = input.id ? s.backups.destinations.find((d) => d.id === input.id) : undefined;
  if (input.id && !prev) throw new HttpError(404, 'destination not found');
  const d = unmask({ ...input, id: prev?.id ?? id('dst') } as Destination, prev, ['secretAccessKey']);
  if (d.type === 's3') {
    if (!d.bucket || !d.accessKeyId || !d.secretAccessKey) throw new HttpError(400, 'S3 destinations need a bucket, access key and secret key');
    if (d.endpoint && !/^https?:\/\//.test(d.endpoint)) throw new HttpError(400, 'endpoint must be a URL, e.g. https://s3.eu-central-1.amazonaws.com');
  } else if (!d.path?.startsWith('/')) throw new HttpError(400, 'local destinations need an absolute folder path');
  s.backups.destinations = prev ? s.backups.destinations.map((x) => (x.id === d.id ? d : x)) : [...s.backups.destinations, d];
  save(s);
  recordActivity(actor, 'settings.backups', `${prev ? 'Updated' : 'Added'} backup destination ${d.name}`);
  return maskDestination(d);
}

export function deleteDestination(actor: Actor, destId: string) {
  const s = structuredClone(getSettings());
  const d = s.backups.destinations.find((x) => x.id === destId);
  if (!d) throw new HttpError(404, 'destination not found');
  s.backups.destinations = s.backups.destinations.filter((x) => x.id !== destId);
  save(s);
  recordActivity(actor, 'settings.backups', `Removed backup destination ${d.name}`);
}

export function rotateWebhookSecret(actor: Actor) {
  const s = structuredClone(getSettings());
  s.webhooks.secret = secret(24);
  save(s);
  recordActivity(actor, 'settings.webhooks', 'Rotated the git webhook secret');
  return s.webhooks.secret;
}
