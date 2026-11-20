import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { registry, connect, bezierPath, INGRESS_ID, type Rect } from './geometry.ts';
import type { ServiceView } from '../lib/types.ts';
import { Spring, springs } from '../motion/spring.ts';
import { useTraffic, traffic } from '../lib/store.ts';
import { num } from '../lib/format.ts';
import { Icon } from '../components/Icon.tsx';

export type EdgeSpec = { id: string; from: string; to: string; kind: 'ingress' | 'ref'; label?: string; active: boolean };

/** Hook: re-render on registry changes, coalesced to one render per frame. */
function useRegistryVersion() {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0;
    const off = registry.subscribe(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setV(registry.version);
      });
    });
    // Nodes register in layout effects, before this passive effect subscribes: catch up now.
    setV(registry.version);
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  }, []);
  return v;
}

export function EdgesLayer({ edges, highlight, draft }: { edges: EdgeSpec[]; highlight: string | null; draft?: { from: string; x: number; y: number; over: string | null } | null }) {
  useRegistryVersion();
  let draftPath: string | null = null;
  if (draft) {
    const a = registry.rects.get(draft.from);
    const b = draft.over ? registry.rects.get(draft.over) : null;
    if (a) draftPath = bezierPath(connect(a, b ?? { x: draft.x - 1, y: draft.y - 1, w: 2, h: 2 }));
  }
  return (
    <svg className="edges" width="1" height="1" style={{ overflow: 'visible' }}>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M1,1 L9,5 L1,9" fill="none" stroke="var(--line-3)" strokeWidth="1.6" strokeLinecap="round" />
        </marker>
      </defs>
      {draftPath && <path d={draftPath} className={`edge-draft ${draft?.over ? 'locked' : ''}`} />}
      {edges.map((e) => {
        const a = registry.rects.get(e.from);
        const b = registry.rects.get(e.to);
        if (!a || !b) return null;
        const bz = connect(a, b);
        const d = bezierPath(bz);
        const hl = highlight && (e.from === highlight || e.to === highlight);
        const gid = `g-${e.id}`;
        return (
          <g key={e.id} className={`edge edge-${e.kind} ${e.active ? 'active' : ''} ${hl ? 'hl' : ''}`}>
            {e.kind === 'ingress' && (
              <defs>
                {/* userSpaceOnUse: objectBoundingBox gradients vanish on perfectly straight paths */}
                <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1={bz.p0.x} y1={bz.p0.y} x2={bz.p3.x} y2={bz.p3.y}>
                  <stop offset="0" stopColor="var(--signal)" stopOpacity="0.15" />
                  <stop offset="1" stopColor="var(--signal)" stopOpacity="0.6" />
                </linearGradient>
              </defs>
            )}
            <path d={d} className="edge-halo" />
            <path d={d} className="edge-line" style={e.kind === 'ingress' && e.active && !hl ? { stroke: `url(#${gid})` } : undefined} markerEnd={e.kind === 'ref' ? 'url(#arrow)' : undefined} />
            {e.label && (
              <EdgeLabel x={(bz.p0.x + bz.p3.x) / 2} y={(bz.p0.y + bz.p3.y) / 2} label={e.label} />
            )}
          </g>
        );
      })}
    </svg>
  );
}

function EdgeLabel({ x, y, label }: { x: number; y: number; label: string }) {
  const w = label.length * 6.4 + 14;
  return (
    <g transform={`translate(${x - w / 2}, ${y - 9})`} className="edge-label">
      <rect width={w} height={18} rx={5} />
      <text x={w / 2} y={12.5} textAnchor="middle">
        {label}
      </text>
    </g>
  );
}

/** The edge router: where outside traffic enters the project. Auto-positioned left of the cluster. */
export function IngressNode({ services, proxyPort, visible }: { services: ServiceView[]; proxyPort: number; visible: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useRef<{ x: Spring; y: Spring; a: Spring } | null>(null);
  useTraffic(null);
  const total = services.reduce((sum, s) => sum + (traffic.data[s.id]?.rps ?? 0), 0);
  const publicCount = services.filter((s) => (s.protocol === 'http' && s.publicHttp) || s.publicTcpPort).length;

  // Target: left of the public services' bounding box, vertically centred.
  const pubIds = services.filter((s) => (s.protocol === 'http' && s.publicHttp) || s.publicTcpPort).map((s) => s.id);
  const rects = services.map((s) => ({ x: s.x, y: s.y, w: 256, h: 132 }));
  const pubRects = services.filter((s) => pubIds.includes(s.id)).map((s) => ({ x: s.x, y: s.y, w: 256, h: 132 }));
  const minX = rects.length ? Math.min(...rects.map((r) => r.x)) : 0;
  const ys = (pubRects.length ? pubRects : rects).map((r) => r.y + r.h / 2);
  const cy = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 0;
  const tx = minX - 300;
  const ty = cy - 46;

  useLayoutEffect(() => {
    if (!pos.current) {
      const x = new Spring(tx, springs.smooth);
      const y = new Spring(ty, springs.smooth);
      const a = new Spring(0, springs.smooth);
      const apply = () => {
        const el = ref.current;
        if (!el) return;
        el.style.transform = `translate3d(${x.value}px, ${y.value}px, 0) scale(${0.9 + 0.1 * a.value})`;
        el.style.opacity = String(a.value);
        registry.set(INGRESS_ID, { x: x.value, y: y.value, w: el.offsetWidth || 168, h: el.offsetHeight || 92 });
      };
      x.onChange(apply);
      y.onChange(apply);
      a.onChange(apply);
      pos.current = { x, y, a };
      apply();
    }
    pos.current.x.set(tx);
    pos.current.y.set(ty);
    pos.current.a.set(visible ? 1 : 0);
  }, [tx, ty, visible]);

  useEffect(() => () => registry.delete(INGRESS_ID), []);

  return (
    <div className="ingress" ref={ref} aria-label="Edge router">
      <div className="ingress-head">
        <div className="ingress-icon">
          <Icon name="globe" size={15} />
        </div>
        <div className="grow">
          <div className="ingress-title">Edge</div>
          <div className="ingress-sub mono">:{proxyPort}</div>
        </div>
      </div>
      <div className="ingress-stats">
        <span className="tnum">
          <b>{num(total)}</b> req/s
        </span>
        <span className="faint">{publicCount} routed</span>
      </div>
    </div>
  );
}

export type { Rect };
