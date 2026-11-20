import { useRef, useEffect, useState } from 'react';
import type { ServiceView, Replica } from '../lib/types.ts';
import { useStore, deploymentsFor, useTraffic } from '../lib/store.ts';
import { Stepper, Segmented, Badge, Tooltip, CopyButton } from '../components/ui.tsx';
import { Icon } from '../components/Icon.tsx';
import { scale } from '../lib/actions.ts';
import { deployTone, num, mem, timeAgo, duration } from '../lib/format.ts';
import { useCountUp } from '../motion/hooks.ts';
import { api } from '../lib/api.ts';
import { toastError } from '../components/ui.tsx';
import type { PanelTab } from './ServicePanel.tsx';
import type { LbStrategy } from '../lib/types.ts';

function Stat({ label, value, format, unit, icon }: { label: string; value: number; format: (n: number) => string; unit?: string; icon: any }) {
  const ref = useRef<HTMLSpanElement>(null);
  useCountUp(ref, value, format);
  return (
    <div className="stat">
      <div className="stat-label">
        <Icon name={icon} size={12} />
        {label}
      </div>
      <div className="stat-value tnum">
        <span ref={ref}>{format(value)}</span>
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
    </div>
  );
}

const stateTone: Record<Replica['state'], any> = { healthy: 'ok', starting: 'warn', unhealthy: 'err', draining: 'idle', exited: 'err' };

function LoadTester({ serviceId }: { serviceId: string }) {
  const [until, setUntil] = useState<number | null>(null);
  const [rps, setRps] = useState(40);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!until) return;
    const i = setInterval(() => {
      if (Date.now() > until) setUntil(null);
      tick((n) => n + 1);
    }, 500);
    return () => clearInterval(i);
  }, [until]);
  const start = async () => {
    try {
      const r = await api.post<{ until: number }>(`/services/${serviceId}/loadtest`, { rps, seconds: 30 });
      setUntil(r.until);
    } catch (e) {
      toastError(e);
    }
  };
  const stop = async () => {
    await api.del(`/services/${serviceId}/loadtest`).catch(() => {});
    setUntil(null);
  };
  const left = until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0;
  return (
    <div className={`loadtest ${until ? 'on' : ''}`}>
      <Icon name="zap" size={14} />
      <div className="grow">
        <div style={{ fontSize: 12, fontWeight: 550 }}>{until ? `Sending ${rps} req/s · ${left}s left` : 'Test traffic'}</div>
        <div className="faint" style={{ fontSize: 11 }}>Watch requests spread across replicas on the canvas.</div>
      </div>
      {!until && (
        <Segmented
          value={String(rps) as '10' | '40' | '150'}
          onChange={(v) => setRps(Number(v))}
          options={[
            { value: '10', label: '10/s' },
            { value: '40', label: '40/s' },
            { value: '150', label: '150/s' },
          ]}
        />
      )}
      <button className={`btn btn-sm ${until ? 'btn-secondary' : 'btn-primary'}`} onClick={until ? stop : start}>
        {until ? 'Stop' : 'Start'}
      </button>
    </div>
  );
}

