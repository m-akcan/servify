import { useEffect, useRef, useState, type RefObject } from 'react';
import { registry, bounds, INGRESS_ID, type Camera } from './geometry.ts';
import type { ServiceView } from '../lib/types.ts';
import { serviceTone } from '../lib/format.ts';

const W = 168;
const H = 104;

/** Overview of the whole canvas with the current viewport; click or drag to navigate. */
export function Minimap({
  services,
  getCamera,
  subscribeCamera,
  rootRef,
  panelWidth,
  onJump,
  selectedId,
}: {
  services: ServiceView[];
  getCamera: () => Camera;
  subscribeCamera: (fn: () => void) => () => void;
  rootRef: RefObject<HTMLDivElement | null>;
  panelWidth: number;
  onJump: (x: number, y: number) => void;
  selectedId: string | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const svcRef = useRef(services);
  svcRef.current = services;
  const sel = useRef(selectedId);
  sel.current = selectedId;
  const layout = useRef({ scale: 1, ox: 0, oy: 0 });

  useEffect(() => {
    const c = canvasRef.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = W * dpr;
    c.height = H * dpr;
    const ctx = c.getContext('2d')!;
    let raf = 0;
    const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    const draw = () => {
      raf = 0;
      const root = rootRef.current;
      if (!root) return;
      const cam = getCamera();
      const vpW = root.clientWidth - panelWidth;
      const vpH = root.clientHeight;
      const view = { x: -cam.x / cam.z, y: -cam.y / cam.z, w: vpW / cam.z, h: vpH / cam.z };
      const rects = [...registry.rects.entries()].map(([id, r]) => ({ id, ...r }));
      const b = bounds([...rects, view]) ?? view;
      const pad = 40;
      const scale = Math.min(W / (b.w + pad * 2), H / (b.h + pad * 2));
      const ox = (W - (b.w + pad * 2) * scale) / 2 - (b.x - pad) * scale;
      const oy = (H - (b.h + pad * 2) * scale) / 2 - (b.y - pad) * scale;
      layout.current = { scale, ox, oy };
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const tones: Record<string, string> = { ok: css('--ok'), warn: css('--warn'), err: css('--err'), build: css('--build'), idle: css('--idle'), signal: css('--signal') };
      for (const r of rects) {
        const svc = svcRef.current.find((s) => s.id === r.id);
        const x = r.x * scale + ox;
        const y = r.y * scale + oy;
        const w = Math.max(3, r.w * scale);
        const h = Math.max(2, r.h * scale);
        ctx.globalAlpha = r.id === INGRESS_ID ? 0.35 : 0.85;
        ctx.fillStyle = r.id === INGRESS_ID ? tones.signal : svc ? tones[serviceTone[svc.status]] : tones.idle;
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 2);
        ctx.fill();
        if (r.id === sel.current) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = tones.signal;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = css('--text-2');
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.roundRect(view.x * scale + ox, view.y * scale + oy, view.w * scale, view.h * scale, 3);
      ctx.stroke();
      ctx.globalAlpha = 0.06;
      ctx.fillStyle = css('--text');
      ctx.fill();
      ctx.globalAlpha = 1;
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    const offCam = subscribeCamera(schedule);
    const offReg = registry.subscribe(schedule);
    schedule();
    return () => {
      offCam();
      offReg();
      cancelAnimationFrame(raf);
    };
  }, [getCamera, subscribeCamera, rootRef, panelWidth]);

  useEffect(() => {
    // redraw for status color changes
    registry.subscribe(() => {})();
  }, [services, selectedId]);

  const jumpTo = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const { scale, ox, oy } = layout.current;
    const wx = (clientX - rect.left - ox) / scale;
    const wy = (clientY - rect.top - oy) / scale;
    const root = rootRef.current!;
    const cam = getCamera();
    onJump((root.clientWidth - panelWidth) / 2 - wx * cam.z, root.clientHeight / 2 - wy * cam.z);
  };

  // Not enough canvas left beside the panel: get out of the way of the zoom controls.
  const [winW, setWinW] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setWinW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const narrow = (rootRef.current?.clientWidth ?? winW) - panelWidth < 560;
  return (
    <div className="minimap glass canvas-chrome" style={{ right: 16 + panelWidth, opacity: narrow ? 0 : 1, pointerEvents: narrow ? 'none' : undefined }}>
      <canvas
        ref={canvasRef}
        style={{ width: W, height: H }}
        onPointerDown={(e) => {
          e.stopPropagation();
           try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch {}
          jumpTo(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) jumpTo(e.clientX, e.clientY);
        }}
      />
    </div>
  );
}
