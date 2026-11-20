import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { SpringGroup, springs } from '../motion/spring.ts';
import { registry, screenToWorld, bounds, MIN_Z, MAX_Z, INGRESS_ID, type Camera, type Pt, GRID } from './geometry.ts';
import { ServiceNode } from './ServiceNode.tsx';
import { EdgesLayer, IngressNode, type EdgeSpec } from './Edges.tsx';
import { Particles } from './Particles.tsx';
import { Minimap } from './Minimap.tsx';
import type { ProjectState } from '../lib/store.ts';
import { latestDeployment } from '../lib/store.ts';
import { Icon } from '../components/Icon.tsx';
import { Tooltip } from '../components/ui.tsx';

export type CanvasHandle = {
  fit: (animate?: boolean) => void;
  zoomBy: (f: number) => void;
  resetZoom: () => void;
  focus: (id: string) => void;
  centerWorld: () => Pt;
};

type Props = {
  state: ProjectState;
  selectedId: string | null;
  panelWidth: number;
  onSelect: (id: string | null) => void;
  onCreateAt: (p: Pt, screen: Pt) => void;
  onNodeMenu: (id: string, x: number, y: number) => void;
  onCanvasMenu: (world: Pt, x: number, y: number) => void;
  onMoved: (id: string, x: number, y: number, fromX: number, fromY: number) => void;
  onConnect: (from: string, to: string, x: number, y: number) => void;
};

const camKey = (pid: string) => `servify.cam.${pid}`;

