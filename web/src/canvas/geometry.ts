/** Shared geometry + live node position registry for the canvas. */

export type Rect = { x: number; y: number; w: number; h: number };
export type Camera = { x: number; y: number; z: number };
export type Pt = { x: number; y: number };

export const GRID = 20;
export const NODE_W = 256;
export const MIN_Z = 0.25;
export const MAX_Z = 2;

/** Live world-space rects of every node, updated by node springs each frame. */
class Registry {
  rects = new Map<string, Rect>();
  private subs = new Set<() => void>();
  version = 0;
  set(id: string, r: Rect) {
    const prev = this.rects.get(id);
    if (prev && prev.x === r.x && prev.y === r.y && prev.w === r.w && prev.h === r.h) return;
    this.rects.set(id, r);
    this.version++;
    for (const fn of this.subs) fn();
  }
  delete(id: string) {
    if (this.rects.delete(id)) {
      this.version++;
      for (const fn of this.subs) fn();
    }
  }
  subscribe(fn: () => void) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}
export const registry = new Registry();

export function screenToWorld(p: Pt, cam: Camera): Pt {
  return { x: (p.x - cam.x) / cam.z, y: (p.y - cam.y) / cam.z };
}
export function worldToScreen(p: Pt, cam: Camera): Pt {
  return { x: p.x * cam.z + cam.x, y: p.y * cam.z + cam.y };
}

export function snap(v: number, g = GRID) {
  return Math.round(v / g) * g;
}

export function bounds(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export type Bezier = { p0: Pt; p1: Pt; p2: Pt; p3: Pt };

/** Pick sides and control points for a connection between two rects. */
export function connect(a: Rect, b: Rect): Bezier {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  let p0: Pt;
  let p3: Pt;
  let horizontal: boolean;
  if (Math.abs(dx) > Math.abs(dy) * 0.6 || Math.abs(dx) > (a.w + b.w) / 2 + 30) {
    horizontal = true;
    if (dx >= 0) {
      p0 = { x: a.x + a.w, y: ac.y };
      p3 = { x: b.x, y: bc.y };
    } else {
      p0 = { x: a.x, y: ac.y };
      p3 = { x: b.x + b.w, y: bc.y };
    }
  } else {
    horizontal = false;
    if (dy >= 0) {
      p0 = { x: ac.x, y: a.y + a.h };
      p3 = { x: bc.x, y: b.y };
    } else {
      p0 = { x: ac.x, y: a.y };
      p3 = { x: bc.x, y: b.y + b.h };
    }
  }
  const dist = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  const k = Math.max(36, Math.min(160, dist * 0.42));
  if (horizontal) {
    const s = p3.x >= p0.x ? 1 : -1;
    return { p0, p1: { x: p0.x + k * s, y: p0.y }, p2: { x: p3.x - k * s, y: p3.y }, p3 };
  }
  const s = p3.y >= p0.y ? 1 : -1;
  return { p0, p1: { x: p0.x, y: p0.y + k * s }, p2: { x: p3.x, y: p3.y - k * s }, p3 };
}

export function bezierPath(b: Bezier) {
  return `M${b.p0.x},${b.p0.y} C${b.p1.x},${b.p1.y} ${b.p2.x},${b.p2.y} ${b.p3.x},${b.p3.y}`;
}

export function bezierAt(b: Bezier, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const c1 = 3 * u * u * t;
  const c2 = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * b.p0.x + c1 * b.p1.x + c2 * b.p2.x + d * b.p3.x,
    y: a * b.p0.y + c1 * b.p1.y + c2 * b.p2.y + d * b.p3.y,
  };
}

export const INGRESS_ID = '__ingress__';

/** Imperative handles so a group drag can move every selected node together. */
export type NodeControl = { targets: () => Pt; jump: (p: Pt) => void; settle: (p: Pt) => void; lift: (v: number) => void };
export const nodeControls = new Map<string, NodeControl>();
