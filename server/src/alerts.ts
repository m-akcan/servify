/**
 * Usage alerts: a minute-by-minute look at every server's disk, memory and CPU. Notifies once when a figure
 * stays over its threshold (disk at once, memory for 5 checks, CPU for 10) and once when it is back to normal,
 * with a margin so a value hovering at the line doesn't flap. While the low-disk guard (diskguard.ts) has a server's
 * disk in warn or protect mode, it notifies for that disk and the disk rule here stays quiet.
 */
import { listServers } from './nodes.ts';
import { getSettings } from './settings.ts';
import { notify } from './notify.ts';
import { diskAlertSuppressed } from './diskguard.ts';
import type { HostStats } from './types.ts';

type Metric = 'disk' | 'memory' | 'cpu';
const RULES: Record<Metric, { minutes: number; margin: number; label: string }> = {
  disk: { minutes: 1, margin: 3, label: 'disk' },
  memory: { minutes: 5, margin: 5, label: 'memory' },
  cpu: { minutes: 10, margin: 10, label: 'CPU' },
};
const state = new Map<string, { over: number; alerted: boolean }>();
const GB = 1024 ** 3;
const gb = (b: number) => (b >= 100 * GB ? Math.round(b / GB) : Math.round((b / GB) * 10) / 10);

function figures(st: HostStats): Partial<Record<Metric, { pct: number; detail: string }>> {
  const out: Partial<Record<Metric, { pct: number; detail: string }>> = {};
  if (st.diskTotal && st.diskFree != null) {
    const used = st.diskTotal - st.diskFree;
    out.disk = { pct: (used / st.diskTotal) * 100, detail: `${gb(used)} of ${gb(st.diskTotal)} GB used` };
  }
  if (st.memTotal) {
    const used = st.memTotal - st.memAvailable;
    out.memory = { pct: (used / st.memTotal) * 100, detail: `${gb(used)} of ${gb(st.memTotal)} GB in use` };
  }
  if (st.cpuPct != null) out.cpu = { pct: st.cpuPct, detail: `load ${st.load.join(' / ')}` };
  return out;
}

export function checkUsage() {
  const cfg = getSettings().alerts;
  if (!cfg.enabled) return;
  const limits: Record<Metric, number> = { disk: cfg.diskPct, memory: cfg.memPct, cpu: cfg.cpuPct };
  for (const srv of listServers()) {
    if (srv.status !== 'online' || !srv.stats) continue;
    const name = srv.local ? (srv.info?.hostname || 'This machine') : srv.name;
    for (const [metric, f] of Object.entries(figures(srv.stats)) as [Metric, { pct: number; detail: string }][]) {
      // The low-disk guard is already speaking for this server's disk (warn/protect, and their all-clear): one voice.
      if (metric === 'disk' && diskAlertSuppressed(srv.id)) continue;
      const key = `${srv.id}:${metric}`;
      const s = state.get(key) ?? { over: 0, alerted: false };
      const limit = limits[metric];
      const rule = RULES[metric];
      if (f.pct >= limit) {
        s.over++;
        if (!s.alerted && s.over >= rule.minutes) {
          s.alerted = true;
          notify({ event: 'server.usage', level: 'error', title: `${name}: ${rule.label} at ${Math.round(f.pct)}%`, message: `${f.detail} — over the ${limit}% alert${rule.minutes > 1 ? ` for ${rule.minutes} minutes` : ''}.` });
        }
      } else {
        s.over = 0;
        if (s.alerted && f.pct < limit - rule.margin) {
          s.alerted = false;
          notify({ event: 'server.usage', level: 'success', title: `${name}: ${rule.label} back to ${Math.round(f.pct)}%`, message: `${f.detail}.` });
        }
      }
      state.set(key, s);
    }
  }
}

export function startUsageAlerts() {
  setInterval(() => {
    try {
      checkUsage();
    } catch (e) {
      console.error('[alerts]', e);
    }
  }, Number(process.env.SERVIFY_ALERTS_INTERVAL_MS) || 60_000).unref();
}
