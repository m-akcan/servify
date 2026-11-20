import { useEffect, useRef } from 'react';
import { ticker, reducedMotion } from '../motion/spring.ts';
import { registry, connect, bezierAt, type Camera, type Bezier } from './geometry.ts';
import { traffic } from '../lib/store.ts';
import type { EdgeSpec } from './Edges.tsx';

type Particle = { edge: string; t: number; speed: number; err: boolean; size: number };

/**
 * Traffic particles: requests flowing from the edge router into services, and ambient
 * dependency flow along variable references. Drawn on a screen-space <canvas>; the
 * loop sleeps when nothing is flowing.
 */
export function Particles({ edges, getCamera, subscribeCamera }: { edges: EdgeSpec[]; getCamera: () => Camera; subscribeCamera: (fn: () => void) => () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const state = useRef({ particles: [] as Particle[], acc: new Map<string, number>(), running: false });

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      const r = canvas.parentElement!.getBoundingClientRect();
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement!);

    const signal = () => getComputedStyle(document.documentElement).getPropertyValue('--signal').trim() || '#d4f25a';
    const errC = () => getComputedStyle(document.documentElement).getPropertyValue('--err').trim() || '#ff6b5b';
    const refC = () => getComputedStyle(document.documentElement).getPropertyValue('--text-2').trim() || '#aaa';
    let colors = { signal: signal(), err: errC(), ref: refC() };
    const themeObs = new MutationObserver(() => (colors = { signal: signal(), err: errC(), ref: refC() }));
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    const st = state.current;
    (window as any).__particles = { st, edges: edgesRef, rateFor: (e: EdgeSpec) => rateFor(e) };

    const rateFor = (e: EdgeSpec): { rate: number; errFrac: number } => {
      if (e.kind === 'ingress') {
        const t = traffic.data[e.to];
        if (!t || t.rps <= 0.01) return { rate: 0, errFrac: 0 };
        // Perceptual scale: a trickle is visible, a flood doesn't saturate.
        return { rate: Math.min(26, 1.2 + Math.log2(1 + t.rps) * 3.2), errFrac: t.rps > 0 ? Math.min(1, t.errors / t.rps) : 0 };
      }
      return { rate: e.active ? 0.45 : 0, errFrac: 0 };
    };

    const loop = (dt: number) => {
      if (!st.running) return false;
      const cam = getCamera();
      const W = canvas.width;
      const H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      const curves = new Map<string, Bezier>();
      let anyRate = false;
      for (const e of edgesRef.current) {
        const a = registry.rects.get(e.from);
        const b = registry.rects.get(e.to);
        if (!a || !b) continue;
        curves.set(e.id, connect(a, b));
        const { rate, errFrac } = rateFor(e);
        if (rate <= 0) continue;
        anyRate = true;
        let acc = (st.acc.get(e.id) ?? Math.random()) + rate * dt;
        while (acc >= 1) {
          acc -= 1;
          st.particles.push({
            edge: e.id,
            t: 0,
            speed: e.kind === 'ingress' ? 0.75 + Math.random() * 0.35 : 0.22 + Math.random() * 0.06,
            err: Math.random() < errFrac,
            size: e.kind === 'ingress' ? 2.1 + Math.random() * 0.8 : 1.6,
          });
        }
        st.acc.set(e.id, acc);
      }
      if (st.particles.length > 600) st.particles.splice(0, st.particles.length - 600);

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.globalCompositeOperation = 'lighter';
      const kinds = new Map(edgesRef.current.map((e) => [e.id, e.kind]));
      st.particles = st.particles.filter((p) => {
        p.t += p.speed * dt;
        const bz = curves.get(p.edge);
        if (!bz || p.t >= 1) return false;
        const kind = kinds.get(p.edge);
        const color = p.err ? colors.err : kind === 'ref' ? colors.ref : colors.signal;
        // ease in/out alpha at the ends
        const alpha = Math.min(1, p.t * 6, (1 - p.t) * 6) * (kind === 'ref' ? 0.45 : 1);
        for (let k = 3; k >= 0; k--) {
          const tt = Math.max(0, p.t - k * 0.018);
          const pt = bezierAt(bz, tt);
          const sx = pt.x * cam.z + cam.x;
          const sy = pt.y * cam.z + cam.y;
          const r = p.size * Math.max(0.55, Math.min(1.4, cam.z)) * (1 - k * 0.2);
          ctx.globalAlpha = alpha * (k === 0 ? 1 : 0.28 / k);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, Math.PI * 2);
          ctx.fill();
        }
        // soft glow on the head
        const head = bezierAt(bz, p.t);
        const hx = head.x * cam.z + cam.x;
        const hy = head.y * cam.z + cam.y;
        ctx.globalAlpha = alpha * 0.18;
        ctx.beginPath();
        ctx.arc(hx, hy, p.size * 3.2 * Math.max(0.6, cam.z), 0, Math.PI * 2);
        ctx.fill();
        return true;
      });
      ctx.restore();
      if (!anyRate && st.particles.length === 0) {
        st.running = false;
        ctx.clearRect(0, 0, W, H);
        return false;
      }
    };

    const wake = () => {
      if (st.running || reducedMotion()) return;
      st.running = true;
      ticker.add(loop);
    };
    traffic.subs.add(wake);
    const offCam = subscribeCamera(() => {
      // particles are screen-space; redraw is handled by the running loop
      if (!st.running && st.particles.length) wake();
    });
    wake();
    return () => {
      traffic.subs.delete(wake);
      offCam();
      ro.disconnect();
      themeObs.disconnect();
      st.running = false;
      st.particles = [];
    };
  }, [getCamera, subscribeCamera]);

  useEffect(() => {
    // New edges (e.g. reference added) may need ambient flow.
    traffic.subs.forEach((fn) => fn());
  }, [edges]);

  return <canvas ref={canvasRef} className="particles" />;
}
