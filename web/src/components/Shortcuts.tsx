import { useEffect, useState } from 'react';
import { Modal } from './ui.tsx';

const GROUPS: [string, [string, string][]][] = [
  ['Canvas', [['N', 'New service'], ['F', 'Fit to screen'], ['0', 'Zoom to 100%'], ['+ / −', 'Zoom in / out'], ['Space + drag', 'Pan'], ['⌘ + scroll / pinch', 'Zoom at cursor'], ['Double-click', 'New service here'], ['⌘Z', 'Undo move']]],
  ['Services', [['Tab / ⇧Tab', 'Next / previous service'], ['Esc', 'Close panel'], ['⌫', 'Delete selected'], ['Right-click', 'Service actions'], ['Double-click node', 'Focus & open'], ['Drag the ⊕ port', 'Connect services']]],
  ['Anywhere', [['⌘K', 'Command palette'], ['?', 'This help']]],
];

export function Shortcuts() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?' || (e.target as HTMLElement).closest('input, textarea, [contenteditable]')) return;
      setOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <Modal open={open} onClose={() => setOpen(false)} width={560}>
      <div style={{ padding: 24 }}>
        <h2 className="h2" style={{ marginBottom: 16 }}>
          Keyboard shortcuts
        </h2>
        <div className="shortcut-grid">
          {GROUPS.map(([g, items]) => (
            <div key={g}>
              <div className="label" style={{ marginBottom: 8 }}>
                {g}
              </div>
              {items.map(([k, d]) => (
                <div key={k} className="shortcut-row">
                  <span className="muted">{d}</span>
                  <span className="kbd" style={{ minWidth: 0, padding: '0 6px' }}>
                    {k}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
