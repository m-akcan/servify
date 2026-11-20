import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  cloneElement,
  type ReactNode,
  type ButtonHTMLAttributes,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon.tsx';
import { Spring, springs } from '../motion/spring.ts';
import { usePresence } from '../motion/hooks.ts';
import type { Tone } from '../lib/format.ts';
import { createStore } from '../lib/store.ts';
import { useSyncExternalStore } from 'react';

// ───────────────────────────── Button ─────────────────────────────

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
  iconOnly?: boolean;
};

export function Button({ variant = 'secondary', size = 'md', icon, iconRight, loading, iconOnly, className = '', children, disabled, ...rest }: BtnProps) {
  const iconSize = size === 'sm' ? 14 : size === 'lg' ? 18 : 16;
  return (
    <button
      className={`btn btn-${variant} ${size !== 'md' ? `btn-${size}` : ''} ${iconOnly ? 'btn-icon' : ''} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <span className="spinner" /> : icon ? <Icon name={icon} size={iconSize} /> : null}
      {children}
      {iconRight && !loading ? <Icon name={iconRight} size={iconSize} /> : null}
    </button>
  );
}

// ───────────────────────────── Badge ─────────────────────────────

export function Badge({ tone = 'idle', live, children }: { tone?: Tone; live?: boolean; children: ReactNode }) {
  return (
    <span className={`badge ${live ? 'live' : ''}`} data-tone={tone}>
      <span className="dot" />
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

// ───────────────────────────── Switch ─────────────────────────────

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
    />
  );
}

// ───────────────────────────── Segmented (spring thumb) ─────────────────────────────

export function Segmented<T extends string>({ value, options, onChange, size }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; size?: 'sm' }) {
  const wrap = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const spring = useRef<{ x: Spring; w: Spring } | null>(null);
  useLayoutEffect(() => {
    const el = wrap.current?.querySelector<HTMLButtonElement>(`button[data-v="${CSS.escape(value)}"]`);
    if (!el || !thumb.current) return;
    const x = el.offsetLeft;
    const w = el.offsetWidth;
    if (!spring.current) {
      const sx = new Spring(x, springs.snappy);
      const sw = new Spring(w, springs.snappy);
      const apply = () => {
        if (thumb.current) {
          thumb.current.style.transform = `translateX(${sx.value}px)`;
          thumb.current.style.width = `${sw.value}px`;
        }
      };
      sx.onChange(apply);
      sw.onChange(apply);
      spring.current = { x: sx, w: sw };
      apply();
    } else {
      spring.current.x.set(x);
      spring.current.w.set(w);
    }
  }, [value, options.length]);
  return (
    <div className="segmented" ref={wrap} style={size === 'sm' ? { transform: 'scale(.95)', transformOrigin: 'left' } : undefined}>
      <div className="seg-thumb" ref={thumb} style={{ left: 0 }} />
      {options.map((o) => (
        <button key={o.value} type="button" data-v={o.value} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ───────────────────────────── Tabs (spring underline) ─────────────────────────────

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { value: T; label: string; icon?: IconName; count?: number | null }[]; onChange: (v: T) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const spring = useRef<{ x: Spring; w: Spring } | null>(null);
  useLayoutEffect(() => {
    const el = wrap.current?.querySelector<HTMLButtonElement>(`button[data-v="${value}"]`);
    if (!el || !bar.current) return;
    const x = el.offsetLeft + 8;
    const w = el.offsetWidth - 16;
    if (!spring.current) {
      const sx = new Spring(x, springs.snappy);
      const sw = new Spring(w, springs.snappy);
      const apply = () => {
        if (bar.current) {
          bar.current.style.transform = `translateX(${sx.value}px)`;
          bar.current.style.width = `${sw.value}px`;
        }
      };
      sx.onChange(apply);
      sw.onChange(apply);
      spring.current = { x: sx, w: sw };
      apply();
    } else {
      spring.current.x.set(x);
      spring.current.w.set(w);
    }
  }, [value, tabs.length]);
  return (
    <div className="tabs" ref={wrap} role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" data-v={t.value} aria-selected={t.value === value} className="tab" onClick={() => onChange(t.value)}>
          {t.icon && <Icon name={t.icon} size={14} />}
          {t.label}
          {t.count != null && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
      <div className="tab-bar" ref={bar} />
    </div>
  );
}

// ───────────────────────────── Stepper ─────────────────────────────

export function Stepper({ value, min = 0, max = 99, onChange, disabled }: { value: number; min?: number; max?: number; onChange: (v: number) => void; disabled?: boolean }) {
  const numRef = useRef<HTMLSpanElement>(null);
  const [dir, setDir] = useState<'up' | 'down' | null>(null);
  const prev = useRef(value);
  useEffect(() => {
    if (value !== prev.current) {
      setDir(value > prev.current ? 'up' : 'down');
      prev.current = value;
      const t = setTimeout(() => setDir(null), 300);
      return () => clearTimeout(t);
    }
  }, [value]);
  return (
    <div className={`stepper ${disabled ? 'disabled' : ''}`}>
      <button type="button" disabled={disabled || value <= min} onClick={() => onChange(Math.max(min, value - 1))} aria-label="Decrease">
        <Icon name="minus" size={14} />
      </button>
      <span ref={numRef} className={`stepper-value tnum ${dir ? `bump-${dir}` : ''}`} key={value}>
        {value}
      </span>
      <button type="button" disabled={disabled || value >= max} onClick={() => onChange(Math.min(max, value + 1))} aria-label="Increase">
        <Icon name="plus" size={14} />
      </button>
    </div>
  );
}

// ───────────────────────────── Tooltip ─────────────────────────────

export function Tooltip({ label, kbd, children, side = 'top' }: { label: ReactNode; kbd?: string; children: ReactElement<any>; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (side === 'bottom') setPos({ x: r.left + r.width / 2, y: r.bottom + 8 });
      else if (side === 'left') setPos({ x: r.left - 8, y: r.top + r.height / 2 });
      else if (side === 'right') setPos({ x: r.right + 8, y: r.top + r.height / 2 });
      else setPos({ x: r.left + r.width / 2, y: r.top - 8 });
    }, 380);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setPos(null);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const transform =
    side === 'bottom' ? 'translate(-50%, 0)' : side === 'left' ? 'translate(-100%, -50%)' : side === 'right' ? 'translate(0, -50%)' : 'translate(-50%, -100%)';
  return (
    <>
      {cloneElement(children, {
        onMouseEnter: (e: React.MouseEvent) => {
          children.props.onMouseEnter?.(e);
          show(e);
        },
        onMouseLeave: (e: React.MouseEvent) => {
          children.props.onMouseLeave?.(e);
          hide();
        },
        onMouseDown: (e: React.MouseEvent) => {
          children.props.onMouseDown?.(e);
          hide();
        },
      })}
      {pos &&
        createPortal(
          <div className="tooltip" style={{ left: pos.x, top: pos.y, transform }}>
            {label}
            {kbd && <span className="kbd">{kbd}</span>}
          </div>,
          document.body,
        )}
    </>
  );
}

// ───────────────────────────── Menu ─────────────────────────────

export type MenuItem =
  | { type?: 'item'; label: string; icon?: IconName; kbd?: string; danger?: boolean; disabled?: boolean; onSelect: () => void }
  | { type: 'sep' }
  | { type: 'label'; label: string };

type MenuState = { x: number; y: number; items: MenuItem[]; origin: string } | null;
const menuStore = createStore<{ menu: MenuState }>({ menu: null });

export function openMenu(x: number, y: number, items: MenuItem[]) {
  const w = 220;
  const h = items.length * 32 + 10;
  const fx = x + w > window.innerWidth - 8 ? x - w : x;
  const fy = y + h > window.innerHeight - 8 ? Math.max(8, y - h) : y;
  menuStore.set({ menu: { x: fx, y: fy, items, origin: `${fx < x ? 'right' : 'left'} ${fy < y ? 'bottom' : 'top'}` } });
}

export function openMenuAt(el: HTMLElement, items: MenuItem[], align: 'left' | 'right' = 'left') {
  const r = el.getBoundingClientRect();
  openMenu(align === 'right' ? r.right - 220 : r.left, r.bottom + 6, items);
}

export function closeMenu() {
  menuStore.set({ menu: null });
}

export function MenuHost() {
  const menu = useSyncExternalStore(menuStore.subscribe, () => menuStore.get().menu);
  const [active, setActive] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    setActive(-1);
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      const items = menu.items.map((it, i) => ({ it, i })).filter(({ it }) => (it.type ?? 'item') === 'item' && !(it as any).disabled);
      if (e.key === 'Escape') closeMenu();
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => {
          const idx = items.findIndex((x) => x.i === a);
          const next = e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
          return items[next]?.i ?? -1;
        });
      } else if (e.key === 'Enter') {
        setActive((a) => {
          const it = menu.items[a] as any;
          if (it?.onSelect) {
            closeMenu();
            it.onSelect();
          }
          return a;
        });
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', closeMenu);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', closeMenu);
    };
  }, [menu]);
  if (!menu) return null;
  return createPortal(
    <div className="menu" ref={ref} style={{ left: menu.x, top: menu.y, ['--origin' as any]: menu.origin }} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {menu.items.map((it, i) => {
        if (it.type === 'sep') return <div key={i} className="menu-sep" />;
        if (it.type === 'label') return <div key={i} className="menu-label label">{it.label}</div>;
        return (
          <button
            key={i}
            role="menuitem"
            className={`menu-item ${it.danger ? 'danger' : ''}`}
            data-active={active === i}
            disabled={it.disabled}
            style={it.disabled ? { opacity: 0.4 } : undefined}
            onMouseEnter={() => setActive(i)}
            onClick={() => {
              closeMenu();
              it.onSelect();
            }}
          >
            {it.icon && <Icon name={it.icon} size={15} />}
            {it.label}
            {it.kbd && <span className="kbd">{it.kbd}</span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

// ───────────────────────────── Modal ─────────────────────────────

export function Modal({ open, onClose, children, width = 560, className = '', labelledBy }: { open: boolean; onClose: () => void; children: ReactNode; width?: number; className?: string; labelledBy?: string }) {
  const { mounted, state } = usePresence(open, 260);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);
  if (!mounted) return null;
  return createPortal(
    <div className="modal-root" data-state={state}>
      <div className="modal-scrim" onClick={onClose} />
      <div className={`modal ${className}`} style={{ width }} role="dialog" aria-modal aria-labelledby={labelledBy}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ───────────────────────────── Confirm ─────────────────────────────

type ConfirmReq = { title: string; body: ReactNode; confirm: string; danger?: boolean; typeToConfirm?: string; resolve: (v: boolean) => void } | null;
const confirmStore = createStore<{ req: ConfirmReq }>({ req: null });

export function confirmDialog(opts: { title: string; body: ReactNode; confirm?: string; danger?: boolean; typeToConfirm?: string }): Promise<boolean> {
  return new Promise((resolve) => confirmStore.set({ req: { confirm: 'Confirm', ...opts, resolve } }));
}

export function ConfirmHost() {
  const req = useSyncExternalStore(confirmStore.subscribe, () => confirmStore.get().req);
  const [typed, setTyped] = useState('');
  const last = useRef(req);
  if (req) last.current = req;
  const r = last.current;
  const close = useCallback(
    (v: boolean) => {
      confirmStore.get().req?.resolve(v);
      confirmStore.set({ req: null });
      setTimeout(() => setTyped(''), 300);
    },
    [],
  );
  return (
    <Modal open={!!req} onClose={() => close(false)} width={420}>
      {r && (
        <form
          className="confirm"
          onSubmit={(e) => {
            e.preventDefault();
            if (!r.typeToConfirm || typed === r.typeToConfirm) close(true);
          }}
        >
          <div className="confirm-icon" data-tone={r.danger ? 'err' : 'signal'}>
            <Icon name={r.danger ? 'alert' : 'info'} size={18} />
          </div>
          <h3 className="h2">{r.title}</h3>
          <div className="muted confirm-body">{r.body}</div>
          {r.typeToConfirm && (
            <div className="field">
              <span className="label">
                Type <code style={{ color: 'var(--text)' }}>{r.typeToConfirm}</code> to confirm
              </span>
              <input className="input mono" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
            </div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" variant={r.danger ? 'danger' : 'primary'} autoFocus={!r.typeToConfirm} disabled={!!r.typeToConfirm && typed !== r.typeToConfirm}>
              {r.confirm}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ───────────────────────────── Toasts ─────────────────────────────

type Toast = { id: number; title: string; body?: string; tone: Tone; action?: { label: string; onClick: () => void }; leaving?: boolean };
const toastStore = createStore<{ toasts: Toast[] }>({ toasts: [] });
let toastId = 0;

export function toast(t: { title: string; body?: string; tone?: Tone; action?: { label: string; onClick: () => void }; duration?: number }) {
  const id = ++toastId;
  toastStore.set((s) => ({ toasts: [...s.toasts.slice(-4), { id, tone: 'signal', ...t }] }));
  setTimeout(() => dismissToast(id), t.duration ?? 4200);
  return id;
}

export function dismissToast(id: number) {
  toastStore.set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }));
  setTimeout(() => toastStore.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 260);
}

export function toastError(e: unknown, title = 'Something went wrong') {
  toast({ title, body: (e as Error)?.message ?? String(e), tone: 'err', duration: 6000 });
}

const toneIcon: Record<Tone, IconName> = { ok: 'check', warn: 'alert', err: 'alert', build: 'box', idle: 'info', signal: 'sparkle' };

export function ToastHost() {
  const toasts = useSyncExternalStore(toastStore.subscribe, () => toastStore.get().toasts);
  return createPortal(
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.leaving ? 'leaving' : ''}`} data-tone={t.tone} onClick={() => dismissToast(t.id)}>
          <div className="toast-icon">
            <Icon name={toneIcon[t.tone]} size={14} stroke={2} />
          </div>
          <div className="grow">
            <div className="toast-title">{t.title}</div>
            {t.body && <div className="toast-body">{t.body}</div>}
          </div>
          {t.action && (
            <button
              className="btn btn-sm btn-secondary"
              onClick={(e) => {
                e.stopPropagation();
                t.action!.onClick();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}

// ───────────────────────────── misc ─────────────────────────────

export function Field({ label, hint, children, right }: { label: ReactNode; hint?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <label className="field">
      <span className="label">
        {label}
        {right && <span style={{ marginLeft: 'auto' }}>{right}</span>}
      </span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function CopyButton({ text, label, size = 'sm' }: { text: string; label?: string; size?: 'sm' | 'md' }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size={size}
      variant="ghost"
      iconOnly={!label}
      icon={done ? 'check' : 'copy'}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
      aria-label="Copy"
      style={done ? { color: 'var(--ok)' } : undefined}
    >
      {label}
    </Button>
  );
}

export function Empty({ icon, title, body, children }: { icon: IconName; title: string; body?: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty rise-in">
      <div className="empty-icon">
        <Icon name={icon} size={20} />
      </div>
      <div className="h3">{title}</div>
      {body && <div className="muted" style={{ maxWidth: 340 }}>{body}</div>}
      {children}
    </div>
  );
}
