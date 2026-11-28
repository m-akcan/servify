/**
 * Notification channel health: the last delivery result per channel, failures in a row, and what a failure means in
 * plain language ("This chat ID is the bot itself …") with what to do about it. Stored in its own kv key (not the
 * sealed settings, whose every write republishes settings.updated). Nothing here ever holds a credential: excerpts of
 * a service's answer are scrubbed of the channel's own token, URL, secret and password before they are kept.
 */
import { kv } from './db.ts';
import type { Channel } from './settings.ts';

/** Failures in a row before a channel counts as failing (badge in the dashboard, notice to the other channels). */
export const FAILING_AFTER = 3;

/** A failed send with what the service answered: HTTP status and body, or a socket/SMTP error code. */
export class SendError extends Error {
  status?: number;
  body?: string;
  code?: string;
  responseCode?: number;
  constructor(message: string, o: { status?: number; body?: string; code?: string; responseCode?: number } = {}) {
    super(message);
    Object.assign(this, o);
  }
}

export type Explained = { problem: string; fix: string };

export type ChannelHealth = {
  /** Last delivery (a notification or a test). */
  ts: number;
  ok: boolean;
  /** Plain-language problem and fix of the last failure (null when it worked). */
  problem: string | null;
  fix: string | null;
  /** Short, scrubbed technical detail: "HTTP 403 Forbidden: bot can't send messages to bots". */
  detail: string | null;
  /** Failures in a row (0 after a success). */
  failures: number;
  lastOkTs: number | null;
};

const KEY = 'notify.health';
let health: Record<string, ChannelHealth> | null = null;

function load(): Record<string, ChannelHealth> {
  if (health) return health;
  try {
    health = JSON.parse(kv.get(KEY) ?? '{}') as Record<string, ChannelHealth>;
  } catch {
    health = {};
  }
  return health;
}

function persist() {
  kv.set(KEY, JSON.stringify(health ?? {}));
}

export function channelHealth(): Record<string, ChannelHealth> {
  return { ...load() };
}

export const isFailing = (h: ChannelHealth | undefined) => !!h && !h.ok && h.failures >= FAILING_AFTER;

/** Forget a channel's results (it was removed, or saved with new delivery settings). */
export function clearHealth(channelId: string) {
  const h = load();
  if (!(channelId in h)) return;
  delete h[channelId];
  persist();
}

/** Record one delivery; returns the channel's health afterwards and whether it just crossed into failing. */
export function recordHealth(ch: Channel, err: unknown | null): { health: ChannelHealth; becameFailing: boolean } {
  const all = load();
  const prev = all[ch.id];
  const now = Date.now();
  let next: ChannelHealth;
  if (!err) next = { ts: now, ok: true, problem: null, fix: null, detail: null, failures: 0, lastOkTs: now };
  else {
    const ex = explain(ch, err);
    next = { ts: now, ok: false, problem: ex.problem, fix: ex.fix, detail: scrub(ch, technical(err)).slice(0, 240), failures: (prev?.ok === false ? prev.failures : 0) + 1, lastOkTs: prev?.lastOkTs ?? null };
  }
  all[ch.id] = next;
  persist();
  return { health: next, becameFailing: !next.ok && next.failures === FAILING_AFTER };
}

// ───────────────────────────── scrubbing ─────────────────────────────

/** Remove the channel's credentials (and the token part of webhook URLs) from a message. */
export function scrub(ch: Channel, s: string): string {
  const secrets = [ch.botToken, ch.secret, ch.smtp?.pass, ch.url && ch.type !== 'ntfy' ? ch.url : null].filter((v): v is string => !!v && v.length >= 4);
  // Webhook URLs: the last path segments are the credential (Slack /services/T/B/xyz, Discord /webhooks/id/token).
  if (ch.url && ch.type !== 'ntfy') {
    try {
      for (const seg of new URL(ch.url).pathname.split('/')) if (seg.length >= 12) secrets.push(seg);
    } catch {}
  }
  if (ch.botToken) secrets.push(`bot${ch.botToken}`);
  let out = s;
  for (const v of secrets.sort((a, b) => b.length - a.length)) out = out.split(v).join('••••');
  // Anything that still looks like a Telegram bot token.
  return out.replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '••••');
}

function technical(err: unknown): string {
  const e = err as SendError;
  if (e?.status) return `HTTP ${e.status}${e.body ? ` ${e.body.replace(/\s+/g, ' ').trim().slice(0, 160)}` : ''}`;
  const code = e?.code ? `${e.code}: ` : '';
  return `${code}${String(e?.message ?? err).replace(/\s+/g, ' ')}`.slice(0, 240);
}

/** The service's own description of the error: Telegram's `description`, Discord's `message`, Slack's plain text. */
function said(body: string | undefined): string {
  if (!body) return '';
  try {
    const j = JSON.parse(body) as { description?: string; message?: string; error?: string };
    return String(j.description ?? j.message ?? j.error ?? body);
  } catch {
    return body;
  }
}

