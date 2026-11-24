import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import { useStore, traffic } from '../lib/store.ts';
import { navigate, projectPath } from '../lib/router.ts';
import type { ProjectListItem, ProjectListService } from '../lib/types.ts';
import { Icon } from '../components/Icon.tsx';
import { ProjectMark } from '../components/ProjectMark.tsx';
import { Tooltip, Segmented } from '../components/ui.tsx';
import { ticker, reducedMotion } from '../motion/spring.ts';

// ───────────────────────────── data ─────────────────────────────

type Totals = { requests: number; errors: number; bots: number; visitors: number };
type Recent = { id: number; serviceId: string; ts: number; host: string; method: string; path: string; status: number; ms: number; bot: boolean; botName: string | null; refHost: string };

/** Reached from outside: a domain, Servify's generated URL, a redirect or a public TCP port. */
const routed = (s: ProjectListService) => !!(s.domains?.length || s.publicHttp || s.publicTcpPort || s.kind === 'redirect');

type Row = {
  project: ProjectListItem;
  label: string;
  services: ProjectListService[];
  domains: string[];
  tcp: { name: string; port: number }[];
  httpIds: string[];
  internal: boolean;
};

function buildRows(projects: ProjectListItem[]): Row[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  return projects.map((p) => {
    const parent = p.parentId ? byId.get(p.parentId) : null;
    const services = p.services.filter(routed);
    const domains = [...new Set(services.flatMap((s) => s.domains ?? []))];
    const tcp = services.filter((s) => s.publicTcpPort).map((s) => ({ name: s.name, port: s.publicTcpPort! }));
    // TCP/UDP routes aren't counted by the router; only HTTP services carry request numbers.
    const httpIds = services.filter((s) => s.domains?.length || s.publicHttp || s.kind === 'redirect').map((s) => s.id);
    return {
      project: p,
      label: parent ? `${parent.name} · ${p.envName ?? 'environment'}` : p.name,
      services,
      domains,
      tcp,
      httpIds,
      internal: services.length === 0,
    };
  });
}

type Live = { rps: number; errors: number; p95: number; history: number[]; active: boolean };

function liveOf(ids: string[]): Live {
  let rps = 0;
  let errors = 0;
  let p95 = 0;
  const history: number[] = [];
  for (const id of ids) {
    const t = traffic.data[id];
    if (t) {
      rps += t.rps;
      errors += t.errors;
      if (t.rps > 0) p95 = Math.max(p95, t.p95);
    }
    const h = traffic.history[id] ?? [];
    const off = 60 - h.length;
    for (let i = 0; i < h.length; i++) history[off + i] = (history[off + i] ?? 0) + h[i];
  }
  for (let i = 0; i < 60; i++) history[i] ??= 0;
  return { rps, errors, p95, history, active: rps > 0 };
}

/**
 * Rates smoothed over a few seconds (an exponential moving average, updated once per router tick), so bursty traffic
 * glides instead of flickering between 0 and a spike. A project counts as active for 10 s after its last request.
 */
const smoothing = new Map<string, { rps: number; errors: number; seenAt: number; tick: number }>();
const TAU_SEC = 4;
const ACTIVE_FOR_MS = 10_000;

function smoothed(key: string, raw: Live): Live {
  let st = smoothing.get(key);
  if (!st) smoothing.set(key, (st = { rps: raw.rps, errors: raw.errors, seenAt: raw.rps > 0 ? Date.now() : 0, tick: traffic.tick }));
  else if (st.tick !== traffic.tick) {
    const steps = Math.max(1, Math.min(10, traffic.tick - st.tick));
    const a = 1 - Math.exp(-steps / TAU_SEC);
    st.rps += (raw.rps - st.rps) * a;
    st.errors += (raw.errors - st.errors) * a;
    if (raw.rps > 0) st.seenAt = Date.now();
    st.tick = traffic.tick;
  }
  return { ...raw, rps: st.rps < 0.005 ? 0 : st.rps, errors: st.errors < 0.005 ? 0 : st.errors, active: Date.now() - st.seenAt < ACTIVE_FOR_MS };
}

function totalsOf(ids: string[], totals: Record<string, Totals>): Totals {
  const out = { requests: 0, errors: 0, bots: 0, visitors: 0 };
  for (const id of ids) {
    const t = totals[id];
    if (!t) continue;
    out.requests += t.requests;
    out.errors += t.errors;
    out.bots += t.bots;
    out.visitors += t.visitors;
  }
  return out;
}

