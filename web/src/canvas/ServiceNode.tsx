import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Deployment, Replica, ServiceView } from '../lib/types.ts';
import { SpringGroup, springs, Spring } from '../motion/spring.ts';
import { registry, snap, NODE_W, type Camera } from './geometry.ts';
import { ServiceGlyph, Icon } from '../components/Icon.tsx';
import { serviceTone, serviceLabel, num, isBusy } from '../lib/format.ts';
import { useTraffic, traffic, useDeployTail } from '../lib/store.ts';
import { duration } from '../lib/format.ts';

type Props = {
  service: ServiceView;
  replicas: Replica[];
  latest: Deployment | null;
  selected: boolean;
  getCamera: () => Camera;
  onSelect: (id: string) => void;
  onOpenMenu: (id: string, x: number, y: number) => void;
  onMoved: (id: string, x: number, y: number, fromX: number, fromY: number) => void;
  onDragState: (dragging: boolean) => void;
  onStartConnect: (id: string, e: React.PointerEvent) => void;
  onFocusNode: (id: string) => void;
  connectTarget: boolean;
  index: number;
};

function sourceLine(s: ServiceView) {
  if (s.source.type === 'image') return s.source.image;
  if (s.source.type === 'git') return s.source.repo.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '') + (s.source.branch ? `@${s.source.branch}` : '');
  return s.source.path.replace(/^\/Users\/[^/]+/, '~');
}

function Sparkline({ serviceId }: { serviceId: string }) {
  useTraffic(serviceId);
  const h = traffic.history[serviceId] ?? [];
  const pts = h.slice(-30);
  if (pts.length < 2 || pts.every((v) => v === 0)) return <svg className="spark" width="64" height="18" />;
  const max = Math.max(1, ...pts);
  const W = 64;
  const H = 18;
  const step = W / (pts.length - 1);
  const d = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(H - 2 - (v / max) * (H - 4)).toFixed(1)}`).join(' ');
  return (
    <svg className="spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <path d={`${d} L${W},${H} L0,${H} Z`} className="spark-fill" />
      <path d={d} className="spark-line" />
    </svg>
  );
}

function Pips({ service, replicas }: { service: ServiceView; replicas: Replica[] }) {
  const t = useTraffic(service.id);
  const active = replicas.filter((r) => r.deploymentId === service.activeDeploymentId || r.state === 'starting');
  const shown = active.slice(0, 12);
  const desired = service.stopped ? 0 : service.replicas;
  const ghosts = Math.max(0, Math.min(12, desired) - shown.length);
  const maxRps = Math.max(1, ...shown.map((r) => t?.replicas[r.containerId] ?? 0));
  return (
    <div className="pips">
      {shown.map((r) => {
        const load = (t?.replicas[r.containerId] ?? 0) / maxRps;
        return <span key={r.containerId} className="pip" data-state={r.state} style={{ ['--load' as any]: load.toFixed(2) }} title={`#${r.index} · ${r.state}`} />;
      })}
      {Array.from({ length: ghosts }, (_, i) => (
        <span key={`g${i}`} className="pip" data-state="pending" />
      ))}
    </div>
  );
}

const STAGES = ['queued', 'building', 'deploying'] as const;

/** Live deploy progress on the card: three-stage rail + the latest log line. */
function DeployTicker({ service, latest }: { service: ServiceView; latest: Deployment }) {
  const tail = useDeployTail(service.id, true);
  const [, tick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, []);
  const stage = STAGES.indexOf(latest.status as (typeof STAGES)[number]);
  const fresh = tail && tail.ts >= latest.createdAt;
  const label = latest.status === 'queued' ? 'Queued' : latest.status === 'building' ? (latest.config.source.type === 'image' ? 'Pulling' : 'Building') : 'Starting replicas';
  return (
    <div className="ticker">
      <div className="ticker-rail">
        {['Build', 'Deploy', 'Live'].map((name, i) => (
          <span key={name} className="ticker-seg" data-state={i < stage ? 'done' : i === stage ? 'active' : 'todo'} />
        ))}
      </div>
      <div className="ticker-meta">
        <span>{label}</span>
        <span className="tnum faint">{duration(Date.now() - (latest.startedAt ?? latest.createdAt))}</span>
      </div>
      <div className="ticker-line mono truncate" key={fresh ? tail!.ts : 'none'}>
        {fresh ? tail!.line : latest.status === 'queued' ? 'Waiting for the previous deploy…' : '…'}
      </div>
    </div>
  );
}

