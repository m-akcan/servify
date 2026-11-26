import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession, useNav, useServerEvents, useDebounced } from '../session.tsx';
import { Icon, StatusPill, TopBar, Spinner, ServiceGlyph, Sparkline, confirmSheet, toast, toastError, useTick, Live } from '../ui/kit.tsx';
import { PullScroll } from '../ui/pull.tsx';
import { openStream } from '../lib/stream.ts';
import { sourceLine, publicUrls, hostOf } from '../lib/describe.ts';
import { timeAgo, num, mem, describeCron } from '../../../web/src/lib/format.ts';
import type { ServiceView as Svc, Deployment, ServiceMetricsPoint, Replica, LogLine } from '../../../web/src/lib/types.ts';

type Metrics = { points: ServiceMetricsPoint[]; replicas: Replica[] };

export function ServiceView({ id, title }: { id: string; title: string }) {
  const nav = useNav();
  const { live } = useSession();
  const [tab, setTab] = useState<'overview' | 'logs'>('overview');
  const [svc, setSvc] = useState<Svc | null>(null);
  return (
    <>
      <TopBar title={svc?.name ?? title} sub={<Live on={live} />} onBack={nav.back} />
      <div style={{ paddingTop: 12 }}>
        <div className="tabs" role="tablist">
          <button className="tab" role="tab" aria-selected={tab === 'overview'} onClick={() => setTab('overview')}>
            Overview
          </button>
          <button className="tab" role="tab" aria-selected={tab === 'logs'} onClick={() => setTab('logs')}>
            Logs
          </button>
        </div>
      </div>
      {/* Overview stays mounted so switching tabs keeps its data and scroll position. */}
      <div style={{ display: tab === 'overview' ? 'contents' : 'none' }}>
        <Overview id={id} svc={svc} setSvc={setSvc} />
      </div>
      {tab === 'logs' && <Logs id={id} />}
    </>
  );
}

