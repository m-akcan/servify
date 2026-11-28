/**
 * Small hand-drawn SVG charts for the Traffic screen (no chart library: the APK stays small).
 *
 * The area chart is placed by time, not by index: on new data it redraws its ~100 points in screen coordinates (time
 * slides left), and only while the y-scale eases to a new maximum does it animate frame by frame. Animation is done with SVG attributes inside the chart, never CSS
 * transforms, scaled matrices or backdrop filters (Android WebViews left stale copies of the chart on screen with
 * those; see also the WebView note in styles.css).
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

const reduced = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/** A smooth curve through the points that never overshoots (monotone cubic, Fritsch–Carlson). */
function monotone(xs: number[], ys: number[]): string {
  const n = xs.length;
  if (!n) return '';
  if (n === 1) return `M${xs[0]},${ys[0]}`;
  const d: number[] = [];
  const m: number[] = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i] || 1e-9));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  const f = (v: number) => (Math.round(v * 1000) / 1000).toString();
  let p = `M${f(xs[0])},${f(ys[0])}`;
  for (let i = 0; i < n - 1; i++) {
    const h = (xs[i + 1] - xs[i]) / 3;
    p += `C${f(xs[i] + h)},${f(ys[i] + m[i] * h)} ${f(xs[i + 1] - h)},${f(ys[i + 1] - m[i + 1] * h)} ${f(xs[i + 1])},${f(ys[i + 1])}`;
  }
  return p;
}

/** A round number just above `v` for the top of the y-axis (never zero, so a quiet chart stays flat at the bottom). */
function niceMax(v: number): number {
  const x = Math.max(v * 1.18, 0.5);
  const e = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
}

export type AreaPoint = { t: number; rps: number; err: number };

const PAD_T = 14;
const PAD_B = 22;