export const ServiceNode = memo(function ServiceNode({ service: s, replicas, latest, selected, getCamera, onSelect, onOpenMenu, onMoved, onDragState, onStartConnect, onFocusNode, connectTarget, index }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const deckRef = useRef<HTMLDivElement>(null);
  const group = useRef<SpringGroup<'x' | 'y' | 'lift' | 'appear'> | null>(null);
  const dragging = useRef(false);
  const [isDragging, setDragging] = useState(false);
  const t = useTraffic(s.id);

  if (!group.current) group.current = new SpringGroup({ x: s.x, y: s.y, lift: 0, appear: 0 }, springs.smooth);

  // Apply spring values to the DOM + registry without React re-renders.
  useLayoutEffect(() => {
    const g = group.current!;
    const apply = (v: Record<'x' | 'y' | 'lift' | 'appear', number>) => {
      const el = ref.current;
      if (!el) return;
      const scale = 0.92 + 0.08 * v.appear + v.lift * 0.025;
      el.style.transform = `translate3d(${v.x}px, ${v.y + (1 - v.appear) * 14}px, 0) scale(${scale})`;
      el.style.opacity = String(Math.min(1, v.appear * 1.4));
      el.style.setProperty('--lift', v.lift.toFixed(3));
      registry.set(s.id, { x: v.x, y: v.y, w: el.offsetWidth || NODE_W, h: el.offsetHeight || 120 });
    };
    const off = g.onChange(apply);
    apply(g.values);
    // Staggered entrance.
    const timer = setTimeout(() => g.set({ appear: 1 }, springs.bouncy), 40 + index * 45);
    const ro = new ResizeObserver(() => apply(g.values));
    if (ref.current) ro.observe(ref.current);
    return () => {
      off();
      clearTimeout(timer);
      ro.disconnect();
      registry.delete(s.id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.id]);

  // Follow server-side position changes (e.g. moved by an agent or another tab).
  useEffect(() => {
    if (dragging.current) return;
    group.current!.set({ x: s.x, y: s.y }, springs.smooth);
  }, [s.x, s.y]);

  // Replica deck: stacked cards behind the node, spring-animated on scale.
  const deckCount = Math.min(3, Math.max(0, (s.stopped ? 0 : s.replicas) - 1));
  const deckSpring = useRef<Spring | null>(null);
  useLayoutEffect(() => {
    if (!deckSpring.current) {
      deckSpring.current = new Spring(deckCount, springs.bouncy);
      deckSpring.current.onChange((v) => deckRef.current?.style.setProperty('--deck', v.toFixed(3)));
      deckRef.current?.style.setProperty('--deck', String(deckCount));
    } else deckSpring.current.set(deckCount);
  }, [deckCount]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, a, input')) return;
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    const start = { x: e.clientX, y: e.clientY };
    const origin = group.current!.targets;
    let moved = false;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const z = getCamera().z;
      const dx = (ev.clientX - start.x) / z;
      const dy = (ev.clientY - start.y) / z;
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 3) {
        moved = true;
        dragging.current = true;
        setDragging(true);
        onDragState(true);
        group.current!.set({ lift: 1 }, springs.snappy);
      }
      if (moved) group.current!.jump({ x: origin.x + dx, y: origin.y + dy });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (!moved) {
        onSelect(s.id);
        return;
      }
      const v = group.current!.values;
      const nx = snap(v.x);
      const ny = snap(v.y);
      group.current!.set({ x: nx, y: ny, lift: 0 }, springs.bouncy);
      dragging.current = false;
      setDragging(false);
      onDragState(false);
      if (nx !== origin.x || ny !== origin.y) onMoved(s.id, nx, ny, origin.x, origin.y);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const tone = serviceTone[s.status];
  const busy = isBusy(s.status) || (latest ? isBusy(latest.status) : false);
  const statusText = latest && latest.status === 'queued' ? 'Queued' : serviceLabel[s.status];
  const healthy = replicas.filter((r) => r.state === 'healthy' && r.deploymentId === s.activeDeploymentId).length;
  const host = s.url ? s.url.replace(/^https?:\/\//, '') : s.tcpAddress;

  return (
    <div
      ref={ref}
      className={`node ${selected ? 'selected' : ''} ${isDragging ? 'dragging' : ''} ${busy ? 'busy' : ''} ${connectTarget ? 'connect-target' : ''}`}
      data-tone={tone}
      data-status={s.status}
      onPointerDown={onPointerDown}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenMenu(s.id, e.clientX, e.clientY);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onFocusNode(s.id);
      }}
      data-node-id={s.id}
    >
      <button
        className="node-port"
        aria-label={`Connect ${s.name} to another service`}
        title="Drag onto another service to reference its variables"
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onStartConnect(s.id, e);
        }}
      >
        <Icon name="plus" size={10} stroke={2.4} />
      </button>
      <div className="node-deck" ref={deckRef} aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <div className="node-card">
        {busy && <div className="node-busy-ring" aria-hidden />}
        <div className="node-head">
          <ServiceGlyph icon={s.icon} name={s.name} size={34} />
          <div className="grow">
            <div className="node-name truncate">{s.name}</div>
            <div className="node-source truncate">{sourceLine(s)}</div>
          </div>
          <button
            className="node-more"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              onOpenMenu(s.id, r.right - 4, r.bottom + 4);
            }}
            aria-label="Service menu"
          >
            <Icon name="more" size={16} />
          </button>
        </div>
        <div className="node-status">
          <span className={`badge ${busy || s.status === 'running' ? 'live' : ''}`} data-tone={tone}>
            <span className="dot" />
            {statusText}
          </span>
          {s.pendingChanges.length > 0 && !busy && (
            <span className="node-pending" title={`Undeployed changes: ${s.pendingChanges.join(', ')}`}>
              <Icon name="dot" size={10} /> changes
            </span>
          )}
          <span className="spacer" />
          {s.protocol !== 'none' && t && t.rps > 0.05 ? (
            <span className="node-rps tnum">
              {num(t.rps)} <span className="faint">req/s</span>
            </span>
          ) : null}
        </div>
        {busy && latest && STAGES.includes(latest.status as any) && <DeployTicker service={s} latest={latest} />}
        <div className="node-foot">
          <Pips service={s} replicas={replicas} />
          <span className="node-replicas tnum">
            {s.stopped ? 'stopped' : `${healthy}/${s.replicas}`}
            {s.replicas > 1 && s.protocol !== 'none' && <span className="node-lb" title={`Load balanced · ${s.strategy}`}>LB</span>}
          </span>
          <span className="spacer" />
          {s.protocol !== 'none' && <Sparkline serviceId={s.id} />}
        </div>
        {host && (
          <div className="node-host truncate">
            <Icon name={s.protocol === 'tcp' ? 'network' : 'globe'} size={12} />
            <span className="truncate">{host}</span>
          </div>
        )}
        {s.volumes.length > 0 && (
          <div className="node-volume">
            <Icon name="database" size={12} />
            <span className="truncate">{s.volumes.map((v) => v.mountPath).join(', ')}</span>
          </div>
        )}
      </div>
    </div>
  );
});
