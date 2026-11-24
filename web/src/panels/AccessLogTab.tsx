import { useEffect, useState } from 'react';
import type { ServiceView } from '../lib/types.ts';
import { api } from '../lib/api.ts';
import { Switch, Segmented, Button, toastError, Tooltip } from '../components/ui.tsx';
import { Icon } from '../components/Icon.tsx';
import { num } from '../lib/format.ts';

type Entry = { id: number; ts: number; host: string; method: string; path: string; status: number; bytes: number; ms: number; referrer: string; userAgent: string; visitor: string; bot: boolean; replica: number | null };
type Summary = {
  day: string;
  requests: { total: number; humans: number; bots: number };
  uniqueVisitors: { humans: number; bots: number };
  statuses: Record<string, number>;
  topPaths: { path: string; requests: number; visitors: number }[];
  topReferrers: { host: string; requests: number; visitors: number }[];
  topUtm: { source: string; requests: number; visitors: number }[];
  topUserAgents: { userAgent: string; requests: number; visitors: number }[];
  topBots: { name: string; requests: number }[];
};

const today = () => new Date().toISOString().slice(0, 10);
const refHost = (r: string) => r.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i)?.[1] ?? '';
const shortUa = (ua: string) => {
  if (!ua) return '—';
  const m = ua.match(/(Edg|OPR|Firefox|Chrome|Safari|GPTBot|ClaudeBot|PerplexityBot|Googlebot|bingbot|curl|Wget)\/[\d.]+/i);
  const os = ua.match(/\((?:[^;)]*;\s*)?(Windows|Mac OS X|Android|iPhone|iPad|Linux)/i)?.[1];
  return m ? `${m[0].split('/')[0]}${os ? ` · ${os.replace('Mac OS X', 'macOS')}` : ''}` : ua.slice(0, 40);
};
const statusTone = (s: number) => (s >= 500 ? 'err' : s >= 400 ? 'warn' : s >= 300 ? 'idle' : 'ok');

function TopList({ title, unit, rows, empty }: { title: string; unit: string; rows: { label: string; value: number; sub?: number }[]; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <section className="card al-top">
      <div className="al-top-head">
        <span className="h3">{title}</span>
        <span className="faint mono al-unit">{unit}</span>
      </div>
      {rows.length ? (
        rows.slice(0, 8).map((r) => (
          <div className="al-top-row" key={r.label} title={r.label}>
            <span className="al-bar" style={{ width: `${(r.value / max) * 100}%` }} />
            <span className="truncate mono">{r.label}</span>
            <span className="tnum faint">{r.sub !== undefined ? `${num(r.sub, 0)} · ` : ''}{num(r.value, 0)}</span>
          </div>
        ))
      ) : (
        <div className="faint al-none">{empty}</div>
      )}
    </section>
  );
}