export const Canvas = forwardRef<CanvasHandle, Props>(function Canvas({ state, selectedId, panelWidth, onSelect, onCreateAt, onNodeMenu, onCanvasMenu, onMoved, onConnect }, handle) {
  const rootRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const zoomLabel = useRef<HTMLSpanElement>(null);
  const camSubs = useRef(new Set<() => void>());
  const cam = useRef<SpringGroup<'x' | 'y' | 'z'> | null>(null);
  const [panning, setPanning] = useState(false);
  const [draggingNode, setDraggingNode] = useState(false);
  const spaceDown = useRef(false);
  const pid = state.project.id;

  if (!cam.current) {
    let init = { x: 0, y: 0, z: 1 };
    try {
      const saved = localStorage.getItem(camKey(pid));
      if (saved) init = JSON.parse(saved);
    } catch {}
    cam.current = new SpringGroup(init, springs.camera);
  }

  const getCamera = useCallback((): Camera => cam.current!.values, []);
  const subscribeCamera = useCallback((fn: () => void) => {
    camSubs.current.add(fn);
    return () => {
      camSubs.current.delete(fn);
    };
  }, []);

  // Apply camera → DOM (world transform + grid) imperatively.
  useLayoutEffect(() => {
    const g = cam.current!;
    let saveTimer: number | undefined;
    const apply = (v: Camera) => {
      if (worldRef.current) worldRef.current.style.transform = `translate3d(${v.x}px, ${v.y}px, 0) scale(${v.z})`;
      if (gridRef.current) {
        const size = GRID * v.z;
        const major = size * 5;
        const s = gridRef.current.style;
        s.backgroundSize = `${size}px ${size}px, ${major}px ${major}px`;
        s.backgroundPosition = `${v.x}px ${v.y}px, ${v.x}px ${v.y}px`;
        s.setProperty('--minor-alpha', String(Math.max(0, Math.min(1, (v.z - 0.35) / 0.4))));
      }
      if (zoomLabel.current) zoomLabel.current.textContent = `${Math.round(v.z * 100)}%`;
      for (const fn of camSubs.current) fn();
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        try {
          localStorage.setItem(camKey(pid), JSON.stringify(g.targets));
        } catch {}
      }, 400);
    };
    const off = g.onChange(apply);
    apply(g.values);
    return () => {
      off();
      window.clearTimeout(saveTimer);
    };
  }, [pid]);

  const viewport = () => {
    const r = rootRef.current!.getBoundingClientRect();
    return { w: r.width - panelWidth, h: r.height, left: r.left, top: r.top };
  };

  const fit = useCallback(
    (animate = true) => {
      const rects = [...registry.rects.entries()].filter(([id]) => id === INGRESS_ID || state.services[id]).map(([, r]) => r);
      const b = bounds(rects.length ? rects : Object.values(state.services).map((s) => ({ x: s.x, y: s.y, w: 256, h: 130 })));
      const vp = viewport();
      if (!b) {
        cam.current!.set({ x: vp.w / 2 - 128, y: vp.h / 2 - 80, z: 1 });
        return;
      }
      const pad = 120;
      const z = Math.max(MIN_Z, Math.min(1.15, Math.min((vp.w - pad * 2) / b.w, (vp.h - pad * 2) / b.h)));
      const target = { x: vp.w / 2 - (b.x + b.w / 2) * z, y: vp.h / 2 - (b.y + b.h / 2) * z, z };
      if (animate) cam.current!.set(target, springs.camera);
      else cam.current!.jump(target);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.services, panelWidth],
  );

  const zoomAt = (factor: number, sx: number, sy: number, animate: boolean) => {
    const g = cam.current!;
    const cur = animate ? g.targets : g.values;
    const z = Math.max(MIN_Z, Math.min(MAX_Z, cur.z * factor));
    const k = z / cur.z;
    const next = { x: sx - (sx - cur.x) * k, y: sy - (sy - cur.y) * k, z };
    if (animate) g.set(next, springs.snappy);
    else g.jump(next);
  };

  useImperativeHandle(handle, () => ({
    fit,
    zoomBy: (f) => {
      const vp = viewport();
      zoomAt(f, vp.w / 2, vp.h / 2, true);
    },
    resetZoom: () => {
      const vp = viewport();
      zoomAt(1 / cam.current!.targets.z, vp.w / 2, vp.h / 2, true);
    },
    focus: (id) => {
      const r = registry.rects.get(id);
      if (!r) return;
      const vp = viewport();
      const z = Math.max(0.8, cam.current!.targets.z);
      cam.current!.set({ x: vp.w / 2 - (r.x + r.w / 2) * z, y: vp.h / 2 - (r.y + r.h / 2) * z, z }, springs.camera);
    },
    centerWorld: () => {
      const vp = viewport();
      return screenToWorld({ x: vp.w / 2, y: vp.h / 2 }, cam.current!.values);
    },
  }));

  // First visit to a project: fit everything once nodes have measured.
  useEffect(() => {
    let has = false;
    try {
      has = !!localStorage.getItem(camKey(pid));
    } catch {}
    if (!has) {
      const t = setTimeout(() => fit(false), 30);
      const t2 = setTimeout(() => fit(true), 400);
      return () => {
        clearTimeout(t);
        clearTimeout(t2);
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  // Keep the selected node visible when the side panel opens.
  useEffect(() => {
    if (!selectedId) return;
    const r = registry.rects.get(selectedId);
    const root = rootRef.current;
    if (!r || !root) return;
    const c = cam.current!.targets;
    const W = root.clientWidth - panelWidth;
    const sx = r.x * c.z + c.x;
    const ex = (r.x + r.w) * c.z + c.x;
    const sy = r.y * c.z + c.y;
    const ey = (r.y + r.h) * c.z + c.y;
    let dx = 0;
    let dy = 0;
    if (ex > W - 40) dx = W - 40 - ex;
    if (sx + dx < 40) dx = 40 - sx;
    if (sy < 80) dy = 80 - sy;
    if (ey > root.clientHeight - 40) dy = root.clientHeight - 40 - ey;
    if (dx || dy) cam.current!.set({ x: c.x + dx, y: c.y + dy }, springs.camera);
  }, [selectedId, panelWidth]);

  // Wheel: trackpad two-finger pan, pinch (ctrl) / cmd+wheel zoom at the cursor.
  useEffect(() => {
    const el = rootRef.current!;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('.no-canvas-wheel')) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const g = cam.current!;
      if (e.ctrlKey || e.metaKey) {
        const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        zoomAt(Math.exp(-delta * (e.ctrlKey ? 0.0105 : 0.0025)), sx, sy, false);
      } else {
        const k = e.deltaMode === 1 ? 16 : 1;
        const v = g.values;
        g.jump({ x: v.x - e.deltaX * k, y: v.y - e.deltaY * k });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Space-to-pan.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target as HTMLElement).closest('input, textarea, [contenteditable]')) {
        if (!spaceDown.current) rootRef.current?.classList.add('space-pan');
        spaceDown.current = true;
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceDown.current = false;
        rootRef.current?.classList.remove('space-pan');
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // Background drag → pan with inertia.
  const onPointerDown = (e: React.PointerEvent) => {
    const onNode = (e.target as HTMLElement).closest('.node, .ingress, .canvas-chrome, .minimap');
    if (onNode && !spaceDown.current && e.button !== 1) return;
    if (e.button !== 0 && e.button !== 1) return;
    const el = rootRef.current!;
    el.setPointerCapture(e.pointerId);
    const g = cam.current!;
    const start = { x: e.clientX, y: e.clientY };
    const origin = g.values;
    let last = { x: e.clientX, y: e.clientY, t: performance.now() };
    let vel = { x: 0, y: 0 };
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) > 2) {
        moved = true;
        setPanning(true);
      }
      const now = performance.now();
      const dt = Math.max(1, now - last.t);
      vel = { x: 0.8 * ((ev.clientX - last.x) / dt) + 0.2 * vel.x, y: 0.8 * ((ev.clientY - last.y) / dt) + 0.2 * vel.y };
      last = { x: ev.clientX, y: ev.clientY, t: now };
      g.jump({ x: origin.x + dx, y: origin.y + dy });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setPanning(false);
      if (!moved) {
        onSelect(null);
        return;
      }
      if (performance.now() - last.t < 60) {
        // Momentum glide.
        const v = g.values;
        g.set({ x: v.x + vel.x * 180, y: v.y + vel.y * 180 }, springs.gentle);
      }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.node, .ingress, .canvas-chrome, .minimap')) return;
    const r = rootRef.current!.getBoundingClientRect();
    const w = screenToWorld({ x: e.clientX - r.left, y: e.clientY - r.top }, cam.current!.values);
    onCreateAt({ x: w.x - 128, y: w.y - 50 }, { x: e.clientX, y: e.clientY });
  };

  const onContextMenu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.node')) return;
    e.preventDefault();
    const r = rootRef.current!.getBoundingClientRect();
    const w = screenToWorld({ x: e.clientX - r.left, y: e.clientY - r.top }, cam.current!.values);
    onCanvasMenu({ x: w.x - 128, y: w.y - 50 }, e.clientX, e.clientY);
  };

  // Drag-to-connect: a draft edge follows the pointer from a node's port to a target node.
  const [draft, setDraft] = useState<{ from: string; x: number; y: number; over: string | null } | null>(null);
  const startConnect = useCallback((id: string, e: React.PointerEvent) => {
    const root = rootRef.current!;
    const r = root.getBoundingClientRect();
    const toWorld = (cx: number, cy: number) => screenToWorld({ x: cx - r.left, y: cy - r.top }, cam.current!.values);
    const hit = (p: Pt) => {
      for (const [nid, rect] of registry.rects) {
        if (nid === id || nid === INGRESS_ID) continue;
        if (p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h) return nid;
      }
      return null;
    };
    const start = toWorld(e.clientX, e.clientY);
    setDraft({ from: id, x: start.x, y: start.y, over: null });
    const move = (ev: PointerEvent) => {
      const p = toWorld(ev.clientX, ev.clientY);
      setDraft({ from: id, x: p.x, y: p.y, over: hit(p) });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const target = hit(toWorld(ev.clientX, ev.clientY));
      setDraft(null);
      if (target) onConnect(id, target, ev.clientX, ev.clientY);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [onConnect]);
  const focusNode = useCallback((id: string) => {
    const r = registry.rects.get(id);
    if (!r) return;
    const root = rootRef.current!;
    const z = Math.max(1, cam.current!.targets.z);
    cam.current!.set({ x: (root.clientWidth - 620) / 2 - (r.x + r.w / 2) * z, y: root.clientHeight / 2 - (r.y + r.h / 2) * z, z }, springs.camera);
    onSelect(id);
  }, [onSelect]);

  const services = useMemo(() => state.order.map((id) => state.services[id]).filter(Boolean), [state.order, state.services]);

  const edges: EdgeSpec[] = useMemo(() => {
    const out: EdgeSpec[] = [];
    for (const s of services) {
      if (!s.activeDeploymentId && s.status === 'idle') continue; // never deployed: nothing to route yet
      if (s.protocol === 'http' && s.publicHttp) out.push({ id: `in-${s.id}`, from: INGRESS_ID, to: s.id, kind: 'ingress', active: s.status === 'running' });
      else if (s.publicTcpPort) out.push({ id: `in-${s.id}`, from: INGRESS_ID, to: s.id, kind: 'ingress', label: `tcp :${s.publicTcpPort}`, active: s.status === 'running' });
    }
    for (const e of state.edges) {
      const a = state.services[e.from];
      const b = state.services[e.to];
      if (!a || !b) continue;
      out.push({ id: `ref-${e.from}-${e.to}`, from: e.from, to: e.to, kind: 'ref', active: a.status === 'running' && b.status === 'running' });
    }
    return out;
  }, [services, state.edges, state.services]);

  const hasIngress = edges.some((e) => e.kind === 'ingress');

  return (
    <div
      ref={rootRef}
      className={`canvas ${panning ? 'panning' : ''} ${draggingNode ? 'node-dragging' : ''} ${draft ? 'connecting' : ''}`}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <div className="canvas-grid" ref={gridRef} />
      <div className="canvas-vignette" />
      <div className="world" ref={worldRef}>
        <EdgesLayer edges={edges} highlight={selectedId} draft={draft} />
        <IngressNode services={services} proxyPort={state.proxyPort} visible={hasIngress} />
        {services.map((s, i) => (
          <ServiceNode
            key={s.id}
            index={i}
            service={s}
            replicas={state.replicas[s.id] ?? []}
            latest={latestDeployment(state, s.id)}
            selected={selectedId === s.id}
            getCamera={getCamera}
            onSelect={onSelect}
            onOpenMenu={onNodeMenu}
            onMoved={onMoved}
            onDragState={setDraggingNode}
            onStartConnect={startConnect}
            onFocusNode={focusNode}
            connectTarget={draft?.over === s.id}
          />
        ))}
      </div>
      <Particles edges={edges} getCamera={getCamera} subscribeCamera={subscribeCamera} />

      <div className="canvas-chrome canvas-controls glass" style={{ left: 16 }}>
        <Tooltip label="Zoom out" kbd="−">
          <button className="cc-btn" onClick={() => zoomAt(1 / 1.25, viewport().w / 2, viewport().h / 2, true)} aria-label="Zoom out">
            <Icon name="minus" size={15} />
          </button>
        </Tooltip>
        <Tooltip label="Reset to 100%" kbd="0">
          <button className="cc-zoom mono" onClick={() => zoomAt(1 / cam.current!.targets.z, viewport().w / 2, viewport().h / 2, true)}>
            <span ref={zoomLabel}>100%</span>
          </button>
        </Tooltip>
        <Tooltip label="Zoom in" kbd="+">
          <button className="cc-btn" onClick={() => zoomAt(1.25, viewport().w / 2, viewport().h / 2, true)} aria-label="Zoom in">
            <Icon name="plus" size={15} />
          </button>
        </Tooltip>
        <span className="cc-sep" />
        <Tooltip label="Fit to screen" kbd="F">
          <button className="cc-btn" onClick={() => fit(true)} aria-label="Fit">
            <Icon name="fit" size={15} />
          </button>
        </Tooltip>
      </div>

      <Minimap services={services} getCamera={getCamera} subscribeCamera={subscribeCamera} rootRef={rootRef} panelWidth={panelWidth} onJump={(x, y) => cam.current!.set({ x, y }, springs.camera)} selectedId={selectedId} />
    </div>
  );
});
