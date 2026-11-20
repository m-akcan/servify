import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Spring, SpringGroup, springs, tween, type SpringConfig } from './spring.ts';

/**
 * Mount/unmount with exit animations. Returns whether to render and the current phase,
 * which components map to `data-state` for CSS or to spring targets.
 */
export function usePresence(show: boolean, exitMs = 220): { mounted: boolean; state: 'enter' | 'open' | 'exit' } {
  const [mounted, setMounted] = useState(show);
  const [state, setState] = useState<'enter' | 'open' | 'exit'>(show ? 'open' : 'exit');
  useEffect(() => {
    if (show) {
      setMounted(true);
      setState('enter');
      const r = requestAnimationFrame(() => requestAnimationFrame(() => setState('open')));
      return () => cancelAnimationFrame(r);
    }
    setState('exit');
    const t = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(t);
  }, [show, exitMs]);
  return { mounted, state };
}

/** Drive an element's style from a spring group without re-rendering React. */
export function useSpringStyle<K extends string>(
  ref: RefObject<HTMLElement | SVGElement | null>,
  targets: Record<K, number>,
  apply: (el: HTMLElement | SVGElement, v: Record<K, number>) => void,
  config: SpringConfig = springs.smooth,
  initial?: Partial<Record<K, number>>,
) {
  const group = useRef<SpringGroup<K> | null>(null);
  if (!group.current) group.current = new SpringGroup<K>({ ...targets, ...initial } as Record<K, number>, config);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useLayoutEffect(() => {
    const g = group.current!;
    const off = g.onChange((v) => ref.current && applyRef.current(ref.current, v));
    if (ref.current) applyRef.current(ref.current, g.values);
    return () => {
      off();
    };
  }, [ref]);
  const key = JSON.stringify(targets);
  useLayoutEffect(() => {
    group.current!.set(targets, config);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return group.current;
}

/** Animated number for stat readouts: tweens between values, writes text directly. */
export function useCountUp(ref: RefObject<HTMLElement | null>, value: number, format: (n: number) => string, duration = 600) {
  const prev = useRef(value);
  useEffect(() => {
    const from = prev.current;
    const to = value;
    prev.current = value;
    if (!ref.current) return;
    if (from === to) {
      ref.current.textContent = format(to);
      return;
    }
    return tween(duration, (t) => {
      if (ref.current) ref.current.textContent = format(from + (to - from) * t);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
}

/** A spring-backed numeric value that re-renders on each frame. Use sparingly (small trees). */
export function useSpringValue(target: number, config: SpringConfig = springs.smooth) {
  const spring = useRef<Spring | null>(null);
  if (!spring.current) spring.current = new Spring(target, config);
  const [v, setV] = useState(target);
  useEffect(() => {
    const off = spring.current!.onChange(setV);
    return () => {
      off();
    };
  }, []);
  useEffect(() => {
    spring.current!.set(target);
  }, [target]);
  return v;
}

/** Measure an element's size and keep it updated. */
export function useMeasure<T extends HTMLElement>(): [RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ width: e.contentRect.width, height: e.contentRect.height }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

/** Animate an element's height to its content (accordions, expanding cards). */
export function useAutoHeight(ref: RefObject<HTMLElement | null>, deps: unknown[], config: SpringConfig = springs.smooth) {
  const spring = useRef<Spring | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const inner = el.firstElementChild as HTMLElement | null;
    if (!inner) return;
    if (!spring.current) {
      spring.current = new Spring(inner.offsetHeight, config);
      spring.current.onChange((h) => {
        if (ref.current) ref.current.style.height = `${h}px`;
      });
      spring.current.onRest(() => {
        if (ref.current) ref.current.style.height = 'auto';
      });
      el.style.height = 'auto';
      return;
    }
    const from = el.offsetHeight;
    const to = inner.offsetHeight;
    if (Math.abs(from - to) < 1) return;
    spring.current.jump(from);
    el.style.height = `${from}px`;
    spring.current.set(to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
