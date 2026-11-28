import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { useSession, useNav, useServerEvents } from '../session.tsx';
import { Icon, Live, TopBar, Spinner, ServiceGlyph } from '../ui/kit.tsx';
import { PullScroll } from '../ui/pull.tsx';
import { AreaChart, BarList, Counter, Donut, Histogram, type Slice } from '../ui/charts.tsx';
import {
  RANGES,
  rangeOf,
  emptySeries,
  addPoints,
  addTick,
  seriesPoints,
  seriesCount,
  seriesErrCount,
  prune,
  breakdown,
  fetchTotals,
  fetchRecent,
  fetchMetrics,
  fetchRows,
  feedToReq,
  pool,
  NoTrafficApi,
  LAT_EDGES,
  fmtRate,
  fmtCount,
  fmtMs,
  pct,
  type RangeKey,
  type Series,
  type TotalsResp,
  type FeedEntry,
  type Req,
} from '../lib/traffic.ts';
import type { ProjectListItem } from '../../../web/src/lib/types.ts';

const RANGE_KEY = 'servify.trafficRange';
const FEED_SIZE = 30;
const ROWS_PER_SERVICE = 400;
const ROW_SERVICES = 6;
const METRIC_SERVICES = 16;

type SvcInfo = { name: string; icon: string; project: string; http: boolean };

function savedRange(): RangeKey {
  try {
    const v = localStorage.getItem(RANGE_KEY);
    if (v && RANGES.some((r) => r.key === v)) return v as RangeKey;
  } catch {
    /* private storage off: the default */
  }
  return '15m';
}

/** True while the app is in front and the screen is visible; polling and animation stop otherwise. */
function useForeground(): boolean {
  const [fg, setFg] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    let vis = document.visibilityState === 'visible';
    let app = true;
    const update = () => setFg(vis && app);
    const onVis = () => {
      vis = document.visibilityState === 'visible';
      update();
    };
    document.addEventListener('visibilitychange', onVis);
    const h = Capacitor.isNativePlatform()
      ? CapApp.addListener('appStateChange', (s) => {
          app = s.isActive;
          update();
        })
      : null;
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      void h?.then((x) => x.remove());
    };
  }, []);
  return fg;
}

/** Runs `fn` now and then `ms` after each run finishes (never overlapping), while `on`. */
function usePoll(fn: () => Promise<unknown>, ms: number, on: boolean, key: unknown) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!on) return;
    let stop = false;
    let t: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      try {
        await ref.current();
      } catch {
        /* shown by the loader itself */
      }
      if (!stop) t = setTimeout(run, ms);
    };
    void run();
    return () => {
      stop = true;
      if (t) clearTimeout(t);
    };
  }, [on, ms, key]);
}

const STATUS_COLORS: Record<string, string> = { '2xx': 'var(--ok)', '3xx': 'var(--build)', '4xx': 'var(--warn)', '5xx': 'var(--err)', other: 'var(--idle)' };
const statusTone = (s: number) => STATUS_COLORS[`${Math.floor(s / 100)}xx`] ?? STATUS_COLORS.other;
const LAT_LABELS = ['<10', '<50', '<100', '<250', '<500', '<1s', '1s+'];
const LAT_COLORS = ['var(--ok)', 'var(--ok)', 'color-mix(in srgb, var(--ok) 50%, var(--warn))', 'var(--warn)', 'color-mix(in srgb, var(--warn) 50%, var(--err))', 'var(--err)', 'var(--err)'];