const fmtRate = (n: number) => (n <= 0 ? '0' : n < 0.1 ? '<0.1' : n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString());
const fmtCount = (n: number) => (n < 1000 ? String(n) : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1e6).toFixed(1)}M`);
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Re-render once per traffic tick (every second). */
function useTrafficTick() {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    traffic.subs.add(fn);
    return () => {
      traffic.subs.delete(fn);
    };
  }, []);
}

function usePoll<T>(path: string, everyMs: number, initial: T): T {
  const [v, setV] = useState<T>(initial);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get<T>(path)
        .then((r) => alive && setV(r))
        .catch(() => {});
    void load();
    const t = setInterval(load, everyMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [path, everyMs]);
  return v;
}

// ───────────────────────────── geometry ─────────────────────────────

type Pt = { x: number; y: number };
type Curve = [Pt, Pt, Pt, Pt];

function curveBetween(a: Pt, b: Pt): Curve {
  const dx = Math.max(40, (b.x - a.x) * 0.5);
  return [a, { x: a.x + dx, y: a.y }, { x: b.x - dx, y: b.y }, b];
}

function at(c: Curve, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return { x: a * c[0].x + b * c[1].x + d * c[2].x + e * c[3].x, y: a * c[0].y + b * c[1].y + d * c[2].y + e * c[3].y };
}

const pathOf = (c: Curve) => `M${c[0].x},${c[0].y} C${c[1].x},${c[1].y} ${c[2].x},${c[2].y} ${c[3].x},${c[3].y}`;

/** Requests per second → particles per second: a trickle is visible, a flood doesn't saturate. */
const particleRate = (rps: number) => (rps <= 0.01 ? 0 : Math.min(26, 1.2 + Math.log2(1 + rps) * 3.2));
const strokeFor = (rps: number) => (rps <= 0.01 ? 1.25 : Math.min(6, 1.6 + Math.log2(1 + rps) * 0.9));

// ───────────────────────────── the board ─────────────────────────────

/**
 * The traffic board: Servify's router on the left, a string to every project that's reachable from outside, and
 * requests flowing along them live. Thickness and particles follow requests per second; red marks server errors.
 */
export function TrafficView() {
  const projects = useStore((s) => s.projects);
  const loaded = useStore((s) => s.projectsLoaded);
  const system = useStore((s) => s.system);
  const connected = useStore((s) => s.connected);
  useTrafficTick();

  const totalsRes = usePoll<{ since: number; services: Record<string, Totals> }>('/access-log/totals?hours=24', 30_000, { since: 0, services: {} });
  const totals = totalsRes.services;
  const [showInternal, setShowInternal] = useState(false);

  const rows = useMemo(() => buildRows(projects), [projects]);
  const live = new Map(rows.map((r) => [r.project.id, smoothed(r.project.id, liveOf(r.httpIds))]));
  const day = new Map(rows.map((r) => [r.project.id, totalsOf(r.httpIds, totals)]));

  // The order is fixed while you watch: worked out once (busiest over 24 h, or A–Z) when the page has its numbers,
  // and again only when you change the sort. New projects join at the end, deleted ones drop out.
  const [sort, setSort] = useState<'busiest' | 'az'>('busiest');
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), 3000);
    return () => clearTimeout(t);
  }, []);
  const order = useRef<string[] | null>(null);
  const visible = rows.filter((r) => showInternal || !r.internal);
  const byName = (a: Row, b: Row) => a.label.localeCompare(b.label);
  const sortRows = (list: Row[]) => [...list].sort(sort === 'az' ? byName : (a, b) => day.get(b.project.id)!.requests - day.get(a.project.id)!.requests || byName(a, b));
  const ready = loaded && (totalsRes.since > 0 || waited);
  if (ready && order.current === null) order.current = sortRows(visible).map((r) => r.project.id);
  let shown: Row[];
  if (order.current) {
    const ids = new Set(visible.map((r) => r.project.id));
    const kept = order.current.filter((id) => ids.has(id));
    const added = visible.filter((r) => !kept.includes(r.project.id)).sort(byName).map((r) => r.project.id);
    order.current = [...kept, ...added];
    const byId = new Map(visible.map((r) => [r.project.id, r]));
    shown = order.current.map((id) => byId.get(id)!);
  } else shown = [...visible].sort(byName);
  const resort = () => {
    order.current = null;
  };
  const hiddenInternal = rows.filter((r) => r.internal).length;

  const allHttp = rows.flatMap((r) => r.httpIds);
  const liveAll = smoothed('__all', liveOf(allHttp));
  const dayAll = totalsOf(allHttp, totals);
  const domainCount = new Set(rows.flatMap((r) => r.domains)).size;

  // Service id → where it lives, for the request feed.
  const where = useMemo(() => {
    const m = new Map<string, { row: Row; service: ProjectListService }>();
    for (const r of rows) for (const s of r.project.services) m.set(s.id, { row: r, service: s });
    return m;
  }, [rows]);

  return (
    <div className="page traffic-page" data-scroll-root>
      <div className="page-inner traffic-inner">
        <div className="rise-in row traffic-head" style={{ alignItems: 'flex-end', gap: 16 }}>
          <div className="grow">
            <div className="label">Router</div>
            <h1 className="h1" style={{ marginTop: 6 }}>
              Traffic
            </h1>
            <p className="muted" style={{ maxWidth: 660, marginTop: 8 }}>
              Every request that reaches Servify passes through its router. Each string is a project that's reachable from outside; it thickens and fills with requests as traffic flows, and turns red on server errors.
            </p>
          </div>
          <Segmented
            size="sm"
            value={sort}
            onChange={(v) => {
              resort();
              setSort(v);
            }}
            options={[
              { value: 'busiest', label: 'Busiest (24 h)' },
              { value: 'az', label: 'A–Z' },
            ]}
          />
          {hiddenInternal > 0 && (
            <button
              className={`btn btn-sm ${showInternal ? 'active' : 'btn-ghost'}`}
              onClick={() => {
                resort();
                setShowInternal((v) => !v);
              }}
            >
              <Icon name={showInternal ? 'eyeOff' : 'eye'} size={14} />
              {showInternal ? 'Hide' : 'Show'} {hiddenInternal} without a route
            </button>
          )}
        </div>

        <div className="traffic-stats rise-in" style={{ animationDelay: '40ms' }}>
          <Stat label="Right now" value={`${fmtRate(liveAll.rps)}`} unit="req/s" tone={liveAll.active ? 'live' : undefined} />
          <Stat label="Server errors" value={fmtRate(liveAll.errors)} unit="/s" tone={liveAll.errors > 0.01 ? 'err' : undefined} />
          <Stat label="Requests · 24 h" value={fmtCount(dayAll.requests)} />
          <Stat label="People · 24 h" value={fmtCount(dayAll.visitors)} hint="Unique visitors per site, added up (someone on two sites counts twice). No IP addresses are stored." />
          <Stat label="Bots · 24 h" value={fmtCount(dayAll.bots)} hint="Crawlers and AI bots (GPTBot, ClaudeBot, PerplexityBot…), recognised by user agent." />
        </div>

        <div className="traffic-layout rise-in" style={{ animationDelay: '80ms' }}>
          {!loaded ? (
            <div className="traffic-board traffic-empty faint">Loading…</div>
          ) : shown.length === 0 ? (
            <div className="traffic-board traffic-empty">
              <Icon name="globe" size={22} />
              <div>No project is reachable from outside yet.</div>
              <div className="faint">Give a service a domain or a public port and it shows up here.</div>
            </div>
          ) : (
            <Board rows={shown} live={live} day={day} edge={{ rps: liveAll.rps, active: liveAll.active, domains: domainCount, projects: rows.filter((r) => !r.internal).length, https: system?.proxy.httpsPort, http: system?.proxy.port, connected }} />
          )}
          <Feed where={where} />
        </div>
        <p className="faint traffic-foot">
          Live rates come from the router every second. Totals cover the last 24 hours of the access log, which keeps 7 days. TCP and UDP routes (games, voice) pass through without request counts.
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value, unit, tone, hint }: { label: string; value: string; unit?: string; tone?: 'live' | 'err'; hint?: string }) {
  const body = (
    <div className={`traffic-stat ${tone ?? ''}`}>
      <div className="label">{label}</div>
      <div className="traffic-stat-value">
        {value}
        {unit && <span className="traffic-stat-unit">{unit}</span>}
      </div>
    </div>
  );
  return hint ? <Tooltip label={hint}>{body}</Tooltip> : body;
}

type EdgeInfo = { rps: number; active: boolean; domains: number; projects: number; https?: number; http?: number; connected: boolean };

function Board({ rows, live, day, edge }: { rows: Row[]; live: Map<string, Live>; day: Map<string, Totals>; edge: EdgeInfo }) {
  const boardRef = useRef<HTMLDivElement>(null);
  const edgeRef = useRef<HTMLDivElement>(null);
  const anchors = useRef(new Map<string, HTMLElement>());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [geo, setGeo] = useState<{ w: number; h: number; curves: Record<string, Curve> } | null>(null);
  const geoRef = useRef(geo);
  geoRef.current = geo;
  const liveRef = useRef(live);
  liveRef.current = live;
  const ids = rows.map((r) => r.project.id).join(',');

  // Where the strings run: from the router's right edge to each row's anchor dot, in board coordinates.
  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const b = board.getBoundingClientRect();
      const e = edgeRef.current?.getBoundingClientRect();
      if (!e || getComputedStyle(board).getPropertyValue('--strings').trim() === 'off') {
        setGeo(null);
        return;
      }
      const from = { x: e.right - b.left, y: e.top + e.height / 2 - b.top };
      const curves: Record<string, Curve> = {};
      for (const [id, el] of anchors.current) {
        const r = el.getBoundingClientRect();
        curves[id] = curveBetween(from, { x: r.left + r.width / 2 - b.left, y: r.top + r.height / 2 - b.top });
      }
      setGeo({ w: b.width, h: b.height, curves });
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    const ro = new ResizeObserver(schedule);
    ro.observe(board);
    const scroller = board.closest('[data-scroll-root]');
    scroller?.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      ro.disconnect();
      scroller?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ids]);

  // Requests as particles running along the strings. Sleeps when nothing flows; off with reduced motion.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || reducedMotion()) return;
    const ctx = canvas.getContext('2d')!;
    const css = (v: string, d: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || d;
    let colors = { signal: css('--signal', '#d4f25a'), err: css('--err', '#ff6b5b') };
    const themeObs = new MutationObserver(() => (colors = { signal: css('--signal', '#d4f25a'), err: css('--err', '#ff6b5b') }));
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    type P = { id: string; t: number; speed: number; err: boolean; size: number };
    let parts: P[] = [];
    const acc = new Map<string, number>();
    let running = false;
    let stop: (() => void) | null = null;
    let size = { w: 0, h: 0, dpr: 1 };

    const loop = (dt: number) => {
      const g = geoRef.current;
      if (!g) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        parts = [];
        running = false;
        return false;
      }
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (size.w !== g.w || size.h !== g.h || size.dpr !== dpr) {
        size = { w: g.w, h: g.h, dpr };
        canvas.width = Math.round(g.w * dpr);
        canvas.height = Math.round(g.h * dpr);
        canvas.style.width = `${g.w}px`;
        canvas.style.height = `${g.h}px`;
      }
      let flowing = false;
      for (const [id, l] of liveRef.current) {
        const rate = particleRate(l.rps);
        if (!rate || !g.curves[id]) continue;
        flowing = true;
        const errFrac = l.rps > 0 ? Math.min(1, l.errors / l.rps) : 0;
        let a = (acc.get(id) ?? Math.random()) + rate * dt;
        while (a >= 1 && parts.length < 600) {
          a -= 1;
          parts.push({ id, t: 0, speed: 0.55 + Math.random() * 0.35, err: Math.random() < errFrac, size: 1.6 + Math.random() * 1.2 });
        }
        acc.set(id, a % 1);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, g.w, g.h);
      const next: P[] = [];
      for (const p of parts) {
        p.t += p.speed * dt;
        const c = g.curves[p.id];
        if (p.t >= 1 || !c) continue;
        const pt = at(c, p.t);
        const fade = Math.min(1, p.t * 6, (1 - p.t) * 6);
        ctx.globalAlpha = 0.9 * fade;
        ctx.fillStyle = p.err ? colors.err : colors.signal;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        next.push(p);
      }
      ctx.globalAlpha = 1;
      parts = next;
      if (!flowing && parts.length === 0) {
        running = false;
        return false;
      }
      return true;
    };
    const wake = () => {
      if (running) return;
      running = true;
      stop = ticker.add(loop);
    };
    wake();
    traffic.subs.add(wake);
    return () => {
      traffic.subs.delete(wake);
      themeObs.disconnect();
      running = false;
      stop?.();
      parts = [];
    };
  }, []);

  return (
    <div className="traffic-board" ref={boardRef}>
      {geo && (
        <svg className="traffic-strings" width={geo.w} height={geo.h} aria-hidden>
          {rows.map((r) => {
            const c = geo.curves[r.project.id];
            if (!c) return null;
            const l = live.get(r.project.id)!;
            const active = l.active;
            const err = active && l.errors > 0.01 && l.errors / Math.max(l.rps, 0.01) > 0.05;
            const tcpOnly = r.httpIds.length === 0;
            return (
              <path
                key={r.project.id}
                d={pathOf(c)}
                className={`traffic-string ${active ? 'live' : ''} ${err ? 'err' : ''} ${tcpOnly ? 'tcp' : ''} ${day.get(r.project.id)!.requests === 0 && !active ? 'idle' : ''}`}
                style={{ strokeWidth: strokeFor(l.rps) }}
              />
            );
          })}
        </svg>
      )}
      <canvas className="traffic-particles" ref={canvasRef} aria-hidden />

      <div className="traffic-edge-col">
        <div className="traffic-edge card" ref={edgeRef}>
          <div className="traffic-internet faint">
            <Icon name="globe" size={13} /> Internet
          </div>
          <div className="traffic-edge-icon">
            <Icon name="network" size={22} />
          </div>
          <div className="traffic-edge-title">Router</div>
          <div className="faint traffic-edge-sub">
            {edge.https ? `:${edge.https} HTTPS` : ''}
            {edge.https && edge.http ? ' · ' : ''}
            {edge.http ? `:${edge.http} HTTP` : ''}
          </div>
          <div className={`traffic-edge-rate ${edge.active ? 'live' : ''}`}>
            {fmtRate(edge.rps)}
            <span>req/s</span>
          </div>
          <div className="faint traffic-edge-sub">
            {edge.domains} domain{edge.domains === 1 ? '' : 's'} · {edge.projects} project{edge.projects === 1 ? '' : 's'}
          </div>
          {!edge.connected && <div className="traffic-edge-warn">Reconnecting…</div>}
        </div>
      </div>

      <div className="traffic-rows">
        {rows.map((r) => (
          <ProjectRow
            key={r.project.id}
            row={r}
            live={live.get(r.project.id)!}
            day={day.get(r.project.id)!}
            anchorRef={(el) => {
              if (el) anchors.current.set(r.project.id, el);
              else anchors.current.delete(r.project.id);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function Spark({ data, tone }: { data: number[]; tone: string }) {
  const max = Math.max(0.5, ...data);
  const w = 84;
  const h = 22;
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(h - 1 - (v / max) * (h - 3)).toFixed(1)}`).join(' ');
  return (
    <svg className={`traffic-spark ${tone}`} width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polyline points={pts} fill="none" />
    </svg>
  );
}