function Overview({ id, svc, setSvc }: { id: string; svc: Svc | null; setSvc: (s: Svc) => void }) {
  const { api } = useSession();
  const nav = useNav();
  const [deps, setDeps] = useState<Deployment[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  useTick(15_000);

  const load = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([api.get<Svc>(`/services/${id}`), api.get<Deployment[]>(`/services/${id}/deployments?limit=5`)]);
      setSvc(s);
      setDeps(d);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, id, setSvc]);
  const loadMetrics = useCallback(() => {
    api
      .get<Metrics>(`/services/${id}/metrics?seconds=1800`)
      .then(setMetrics)
      .catch(() => {});
  }, [api, id]);

  useEffect(() => {
    void load();
    loadMetrics();
    const t = setInterval(() => document.visibilityState === 'visible' && loadMetrics(), 15_000);
    return () => clearInterval(t);
  }, [load, loadMetrics]);

  const refetchDeps = useDebounced(() => void load(), 500);
  useServerEvents((ev) => {
    if (ev.type === 'service.updated' && ev.service.id === id) setSvc({ ...(svc ?? {}), ...(ev.service as Svc) });
    else if (ev.type === 'deployment.updated' && ev.deployment.serviceId === id) refetchDeps();
    else if (ev.type === 'replicas' && ev.serviceId === id) setMetrics((m) => (m ? { ...m, replicas: ev.replicas } : m));
    else if (ev.type === 'service.deleted' && ev.serviceId === id) {
      toast('This service was deleted.');
      nav.back();
    }
  });

  const act = async (kind: 'restart' | 'deploy' | 'stop' | 'start' | 'run') => {
    if (!svc) return;
    const ask = {
      restart: { title: `Restart ${svc.name}?`, body: 'Its containers restart one by one with the same version.', confirm: 'Restart' },
      deploy: { title: `Redeploy ${svc.name}?`, body: svc.source.type === 'image' ? 'Pulls the image again and replaces the running containers.' : 'Builds it again from its source and replaces the running containers.', confirm: 'Redeploy' },
      stop: { title: `Stop ${svc.name}?`, body: 'Its containers stop and it stops answering until you start it again.', confirm: 'Stop', danger: true },
      start: null,
      run: { title: `Run ${svc.name} now?`, body: 'Runs the scheduled job once, outside its schedule.', confirm: 'Run now' },
    }[kind];
    if (ask && !(await confirmSheet(ask))) return;
    setActing(kind);
    try {
      await api.post(`/services/${id}/${kind}`);
      toast({ restart: 'Restarting…', deploy: 'Deploy started', stop: 'Stopped', start: 'Starting…', run: 'Job started' }[kind]);
      void load();
    } catch (e) {
      toastError(e);
    } finally {
      setActing(null);
    }
  };

  if (!svc) {
    return (
      <div className="scroll">
        {error ? (
          <div className="error" role="alert" style={{ marginTop: 0 }}>
            <Icon name="alert" size={16} />
            <div>{error}</div>
          </div>
        ) : (
          <div className="empty">
            <Spinner />
          </div>
        )}
      </div>
    );
  }

  const deployable = svc.source.type !== 'external' && svc.source.type !== 'redirect';
  const stopped = svc.status === 'stopped' || svc.status === 'idle';
  const urls = publicUrls(svc);
  const pts = metrics?.points ?? [];
  const last = pts[pts.length - 1];
  const reps = metrics?.replicas ?? [];
  const healthy = reps.filter((r) => r.state === 'healthy').length;
  const isHttp = svc.protocol === 'http';

  return (
    <PullScroll
      onRefresh={async () => {
        loadMetrics();
        await load();
      }}
    >
      <div className="svc-head">
        <ServiceGlyph icon={svc.icon} name={svc.name} size={52} />
        <div className="grow">
          <h2 className="ellipsis">{svc.name}</h2>
          <div className="row" style={{ marginTop: 4 }}>
            <StatusPill status={svc.status} />
            {svc.pendingChanges?.length > 0 && (
              <span className="pill" style={{ ['--tone' as any]: 'var(--warn)' }}>
                changes not deployed
              </span>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="error" role="alert" style={{ marginTop: 0, marginBottom: 12 }}>
          <Icon name="alert" size={16} />
          <div>{error}</div>
        </div>
      )}

      {deployable && (
        <div className="card actions" style={{ gridTemplateColumns: svc.schedule ? 'repeat(4, 1fr)' : undefined }}>
          {svc.schedule && (
            <button className="action" disabled={!!acting} onClick={() => void act('run')}>
              <span className="ic">{acting === 'run' ? <Spinner /> : <Icon name="play" size={20} />}</span>
              Run now
            </button>
          )}
          <button className="action" disabled={!!acting || stopped} onClick={() => void act('restart')}>
            <span className="ic">{acting === 'restart' ? <Spinner /> : <Icon name="refresh" size={20} />}</span>
            Restart
          </button>
          <button className="action" disabled={!!acting} onClick={() => void act('deploy')}>
            <span className="ic">{acting === 'deploy' ? <Spinner /> : <Icon name="rocket" size={20} />}</span>
            Redeploy
          </button>
          {stopped && svc.status !== 'idle' ? (
            <button className="action" disabled={!!acting} onClick={() => void act('start')}>
              <span className="ic">{acting === 'start' ? <Spinner /> : <Icon name="power" size={20} />}</span>
              Start
            </button>
          ) : (
            <button className="action" disabled={!!acting || stopped} onClick={() => void act('stop')}>
              <span className="ic" style={{ color: stopped ? undefined : 'var(--err)' }}>
                {acting === 'stop' ? <Spinner /> : <Icon name="stop" size={20} />}
              </span>
              Stop
            </button>
          )}
        </div>
      )}

      {svc.imageUpdate?.status === 'changed' && (
        <div className="note">
          <Icon name="arrowUp" size={16} />
          <div>
            {svc.imageUpdate.base ? 'Its base image' : 'Its image'} {svc.imageUpdate.ref} has a newer version. Redeploy to update.
          </div>
        </div>
      )}

      {(svc.status === 'running' || svc.status === 'degraded') && pts.length > 1 && (
        <>
          <div className="section-title">
            <span className="label">Last 30 minutes</span>
          </div>
          <div className="spark-grid">
            <div className="card spark-card">
              <div className="label">CPU</div>
              <div className="v">{last ? `${num(last.cpu)}%` : '–'}</div>
              <Sparkline values={pts.map((p) => p.cpu)} />
            </div>
            <div className="card spark-card">
              <div className="label">Memory</div>
              <div className="v">{last ? mem(last.memMb) : '–'}</div>
              <Sparkline values={pts.map((p) => p.memMb)} color="var(--build)" />
            </div>
            {isHttp && (
              <>
                <div className="card spark-card">
                  <div className="label">Requests</div>
                  <div className="v">{last ? `${num(last.rps)}/s` : '–'}</div>
                  <Sparkline values={pts.map((p) => p.rps)} color="var(--ok)" />
                </div>
                <div className="card spark-card">
                  <div className="label">p95 latency</div>
                  <div className="v">{last ? `${Math.round(last.p95)} ms` : '–'}</div>
                  <Sparkline values={pts.map((p) => p.p95)} color="var(--warn)" />
                </div>
              </>
            )}
          </div>
        </>
      )}

      <div className="section-title">
        <span className="label">Details</span>
      </div>
      <dl className="card kv">
        {urls.length > 0 && (
          <>
            <dt>Address</dt>
            <dd>
              {urls.map((u) => (
                <div key={u}>
                  <a className="link mono" href={u} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                    {hostOf(u)}
                  </a>
                </div>
              ))}
            </dd>
          </>
        )}
        {svc.tcpAddress && (
          <>
            <dt>TCP</dt>
            <dd className="mono">{svc.tcpAddress}</dd>
          </>
        )}
        <dt>Source</dt>
        <dd className="mono" style={{ fontSize: 12 }}>
          {sourceLine(svc)}
        </dd>
        {svc.baseImage && (
          <>
            <dt>Built from</dt>
            <dd className="mono" style={{ fontSize: 12 }}>
              {svc.baseImage}
            </dd>
          </>
        )}
        {deployable && (
          <>
            <dt>Replicas</dt>
            <dd>{reps.length ? `${healthy} of ${reps.length} healthy` : svc.replicas === 0 ? 'none' : `${svc.replicas} wanted`}</dd>
          </>
        )}
        {svc.schedule && (
          <>
            <dt>Schedule</dt>
            <dd>
              {describeCron(svc.schedule)}
              {svc.nextRunAt ? <div className="faint">next {new Date(svc.nextRunAt).toLocaleString()}</div> : null}
            </dd>
          </>
        )}
        {svc.server && (
          <>
            <dt>Server</dt>
            <dd>
              {svc.server.name}
              {!svc.server.online && <span style={{ color: 'var(--err)' }}> · offline</span>}
            </dd>
          </>
        )}
        {svc.external && (
          <>
            <dt>Target</dt>
            <dd>
              {svc.external.host}:{svc.external.port}
              {svc.external.healthy === false && <span style={{ color: 'var(--err)' }}> · not answering</span>}
            </dd>
          </>
        )}
      </dl>

      {deployable && (
        <>
          <div className="section-title">
            <span className="label">Deployments</span>
          </div>
          {deps.length === 0 ? (
            <div className="card empty" style={{ padding: 24 }}>
              Not deployed yet.
            </div>
          ) : (
            <div className="card list">
              {deps.map((d) => (
                <div className="item" key={d.id} style={{ alignItems: 'flex-start' }}>
                  <div className="grow">
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span className="title ellipsis" style={{ fontSize: 13 }}>
                        {d.commitMessage?.split('\n')[0] || d.sourceLabel || d.image || 'Deployment'}
                      </span>
                      <StatusPill status={d.status} />
                    </div>
                    <div className="meta">
                      {timeAgo(d.createdAt)} · {d.trigger}
                      {d.actor && d.actor !== 'you' ? ` by ${d.actor}` : ''}
                      {d.commitSha ? ` · ${d.commitSha.slice(0, 7)}` : ''}
                    </div>
                    {d.error && (
                      <div className="meta" style={{ color: 'var(--err)', whiteSpace: 'normal' }}>
                        {d.error}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </PullScroll>
  );
}

const MAX_LINES = 2000;
// Many apps log everything to stderr, so the colour comes from what a line says, not its stream.
const levelOf = (text: string) => (/\b(error|err|fatal|panic|exception|failed|crit(ical)?)\b/i.test(text) ? 'error' : /\b(warn(ing)?)\b/i.test(text) ? 'warn' : undefined);

function Logs({ id }: { id: string }) {
  const { server, token } = useSession();
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [follow, setFollow] = useState(true);
  const [times, setTimes] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      openStream(
        server.url,
        token,
        `/services/${id}/logs/stream?tail=300`,
        {
          backlog: (b: LogLine[]) => {
            setLines(Array.isArray(b) ? b.slice(-MAX_LINES) : []);
            setLoaded(true);
          },
          lines: (b: LogLine[]) => setLines((cur) => (cur.length + b.length > MAX_LINES ? [...cur, ...b].slice(-MAX_LINES) : [...cur, ...b])),
        },
        { onState: setConnected },
      ),
    [server.url, token, id],
  );

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, follow]);

  return (
    <div className="logs-wrap">
      <div className="logs-bar">
        <button className="chip-btn" aria-pressed={follow} onClick={() => setFollow((f) => !f)}>
          <Icon name="arrowUp" size={13} style={{ transform: 'rotate(180deg)' }} />
          Follow
        </button>
        <button className="chip-btn" aria-pressed={times} onClick={() => setTimes((t) => !t)}>
          <Icon name="clock" size={13} />
          Time
        </button>
        <span className="grow" />
        <Live on={connected} />
      </div>
      <div
        className="logs"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (!atBottom && follow) setFollow(false);
        }}
      >
        {!loaded ? (
          <div className="empty">
            <Spinner />
          </div>
        ) : lines.length === 0 ? (
          <div className="empty">No log lines yet.</div>
        ) : (
          lines.map((l, i) => (
            <div className="log-line" key={i} data-level={levelOf(l.text)}>
              {times && <span className="ts">{new Date(l.ts).toLocaleTimeString()}</span>}
              {l.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