export function OverviewTab({ service: s, onTab }: { service: ServiceView; onTab: (t: PanelTab) => void }) {
  const current = useStore((st) => st.current);
  const replicas = (current?.replicas[s.id] ?? []).filter((r) => r.deploymentId === s.activeDeploymentId || r.state === 'starting');
  const t = useTraffic(s.id);
  const deps = deploymentsFor(current, s.id).slice(0, 4);
  const [, tick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(i);
  }, []);
  const [stats, setStats] = useState<Record<string, { cpu: number | null; memMb: number | null }>>({});
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get<{ replicas: Replica[] }>(`/services/${s.id}/metrics?seconds=1`)
        .then((m) => alive && setStats(Object.fromEntries(m.replicas.map((r) => [r.containerId, { cpu: r.cpu, memMb: r.memMb }]))))
        .catch(() => {});
    void load();
    const i = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, [s.id]);
  const cpu = replicas.reduce((a, r) => a + (stats[r.containerId]?.cpu ?? 0), 0);
  const memMb = replicas.reduce((a, r) => a + (stats[r.containerId]?.memMb ?? 0), 0);
  const stateful = s.volumes.length > 0;
  const maxRps = Math.max(0.001, ...replicas.map((r) => t?.replicas[r.containerId] ?? 0));

  const setStrategy = async (strategy: LbStrategy) => {
    try {
      await api.patch(`/services/${s.id}`, { strategy });
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className="tab-pad col" style={{ gap: 18 }}>
      <div className="stats">
        <Stat label="Requests" value={t?.rps ?? 0} format={(n) => num(n)} unit="/s" icon="zap" />
        <Stat label="p95" value={t?.p95 ?? 0} format={(n) => (n < 10 ? n.toFixed(1) : n.toFixed(0))} unit="ms" icon="clock" />
        <Stat label="CPU" value={cpu} format={(n) => n.toFixed(n < 10 ? 1 : 0)} unit="%" icon="cpu" />
        <Stat label="Memory" value={memMb} format={(n) => mem(n).split(' ')[0]} unit={memMb >= 1024 ? 'GB' : 'MB'} icon="memory" />
      </div>

      <section className="card scale-card">
        <div className="scale-head">
          <div className="grow">
            <div className="h3">Replicas</div>
            <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
              {stateful
                ? 'Stateful service with a volume — runs as a single replica to keep data safe.'
                : s.protocol === 'none'
                  ? 'Workers run in parallel; no load balancer needed.'
                  : s.replicas > 1
                    ? `Load balanced across ${s.replicas} replicas · health-checked every ${s.healthcheck.intervalSec}s`
                    : 'Add replicas to load-balance traffic and survive crashes.'}
            </div>
          </div>
          <Stepper value={s.replicas} min={0} max={stateful ? 1 : 32} onChange={(v) => void scale(s, v)} disabled={stateful && s.replicas >= 1 && false} />
        </div>
        {s.protocol === 'http' && s.activeDeploymentId && !s.stopped && <LoadTester serviceId={s.id} />}
        {s.protocol !== 'none' && !stateful && (
          <div className="row" style={{ gap: 10 }}>
            <span className="label">Strategy</span>
            <Segmented<LbStrategy>
              value={s.strategy}
              onChange={(v) => void setStrategy(v)}
              options={[
                { value: 'round-robin', label: 'Round robin' },
                { value: 'least-conn', label: 'Least conn' },
                { value: 'ip-hash', label: 'IP hash' },
                { value: 'random', label: 'Random' },
              ]}
            />
          </div>
        )}
        <div className="replica-list">
          {replicas.length === 0 && <div className="faint" style={{ fontSize: 12, padding: '6px 2px' }}>{s.stopped ? 'Service is stopped.' : 'No replicas running yet.'}</div>}
          {replicas.map((r) => {
            const rps = t?.replicas[r.containerId] ?? 0;
            const st = stats[r.containerId];
            return (
              <div key={r.containerId} className="replica-row" data-state={r.state}>
                <span className="replica-idx mono">#{r.index}</span>
                <Badge tone={stateTone[r.state]} live={r.state === 'starting'}>
                  {r.state}
                </Badge>
                <div className="replica-bar" title={`${num(rps)} req/s`}>
                  <span style={{ transform: `scaleX(${rps / maxRps || 0})` }} />
                </div>
                <span className="mono replica-num">{num(rps)} r/s</span>
                <span className="mono replica-num faint">{st?.cpu != null ? `${st.cpu.toFixed(1)}%` : '—'}</span>
                <span className="mono replica-num faint">{mem(st?.memMb)}</span>
                <Tooltip label={`${r.name}${r.port ? ` → 127.0.0.1:${r.port}` : ''}${r.restarts ? ` · ${r.restarts} restarts` : ''}`}>
                  <span className="replica-uptime faint mono">{r.startedAt ? timeAgo(r.startedAt).replace(' ago', '') : '—'}</span>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </section>

      {(s.url || s.tcpAddress || s.protocol !== 'none') && (
        <section className="card net-card">
          <div className="h3" style={{ marginBottom: 10 }}>
            Networking
          </div>
          {s.url && (
            <div className="net-row">
              <Icon name="globe" size={14} />
              <span className="label" style={{ width: 64 }}>
                Public
              </span>
              <a className="mono grow truncate net-link" href={s.url} target="_blank" rel="noreferrer">
                {s.url}
              </a>
              <CopyButton text={s.url} />
            </div>
          )}
          {s.domains.map((d) => (
            <div className="net-row" key={d}>
              <Icon name="link" size={14} />
              <span className="label" style={{ width: 64 }}>
                Domain
              </span>
              <span className="mono grow truncate">{d}</span>
              <CopyButton text={d} />
            </div>
          ))}
          {s.tcpAddress && (
            <div className="net-row">
              <Icon name="network" size={14} />
              <span className="label" style={{ width: 64 }}>
                TCP
              </span>
              <span className="mono grow truncate">{s.tcpAddress}</span>
              <CopyButton text={s.tcpAddress} />
            </div>
          )}
          <div className="net-row">
            <Icon name="shield" size={14} />
            <span className="label" style={{ width: 64 }}>
              Private
            </span>
            <span className="mono grow truncate">
              {s.slug}
              {(s.port ?? s.detectedPort) ? `:${s.port ?? s.detectedPort}` : ''}
            </span>
            <CopyButton text={`${s.slug}${(s.port ?? s.detectedPort) ? `:${s.port ?? s.detectedPort}` : ''}`} />
          </div>
        </section>
      )}

      <section>
        <div className="row" style={{ marginBottom: 8 }}>
          <div className="h3 grow">Recent deployments</div>
          <button className="btn btn-ghost btn-sm" onClick={() => onTab('deployments')}>
            View all <Icon name="arrowRight" size={13} />
          </button>
        </div>
        <div className="mini-deploys">
          {deps.length === 0 && <div className="faint" style={{ fontSize: 12 }}>No deployments yet.</div>}
          {deps.map((d) => (
            <button key={d.id} className="mini-deploy" onClick={() => onTab('deployments')}>
              <Badge tone={deployTone[d.status]} live={d.status === 'building' || d.status === 'deploying'}>
                {d.status}
              </Badge>
              <span className="grow truncate mono" style={{ fontSize: 12 }}>
                {d.commitMessage ?? d.sourceLabel}
              </span>
              <span className="faint" style={{ fontSize: 12 }}>
                {d.actor !== 'you' && (
                  <span className="actor-pill">
                    <Icon name={d.trigger === 'agent' ? 'bot' : d.trigger === 'git' ? 'git' : 'user'} size={11} />
                    {d.actor}
                  </span>
                )}{' '}
                {timeAgo(d.createdAt)}
                {d.finishedAt && d.startedAt ? ` · ${duration(d.finishedAt - d.startedAt)}` : ''}
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