const ago = (ts: number, now: number) => {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

export function Traffic() {
  const { api, live, server } = useSession();
  const nav = useNav();
  const fg = useForeground();
  const [range, setRangeState] = useState<RangeKey>(savedRange);
  const R = rangeOf(range);
  const rangeRef = useRef(range);
  rangeRef.current = range;

  const [svcs, setSvcs] = useState<Map<string, SvcInfo>>(new Map());
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totals, setTotals] = useState<TotalsResp | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Chart series: mutated in place by live ticks, replaced on each resync; `ver` re-renders.
  const series = useRef<Series>(emptySeries(range));
  const synced = useRef<{ range: RangeKey; at: number } | null>(null);
  const [ver, setVer] = useState(0);

  // Rows for the breakdown, by id (the feed and the per-service log share one id space).
  const rows = useRef(new Map<number, Req>());
  const [rowsMeta, setRowsMeta] = useState<{ partial: boolean; range: RangeKey | null; at: number }>({ partial: false, range: null, at: 0 });

  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const fresh = useRef(new Set<number>());
  const feedLast = useRef<number | null>(null);

  // The live numbers from the event stream, smoothed over a few seconds so bursts glide.
  const [now1, setNow1] = useState({ rps: 0, err: 0, p95: 0, seen: false });
  const smooth = useRef({ rps: 0, err: 0 });

  const setRange = (k: RangeKey) => {
    if (k === range) return;
    try {
      localStorage.setItem(RANGE_KEY, k);
    } catch {
      /* remembered for this visit only */
    }
    series.current = emptySeries(k);
    synced.current = null;
    rows.current = new Map();
    setRowsMeta({ partial: false, range: null, at: 0 });
    setTotals(null);
    setLoaded(false);
    setRangeState(k);
  };

  // ── services (names and icons) ──
  const loadServices = useCallback(async () => {
    const list = await api.get<ProjectListItem[]>('/projects');
    if (!Array.isArray(list)) return;
    const byId = new Map(list.map((p) => [p.id, p]));
    const m = new Map<string, SvcInfo>();
    for (const p of list) {
      const parent = p.parentId ? byId.get(p.parentId) : null;
      const project = parent ? `${parent.name} · ${p.envName ?? 'environment'}` : p.name;
      for (const s of p.services)
        m.set(s.id, { name: s.name, icon: s.icon, project, http: !!(s.domains?.length || s.publicHttp || s.kind === 'redirect') });
    }
    setSvcs(m);
  }, [api]);
  useEffect(() => {
    void loadServices().catch(() => {});
  }, [loadServices]);

  // ── totals, then the chart and the breakdown when they're due ──
  const svcsRef = useRef(svcs);
  svcsRef.current = svcs;
  const lastRows = useRef(0);

  const sync = useCallback(
    async (force = false) => {
      const k = rangeRef.current;
      const r = rangeOf(k);
      let t: TotalsResp | null = null;
      let noApi = false;
      try {
        t = await fetchTotals(api, r.hours ?? 1);
      } catch (e) {
        if (e instanceof NoTrafficApi) noApi = true;
        else {
          setError((e as Error).message);
          return;
        }
      }
      if (rangeRef.current !== k) return;
      setUnsupported(noApi);
      setError(null);
      if (t) setTotals(t);

      // Which services to chart: those with requests in the range (busiest first); on a server without the access
      // log, the ones reachable over HTTP.
      const ranked = t
        ? Object.entries(t.services)
            .sort((a, b) => b[1].requests - a[1].requests)
            .map(([id]) => id)
        : [...svcsRef.current].filter(([, s]) => s.http).map(([id]) => id);

      const now = Date.now();
      const metricsEvery = r.sec <= 900 ? 60_000 : r.sec <= 3600 ? 30_000 : 120_000;
      const tasks: Promise<unknown>[] = [];
      if (force || !synced.current || synced.current.range !== k || now - synced.current.at > metricsEvery) {
        tasks.push(
          (async () => {
            const from = now - r.sec * 1000;
            const s = emptySeries(k);
            const res = await pool(ranked.slice(0, METRIC_SERVICES), 3, (id) => fetchMetrics(api, id, r.sec));
            if (rangeRef.current !== k) return;
            for (const x of res) if (x.status === 'fulfilled') addPoints(s, x.value, r.sec, from);
            series.current = s;
            synced.current = { range: k, at: Date.now() };
            setVer((v) => v + 1);
          })(),
        );
      }
      const rowsEvery = r.sec <= 900 ? 30_000 : 90_000;
      if (!noApi && (force || rowsMeta.range !== k || now - lastRows.current > rowsEvery)) {
        lastRows.current = now;
        tasks.push(
          (async () => {
            const from = now - r.sec * 1000;
            const res = await pool(ranked.slice(0, ROW_SERVICES), 2, (id) => fetchRows(api, id, from, ROWS_PER_SERVICE));
            if (rangeRef.current !== k) return;
            const m = new Map<number, Req>();
            let partial = ranked.length > ROW_SERVICES;
            for (const x of res) {
              if (x.status !== 'fulfilled') continue;
              partial ||= x.value.partial;
              for (const row of x.value.rows) m.set(row.id, row);
            }
            // Keep what the live feed added since the request went out.
            for (const [id, row] of rows.current) if (row.ts >= from && !m.has(id)) m.set(id, row);
            rows.current = m;
            setRowsMeta({ partial, range: k, at: Date.now() });
          })(),
        );
      }
      await Promise.all(tasks);
      if (rangeRef.current === k) setLoaded(true);
    },
    [api, rowsMeta.range],
  );

  // Coming back to the app: redraw the chart from the server, since the stream was quiet in the background.
  useEffect(() => {
    if (!fg) synced.current = null;
  }, [fg]);

  usePoll(() => sync(), 15_000, fg, range);

  // ── the live feed ──
  const pollFeed = useCallback(async () => {
    if (unsupported) return;
    const first = feedLast.current === null;
    let r;
    try {
      r = await fetchRecent(api, feedLast.current, first ? FEED_SIZE : 60);
    } catch (e) {
      if (e instanceof NoTrafficApi) setUnsupported(true);
      return;
    }
    const k = rangeRef.current;
    const from = Date.now() - rangeOf(k).sec * 1000;
    feedLast.current = r.last;
    if (!r.entries.length) return;
    if (!first) for (const e of r.entries) fresh.current.add(e.id);
    for (const e of r.entries) if (e.ts >= from) rows.current.set(e.id, feedToReq(e));
    // A full page means requests came faster than the feed polls: the breakdown is a sample until the next resync.
    if (!first && r.entries.length >= 60) setRowsMeta((m) => ({ ...m, partial: true }));
    setFeed((f) => {
      const seen = new Set(f.map((x) => x.id));
      return [...r.entries.filter((e) => !seen.has(e.id)), ...f].slice(0, FEED_SIZE);
    });
  }, [api, unsupported]);
  usePoll(pollFeed, 2500, fg && !unsupported, unsupported);

  // ── live seconds from the event stream ──
  useServerEvents((ev) => {
    if (ev.type !== 'traffic') return;
    let rps = 0;
    let err = 0;
    let p95 = 0;
    for (const t of Object.values(ev.services)) {
      rps += t.rps;
      err += t.errors;
      if (t.rps > 0) p95 = Math.max(p95, t.p95);
    }
    const a = 1 - Math.exp(-1 / 3); // ~3 s smoothing
    smooth.current.rps += (rps - smooth.current.rps) * a;
    smooth.current.err += (err - smooth.current.err) * a;
    if (!fg) return;
    const now = Date.now();
    if (synced.current && synced.current.range === rangeRef.current && now > synced.current.at) {
      addTick(series.current, now, rps, err, p95);
      prune(series.current, now - rangeOf(rangeRef.current).sec * 1000);
    }
    setNow1({ rps: smooth.current.rps < 0.005 ? 0 : smooth.current.rps, err: smooth.current.err < 0.005 ? 0 : smooth.current.err, p95, seen: true });
    setVer((v) => v + 1);
  });

  // Drop "fresh" marks after their slide-in has played.
  useEffect(() => {
    if (!fresh.current.size) return;
    const t = setTimeout(() => fresh.current.clear(), 1200);
    return () => clearTimeout(t);
  }, [feed]);

  const refresh = async () => {
    await Promise.all([loadServices().catch(() => {}), sync(true), pollFeed()]);
  };

  // ── derived ──
  const now = Date.now();
  const from = now - R.sec * 1000;
  const points = useMemo(() => seriesPoints(series.current, Date.now(), R.sec * 1000), [ver, range]);
  const inRange = useMemo(() => [...rows.current.values()].filter((r) => r.ts >= from), [rowsMeta, feed, range]);
  const bd = useMemo(() => breakdown(inRange), [inRange]);
  const complete = rowsMeta.range === range && !rowsMeta.partial;

  const sum = totals ? Object.values(totals.services).reduce((a, t) => ({ requests: a.requests + t.requests, errors: a.errors + t.errors, bots: a.bots + t.bots, visitors: a.visitors + t.visitors }), { requests: 0, errors: 0, bots: 0, visitors: 0 }) : null;
  const exact = R.hours !== null && sum; // totals cover exactly this range
  const requests = exact ? sum.requests : complete ? bd.n : seriesCount(series.current, from);
  const approx = !exact && !complete;
  // Short ranges with more requests than were fetched: 5xx from the router's rate, bots as the sample's share, and
  // visitors as a lower bound (the sample's distinct visitors).
  const errors5 = exact ? sum.errors : complete ? bd.statuses['5xx'] : Math.round(seriesErrCount(series.current, from));
  const bots = exact ? sum.bots : complete ? bd.bots : bd.n ? Math.round((bd.bots / bd.n) * requests) : null;
  const visitors = exact ? sum.visitors : complete ? bd.visitors : bd.visitors || null;

  const byService: { id: string; n: number }[] = exact
    ? Object.entries(totals!.services).map(([id, t]) => ({ id, n: t.requests }))
    : [...inRange.reduce((m, r) => m.set(r.serviceId, (m.get(r.serviceId) ?? 0) + 1), new Map<string, number>())].map(([id, n]) => ({ id, n }));
  byService.sort((a, b) => b.n - a.n);

  const slices: Slice[] = (['2xx', '3xx', '4xx', '5xx', 'other'] as const).map((k) => ({ key: k, label: k === 'other' ? 'other' : k, n: bd.statuses[k], color: STATUS_COLORS[k] })).filter((s) => s.key !== 'other' || s.n > 0);
  const okShare = bd.n ? (bd.statuses['2xx'] + bd.statuses['3xx']) / bd.n : 0;
  const sampleNote = !complete && bd.n ? `latest ${bd.n.toLocaleString()} requests` : R.long;
  const timeLabel = (t: number) =>
    R.sec <= 3600 ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : R.sec <= 86400 ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric' });

  const quiet = loaded && requests === 0 && !now1.rps;

  return (
    <>
      <TopBar
        title="Traffic"
        onBack={nav.back}
        sub={
          <span className="row" style={{ gap: 10 }}>
            <Live on={live && fg} />
            <span className="ellipsis">{server.label}</span>
          </span>
        }
      />
      <PullScroll onRefresh={refresh} className="scroll traffic">
        <div className="range-chips" role="tablist" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r.key} role="tab" aria-selected={r.key === range} className="range-chip" onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>

        {error && (
          <div className="error" role="alert" style={{ marginTop: 0, marginBottom: 12 }}>
            <Icon name="alert" size={16} />
            <div>{error}</div>
          </div>
        )}

        <section className="card tr-hero">
          <div className="tr-hero-head">
            <div>
              <div className="label">Requests per second</div>
              <div className="tr-big mono">
                <Counter value={now1.rps} fmt={fmtRate} />
                <small>req/s</small>
              </div>
            </div>
            <div className="tr-hero-side">
              <span className="pill" style={{ ['--tone' as any]: now1.p95 > 1000 ? 'var(--err)' : now1.p95 > 300 ? 'var(--warn)' : 'var(--ok)' }}>
                p95 {now1.seen && now1.rps > 0 ? fmtMs(now1.p95) : '–'}
              </span>
              <span className="pill" style={{ ['--tone' as any]: now1.err > 0 ? 'var(--err)' : 'var(--idle)' }}>
                5xx {fmtRate(now1.err)}/s
              </span>
            </div>
          </div>
          <div className="tr-hero-sub mono">
            {loaded ? (
              <>
                {approx && requests > 0 ? '≈' : ''}
                <Counter value={requests} fmt={fmtCount} /> requests · {R.long}
              </>
            ) : (
              <>loading {R.long}…</>
            )}
          </div>
          <AreaChart points={points} rangeMs={R.sec * 1000} running={fg} fmt={fmtRate} timeLabel={timeLabel} />
        </section>

        {unsupported ? (
          <div className="card empty tr-empty">
            <div className="ic">
              <Icon name="pulse" size={30} />
            </div>
            <b>This Servify doesn't keep an access log yet</b>
            <div>The live rate above comes from the router. Update Servify on your server (0.2.2 or newer) to see status codes, paths, domains and every request as it happens.</div>
          </div>
        ) : !loaded && !totals ? (
          <div className="empty">
            <Spinner />
          </div>
        ) : (
          <>
            <div className="tr-tiles">
              <Tile label="Requests" value={requests} prefix={approx && requests > 0 ? '≈' : ''} icon="pulse" hint={exact ? 'counted' : approx ? 'from the request rate' : 'counted'} />
              <Tile label="Visitors" value={visitors} prefix={!exact && !complete && visitors ? '≥' : ''} icon="user" hint="people, not bots" />
              <Tile label="Server errors" value={errors5} prefix={!exact && !complete && errors5 ? '≈' : ''} icon="alert" tone={errors5 ? 'var(--err)' : undefined} hint={errors5 !== null && requests ? `${pct(errors5, requests)} of requests` : undefined} />
              <Tile label="Bots" value={bots} prefix={!exact && !complete && bots ? '≈' : ''} icon="bot" hint={bots !== null && requests ? `${pct(bots, requests)} of requests` : undefined} />
            </div>

            {quiet ? (
              <div className="card empty tr-empty">
                <div className="ic">
                  <Icon name="wave" size={30} />
                </div>
                <b>No requests in the {R.long}</b>
                <div>Requests through Servify's router to your domains and generated URLs show up here as they happen.</div>
              </div>
            ) : (
              <>
                {bd.n > 0 && (
                  <section className="card tr-card">
                    <CardHead title="Status codes" note={sampleNote} />
                    <div className="tr-status">
                      <Donut
                        slices={slices}
                        center={
                          <>
                            <b className="mono">{Math.round(okShare * 100)}%</b>
                            <span className="faint">OK</span>
                          </>
                        }
                      />
                      <div className="tr-legend">
                        {slices.map((s) => (
                          <div key={s.key} className="tr-legend-row">
                            <i style={{ background: s.color }} />
                            <span className="mono grow">{s.label}</span>
                            <span className="mono">{s.n.toLocaleString()}</span>
                            <span className="mono faint tr-legend-pct">{pct(s.n, bd.n)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="tr-stack" aria-hidden>
                      {slices.map((s) => (s.n ? <span key={s.key} style={{ flexGrow: s.n, background: s.color }} /> : null))}
                    </div>
                  </section>
                )}

                {byService.length > 0 && (
                  <section className="card tr-card">
                    <CardHead title="Services" note={exact ? R.long : sampleNote} />
                    <BarList
                      total={byService.reduce((a, s) => a + s.n, 0)}
                      items={byService.slice(0, 6).map((s) => {
                        const info = svcs.get(s.id);
                        return {
                          key: s.id,
                          n: s.n,
                          lead: <ServiceGlyph icon={info?.icon ?? ''} name={info?.name ?? '?'} size={26} />,
                          label: (
                            <>
                              <span className="bar-title">{info?.name ?? 'service'}</span>
                              <span className="bar-meta">{info?.project ?? ''}</span>
                            </>
                          ),
                          onClick: info ? () => nav.push({ name: 'service', id: s.id, title: info.name }) : undefined,
                        };
                      })}
                    />
                  </section>
                )}

                {bd.hosts.length > 0 && (
                  <section className="card tr-card">
                    <CardHead title="Domains" note={sampleNote} />
                    <BarList mono tone="var(--build)" items={bd.hosts.map((h) => ({ key: h.key, label: h.key, n: h.n }))} />
                  </section>
                )}

                {bd.paths.length > 0 && (
                  <section className="card tr-card">
                    <CardHead title="Top paths" note="people only" />
                    <BarList mono items={bd.paths.map((p) => ({ key: p.key, label: p.key, n: p.n }))} />
                  </section>
                )}

                {bd.latency && (
                  <section className="card tr-card">
                    <CardHead title="Response time" note={sampleNote} />
                    <div className="tr-lat">
                      {(['p50', 'p95', 'p99'] as const).map((k) => (
                        <div key={k}>
                          <div className="label">{k}</div>
                          <div className="mono tr-lat-v" style={{ color: bd.latency![k] > 1000 ? 'var(--err)' : bd.latency![k] > 300 ? 'var(--warn)' : undefined }}>
                            {fmtMs(bd.latency![k])}
                          </div>
                        </div>
                      ))}
                    </div>
                    <Histogram values={bd.latency.hist} labels={LAT_LABELS.slice(0, LAT_EDGES.length + 1)} colors={LAT_COLORS} />
                  </section>
                )}

                {bd.referrers.length > 0 && (
                  <section className="card tr-card">
                    <CardHead title="Sources" note="other sites linking in" />
                    <BarList mono tone="var(--ok)" items={bd.referrers.map((r) => ({ key: r.key, label: r.key, n: r.n }))} />
                  </section>
                )}
              </>
            )}

            <div className="section-title">
              <span className="label">Recent requests</span>
              <span className="label row" style={{ gap: 6 }}>
                {fg && <i className="tr-rec" />}
                {fg ? 'live' : 'paused'}
              </span>
            </div>
            {feed.length === 0 ? (
              <div className="card empty" style={{ padding: '28px 20px' }}>
                Nothing yet. New requests slide in here.
              </div>
            ) : (
              <div className="card tr-feed">
                {feed.map((e) => {
                  const info = svcs.get(e.serviceId);
                  return (
                    <button
                      key={e.id}
                      className="tr-req"
                      data-fresh={fresh.current.has(e.id) || undefined}
                      onClick={info ? () => nav.push({ name: 'service', id: e.serviceId, title: info.name }) : undefined}
                    >
                      <span className="tr-status-chip mono" style={{ ['--tone' as any]: statusTone(e.status) }}>
                        {e.status}
                      </span>
                      <div className="grow">
                        <div className="ellipsis mono tr-req-path">
                          <span className="faint">{e.method} </span>
                          {e.path}
                        </div>
                        <div className="ellipsis tr-req-meta">
                          {e.bot && (
                            <span className="tr-bot">
                              <Icon name="bot" size={11} />
                              {e.botName ?? 'bot'}
                            </span>
                          )}
                          {e.host}
                          {info ? ` · ${info.name}` : ''}
                          {e.refHost ? ` · from ${e.refHost}` : ''}
                        </div>
                      </div>
                      <div className="tr-req-side mono">
                        <span>{e.ms > 0 ? fmtMs(e.ms) : '—'}</span>
                        <span className="faint">{ago(e.ts, now)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}

        <div className="tr-privacy">
          <Icon name="shield" size={14} />
          <span>Servify never stores client IPs, so there are no countries or addresses here. Visitors are counted with a daily key kept only in the server's memory.</span>
        </div>
      </PullScroll>
    </>
  );
}

function CardHead({ title, note }: { title: string; note?: string }) {
  return (
    <div className="tr-card-head">
      <span className="tr-card-title">{title}</span>
      {note && <span className="label">{note}</span>}
    </div>
  );
}

function Tile({ label, value, icon, hint, tone, prefix }: { label: string; value: number | null; icon: string; hint?: string; tone?: string; prefix?: string }) {
  return (
    <div className="card tr-tile" style={tone ? { ['--tone' as any]: tone } : undefined}>
      <div className="row tr-tile-head">
        <Icon name={icon} size={14} />
        <span className="label">{label}</span>
      </div>
      <div className="mono tr-tile-v">
        {value === null ? (
          '–'
        ) : (
          <>
            {prefix}
            <Counter value={value} fmt={fmtCount} />
          </>
        )}
      </div>
      {hint && <div className="tr-tile-hint mono">{hint}</div>}
    </div>
  );
}