export function AreaChart({
  points,
  rangeMs,
  height = 176,
  running,
  fmt,
  timeLabel,
}: {
  points: AreaPoint[];
  rangeMs: number;
  height?: number;
  /** Animate (the app is in front). */
  running: boolean;
  fmt: (v: number) => string;
  timeLabel: (t: number) => string;
}) {
  const id = 'ac' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(320);
  const refs = {
    area: useRef<SVGPathElement>(null),
    line: useRef<SVGPathElement>(null),
    glow: useRef<SVGPathElement>(null),
    errArea: useRef<SVGPathElement>(null),
    errLine: useRef<SVGPathElement>(null),
    dot: useRef<SVGGElement>(null),
    top: useRef<SVGTextElement>(null),
    mid: useRef<SVGTextElement>(null),
  };
  const shown = useRef<number | null>(null); // the y-axis maximum as drawn (eases toward the target)
  const [scrub, setScrub] = useState<{ x: number; p: AreaPoint } | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(120, Math.round(el.clientWidth))));
    ro.observe(el);
    setW(Math.max(120, Math.round(el.clientWidth)));
    return () => ro.disconnect();
  }, []);

  const plotH = height - PAD_T - PAD_B;
  const base = height - PAD_B;
  const hasErr = points.some((p) => p.err > 0);
  const target = niceMax(points.reduce((a, p) => Math.max(a, p.rps), 0));
  const last = points[points.length - 1];

  // Everything that moves, per frame: plain screen coordinates (about a hundred points, cheap to rebuild), so the
  // WebView only ever repaints this one SVG. Kept in a ref so the loop always sees the latest data.
  const frame = useRef<() => void>(() => {});
  frame.current = () => {
    const now = Date.now();
    const snap = reduced();
    if (shown.current === null) shown.current = snap ? target : target * 3; // first paint: the area rises into place
    const prev = shown.current;
    shown.current = snap ? target : prev + (target - prev) * 0.14;
    if (Math.abs(shown.current - target) < target * 0.002) shown.current = target;
    const max = shown.current;
    const xs = points.map((p) => w - ((now - p.t) / rangeMs) * w);
    const yOfV = (v: number) => base - (Math.max(0, v) / max) * plotH;
    const line = monotone(xs, points.map((p) => yOfV(p.rps)));
    const close = xs.length ? `L${xs[xs.length - 1].toFixed(2)},${base}L${xs[0].toFixed(2)},${base}Z` : '';
    refs.area.current?.setAttribute('d', line ? line + close : '');
    refs.line.current?.setAttribute('d', line);
    refs.glow.current?.setAttribute('d', line);
    if (hasErr) {
      const el = monotone(xs, points.map((p) => yOfV(p.err)));
      refs.errArea.current?.setAttribute('d', el ? el + close : '');
      refs.errLine.current?.setAttribute('d', el);
    }
    if (last && refs.dot.current) refs.dot.current.setAttribute('transform', `translate(${xs[xs.length - 1].toFixed(1)} ${yOfV(last.rps).toFixed(1)})`);
    if (refs.top.current) refs.top.current.textContent = fmt(max);
    if (refs.mid.current) refs.mid.current.textContent = fmt(max / 2);
  };

  useEffect(() => {
    // Redraw on new data (about once a second while live) and animate only while the y-scale eases: an SVG redrawn
    // at 30 fps inside the scroll area made the emulator's WebView paint stale tiles all over the screen.
    frame.current();
    if (!running || shown.current === target) return;
    let raf = 0;
    const loop = () => {
      frame.current();
      if (shown.current !== target) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running, w, points, target, rangeMs, hasErr]);

  // Long ranges get no new points for minutes: keep time moving anyway.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => frame.current(), 5000);
    return () => clearInterval(t);
  }, [running]);

  const onTouch = (clientX: number) => {
    const el = wrap.current;
    if (!el || !points.length) return;
    const x = Math.max(0, Math.min(w, clientX - el.getBoundingClientRect().left));
    const t = Date.now() - ((w - x) / w) * rangeMs;
    let best = points[0];
    for (const p of points) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    setScrub({ x: w - ((Date.now() - best.t) / rangeMs) * w, p: best });
  };
  const yOf = (v: number) => base - (v / (shown.current ?? target)) * plotH;

  return (
    <div
      ref={wrap}
      className="area"
      style={{ height }}
      onTouchStart={(e) => {
        e.stopPropagation(); // not a pull-to-refresh
        onTouch(e.touches[0].clientX);
      }}
      onTouchMove={(e) => {
        e.stopPropagation();
        onTouch(e.touches[0].clientX);
      }}
      onTouchEnd={(e) => {
        e.stopPropagation();
        setScrub(null);
      }}
    >
      <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} aria-hidden>
        <defs>
          {/* In screen units, so a flat (all-zero) series still gets its gradient. */}
          <linearGradient id={`${id}g`} gradientUnits="userSpaceOnUse" x1="0" y1={PAD_T} x2="0" y2={base}>
            <stop offset="0" style={{ stopColor: 'var(--signal)', stopOpacity: 0.42 }} />
            <stop offset="0.55" style={{ stopColor: 'var(--signal)', stopOpacity: 0.12 }} />
            <stop offset="1" style={{ stopColor: 'var(--signal)', stopOpacity: 0 }} />
          </linearGradient>
          <linearGradient id={`${id}e`} gradientUnits="userSpaceOnUse" x1="0" y1={PAD_T} x2="0" y2={base}>
            <stop offset="0" style={{ stopColor: 'var(--err)', stopOpacity: 0.5 }} />
            <stop offset="1" style={{ stopColor: 'var(--err)', stopOpacity: 0.05 }} />
          </linearGradient>
        </defs>
        {/* grid */}
        <g className="area-grid">
          <line x1="0" x2={w} y1={PAD_T} y2={PAD_T} />
          <line x1="0" x2={w} y1={PAD_T + plotH / 2} y2={PAD_T + plotH / 2} />
          <line x1="0" x2={w} y1={base} y2={base} className="base" />
          <text ref={refs.top} x={w - 2} y={PAD_T - 3} textAnchor="end" />
          <text ref={refs.mid} x={w - 2} y={PAD_T + plotH / 2 - 3} textAnchor="end" />
        </g>
        <path ref={refs.area} fill={`url(#${id}g)`} />
        {hasErr && <path ref={refs.errArea} fill={`url(#${id}e)`} />}
        <path ref={refs.glow} className="area-glow" />
        <path ref={refs.line} className="area-line" />
        {hasErr && <path ref={refs.errLine} className="area-err" />}
        {last && (
          <g ref={refs.dot}>
            <circle r="9" className="area-pulse" />
            <circle r="3.5" className="area-dot" />
          </g>
        )}
        <text x="2" y={height - 6} className="area-axis">
          {timeLabel(Date.now() - rangeMs)}
        </text>
        <text x={w / 2} y={height - 6} className="area-axis" textAnchor="middle">
          {timeLabel(Date.now() - rangeMs / 2)}
        </text>
        <text x={w - 2} y={height - 6} className="area-axis" textAnchor="end">
          now
        </text>
        {scrub && (
          <g className="area-scrub">
            <line x1={scrub.x} x2={scrub.x} y1={PAD_T - 6} y2={base} />
            <circle cx={scrub.x} cy={yOf(scrub.p.rps)} r="4" />
          </g>
        )}
      </svg>
      {scrub && (
        <div className="area-tip" style={{ left: Math.max(8, Math.min(w - 132, scrub.x - 62)) }}>
          <b className="mono">{fmt(scrub.p.rps)}</b> req/s
          {scrub.p.err > 0 && (
            <span style={{ color: 'var(--err)' }}>
              {' '}
              · {fmt(scrub.p.err)} 5xx/s
            </span>
          )}
          <div className="faint mono">{new Date(scrub.p.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: rangeMs <= 3600_000 ? '2-digit' : undefined })}</div>
        </div>
      )}
    </div>
  );
}