function ProjectRow({ row, live, day, anchorRef }: { row: Row; live: Live; day: Totals; anchorRef: (el: HTMLElement | null) => void }) {
  const active = live.active;
  const errs = active && live.errors > 0.01;
  const idle = !active && day.requests === 0;
  const extra = row.domains.length - 2;
  return (
    <button className={`traffic-row card ${active ? 'live' : ''} ${idle ? 'idle' : ''} ${errs ? 'err' : ''}`} onClick={() => navigate(projectPath(row.project.slug))}>
      <span className="traffic-anchor" ref={anchorRef} />
      <ProjectMark project={row.project} size={22} />
      <div className="traffic-row-main">
        <div className="traffic-row-name truncate">{row.label}</div>
        <div className="traffic-routes">
          {row.domains.slice(0, 2).map((d) => (
            <span key={d} className="traffic-chip truncate">
              {d}
            </span>
          ))}
          {extra > 0 && <span className="traffic-chip faint">+{extra}</span>}
          {row.tcp.map((t) => (
            <span key={t.port} className="traffic-chip tcp" title={`${t.name}: TCP port ${t.port}`}>
              :{t.port}
            </span>
          ))}
          {row.internal && <span className="faint">internal only</span>}
          {!row.internal && row.domains.length === 0 && row.tcp.length === 0 && <span className="faint">Servify URL</span>}
        </div>
      </div>
      {row.httpIds.length > 0 ? (
        <>
          <Spark data={live.history} tone={errs ? 'err' : active ? 'live' : 'idle'} />
          <div className="traffic-row-nums">
            <div className={`traffic-row-rate ${active ? 'live' : ''}`}>
              {fmtRate(live.rps)}
              <span>req/s</span>
            </div>
            <div className="faint traffic-row-day">
              {day.requests ? `${fmtCount(day.requests)} · ${fmtCount(day.visitors)} people` : 'quiet today'}
              {day.errors > 0 && <span className="traffic-row-errs"> · {fmtCount(day.errors)} errors</span>}
            </div>
          </div>
        </>
      ) : (
        <div className="traffic-row-nums faint traffic-row-day">TCP only</div>
      )}
    </button>
  );
}