// ───────────────────────────── explanations ─────────────────────────────

const TELEGRAM_CHAT_ID_HOWTO =
  'To find your chat ID: send any message to your bot, then open https://api.telegram.org/bot<your token>/getUpdates in a browser and copy the number at "chat":{"id": …}. For a group, add the bot to the group first; group IDs start with -100.';

/** A failed delivery in plain language, with what to do. Never includes a credential. */
export function explain(ch: Channel, err: unknown): Explained {
  const e = err as SendError;
  const status = e?.status;
  const text = said(e?.body).toLowerCase();
  const code = String(e?.code ?? (e as any)?.cause?.code ?? '');
  const net = networkProblem(ch, e, code);
  if (net) return net;
  switch (ch.type) {
    case 'telegram':
      if (status === 403 && /bots? can'?t send messages to (the )?bots?/.test(text))
        return { problem: 'This chat ID is the bot itself: Telegram bots can’t send messages to bots.', fix: `Message your bot, then use your own chat ID (or a group’s) instead of the bot’s. ${TELEGRAM_CHAT_ID_HOWTO}` };
      if (status === 403 && /blocked by the user/.test(text)) return { problem: 'You blocked the bot in Telegram.', fix: 'Open the chat with the bot in Telegram, unblock it and press Start, then send a test.' };
      if (status === 403 && /not a member|kicked/.test(text)) return { problem: 'The bot isn’t a member of that group or channel (or was removed).', fix: 'Add the bot to the group or channel again (for a channel, as an administrator allowed to post), then send a test.' };
      if (status === 403 && /deactivated/.test(text)) return { problem: 'That Telegram account was deleted.', fix: `Use another chat ID. ${TELEGRAM_CHAT_ID_HOWTO}` };
      if (status === 400 && /chat not found/.test(text))
        return { problem: 'Telegram doesn’t know this chat for the bot: chat not found.', fix: `Start a chat with the bot first (open it in Telegram and press Start), or add it to the group, and check the chat ID. ${TELEGRAM_CHAT_ID_HOWTO}` };
      if (status === 401 || status === 404) return { problem: 'Telegram rejected the bot token.', fix: 'Copy the token again from @BotFather (/mybots → your bot → API Token). If you revoked it there, paste the new one.' };
      if (status === 429) return { problem: 'Telegram is rate limiting the bot.', fix: 'Too many messages in a short time; it recovers by itself. Subscribe this channel to fewer events if it keeps happening.' };
      break;
    case 'discord':
      if (status === 404 || status === 401) return { problem: 'Discord says this webhook doesn’t exist: it was deleted, or the URL is incomplete.', fix: 'In Discord: channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL, and paste the new URL here.' };
      if (status === 403) return { problem: 'Discord refused the webhook.', fix: 'Create a new webhook in the channel settings (Integrations → Webhooks) and paste its URL here.' };
      if (status === 429) return { problem: 'Discord is rate limiting this webhook.', fix: 'It recovers by itself. Subscribe this channel to fewer events if it keeps happening.' };
      break;
    case 'slack':
      if (status === 404 || status === 401 || status === 403 || /no_service|invalid_token|no_team|team_disabled/.test(text))
        return { problem: 'Slack says this webhook no longer exists: it was deleted, revoked or the app was removed.', fix: 'Create a new Incoming Webhook (api.slack.com/apps → your app → Incoming Webhooks → Add New Webhook) and paste its URL here.' };
      if (status === 410 || /channel_is_archived/.test(text)) return { problem: 'The Slack channel of this webhook was archived.', fix: 'Unarchive the channel, or create a webhook for another channel and paste its URL here.' };
      if (status === 429) return { problem: 'Slack is rate limiting this webhook.', fix: 'It recovers by itself. Subscribe this channel to fewer events if it keeps happening.' };
      break;
    case 'ntfy':
      if (status === 401) return { problem: 'The ntfy server rejected the access token.', fix: 'Create a new access token on your ntfy server (Account → Access tokens) and paste it here.' };
      if (status === 403) return { problem: 'The ntfy topic is protected and this channel may not publish to it.', fix: ch.secret ? 'The access token has no write permission for this topic: grant it (ntfy access <user> <topic> rw) or use a token of a user that has.' : 'Add an access token of a user with write access to the topic, or pick a topic that isn’t reserved.' };
      if (status === 429) return { problem: 'The ntfy server is rate limiting this channel.', fix: 'ntfy.sh limits anonymous publishing. Sign in with an access token, self-host ntfy, or subscribe this channel to fewer events.' };
      if (status === 404) return { problem: 'Nothing answers at that ntfy server URL.', fix: 'Check the Server field: just the base URL, e.g. https://ntfy.sh, without the topic.' };
      if (status === 413) return { problem: 'The ntfy server refused the message size.', fix: 'Raise the message size limit on your ntfy server.' };
      break;
    case 'email': {
      const rc = e?.responseCode;
      if (code === 'EAUTH' || rc === 535 || rc === 534 || rc === 530)
        return { problem: 'The SMTP server refused the username or password.', fix: 'Check both. Gmail, Outlook and iCloud need an app password (not your account password) when two-step sign-in is on; some providers want the full email address as the username.' };
      if (code === 'EENVELOPE' || (rc && rc >= 550 && rc <= 554)) return { problem: 'The SMTP server refused the sender or recipient address.', fix: 'Use a From address your provider lets this account send as (often the account’s own address), and check the To address.' };
      if (/wrong version number|ssl3_get_record|tls/i.test(String(e?.message))) return { problem: 'TLS doesn’t match the port.', fix: 'Port 465 needs "TLS from the start" on; ports 587 and 25 need it off (they upgrade with STARTTLS).' };
      break;
    }
    case 'webhook':
      if (status === 401 || status === 403) return { problem: `Your endpoint refused the request (HTTP ${status}).`, fix: 'Check that it accepts Servify’s requests: the signing secret (X-Servify-Signature) and any auth it expects.' };
      if (status === 404) return { problem: 'Nothing answers at that URL (HTTP 404).', fix: 'Check the URL of your endpoint.' };
      break;
  }
  const excerpt = scrub(ch, technical(err)).slice(0, 160);
  return { problem: status ? `The service answered HTTP ${status}.` : `Delivery failed: ${excerpt}`, fix: status ? `It said: ${excerpt.replace(/^HTTP \d+ ?/, '') || '(nothing)'}. Check the channel’s settings, then send a test.` : 'Check the channel’s settings, then send a test.' };
}

function networkProblem(ch: Channel, e: SendError, code: string): Explained | null {
  const host = ch.type === 'email' ? `${ch.smtp?.host}:${ch.smtp?.port}` : ch.type === 'telegram' ? 'api.telegram.org' : (() => {
    try {
      return new URL(ch.type === 'ntfy' ? ch.url || 'https://ntfy.sh' : ch.url ?? '').host;
    } catch {
      return 'the server';
    }
  })();
  const msg = String(e?.message ?? '');
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg))
    return { problem: `Nothing accepted the connection at ${host} (connection refused).`, fix: ch.type === 'email' ? 'Check the SMTP host and port: usually 587 (STARTTLS) or 465 (TLS from the start). Port 25 is often blocked.' : 'Check the URL, and that the server is running and reachable from this machine.' };
  if (code === 'ENOTFOUND' || code === 'EDNS' || code === 'EAI_AGAIN' || /ENOTFOUND|EAI_AGAIN/.test(msg)) return { problem: `${host.replace(/:\d+$/, '')} could not be found (DNS).`, fix: 'Check the host name for typos, and that this machine can resolve names.' };
  if (code === 'ETIMEDOUT' || (code === 'ESOCKET' && /timeout/i.test(msg)) || e?.name === 'TimeoutError' || /timed? ?out/i.test(msg))
    return { problem: `${host} did not answer in time.`, fix: ch.type === 'email' ? 'A firewall or your provider may block outgoing SMTP on this port; try 587 or 465.' : 'Check that this machine can reach it (firewall, proxy, network).' };
  if (code === 'ECONNECTION' || code === 'ECONNRESET') return { problem: `The connection to ${host} broke off.`, fix: ch.type === 'email' ? 'Often a TLS mismatch: port 465 needs "TLS from the start" on, 587 needs it off.' : 'Try again; if it keeps happening, check the URL and the network.' };
  if (!e?.status && /fetch failed/.test(msg)) return { problem: `${host} could not be reached.`, fix: 'Check the URL and that this machine has network access to it.' };
  return null;
}