export function AccessLogTab({ service: s }: { service: ServiceView }) {
  const on = s.accessLog !== false;
  const [day, setDay] = useState(today());
  const [summary, setSummary] = useState<Summary | null>(null);
  const [who, setWho] = useState<'all' | 'people' | 'bots'>('all');
  const [q, setQ] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .get<Summary>(`/services/${s.id}/access-log/summary?day=${day}`)
      .then((r) => alive && setSummary(r))
      .catch((e) => alive && toastError(e, 'Could not load the access log'));
    return () => {
      alive = false;
    };
  }, [s.id, day, tick]);

  const query = (before?: string) => {
    const p = new URLSearchParams({ limit: '100' });
    if (who !== 'all') p.set('bot', who === 'bots' ? 'true' : 'false');
    if (q.trim()) p.set('q', q.trim());
    if (before) p.set('before', before);
    return api.get<{ entries: Entry[]; next: string | null }>(`/services/${s.id}/access-log?${p}`);
  };

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      query()
        .then((r) => {
          if (!alive) return;
          setEntries(r.entries);
          setNext(r.next);
        })
        .catch(() => {});
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [s.id, who, q, tick]);

  const more = async () => {
    if (!next) return;
    setLoading(true);
    try {
      const r = await query(next);
      setEntries((prev) => [...prev, ...r.entries]);
      setNext(r.next);
    } catch (e) {
      toastError(e, 'Could not load more');
    } finally {
      setLoading(false);
    }
  };

  const toggle = async (v: boolean) => {
    try {
      await api.patch(`/services/${s.id}`, { accessLog: v });
    } catch (e) {
      toastError(e, 'Could not save');
    }
  };

  const errors = (summary?.statuses['4xx'] ?? 0) + (summary?.statuses['5xx'] ?? 0);

  return (
    <div className="tab-pad col" style={{ gap: 16 }}>
      <div className="row al-head">
        <div className="grow col" style={{ gap: 2 }}>
          <div className="row" style={{ gap: 8 }}>
            <Switch checked={on} onChange={(v) => void toggle(v)} label="Record requests" />
            <span style={{ fontSize: 13 }}>Record requests</span>
          </div>
          <span className="faint" style={{ fontSize: 12 }}>
            No IP addresses are kept: visitors are a key hashed with a salt that changes every UTC day. 7 days of history.
          </span>
        </div>
        <input className="input al-day mono" type="date" value={day} max={today()} onChange={(e) => e.target.value && setDay(e.target.value)} aria-label="Day (UTC)" />
        <Tooltip label="Refresh">
          <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setTick((t) => t + 1)} aria-label="Refresh">
            <Icon name="refresh" size={14} />
          </button>
        </Tooltip>
      </div>

      <div className="stats al-stats">
        <div className="stat">
          <div className="stat-label">Visitors</div>
          <div className="stat-value tnum">{num(summary?.uniqueVisitors.humans ?? 0, 0)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Requests</div>
          <div className="stat-value tnum">{num(summary?.requests.humans ?? 0, 0)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Bots</div>
          <div className="stat-value tnum">
            {num(summary?.requests.bots ?? 0, 0)}
            <span className="stat-unit">req</span>
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Errors</div>
          <div className="stat-value tnum">{num(errors, 0)}</div>
        </div>
      </div>

      <div className="al-grid">
        <TopList title="Pages" unit="visitors · requests" empty="No visits yet" rows={(summary?.topPaths ?? []).map((r) => ({ label: r.path, value: r.requests, sub: r.visitors }))} />
        <TopList title="Referrers" unit="visitors" empty="No other sites linked here" rows={(summary?.topReferrers ?? []).map((r) => ({ label: r.host, value: r.visitors }))} />
        <TopList title="Campaigns (UTM)" unit="visitors" empty="No utm_source links" rows={(summary?.topUtm ?? []).map((r) => ({ label: r.source, value: r.visitors }))} />
        <TopList title="Bots & crawlers" unit="requests" empty="No bots" rows={(summary?.topBots ?? []).map((r) => ({ label: r.name, value: r.requests }))} />
      </div>

      <section className="card al-list">
        <div className="row al-list-head">
          <span className="h3 grow">Requests</span>
          <div className="logs-search">
            <Icon name="search" size={14} />
            <input placeholder="Path, referrer, agent…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Segmented
            size="sm"
            value={who}
            onChange={setWho}
            options={[
              { value: 'all', label: 'All' },
              { value: 'people', label: 'People' },
              { value: 'bots', label: 'Bots' },
            ]}
          />
        </div>
        {entries.length ? (
          <div className="al-rows">
            {entries.map((e) => (
              <div className="al-row" key={e.id} title={`${e.userAgent}${e.referrer ? `\nfrom ${e.referrer}` : ''}`}>
                <span className="mono faint tnum">{new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                <span className={`mono tnum al-status ${statusTone(e.status)}`}>{e.status}</span>
                <span className="mono truncate al-path">
                  <span className="faint">{e.method !== 'GET' ? `${e.method} ` : ''}</span>
                  {e.path}
                </span>
                <span className="truncate faint al-ref">{refHost(e.referrer)}</span>
                <span className="truncate faint al-ua">
                  {e.bot && <Icon name="zap" size={11} />} {shortUa(e.userAgent)}
                </span>
                <span className="mono faint tnum al-ms">{e.ms < 10 ? e.ms.toFixed(1) : Math.round(e.ms)} ms</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="faint al-none">{on ? 'No requests recorded yet.' : 'Recording is off for this service.'}</div>
        )}
        {next && (
          <div className="row" style={{ justifyContent: 'center', padding: 8 }}>
            <Button size="sm" variant="ghost" onClick={() => void more()} loading={loading}>
              Load older
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