/** A number that counts toward its new value instead of jumping. */
export function Counter({ value, fmt }: { value: number; fmt: (v: number) => string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const cur = useRef(value);
  useEffect(() => {
    if (reduced() || !Number.isFinite(value)) {
      cur.current = value;
      setShown(value);
      return;
    }
    from.current = cur.current;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 650);
      const e = 1 - Math.pow(1 - k, 3);
      cur.current = from.current + (value - from.current) * e;
      setShown(cur.current);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{fmt(shown)}</>;
}

export type Slice = { key: string; label: string; n: number; color: string };

/** A ring split by share, with the gaps drawn as real gaps; segments ease to new sizes. */
export function Donut({ slices, size = 128, center }: { slices: Slice[]; size?: number; center: ReactNode }) {
  const total = slices.reduce((a, s) => a + s.n, 0);
  const r = size / 2 - 9;
  const c = 2 * Math.PI * r;
  const shown = slices.filter((s) => s.n > 0);
  const gap = shown.length > 1 ? 3 : 0;
  let acc = 0;
  return (
    <div className="donut" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} className="donut-track" />
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {total > 0 &&
            shown.map((s) => {
              const len = (s.n / total) * c;
              const el = (
                <circle
                  key={s.key}
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  className="donut-seg"
                  style={{ stroke: s.color, strokeDasharray: `${Math.max(0.01, len - gap)} ${c}`, strokeDashoffset: -acc }}
                />
              );
              acc += len;
              return el;
            })}
        </g>
      </svg>
      <div className="donut-center">{center}</div>
    </div>
  );
}

export type Bar = { key: string; label: ReactNode; n: number; sub?: ReactNode; onClick?: () => void; lead?: ReactNode };

/** Ranked rows with a bar behind each, longest first. */
export function BarList({ items, total, mono, tone = 'var(--signal)' }: { items: Bar[]; total?: number; mono?: boolean; tone?: string }) {
  const max = Math.max(1, ...items.map((i) => i.n));
  return (
    <div className="bars" style={{ ['--bar' as any]: tone }}>
      {items.map((it, i) => {
        const Tag = it.onClick ? 'button' : 'div';
        return (
          <Tag key={it.key} className="bar-row" onClick={it.onClick} style={{ ['--i' as any]: i }}>
            <span className="bar-fill" style={{ width: `${Math.max(2, (it.n / max) * 100)}%` }} />
            {it.lead}
            <span className={`grow ellipsis bar-label${mono ? ' mono' : ''}`}>{it.label}</span>
            {it.sub && <span className="bar-sub">{it.sub}</span>}
            <span className="bar-n mono">
              {it.n.toLocaleString()}
              {total ? <small> {Math.round((it.n / total) * 100)}%</small> : null}
            </span>
          </Tag>
        );
      })}
    </div>
  );
}

/** Columns for the latency histogram, coloured from quick to slow. */
export function Histogram({ values, labels, colors }: { values: number[]; labels: string[]; colors: string[] }) {
  const max = Math.max(1, ...values);
  return (
    <div className="hist">
      {values.map((v, i) => (
        <div key={i} className="hist-col">
          <div className="hist-track">
            <span className="hist-bar" style={{ height: `${v ? Math.max(4, (v / max) * 100) : 0}%`, background: colors[i], ['--i' as any]: i }} />
          </div>
          <span className="hist-label mono">{labels[i]}</span>
        </div>
      ))}
    </div>
  );
}
