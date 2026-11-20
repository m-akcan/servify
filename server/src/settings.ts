/**
 * Instance-wide settings (HTTPS, notifications, backup destinations, git webhooks), stored sealed in kv.
 * Credentials are masked whenever settings leave the server; a masked value sent back means "unchanged".
 */
import { z } from 'zod';
import { join } from 'node:path';
import { kv } from './db.ts';
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
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

const channelSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(60),
  type: z.enum(['webhook', 'slack', 'discord', 'telegram', 'ntfy', 'email']),
  enabled: z.boolean().default(true),
  events: z.array(z.enum(NOTIFY_EVENTS)).default(['deploy.failed', 'service.crashed', 'job.failed', 'backup.failed', 'cert.failed']),
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
  https: z.infer<typeof httpsSchema>;
  notifications: { channels: Channel[] };
  backups: { destinations: Destination[] };
  webhooks: { secret: string };
};

export const LOCAL_DESTINATION: Destination = { id: 'local', name: 'This machine', type: 'local', path: join(config.dataDir, 'backups') };

function defaults(): Settings {
  return {
    dashboardUrl: null,
    https: { enabled: false, email: '', staging: false, directoryUrl: null, redirectHttp: true },
    notifications: { channels: [] },
    backups: { destinations: [] },
    webhooks: { secret: secret(24) },
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
  };
  if (!raw || !stored.webhooks?.secret) save(cache);
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

function maskChannel(c: Channel): Channel {
  return {
    ...c,
    // Slack/Discord/webhook URLs embed their credentials.
    url: c.type === 'ntfy' ? c.url : mask(c.url) ?? undefined,
    secret: mask(c.secret) ?? undefined,
    botToken: mask(c.botToken) ?? undefined,
    smtp: c.smtp ? { ...c.smtp, pass: mask(c.smtp.pass) ?? undefined } : undefined,
  };
}

function maskDestination(d: Destination): Destination {
  return { ...d, secretAccessKey: mask(d.secretAccessKey) ?? undefined };
}

export function publicSettings(reveal: boolean) {
  const s = getSettings();
  return {
    dashboardUrl: s.dashboardUrl,
    https: s.https,
    // Channel and destination credentials are write-only, even for the owner; only the webhook
    // secret is shown (it has to be pasted into the git host).
    notifications: { channels: s.notifications.channels.map(maskChannel) },
    backups: { destinations: [LOCAL_DESTINATION, ...s.backups.destinations.map(maskDestination)] },
    webhooks: { secret: reveal ? s.webhooks.secret : MASK },
  };
}

/** Keep stored secrets where the client sent back the mask. */
function unmask<T extends Record<string, any>>(next: T, prev: T | undefined, keys: string[]): T {
  const out: any = { ...next };
  for (const k of keys) if (out[k] === MASK) out[k] = prev?.[k];
  return out;
}

// ───────────────────────────── updates ─────────────────────────────

export function updateGeneral(actor: Actor, patch: { dashboardUrl?: string | null }) {
  const s = structuredClone(getSettings());
  if (patch.dashboardUrl !== undefined) {
    const v = patch.dashboardUrl?.trim().replace(/\/+$/, '') || null;
    if (v && !/^https?:\/\//.test(v)) throw new HttpError(400, 'dashboard URL must start with http:// or https://');
    s.dashboardUrl = v;
  }
  save(s);
  recordActivity(actor, 'settings.updated', 'Updated general settings');
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
