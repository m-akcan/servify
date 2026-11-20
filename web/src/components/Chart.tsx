import { useMemo, useRef, useState } from 'react';
import { useMeasure } from '../motion/hooks.ts';
import { clock } from '../lib/format.ts';

export type Series = { key: string; label: string; color: string; values: number[]; fill?: boolean; dashed?: boolean };

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return nice * p;
}

/** Hand-rolled SVG time-series chart with hover crosshair. */
export function Chart({ times, series, height = 140, format = (v: number) => v.toFixed(1), unit = '', step = false }: { times: number[]; series: Series[]; height?: number; format?: (v: number) => string; unit?: string; step?: boolean }) {
  const [wrapRef, { width }] = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const padL = 40;
  const padR = 8;
  const padT = 10;
  const padB = 20;
  const W = Math.max(100, width);
  const H = height;
  const n = times.length;
  const longSpan = n > 1 && times[n - 1] - times[0] > 20 * 3600_000;
  const label = (t: number) => (longSpan ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : clock(t));
  const max = niceMax(Math.max(0.0001, ...series.flatMap((s) => s.values)) * 1.08);
  const x = (i: number) => padL + (n <= 1 ? 0 : (i / (n - 1)) * (W - padL - padR));
  const y = (v: number) => padT + (1 - v / max) * (H - padT - padB);

  const paths = useMemo(
    () =>
      series.map((s) => {
        if (n < 2) return { line: '', area: '' };
        let line = '';
        s.values.forEach((v, i) => {
          const px = x(i).toFixed(1);
          const py = y(v).toFixed(1);
          if (i === 0) line += `M${px},${py}`;
          else if (step) line += `H${px}V${py}`;
          else line += `L${px},${py}`;
        });
        const area = `${line} L${x(n - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
        return { line, area };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, W, max, n],
  );

  const ticks = [0, 0.5, 1].map((f) => max * f);
  const onMove = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    const px = e.clientX - r.left;
    const i = Math.round(((px - padL) / (W - padL - padR)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  return (
    <div className="chart" ref={wrapRef}>
      {width > 0 && (
        <svg ref={svgRef} width={W} height={H} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          <defs>
            {series.map((s) => (
              <linearGradient key={s.key} id={`g-${s.key}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor={s.color} stopOpacity="0.28" />
                <stop offset="1" stopColor={s.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className="chart-grid" />
              <text x={padL - 6} y={y(t) + 3} textAnchor="end" className="chart-axis">
                {format(t)}
              </text>
            </g>
          ))}
          {n > 1 && (
            <>
              <text x={padL} y={H - 4} className="chart-axis">
                {label(times[0])}
              </text>
              <text x={W - padR} y={H - 4} textAnchor="end" className="chart-axis">
                now
              </text>
            </>
          )}
          {series.map((s, i) => (
            <g key={s.key}>
              {s.fill !== false && <path d={paths[i].area} fill={`url(#g-${s.key})`} />}
              <path d={paths[i].line} fill="none" stroke={s.color} strokeWidth={1.6} strokeLinejoin="round" strokeDasharray={s.dashed ? '3 3' : undefined} />
            </g>
          ))}
          {hover !== null && n > 1 && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H - padB} className="chart-cross" />
              {series.map((s) => (
                <circle key={s.key} cx={x(hover)} cy={y(s.values[hover] ?? 0)} r={3.5} fill="var(--bg-1)" stroke={s.color} strokeWidth={2} />
              ))}
            </g>
          )}
        </svg>
      )}
      {hover !== null && n > 1 && (
        <div className="chart-tip" style={{ left: Math.min(W - 150, Math.max(0, x(hover) + 10)) }}>
          <div className="faint mono" style={{ fontSize: 10 }}>
            {label(times[hover])}
          </div>
          {series.map((s) => (
            <div key={s.key} className="row" style={{ gap: 6 }}>
              <span className="chart-dot" style={{ background: s.color }} />
              <span className="grow">{s.label}</span>
              <b className="mono">
                {format(s.values[hover] ?? 0)}
                {unit}
              </b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
