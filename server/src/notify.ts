/**
 * Outbound notifications: Slack, Discord, Telegram, ntfy, email (SMTP) and signed generic webhooks.
 * Fire-and-forget; every delivery is recorded so the settings page can show what happened.
 */
import { createHmac } from 'node:crypto';
import nodemailer from 'nodemailer';
import { getSettings, type Channel, type NotifyEvent } from './settings.ts';
import { projects as projectsTable, services as servicesTable } from './db.ts';
import { config } from './config.ts';
import { HttpError } from './util.ts';
import { recordHealth, channelHealth, isFailing, SendError, scrub } from './notifyhealth.ts';

export type Notice = {
  event: NotifyEvent;
  title: string;
  message: string;
  level: 'info' | 'success' | 'error';
  projectId?: string | null;
  serviceId?: string | null;
  deploymentId?: string | null;
  /** Extra links (preview URLs …). */
  links?: { label: string; url: string }[];
  /** Collapse repeats of the same key within this window (crash storms, flapping). */
  dedupeKey?: string;
  dedupeMs?: number;
};

export type Delivery = { ts: number; channelId: string; event: string; ok: boolean; error?: string; problem?: string; fix?: string };
const deliveries: Delivery[] = [];
const recent = new Map<string, number>();

export function recentDeliveries(channelId?: string): Delivery[] {
  return deliveries.filter((d) => !channelId || d.channelId === channelId).slice(-30).reverse();
}

export function dashboardBase(): string {
  return getSettings().dashboardUrl ?? `http://localhost:${config.port}`;
}

function linkFor(n: Notice): string {
  const base = dashboardBase();
  const p = n.projectId ? projectsTable.get(n.projectId) : null;
  if (!p) return base;
  const s = n.serviceId ? servicesTable.get(n.serviceId) : null;
  return `${base}/p/${encodeURIComponent(p.slug)}${s ? `/${s.id}${n.event.startsWith('deploy') ? '/deployments' : ''}` : ''}`;
}

const COLORS = { info: 0x93a8ff, success: 0x5fe3a1, error: 0xff6b5b };
const EMOJI = { info: 'ℹ️', success: '✅', error: '🔴' };

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': `servify/${config.version}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 600);
    throw new SendError(`HTTP ${res.status} ${body.slice(0, 160)}`, { status: res.status, body });
  }
}

