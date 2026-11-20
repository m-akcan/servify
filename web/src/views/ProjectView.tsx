import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore, loadProject, store } from '../lib/store.ts';
import { navigate, projectPath } from '../lib/router.ts';
import { api } from '../lib/api.ts';
import { Canvas, type CanvasHandle } from '../canvas/Canvas.tsx';
import { ServicePanel } from '../panels/ServicePanel.tsx';
import { NewServiceModal } from './NewService.tsx';
import { Button, openMenu, toastError, Tooltip, Kbd, Empty } from '../components/ui.tsx';
import { Icon } from '../components/Icon.tsx';
import { serviceMenu, deploy, remove, connectServices } from '../lib/actions.ts';
import { ActivityFeed } from '../panels/ActivityFeed.tsx';
import { registerCommands } from '../components/CommandPalette.tsx';
import { Spring, springs } from '../motion/spring.ts';
import type { Pt } from '../canvas/geometry.ts';
import { ProjectSettings } from './ProjectSettings.tsx';

const PANEL_W_KEY = 'servify.panelWidth';

export function ProjectView({ slug, serviceSlug, tab }: { slug: string; serviceSlug?: string; tab?: string }) {
  const current = useStore((s) => s.current);
  const loading = useStore((s) => s.loadingProject);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ at: Pt | null } | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const canvasRef = useRef<CanvasHandle>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelW, setPanelW] = useState(() => {
    try {
      return Number(localStorage.getItem(PANEL_W_KEY)) || 620;
    } catch {
      return 620;
    }
  });

  useEffect(() => {
    setError(null);
    loadProject(slug).catch((e) => setError(e.message));
  }, [slug]);

  const state = current && (current.project.slug === slug || current.project.id === slug) ? current : null;
  const selected = useMemo(() => {
    if (!state || !serviceSlug) return null;
    return Object.values(state.services).find((s) => s.slug === serviceSlug || s.id === serviceSlug) ?? null;
  }, [state, serviceSlug]);

  // Panel slide spring.
  const panelSpring = useRef<Spring | null>(null);
  const open = !!selected;
  useEffect(() => {
    if (!panelSpring.current) {
      panelSpring.current = new Spring(open ? 1 : 0, springs.panel);
      panelSpring.current.onChange((v) => {
        const el = panelRef.current;
        if (!el) return;
        el.style.transform = `translate3d(${(1 - v) * 104}%, 0, 0)`;
        el.style.opacity = String(Math.min(1, v * 2));
        el.style.visibility = v < 0.001 ? 'hidden' : 'visible';
      });
      const el = panelRef.current;
      if (el) {
        el.style.transform = `translate3d(${open ? 0 : 104}%, 0, 0)`;
        el.style.visibility = open ? 'visible' : 'hidden';
      }
    } else panelSpring.current.set(open ? 1 : 0);
  }, [open]);

  const select = useCallback(
    (id: string | null, t?: string) => {
      const st = store.get().current;
      if (!st) return;
      if (!id) return navigate(projectPath(st.project.slug));
      const s = st.services[id];
      if (s) navigate(projectPath(st.project.slug, s.slug, t));
    },
    [],
  );

  const undoStack = useRef<{ id: string; x: number; y: number }[]>([]);
  const onMoved = useCallback(async (id: string, x: number, y: number, fromX: number, fromY: number) => {
    undoStack.current.push({ id, x: fromX, y: fromY });
    if (undoStack.current.length > 50) undoStack.current.shift();
    try {
      await api.patch(`/services/${id}`, { x, y });
    } catch (e) {
      toastError(e, 'Could not save position');
    }
  }, []);

  const onNodeMenu = useCallback(
    (id: string, x: number, y: number) => {
      const s = store.get().current?.services[id];
      if (!s) return;
      openMenu(x, y, serviceMenu(s, { open: (t) => select(id, t) }));
    },
    [select],
  );

  const onConnect = useCallback((fromId: string, toId: string, x: number, y: number) => {
    const st = store.get().current;
    const from = st?.services[fromId];
    const to = st?.services[toId];
    if (!from || !to) return;
    const keys = Object.keys(to.env).filter((k) => !to.secretKeys.includes(k) || /URL$/.test(k));
    const urlKeys = Object.keys(to.env).filter((k) => /URL$/.test(k));
    const ordered = [...new Set([...urlKeys, ...keys])].slice(0, 8);
    const prefix = to.slug.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const ref = (k: string) => `\${{ ${to.slug}.${k} }}`;
    openMenu(x, y, [
      { type: 'label', label: `Reference ${to.name} from ${from.name}` },
      ...ordered.map((k) => ({
        label: k,
        icon: (/URL$/.test(k) ? 'link' : 'braces') as any,
        onSelect: () => void connectServices(from, to, k in from.env ? `${prefix}_${k}` : k, ref(k)),
      })),
      ...(ordered.length ? [{ type: 'sep' as const }] : []),
      { label: 'Private hostname', icon: 'shield', onSelect: () => void connectServices(from, to, `${prefix}_HOST`, ref('SERVIFY_PRIVATE_DOMAIN')) },
      ...(to.protocol === 'http' ? [{ label: 'Internal URL', icon: 'globe' as const, onSelect: () => void connectServices(from, to, `${prefix}_URL`, `http://${ref('SERVIFY_PRIVATE_DOMAIN')}:${ref('PORT')}`) }] : []),
    ]);
  }, []);

  const onCanvasMenu = useCallback((world: Pt, x: number, y: number) => {
    openMenu(x, y, [
      { label: 'New service here', icon: 'plus', kbd: 'N', onSelect: () => setCreating({ at: world }) },
      { label: 'Fit to screen', icon: 'fit', kbd: 'F', onSelect: () => canvasRef.current?.fit() },
      { label: 'Reset zoom', icon: 'search', kbd: '0', onSelect: () => canvasRef.current?.resetZoom() },
      { type: 'sep' },
      { label: 'Activity', icon: 'activity', onSelect: () => setActivityOpen(true) },
    ]);
  }, []);

  // Keyboard shortcuts on the canvas.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable], .modal-root, .palette')) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        const last = undoStack.current.pop();
        if (last) {
          e.preventDefault();
          void api.patch(`/services/${last.id}`, { x: last.x, y: last.y }).catch(() => {});
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const st = store.get().current;
      if (!st) return;
      const sel = serviceSlug ? Object.values(st.services).find((s) => s.slug === serviceSlug) : null;
      switch (e.key) {
        case 'n':
        case 'N':
          e.preventDefault();
          setCreating({ at: null });
          break;
        case 'f':
        case 'F':
          canvasRef.current?.fit();
          break;
        case '0':
          canvasRef.current?.resetZoom();
          break;
        case '=':
        case '+':
          canvasRef.current?.zoomBy(1.25);
          break;
        case '-':
          canvasRef.current?.zoomBy(0.8);
          break;
        case 'Escape':
          if (sel) select(null);
          break;
        case 'Backspace':
        case 'Delete':
          if (sel) void remove(sel);
          break;
        case 'Tab': {
          e.preventDefault();
          const ids = st.order;
          if (!ids.length) break;
          const idx = sel ? ids.indexOf(sel.id) : -1;
          const next = ids[(idx + (e.shiftKey ? -1 : 1) + ids.length) % ids.length];
          select(next);
          setTimeout(() => canvasRef.current?.focus(next), 30);
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [serviceSlug, select]);

  // Register project-scoped commands for ⌘K.
  useEffect(() => {
    if (!state) return;
    return registerCommands('project', [
      { id: 'new-service', title: 'New service…', icon: 'plus', group: 'Project', kbd: 'N', run: () => setCreating({ at: null }) },
      { id: 'fit', title: 'Fit canvas to screen', icon: 'fit', group: 'Canvas', kbd: 'F', run: () => canvasRef.current?.fit() },
      { id: 'activity', title: 'Show activity', icon: 'activity', group: 'Project', run: () => setActivityOpen(true) },
      { id: 'project-settings', title: 'Project settings', icon: 'sliders', group: 'Project', run: () => setSettingsOpen(true) },
      ...Object.values(state.services).flatMap((s) => [
        { id: `open-${s.id}`, title: s.name, subtitle: 'Open service', icon: 'box' as const, group: 'Services', run: (): void => select(s.id) },
        { id: `deploy-${s.id}`, title: `Deploy ${s.name}`, icon: 'rocket' as const, group: 'Actions', run: (): void => void deploy(s) },
        { id: `logs-${s.id}`, title: `Logs: ${s.name}`, icon: 'logs' as const, group: 'Actions', run: (): void => select(s.id, 'logs') },
      ]),
    ]);
  }, [state, select]);

  const onPanelResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelW;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    let w = startW;
    const move = (ev: PointerEvent) => {
      w = Math.max(440, Math.min(window.innerWidth - 240, startW + (startX - ev.clientX)));
      setPanelW(w);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
      try {
        localStorage.setItem(PANEL_W_KEY, String(w));
      } catch {}
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  if (error) {
    return (
      <div className="center-fill">
        <Empty icon="alert" title="Project not found" body={error}>
          <Button onClick={() => navigate('/')} icon="arrowRight" style={{ marginTop: 8 }}>
            Back to projects
          </Button>
        </Empty>
      </div>
    );
  }
  if (!state) {
    return <div className="center-fill">{loading && <span className="spinner" style={{ color: 'var(--text-3)' }} />}</div>;
  }

  const services = Object.values(state.services);
  const pending = services.filter((s) => s.pendingChanges.length && s.activeDeploymentId);
  const empty = services.length === 0;

  return (
    <div className="project-view">
      <Canvas
        ref={canvasRef}
        state={state}
        selectedId={selected?.id ?? null}
        panelWidth={open ? panelW : 0}
        onSelect={select}
        onCreateAt={(at) => setCreating({ at })}
        onNodeMenu={onNodeMenu}
        onCanvasMenu={onCanvasMenu}
        onMoved={onMoved}
        onConnect={onConnect}
      />

      {empty && (
        <div className="canvas-empty">
          <div className="canvas-empty-card rise-in">
            <div className="ce-orbit">
              <span />
              <span />
              <span />
            </div>
            <h2 className="h2">Deploy your first service</h2>
            <p className="muted">From a GitHub repo, a Docker image, a folder on this machine, or a one-click template.</p>
            <div className="row" style={{ gap: 8 }}>
              <Button variant="primary" size="lg" icon="plus" onClick={() => setCreating({ at: null })}>
                New service
              </Button>
              <Button
                size="lg"
                icon="sparkle"
                onClick={async () => {
                  try {
                    await api.post(`/projects/${state.project.id}/demo`);
                    setTimeout(() => canvasRef.current?.fit(), 600);
                  } catch (e) {
                    toastError(e, 'Could not load demo');
                  }
                }}
              >
                Load demo stack
              </Button>
            </div>
            <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>
              or double-click anywhere on the canvas · <Kbd>N</Kbd>
            </div>
          </div>
        </div>
      )}

      <div className="canvas-topleft">
        <div className="project-chip glass">
          <span className="crumb-dot" style={{ background: state.project.color }} />
          <span className="project-chip-name">{state.project.name}</span>
          <span className="faint mono" style={{ fontSize: 11 }}>
            {services.length} svc
          </span>
          <Tooltip label="Project settings" side="bottom">
            <button className="cc-btn" onClick={() => setSettingsOpen(true)} aria-label="Project settings">
              <Icon name="sliders" size={14} />
            </button>
          </Tooltip>
          <Tooltip label="Activity" side="bottom">
            <button className={`cc-btn ${activityOpen ? 'on' : ''}`} onClick={() => setActivityOpen((v) => !v)} aria-label="Activity">
              <Icon name="activity" size={14} />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="canvas-topright" style={{ right: 16 + (open ? panelW : 0) }}>
        <Button variant="primary" icon="plus" onClick={() => setCreating({ at: null })}>
          New
        </Button>
      </div>

      {pending.length > 0 && (
        <div className="pending-bar glass rise-in" style={{ marginLeft: open ? -panelW / 2 : 0 }}>
          <span className="pending-dot" />
          <span>
            <b>{pending.length}</b> service{pending.length > 1 ? 's have' : ' has'} undeployed changes
          </span>
          <span className="faint truncate" style={{ maxWidth: 220 }}>
            {pending.map((s) => s.name).join(', ')}
          </span>
          <Button size="sm" variant="primary" icon="rocket" onClick={() => pending.forEach((s) => void deploy(s))}>
            Deploy {pending.length > 1 ? 'all' : ''}
          </Button>
        </div>
      )}

      <ActivityFeed open={activityOpen} onClose={() => setActivityOpen(false)} />

      <div className="panel-wrap" ref={panelRef} style={{ width: panelW }}>
        <div className="panel-resize" onPointerDown={onPanelResize} />
        {selected && <ServicePanel key={selected.id} service={selected} tab={tab} onClose={() => select(null)} onTab={(t) => select(selected.id, t)} />}
      </div>

      <NewServiceModal
        open={!!creating}
        onClose={() => setCreating(null)}
        projectId={state.project.id}
        at={creating?.at ?? null}
        getCenter={() => canvasRef.current?.centerWorld() ?? { x: 0, y: 0 }}
        onCreated={(id) => {
          setCreating(null);
          setTimeout(() => {
            canvasRef.current?.focus(id);
            select(id);
          }, 120);
        }}
      />
      <ProjectSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} project={state.project} />
    </div>
  );
}
