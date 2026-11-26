import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Icon, BrandMark, hasBrand } from '../../../web/src/components/Icon.tsx';
import type { ServiceStatus } from '../../../server/src/types.ts';

export { Icon };
export { ServiceGlyph } from '../../../web/src/components/Icon.tsx';

const TONES: Record<string, string> = {
  running: 'var(--ok)',
  active: 'var(--ok)',
  degraded: 'var(--warn)',
  crashed: 'var(--err)',
  failed: 'var(--err)',
  building: 'var(--build)',
  deploying: 'var(--build)',
  queued: 'var(--build)',
  stopped: 'var(--idle)',
  idle: 'var(--idle)',
  sleeping: 'var(--text-3)',
  superseded: 'var(--idle)',
  cancelled: 'var(--idle)',
};
const LABELS: Partial<Record<ServiceStatus, string>> = { idle: 'not deployed', sleeping: 'asleep' };

export const tone = (status: string) => TONES[status] ?? 'var(--idle)';
export const isBusy = (status: string) => status === 'building' || status === 'deploying' || status === 'queued';

export function StatusDot({ status }: { status: string }) {
  return <span className="dot" style={{ ['--tone' as any]: tone(status) }} data-busy={isBusy(status)} />;
}

export function StatusPill({ status }: { status: string }) {
  return (
    <span className="pill" style={{ ['--tone' as any]: tone(status) }}>
      <StatusDot status={status} />
      {LABELS[status as ServiceStatus] ?? status}
    </span>
  );
}

export function Spinner() {
  return <div className="spinner" role="progressbar" aria-label="Loading" />;
}

export function Live({ on }: { on: boolean }) {
  return (
    <span className="live" data-on={on}>
      <i />
      {on ? 'live' : 'offline'}
    </span>
  );
}

export function TopBar({ title, sub, onBack, right }: { title: ReactNode; sub?: ReactNode; onBack?: () => void; right?: ReactNode }) {
  return (
    <header className="topbar">
      {onBack && (
        <button className="icon-btn" onClick={onBack} aria-label="Back">
          <Icon name="chevronLeft" size={22} />
        </button>
      )}
      <div className="grow" style={{ paddingLeft: onBack ? 0 : 8 }}>
        <h1 className="ellipsis">{title}</h1>
        {sub && <div className="sub ellipsis">{sub}</div>}
      </div>
      {right}
    </header>
  );
}

/** A project's color with its icon ('i:<line icon>', 'b:<brand logo>', 'e:<emoji>') or its initials. */
export function ProjectMark({ name, color, icon }: { name: string; color?: string | null; icon?: string | null }) {
  const kind = icon?.slice(0, 2);
  const val = icon?.slice(2) ?? '';
  let inner: ReactNode = name.slice(0, 2).replace(/^./, (c) => c.toUpperCase());
  if (kind === 'i:') inner = <Icon name={val} size={17} />;
  else if (kind === 'b:' && hasBrand(val)) inner = <BrandMark icon={val} size={17} inherit />;
  else if (kind === 'e:') inner = <span style={{ fontSize: 17 }}>{val}</span>;
  return (
    <div className="project-mark" style={{ ['--hue' as any]: color || 'var(--signal)' }}>
      {inner}
    </div>
  );
}

/** A tiny line chart. Values are drawn relative to their own max (or `max` when given). */
export function Sparkline({ values, max, color = 'var(--signal)' }: { values: number[]; max?: number; color?: string }) {
  if (values.length < 2) return <svg className="spark" />;
  const top = Math.max(max ?? 0, ...values, 1e-9);
  const w = 100;
  const h = 34;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 2 - (Math.max(0, v) / top) * (h - 4)]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={`${line} L${w},${h} L0,${h} Z`} fill={color} opacity={0.12} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

// ───────────── toasts ─────────────
type ToastMsg = { id: number; text: string; tone?: 'err' };
let toastState: ToastMsg | null = null;
const toastSubs = new Set<() => void>();
let toastSeq = 0;
export function toast(text: string, t?: 'err') {
  const id = ++toastSeq;
  toastState = { id, text, tone: t };
  toastSubs.forEach((f) => f());
  setTimeout(() => {
    if (toastState?.id === id) {
      toastState = null;
      toastSubs.forEach((f) => f());
    }
  }, 3200);
}
export const toastError = (e: unknown) => toast((e as Error)?.message ?? String(e), 'err');
export function ToastHost() {
  const t = useSyncExternalStore(
    (f) => {
      toastSubs.add(f);
      return () => toastSubs.delete(f);
    },
    () => toastState,
  );
  if (!t) return null;
  return (
    <div className="toast" data-tone={t.tone} role="status" key={t.id}>
      {t.text}
    </div>
  );
}

// ───────────── confirm sheet ─────────────
type ConfirmReq = { title: string; body: string; confirm: string; danger?: boolean; resolve: (ok: boolean) => void };
let confirmState: ConfirmReq | null = null;
const confirmSubs = new Set<() => void>();
const setConfirm = (r: ConfirmReq | null) => {
  confirmState = r;
  confirmSubs.forEach((f) => f());
};
export function confirmSheet(opts: Omit<ConfirmReq, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => setConfirm({ ...opts, resolve }));
}
/** The Android back button closes an open sheet first. */
export function closeSheet(): boolean {
  if (!confirmState) return false;
  confirmState.resolve(false);
  setConfirm(null);
  return true;
}
export function SheetHost() {
  const r = useSyncExternalStore(
    (f) => {
      confirmSubs.add(f);
      return () => confirmSubs.delete(f);
    },
    () => confirmState,
  );
  if (!r) return null;
  const done = (ok: boolean) => {
    r.resolve(ok);
    setConfirm(null);
  };
  return (
    <>
      <div className="scrim" onClick={() => done(false)} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={r.title}>
        <div className="grabber" />
        <h3>{r.title}</h3>
        <p>{r.body}</p>
        <div className="btns">
          <button className="btn" onClick={() => done(false)}>
            Cancel
          </button>
          <button className={`btn ${r.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => done(true)}>
            {r.confirm}
          </button>
        </div>
      </div>
    </>
  );
}

/** Re-render every `ms` so "3m ago" labels stay fresh. */
export function useTick(ms = 30_000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}