// ───────────────────────────── validation on save ─────────────────────────────

/**
 * Cheap checks that catch a misconfigured Telegram channel before it fails quietly: the chat ID can't be the bot's own
 * ID (a bot token starts with the bot's ID, and getMe confirms it), and the token must be accepted. Returns the
 * refusal, or null when it looks right or Telegram can't be asked right now (saving then goes ahead).
 */
export async function telegramProblem(botToken: string, chatId: string): Promise<string | null> {
  const chat = chatId.trim();
  const botId = /^(\d+):/.exec(botToken.trim())?.[1];
  const self = `This chat ID is the bot itself (${chat}): Telegram bots can’t send messages to bots. Message your bot, then use your own chat ID instead. ${TELEGRAM_CHAT_ID_HOWTO}`;
  if (botId && botId === chat) return self;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken.trim()}/getMe`, { signal: AbortSignal.timeout(6000) });
    if (res.status === 401 || res.status === 404) return 'Telegram rejected the bot token. Copy it again from @BotFather (/mybots → your bot → API Token).';
    if (!res.ok) return null;
    const me = (await res.json()) as { result?: { id?: number } };
    if (me.result?.id != null && String(me.result.id) === chat) return self;
  } catch {
    // Telegram unreachable: don't block saving.
  }
  return null;
}
