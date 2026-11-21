import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { mem } from '../lib/format.ts';
import { Icon } from './Icon.tsx';
import type { Overview, SystemInfo } from '../lib/types.ts';

const GB = 1024 ** 3;
const gb = (bytes: number) => (bytes >= 100 * GB ? Math.round(bytes / GB) : Math.round((bytes / GB) * 10) / 10);

function uptime(sec: number): string {
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))}m`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86_400)}d`;
}

function Meter({ label, pct, value, hint }: { label: string; pct: number | null; value: string; hint?: string }) {
  const p = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const tone = pct == null ? 'idle' : p >= 90 ? 'err' : p >= 75 ? 'warn' : 'ok';
  return (
    <div className="ov-meter" title={hint}>
      <span className="ov-meter-label">{label}</span>
      <span className="ov-bar" data-tone={tone}>
        <i style={{ width: `${p}%` }} />
      </span>
      <span className="ov-meter-value mono">{value}</span>
    </div>
  );
}

/** Live usage of every server and of Servify itself, refreshed every 10 s while the page is visible. */
export function OverviewPanel({ system }: { system: SystemInfo | null }) {
  const [data, setData] = useState<Overview | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.hidden) return;
      api.get<Overview>('/overview').then((d) => alive && setData(d)).catch(() => {});
    };
    load();
    const t = setInterval(load, 10_000);
    document.addEventListener('visibilitychange', load);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', load);
    };
  }, []);

  if (!data) return <div className="overview overview-loading rise-in" style={{ animationDelay: '60ms' }} />;
  const s = data.servify;
  return (
    <div className="overview rise-in" style={{ animationDelay: '60ms' }}>
      {data.servers.map((srv) => {
        const st = srv.stats;
        const memUsed = st ? st.memTotal - st.memAvailable : 0;
        const diskUsed = st?.diskTotal != null && st.diskFree != null ? st.diskTotal - st.diskFree : null;
        return (
          <div className="ov-card" key={srv.id}>
            <div className="ov-head">
              <span className={`sys-dot ${srv.status === 'online' ? 'ok' : 'err'}`} />
              <span className="ov-name truncate">{srv.local ? (srv.info?.hostname ?? 'This machine') : srv.name}</span>
              {srv.local && <span className="ov-tag">this machine</span>}
              <span className="spacer" />
              {st && <span className="faint mono ov-up" title="Uptime">up {uptime(st.uptimeSec)}</span>}
            </div>
            <div className="ov-sub faint truncate">
              {[srv.os, srv.dockerVersion && `Docker ${srv.dockerVersion}`, srv.info?.cpus && `${srv.info.cpus} CPU`].filter(Boolean).join(' · ') || '—'}
            </div>
            {st ? (
              <div className="ov-meters">
                <Meter label="CPU" pct={st.cpuPct} value={st.cpuPct == null ? '…' : `${st.cpuPct}%`} hint={`Load ${st.load.join(' / ')}`} />
                <Meter label="Memory" pct={st.memTotal ? (memUsed / st.memTotal) * 100 : null} value={`${gb(memUsed)} / ${gb(st.memTotal)} GB`} />
                {diskUsed != null && st.diskTotal ? <Meter label="Disk" pct={(diskUsed / st.diskTotal) * 100} value={`${gb(diskUsed)} / ${gb(st.diskTotal)} GB`} /> : null}
              </div>
            ) : (
              <div className="ov-note faint">
                {srv.status !== 'online' ? 'Offline — no live figures.' : 'No live figures yet: this agent is older than 0.2. To update it: Servers → ⋯ → New token & join command, then on that server run docker rm -f servify-agent and the new command.'}
              </div>
            )}
            <div className="ov-foot faint">
              {srv.containers && (
                <span>
                  {srv.containers.running}/{srv.containers.total} containers
                </span>
              )}
              <span>
                {srv.services} service{srv.services === 1 ? '' : 's'}
                {srv.services > 0 && ` · ${srv.managed.cpuPct}% CPU · ${mem(srv.managed.memMb)}`}
              </span>
              {st && <span title="Load average (1 / 5 / 15 min)">load {st.load[0]}</span>}
            </div>
          </div>
        );
      })}
      <div className="ov-card ov-servify">
        <div className="ov-head">
          <Icon name="layers" size={14} />
          <span className="ov-name">Servify</span>
          <span className="ov-tag mono">{s.version}</span>
          <span className="spacer" />
          <span className="faint mono ov-up" title="Running since the last restart">up {uptime(s.uptimeSec)}</span>
        </div>
        <div className="ov-stats">
          <div>
            <span className="ov-num mono">{s.rps}</span>
            <span className="faint">req/s{s.errorsPerSec > 0 ? ` · ${s.errorsPerSec} errors/s` : ''}</span>
          </div>
          <div>
            <span className="ov-num mono">{s.replicas}</span>
            <span className="faint">
              container{s.replicas === 1 ? '' : 's'} · {s.services} service{s.services === 1 ? '' : 's'} · {s.projects} project{s.projects === 1 ? '' : 's'}
            </span>
          </div>
          <div>
            <span className="ov-num mono">{s.cpuPct}%</span>
            <span className="faint">CPU · {mem(s.rssBytes / 1024 / 1024)} memory</span>
          </div>
        </div>
        <div className="ov-foot faint">
          <span data-tone={s.certificates.expiringSoon ? 'warn' : undefined} className={s.certificates.expiringSoon ? 'ov-warn' : undefined}>
            {s.certificates.total} certificate{s.certificates.total === 1 ? '' : 's'}{s.certificates.expiringSoon ? ` · ${s.certificates.expiringSoon} expiring soon` : ''}
          </span>
          <span className={s.backups24h.failed ? 'ov-warn' : undefined}>
            backups 24h: {s.backups24h.succeeded} ok{s.backups24h.failed ? ` · ${s.backups24h.failed} failed` : ''}
          </span>
          {system && (
            <span>
              <Icon name="lock" size={11} /> {system.api.host}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
