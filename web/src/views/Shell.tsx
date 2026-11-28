import type { ReactNode } from 'react';
import { ProjectMark } from '../components/ProjectMark.tsx';
import { useStore } from '../lib/store.ts';
import { navigate, useRoute, projectPath } from '../lib/router.ts';
import { Icon } from '../components/Icon.tsx';
import { Tooltip, openMenuAt, Kbd } from '../components/ui.tsx';
import { openPalette } from '../components/CommandPalette.tsx';
import { getThemePref, setThemePref } from '../lib/theme.ts';
import { api } from '../lib/api.ts';
import { checkAuth, onServerEvent } from '../lib/store.ts';
import type { DiskState } from '../../../server/src/types.ts';
import { useEffect, useState } from 'react';
import { EnvironmentCrumb } from '../components/Environments.tsx';

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

function ReconnectBanner({ connected }: { connected: boolean }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (connected) return setShow(false);
    const t = setTimeout(() => setShow(true), 2500);
    return () => clearTimeout(t);
  }, [connected]);
  if (!show) return null;
  return (
    <div className="reconnect glass rise-in">
      <span className="spinner" style={{ width: 12, height: 12 }} />
      Reconnecting to Servify…
    </div>
  );
}

const GB = 1024 ** 3;
const size = (n: number | null) => (n == null ? '?' : n >= 100 * GB ? `${Math.round(n / GB)} GB` : n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);

/** Low disk space protection: shown on every page while a disk is protected (what is paused, which disk, what to do). */
function LowDiskBanner({ connected }: { connected: boolean }) {
  const [disk, setDisk] = useState<DiskState | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!connected) return;
    let gone = false;
    void api
      .get<{ disk?: DiskState }>('/system')
      .then((s) => !gone && setDisk(s.disk ?? null))
      .catch(() => {});
    const off = onServerEvent((ev) => {
      if (ev.type === 'disk.updated') setDisk(ev.disk);
    });
    return () => {
      gone = true;
      off();
    };
  }, [connected]);
  if (!disk || disk.level !== 'protect') return null;
  const low = disk.disks.filter((d) => d.level === 'protect');
  return (
    <div className="lowdisk-banner" role="alert">
      <Icon name="alert" size={15} />
      <div className="lowdisk-text">
        <strong>Low disk space — protecting {low.map((d) => (d.nodeId ? d.name : `the ${d.name}`)).join(' and ')}.</strong>{' '}
        {low.map((d) => `${size(d.freeBytes)} free of ${size(d.totalBytes)}${d.path ? ` (${d.path})` : ''}, protection below ${size(d.protectBytes)}`).join('; ')}.{' '}
        {open ? (
          <>
            {disk.paused.length > 0 && <>Paused: {disk.paused.join('; ')}. </>}
            {disk.refused.length > 0 && <>Refused: {disk.refused.join('; ')}. </>}
            {disk.howToFree}
            {disk.lastCleanup && disk.lastCleanup.steps.length > 0 && <> Automatic clean-up: {disk.lastCleanup.steps.join('; ')}.</>}
          </>
        ) : (
          <>{disk.refused.length > 0 && <>Refused: {disk.refused.join('; ')}. </>}</>
        )}
      </div>
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(!open)}>
        {open ? 'Less' : 'What to do'}
      </button>
    </div>
  );
}

/** Notification channels that keep failing (checked every minute): a dot on the settings button. */
function useFailingChannels(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const load = () =>
      api
        .get<Record<string, { failing: boolean }>>('/settings/notifications/health')
        .then((h) => setN(Object.values(h).filter((x) => x.failing).length))
        .catch(() => {});
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  return n;
}

export function Shell({ children }: { children: ReactNode }) {
  const route = useRoute();
  const projects = useStore((s) => s.projects);
  const connected = useStore((s) => s.connected);
  const authMode = useStore((s) => s.auth.authMode);
  const current = route.name === 'project' ? projects.find((p) => p.slug === route.project || p.id === route.project) : null;
  const base = current?.parentId ? projects.find((p) => p.id === current.parentId) ?? current : current;
  const [theme, setTheme] = useState(getThemePref());
  const failingChannels = useFailingChannels();

  const switchProject = (el: HTMLElement) =>
    openMenuAt(el, [
      { type: 'label', label: 'Projects' },
      ...projects.filter((p) => !p.parentId).map((p) => ({
        label: p.name,
        icon: (base?.id === p.id ? 'check' : 'dot') as any,
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
        {current && base ? (
          <>
            <button className="crumb" onClick={(e) => switchProject(e.currentTarget)}>
              <ProjectMark project={base} size={18} />
              {base.name}
              <Icon name="chevronDown" size={14} />
            </button>
            <span className="crumb-sep">/</span>
            <EnvironmentCrumb current={current} />
          </>
        ) : (
          <button className={`crumb ${route.name === 'home' ? 'active' : ''}`} onClick={() => navigate('/')}>
            {route.name === 'agents' ? 'Agents & API' : route.name === 'servers' ? 'Servers' : route.name === 'traffic' ? 'Traffic' : route.name === 'settings' ? 'Settings' : 'Projects'}
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
          <Tooltip label="Traffic — every request through the router, live" side="bottom">
            <button className={`btn btn-ghost btn-sm ${route.name === 'traffic' ? 'active' : ''}`} onClick={() => navigate('/traffic')}>
              <Icon name="pulse" size={15} />
              Traffic
            </button>
          </Tooltip>
          <Tooltip label="Servers — run services on other machines" side="bottom">
            <button className={`btn btn-ghost btn-sm ${route.name === 'servers' ? 'active' : ''}`} onClick={() => navigate('/servers')}>
              <Icon name="server" size={15} />
              Servers
            </button>
          </Tooltip>
          <Tooltip label="Agents, API tokens & MCP" side="bottom">
            <button className={`btn btn-ghost btn-sm ${route.name === 'agents' ? 'active' : ''}`} onClick={() => navigate('/agents')}>
              <Icon name="bot" size={15} />
              Agents
            </button>
          </Tooltip>
          <Tooltip label={failingChannels ? 'A notification channel keeps failing — Settings → Notifications' : 'Settings — HTTPS, notifications, backups, webhooks'} side="bottom">
            <button className={`btn btn-ghost btn-sm btn-icon ${route.name === 'settings' ? 'active' : ''}`} style={{ position: 'relative' }} onClick={() => navigate(failingChannels ? '/settings/notifications' : '/settings')} aria-label="Settings">
              <Icon name="gear" size={15} />
              {failingChannels > 0 && <span className="tls-dot" data-tls="failed" data-testid="notify-failing-dot" style={{ position: 'absolute', top: 3, right: 3, width: 7, height: 7 }} />}
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
      <LowDiskBanner connected={connected} />
      <main className="main">
        {children}
        <ReconnectBanner connected={connected} />
      </main>
    </div>
  );
}
