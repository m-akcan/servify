/**
 * Servify motion engine.
 * Physically-based springs driven by one shared requestAnimationFrame ticker that
 * sleeps whenever nothing is moving. No animation library involved.
 */

export type SpringConfig = { stiffness: number; damping: number; mass?: number; precision?: number };

export const springs = {
  /** UI controls, toggles, small movements */
  snappy: { stiffness: 560, damping: 42 },
  /** Default for most transitions */
  smooth: { stiffness: 300, damping: 34 },
  /** Panels and large surfaces */
  panel: { stiffness: 340, damping: 36 },
  /** Camera moves on the canvas */
  camera: { stiffness: 170, damping: 28 },
  /** Playful overshoot for confirmations / drops */
  bouncy: { stiffness: 460, damping: 24 },
  /** Slow drift */
  gentle: { stiffness: 120, damping: 22 },
} satisfies Record<string, SpringConfig>;

export const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

type TickFn = (dt: number, now: number) => boolean | void; // return false to unsubscribe

class Ticker {
  private subs = new Set<TickFn>();
  private raf = 0;
  private last = 0;

  add(fn: TickFn) {
    this.subs.add(fn);
    if (!this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.loop);
    }
    return () => this.subs.delete(fn);
  }

  private loop = (now: number) => {
    // Clamp dt so a background tab doesn't explode the simulation.
    const dt = Math.min(0.064, Math.max(0.001, (now - this.last) / 1000));
    this.last = now;
    this.raf = 0;
    for (const fn of [...this.subs]) {
      try {
        if (fn(dt, now) === false) this.subs.delete(fn);
      } catch (e) {
        // One broken animation must never stall every other one.
        this.subs.delete(fn);
        console.error('[motion]', e);
      }
    }
    if (this.subs.size && !this.raf) this.raf = requestAnimationFrame(this.loop);
  };
}

export const ticker = new Ticker();

const STEP = 1 / 240;

/** A single damped harmonic oscillator. */
export class Spring {
  value: number;
  velocity = 0;
  target: number;
  config: Required<SpringConfig>;
  private running = false;
  private listeners = new Set<(v: number) => void>();
  private restListeners = new Set<() => void>();

  constructor(value: number, config: SpringConfig = springs.smooth) {
    this.value = value;
    this.target = value;
    this.config = { mass: 1, precision: 0.01, ...config };
  }

  onChange(fn: (v: number) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onRest(fn: () => void) {
    this.restListeners.add(fn);
    return () => this.restListeners.delete(fn);
  }

  setConfig(config: SpringConfig) {
    this.config = { mass: 1, precision: 0.01, ...config };
  }

  /** Animate towards a target, preserving current velocity (interruptible). */
  set(target: number, velocity?: number) {
    this.target = target;
    if (velocity !== undefined) this.velocity = velocity;
    if (reducedMotion()) return this.jump(target);
    if (!this.running && !this.atRest()) this.start();
  }

  /** Teleport without animation. */
  jump(value: number) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.emit();
  }

  get isAnimating() {
    return this.running;
  }

  private atRest() {
    return Math.abs(this.target - this.value) < this.config.precision && Math.abs(this.velocity) < this.config.precision * 10;
  }

  private start() {
    this.running = true;
    ticker.add((dt) => {
      const { stiffness, damping, mass } = this.config;
      let t = dt;
      while (t > 0) {
        const h = Math.min(STEP, t);
        const force = -stiffness * (this.value - this.target) - damping * this.velocity;
        this.velocity += (force / mass) * h;
        this.value += this.velocity * h;
        t -= h;
      }
      if (this.atRest()) {
        this.value = this.target;
        this.velocity = 0;
        this.running = false;
        this.emit();
        for (const fn of this.restListeners) fn();
        return false;
      }
      this.emit();
    });
  }

  private emit() {
    for (const fn of this.listeners) fn(this.value);
  }
}

/** A bundle of springs animated together (x, y, scale, …), emitting one combined update per frame. */
export class SpringGroup<K extends string> {
  springs: Record<K, Spring>;
  private listeners = new Set<(v: Record<K, number>) => void>();
  private scheduled = false;

  constructor(initial: Record<K, number>, config: SpringConfig = springs.smooth) {
    this.springs = {} as Record<K, Spring>;
    for (const k of Object.keys(initial) as K[]) {
      const s = new Spring(initial[k], config);
      s.onChange(() => this.schedule());
      this.springs[k] = s;
    }
  }

  get values(): Record<K, number> {
    const out = {} as Record<K, number>;
    for (const k of Object.keys(this.springs) as K[]) out[k] = this.springs[k].value;
    return out;
  }

  get targets(): Record<K, number> {
    const out = {} as Record<K, number>;
    for (const k of Object.keys(this.springs) as K[]) out[k] = this.springs[k].target;
    return out;
  }

  get isAnimating() {
    return (Object.values(this.springs) as Spring[]).some((s) => s.isAnimating);
  }

  onChange(fn: (v: Record<K, number>) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  set(targets: Partial<Record<K, number>>, config?: SpringConfig) {
    for (const [k, v] of Object.entries(targets) as [K, number][]) {
      if (config) this.springs[k].setConfig(config);
      this.springs[k].set(v);
    }
  }

  jump(values: Partial<Record<K, number>>) {
    for (const [k, v] of Object.entries(values) as [K, number][]) this.springs[k].jump(v);
  }

  private schedule() {
    // Coalesce multiple spring updates in the same frame into a single emit.
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const v = this.values;
      for (const fn of this.listeners) fn(v);
    });
  }
}

/** Tween helper for one-off timed animations (e.g. count-ups). */
export function tween(duration: number, onFrame: (t: number) => void, ease: (t: number) => number = easeOutExpo) {
  const start = performance.now();
  let cancelled = false;
  if (reducedMotion()) {
    onFrame(1);
    return () => {};
  }
  ticker.add((_, now) => {
    if (cancelled) return false;
    const t = Math.min(1, (now - start) / duration);
    onFrame(ease(t));
    return t < 1;
  });
  return () => {
    cancelled = true;
  };
}

export const easeOutExpo = (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
