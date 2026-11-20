import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon.tsx';
import { createStore, store } from '../lib/store.ts';
import { navigate, projectPath } from '../lib/router.ts';
import { usePresence } from '../motion/hooks.ts';
import { setThemePref, resolvedTheme } from '../lib/theme.ts';

export type Command = { id: string; title: string; subtitle?: string; icon: IconName; group: string; kbd?: string; run: () => void };

const pal = createStore<{ open: boolean; scopes: Record<string, Command[]> }>({ open: false, scopes: {} });

export function openPalette() {
  pal.set({ open: true });
}

export function registerCommands(scope: string, cmds: Command[]) {
  pal.set((s) => ({ scopes: { ...s.scopes, [scope]: cmds } }));
  return () =>
    pal.set((s) => {
      const scopes = { ...s.scopes };
      delete scopes[scope];
      return { scopes };
    });
}

/** Fuzzy score: consecutive and word-start matches rank higher. */
function score(q: string, text: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const query = q.toLowerCase();
  if (t.includes(query)) return 100 - t.indexOf(query) + (t.startsWith(query) ? 50 : 0);
  let ti = 0;
  let s = 0;
  let streak = 0;
  for (const ch of query) {
    const idx = t.indexOf(ch, ti);
    if (idx < 0) return 0;
    streak = idx === ti ? streak + 1 : 0;
    s += 1 + streak * 2 + (idx === 0 || t[idx - 1] === ' ' ? 3 : 0);
    ti = idx + 1;
  }
  return s;
}

export function CommandPalette() {
  const { open, scopes } = useSyncExternalStore(pal.subscribe, pal.get);
  const { mounted, state } = usePresence(open, 200);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        pal.set((s) => ({ open: !s.open }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
    }
  }, [open]);

  const globals: Command[] = useMemo(() => {
    const projects = store.get().projects;
    return [
      { id: 'home', title: 'All projects', icon: 'grid', group: 'Navigate', run: () => navigate('/') },
      { id: 'agents', title: 'Agents, API tokens & MCP', icon: 'bot', group: 'Navigate', run: () => navigate('/agents') },
      ...projects.map((p) => ({ id: `p-${p.id}`, title: p.name, subtitle: `${p.serviceCount} services`, icon: 'layers' as IconName, group: 'Projects', run: () => navigate(projectPath(p.slug)) })),
      { id: 'theme', title: `Switch to ${resolvedTheme() === 'dark' ? 'light' : 'dark'} theme`, icon: resolvedTheme() === 'dark' ? 'sun' : 'moon', group: 'Preferences', run: () => setThemePref(resolvedTheme() === 'dark' ? 'light' : 'dark') },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const all = [...Object.values(scopes).flat(), ...globals];
  const results = all
    .map((c) => ({ c, s: Math.max(score(q, c.title), score(q, `${c.group} ${c.title}`) * 0.6, c.subtitle ? score(q, c.subtitle) * 0.4 : 0) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => (q ? b.s - a.s : 0))
    .slice(0, 40)
    .map((r) => r.c);

  const grouped: { group: string; items: { c: Command; i: number }[] }[] = [];
  results.forEach((c, i) => {
    let g = grouped.find((x) => x.group === c.group);
    if (!g) grouped.push((g = { group: c.group, items: [] }));
    g.items.push({ c, i });
  });
  const flat = grouped.flatMap((g) => g.items.map((x) => x.c));

  const run = (c: Command) => {
    pal.set({ open: false });
    setTimeout(c.run, 10);
  };

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!mounted) return null;
  return createPortal(
    <div className="palette-root" data-state={state}>
      <div className="palette-scrim" onClick={() => pal.set({ open: false })} />
      <div className="palette" role="dialog" aria-label="Command palette">
        <div className="palette-input">
          <Icon name="search" size={16} />
          <input
            autoFocus
            placeholder="Search services, projects, actions…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(flat.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter' && flat[active]) {
                run(flat[active]);
              } else if (e.key === 'Escape') {
                pal.set({ open: false });
              }
            }}
          />
          <span className="kbd">esc</span>
        </div>
        <div className="palette-list" ref={listRef}>
          {flat.length === 0 && <div className="palette-empty">No results for “{q}”</div>}
          {(() => {
            let idx = 0;
            return grouped.map((g) => (
              <div key={g.group}>
                <div className="palette-group label">{g.group}</div>
                {g.items.map(({ c }) => {
                  const i = idx++;
                  return (
                    <button key={c.id} className="palette-item" data-active={i === active} onMouseMove={() => setActive(i)} onClick={() => run(c)}>
                      <span className="palette-icon">
                        <Icon name={c.icon} size={15} />
                      </span>
                      <span className="grow truncate">
                        {c.title}
                        {c.subtitle && <span className="faint" style={{ marginLeft: 8, fontSize: 12 }}>{c.subtitle}</span>}
                      </span>
                      {c.kbd && <span className="kbd">{c.kbd}</span>}
                      {i === active && <Icon name="arrowRight" size={14} className="faint" />}
                    </button>
                  );
                })}
              </div>
            ));
          })()}
        </div>
        <div className="palette-foot">
          <span><span className="kbd">↑</span><span className="kbd">↓</span> navigate</span>
          <span><span className="kbd">↵</span> run</span>
          <span className="spacer" />
          <span className="faint">servify</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