async function send(ch: Channel, n: Notice) {
  const link = linkFor(n);
  const links = n.links ?? [];
  switch (ch.type) {
    case 'webhook': {
      const body = JSON.stringify({
        event: n.event,
        level: n.level,
        title: n.title,
        message: n.message,
        projectId: n.projectId ?? null,
        serviceId: n.serviceId ?? null,
        deploymentId: n.deploymentId ?? null,
        url: link,
        links,
        ts: Date.now(),
      });
      const headers: Record<string, string> = { 'x-servify-event': n.event };
      if (ch.secret) headers['x-servify-signature'] = `sha256=${createHmac('sha256', ch.secret).update(body).digest('hex')}`;
      return post(ch.url!, body, headers);
    }
    case 'slack': {
      const extra = links.map((l) => `<${l.url}|${l.label}>`).join(' · ');
      return post(ch.url!, {
        text: `${EMOJI[n.level]} ${n.title}`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*${n.title}*\n${n.message}${extra ? `\n${extra}` : ''}` } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: `<${link}|Open in Servify>` }] },
        ],
      });
    }
    case 'discord':
      return post(ch.url!, {
        username: 'Servify',
        embeds: [
          {
            title: n.title.slice(0, 250),
            description: (n.message + (links.length ? `\n${links.map((l) => `[${l.label}](${l.url})`).join(' · ')}` : '')).slice(0, 3900),
            url: link,
            color: COLORS[n.level],
            timestamp: new Date().toISOString(),
            footer: { text: n.event },
          },
        ],
      });
    case 'telegram':
      return post(`https://api.telegram.org/bot${ch.botToken}/sendMessage`, {
        chat_id: ch.chatId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        text: `${EMOJI[n.level]} <b>${escapeHtml(n.title)}</b>\n${escapeHtml(n.message)}\n${[...links, { label: 'Open in Servify', url: link }]
          .map((l) => `<a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a>`)
          .join(' · ')}`,
      });
    case 'ntfy': {
      const server = (ch.url || 'https://ntfy.sh').replace(/\/+$/, '');
      const headers: Record<string, string> = {
        title: n.title.replace(/[^\x20-\x7e]/g, ''),
        tags: n.level === 'error' ? 'rotating_light' : n.level === 'success' ? 'white_check_mark' : 'information_source',
        priority: n.level === 'error' ? '4' : '3',
        click: link,
        'content-type': 'text/plain',
      };
      if (ch.secret) headers.authorization = `Bearer ${ch.secret}`;
      return post(`${server}/${encodeURIComponent(ch.topic!)}`, n.message, headers);
    }
    case 'email': {
      const s = ch.smtp!;
      const transport = nodemailer.createTransport({
        host: s.host,
        port: s.port,
        secure: s.secure,
        auth: s.user ? { user: s.user, pass: s.pass ?? '' } : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
      });
      const linkList = [...links, { label: 'Open in Servify', url: link }];
      try {
        await transport.sendMail({
        from: s.from,
        to: s.to,
        subject: `[Servify] ${n.title}`,
        text: `${n.message}\n\n${linkList.map((l) => `${l.label}: ${l.url}`).join('\n')}\n`,
        html: `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#1a1b16"><h2 style="font-size:16px;margin:0 0 8px">${escapeHtml(n.title)}</h2><p style="white-space:pre-wrap;margin:0 0 14px">${escapeHtml(n.message)}</p><p>${linkList
          .map((l) => `<a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a>`)
          .join(' · ')}</p></div>`,
        });
      } finally {
        transport.close();
      }
      return;
    }
  }
}

async function deliver(ch: Channel, n: Notice | (Omit<Notice, 'event'> & { event: 'notify.failing' })) {
  const rec: Delivery = { ts: Date.now(), channelId: ch.id, event: n.event, ok: true };
  let err: unknown = null;
  try {
    await send(ch, n as Notice);
  } catch (e) {
    err = e;
  }
  const { health, becameFailing } = recordHealth(ch, err);
  if (err) {
    rec.ok = false;
    rec.error = health.detail ?? scrub(ch, String((err as Error).message)).slice(0, 240);
    rec.problem = health.problem ?? undefined;
    rec.fix = health.fix ?? undefined;
    console.error(`[notify] ${ch.name} (${ch.type}): ${health.problem} — ${rec.error}`);
  }
  deliveries.push(rec);
  if (deliveries.length > 300) deliveries.splice(0, deliveries.length - 300);
  if (becameFailing) warnOthers(ch, health.problem ?? 'deliveries keep failing');
  return rec;
}

/**
 * A channel just failed several times in a row: it can't report that itself, so tell the other enabled channels that
 * still work (whatever events they follow), once per streak.
 */
function warnOthers(failed: Channel, problem: string) {
  const health = channelHealth();
  const others = getSettings().notifications.channels.filter((c) => c.id !== failed.id && c.enabled && !isFailing(health[c.id]));
  for (const ch of others) {
    void deliver(ch, {
      event: 'notify.failing',
      level: 'error',
      title: `Notification channel ${failed.name} is failing`,
      message: `Servify couldn't deliver to ${failed.name} (${failed.type}) several times in a row: ${problem} Open Settings → Notifications to fix it.`,
      links: [{ label: 'Notification settings', url: `${dashboardBase()}/settings/notifications` }],
    });
  }
}

/** Send a notice to every enabled channel subscribed to its event. Never throws. */
export function notify(n: Notice) {
  try {
    if (n.dedupeKey) {
      const last = recent.get(n.dedupeKey) ?? 0;
      if (Date.now() - last < (n.dedupeMs ?? 10 * 60_000)) return;
      recent.set(n.dedupeKey, Date.now());
    }
    for (const ch of getSettings().notifications.channels) {
      if (ch.enabled && ch.events.includes(n.event)) void deliver(ch, n);
    }
  } catch (e) {
    console.error('[notify]', (e as Error).message);
  }
}

export async function testChannel(channelId: string): Promise<Delivery> {
  const ch = getSettings().notifications.channels.find((c) => c.id === channelId);
  if (!ch) throw new HttpError(404, 'channel not found');
  return deliver(ch, {
    event: 'deploy.succeeded',
    level: 'success',
    title: 'Servify test notification',
    message: `If you can read this, "${ch.name}" is set up correctly.`,
  });
}
