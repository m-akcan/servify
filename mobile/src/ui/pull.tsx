import { useRef, useState, type ReactNode } from 'react';
import { Spinner } from './kit.tsx';

/** A scroll area with pull-to-refresh. */
export function PullScroll({ onRefresh, children, className = 'scroll' }: { onRefresh: () => Promise<unknown>; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<number | null>(null);
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const TRIGGER = 50; // px of (damped) pull that starts a refresh
  return (
    <div
      ref={ref}
      className={className}
      onTouchStart={(e) => {
        start.current = ref.current && ref.current.scrollTop <= 0 && !busy ? e.touches[0].clientY : null;
      }}
      onTouchMove={(e) => {
        if (start.current === null) return;
        const d = e.touches[0].clientY - start.current;
        setPull(d > 0 ? Math.min(110, d * 0.5) : 0);
      }}
      onTouchEnd={async () => {
        const go = pull >= TRIGGER;
        start.current = null;
        setPull(0);
        if (!go) return;
        setBusy(true);
        try {
          await onRefresh();
        } catch {
          /* the screen shows its own error */
        } finally {
          setBusy(false);
        }
      }}
    >
      {(pull > 0 || busy) && (
        <div className="ptr" style={{ height: busy ? 40 : pull, opacity: busy ? 1 : Math.min(1, pull / TRIGGER) }}>
          <div style={{ paddingTop: 8 }}>
            <Spinner />
          </div>
        </div>
      )}
      {children}
    </div>
  );
}