// ───────────────────────────── live request feed ─────────────────────────────

function Feed({ where }: { where: Map<string, { row: Row; service: ProjectListService }> }) {
  const [entries, setEntries] = useState<Recent[]>([]);
  const [hideBots, setHideBots] = useState(false);
  const last = useRef<number | undefined>(undefined);
  const entering = useRef(new Set<number>());

  useEffect(() => {
    let alive = true;
    // Requests arrive in batches every 2 s; let them in one at a time, spread over the next 2 s, so the list flows.
    const queue: Recent[] = [];
    let drip: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      drip = undefined;
      if (!alive || !queue.length) return;
      // Under heavy traffic, let several in per step rather than falling behind.
      const take = Math.max(1, Math.ceil(queue.length / 25));
      const batch = queue.splice(0, take);
      for (const e of batch) entering.current.add(e.id);
      setEntries((prev) => [...batch.reverse(), ...prev].slice(0, 80));
      if (queue.length) drip = setTimeout(release, Math.max(60, Math.min(400, 1800 / Math.max(1, queue.length / take))));
    };
    const load = async () => {
      try {
        const r = await api.get<{ entries: Recent[]; last: number }>(`/access-log/recent?limit=60${last.current !== undefined ? `&after=${last.current}` : ''}`);
        if (!alive) return;
        const first = last.current === undefined;
        last.current = r.last;
        if (!r.entries.length) return;
        if (first) {
          setEntries(r.entries);
          return;
        }
        queue.push(...[...r.entries].reverse()); // oldest first
        if (queue.length > 120) queue.splice(0, queue.length - 120);
        if (!drip) release();
      } catch {}
    };
    void load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
      if (drip) clearTimeout(drip);
    };
  }, []);

  const list = hideBots ? entries.filter((e) => !e.bot) : entries;
  return (
    <aside className="traffic-feed card">
      <div className="traffic-feed-head">
        <span className="traffic-feed-dot" />
        <span className="traffic-feed-title">Live requests</span>
        <div className="spacer" />
        <button className={`btn btn-ghost btn-sm ${hideBots ? 'active' : ''}`} onClick={() => setHideBots((v) => !v)}>
          <Icon name="bot" size={13} />
          {hideBots ? 'Bots hidden' : 'Hide bots'}
        </button>
      </div>
      <div className="traffic-feed-list">
        {list.length === 0 ? (
          <div className="faint traffic-feed-empty">Waiting for requests…</div>
        ) : (
          list.map((e) => {
            const w = where.get(e.serviceId);
            const cls = e.status >= 500 ? 'err' : e.status >= 400 ? 'warn' : e.status >= 300 ? 'redir' : 'ok';
            return (
              <div key={e.id} className={`traffic-req-wrap ${entering.current.has(e.id) ? 'enter' : ''}`} onAnimationEnd={() => entering.current.delete(e.id)}>
              <button className="traffic-req" onClick={() => w && navigate(projectPath(w.row.project.slug))} title={`${e.method} ${e.host}${e.path} — ${e.status} in ${Math.round(e.ms)} ms`}>
                <span className="traffic-req-in">
                <span className={`traffic-status ${cls}`}>{e.status}</span>
                <span className="traffic-req-main">
                  <span className="traffic-req-path truncate">
                    <span className="faint">{e.method !== 'GET' ? `${e.method} ` : ''}</span>
                    {e.host}
                    <span className="faint">{e.path}</span>
                  </span>
                  <span className="traffic-req-meta faint truncate">
                    {clock(e.ts)}
                    {w ? ` · ${w.row.label}` : ''}
                    {e.refHost ? ` · from ${e.refHost}` : ''}
                  </span>
                </span>
                {e.bot && <span className="traffic-bot">{e.botName ?? 'bot'}</span>}
                </span>
              </button>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
