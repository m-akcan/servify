import type { ReactNode } from 'react';
import { useStore } from '../lib/store.ts';
import { navigate, useRoute, projectPath } from '../lib/router.ts';
import { Icon } from '../components/Icon.tsx';
import { Tooltip, openMenuAt, Kbd } from '../components/ui.tsx';
import { openPalette } from '../components/CommandPalette.tsx';
import { getThemePref, setThemePref } from '../lib/theme.ts';
import { api } from '../lib/api.ts';
import { checkAuth } from '../lib/store.ts';
import { useState } from 'react';

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className="logo-mark" aria-hidden>
      <rect x="5" y="5" width="10" height="10" rx="2.6" fill="var(--signal)" />
      <rect x="17" y="5" width="10" height="10" rx="2.6" fill="var(--signal)" opacity=".55" />
      <rect x="5" y="17" width="10" height="10" rx="2.6" fill="var(--signal)" opacity=".55" />
      <rect x="17" y="17" width="10" height="10" rx="2.6" fill="var(--signal)" opacity=".22" />
    </svg>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const route = useRoute();
  const projects = useStore((s) => s.projects);
  const connected = useStore((s) => s.connected);
  const authMode = useStore((s) => s.auth.authMode);
  const current = route.name === 'project' ? projects.find((p) => p.slug === route.project || p.id === route.project) : null;
  const [theme, setTheme] = useState(getThemePref());

  const switchProject = (el: HTMLElement) =>
    openMenuAt(el, [
      { type: 'label', label: 'Projects' },
      ...projects.map((p) => ({
        label: p.name,
        icon: (current?.id === p.id ? 'check' : 'dot') as any,
        onSelect: () => navigate(projectPath(p.slug)),
      })),
      { type: 'sep' as const },
      { label: 'All projects', icon: 'grid' as const, onSelect: () => navigate('/') },
    ]);

  const cycleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setThemePref(next);
  };

  return (
    <div className="shell">
      <header className="topbar">
        <button className="brand" onClick={() => navigate('/')}>
          <Logo />
          <span className="brand-name">servify</span>
        </button>
        <span className="crumb-sep">/</span>
        {current ? (
          <button className="crumb" onClick={(e) => switchProject(e.currentTarget)}>
            <span className="crumb-dot" style={{ background: current.color }} />
            {current.name}
            <Icon name="chevronDown" size={14} />
          </button>
        ) : (
          <button className={`crumb ${route.name === 'home' ? 'active' : ''}`} onClick={() => navigate('/')}>
            {route.name === 'agents' ? 'Agents & API' : route.name === 'settings' ? 'Settings' : 'Projects'}
          </button>
        )}
        <div className="spacer" />
        <button className="search-trigger" onClick={() => openPalette()}>
          <Icon name="search" size={14} />
          <span>Search or run a command…</span>
          <Kbd>⌘K</Kbd>
        </button>
        <div className="spacer" />
        <div className="topbar-right">
          <Tooltip label={connected ? 'Live — connected to Servify' : 'Reconnecting…'} side="bottom">
            <span className={`conn ${connected ? 'on' : ''}`} />
          </Tooltip>
          <Tooltip label="Agents, API tokens & MCP" side="bottom">
            <button className={`btn btn-ghost btn-sm ${route.name === 'agents' ? 'active' : ''}`} onClick={() => navigate('/agents')}>
              <Icon name="bot" size={15} />
              Agents
            </button>
          </Tooltip>
          <Tooltip label={theme === 'dark' ? 'Light theme' : 'Dark theme'} side="bottom">
            <button className="btn btn-ghost btn-sm btn-icon" onClick={cycleTheme} aria-label="Toggle theme">
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />
            </button>
          </Tooltip>
          {authMode === 'password' && (
            <Tooltip label="Sign out" side="bottom">
              <button
                className="btn btn-ghost btn-sm btn-icon"
                aria-label="Sign out"
                onClick={async () => {
                  await api.post('/auth/logout');
                  await checkAuth();
                }}
              >
                <Icon name="logout" size={15} />
              </button>
            </Tooltip>
          )}
        </div>
      </header>
      <main className="main">{children}</main>
    </div>
  );
}
