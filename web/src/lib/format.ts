import type { ServiceStatus, DeploymentStatus } from './types.ts';

export function timeAgo(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function duration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return '—';
  const s = ms / 1000;
  if (s < 1) return `${Math.round(ms)}ms`;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export function clock(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function num(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return n.toFixed(0);
  if (n === 0) return '0';
  return n.toFixed(digits);
}

export function mem(mb: number | null | undefined): string {
  if (mb == null) return '—';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

export type Tone = 'ok' | 'warn' | 'err' | 'build' | 'idle' | 'signal';

export const serviceTone: Record<ServiceStatus, Tone> = {
  idle: 'idle',
  building: 'build',
  deploying: 'warn',
  running: 'ok',
  degraded: 'warn',
  crashed: 'err',
  stopped: 'idle',
  sleeping: 'idle',
  failed: 'err',
};

export const deployTone: Record<DeploymentStatus, Tone> = {
  queued: 'idle',
  building: 'build',
  deploying: 'warn',
  active: 'ok',
  failed: 'err',
  superseded: 'idle',
  cancelled: 'idle',
  removed: 'idle',
};

export const serviceLabel: Record<ServiceStatus, string> = {
  idle: 'Not deployed',
  building: 'Building',
  deploying: 'Deploying',
  running: 'Online',
  degraded: 'Degraded',
  crashed: 'Crashed',
  stopped: 'Stopped',
  sleeping: 'Asleep',
  failed: 'Failed',
};

export function isBusy(status: ServiceStatus | DeploymentStatus) {
  return status === 'building' || status === 'deploying' || status === 'queued';
}

export function copy(text: string) {
  return navigator.clipboard?.writeText(text);
}

/** Plain-English summary of common cron expressions. */
export function describeCron(expr: string): string {
  const e = expr.trim();
  const macros: Record<string, string> = { '@hourly': 'Every hour', '@daily': 'Every day at midnight', '@midnight': 'Every day at midnight', '@weekly': 'Every Sunday at midnight', '@monthly': 'On the 1st of every month', '@yearly': 'Once a year', '@annually': 'Once a year' };
  if (macros[e]) return macros[e];
  const p = e.split(/\s+/);
  if (p.length !== 5) return e;
  const [mi, h, dom, mon, dow] = p;
  const pad = (n: string) => n.padStart(2, '0');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (mi === '*' && h === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every minute';
  let m = mi.match(/^\*\/(\d+)$/);
  if (m && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${m[1]} minutes`;
  m = h.match(/^\*\/(\d+)$/);
  if (m && /^\d+$/.test(mi) && dom === '*' && mon === '*' && dow === '*') return `Every ${m[1]} hours at :${pad(mi)}`;
  if (/^\d+$/.test(mi) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every hour at :${pad(mi)}`;
  if (/^\d+$/.test(mi) && /^\d+$/.test(h) && mon === '*') {
    const t = `${pad(h)}:${pad(mi)}`;
    if (dom === '*' && dow === '*') return `Every day at ${t}`;
    if (dom === '*' && dow === '1-5') return `Weekdays at ${t}`;
    if (dom === '*' && /^\d$/.test(dow)) return `Every ${days[Number(dow) % 7]} at ${t}`;
    if (/^\d+$/.test(dom) && dow === '*') return `Monthly on day ${dom} at ${t}`;
  }
  return e;
}
