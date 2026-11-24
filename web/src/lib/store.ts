import { useSyncExternalStore, useRef, useEffect, useState } from 'react';
import { api, sse } from './api.ts';
import type { ActivityEntry, Deployment, ProjectListItem, Replica, ServerEvent, ServiceView, SystemInfo, Template, Project, VolumeRecord } from './types.ts';

// ───────────────────────────── tiny store primitive ─────────────────────────────

export function createStore<T>(initial: T) {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<T> | ((s: T) => Partial<T>)) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...p };
      for (const fn of subs) fn();
    },
    subscribe(fn: () => void) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export type ProjectState = {
  project: Project;
  services: Record<string, ServiceView>;
  order: string[];
  deployments: Record<string, Deployment>;
  replicas: Record<string, Replica[]>;
  edges: { from: string; to: string }[];
  volumes: Record<string, VolumeRecord>;
  proxyPort: number;
};

type AppState = {
  auth: { checked: boolean; setUp: boolean; authenticated: boolean; authMode: 'password' | 'none' };
  system: SystemInfo | null;
  projects: ProjectListItem[];
  projectsLoaded: boolean;
  current: ProjectState | null;
  loadingProject: boolean;
  activity: ActivityEntry[];
  templates: Template[];
  connected: boolean;
};

export const store = createStore<AppState>({
  auth: { checked: false, setUp: true, authenticated: false, authMode: 'password' },
  system: null,
  projects: [],
  projectsLoaded: false,
  current: null,
  loadingProject: false,
  activity: [],
  templates: [],
  connected: false,
});

export function useStore<S>(selector: (s: AppState) => S): S {
  const sel = useRef(selector);
  sel.current = selector;
  const cache = useRef<{ state: AppState; value: S } | null>(null);
  return useSyncExternalStore(store.subscribe, () => {
    const s = store.get();
    if (cache.current && cache.current.state === s) return cache.current.value;
    const v = sel.current(s);
    // Keep referential stability when the selected slice didn't change.
    if (cache.current && Object.is(cache.current.value, v)) {
      cache.current = { state: s, value: cache.current.value };
      return cache.current.value;
    }
    cache.current = { state: s, value: v };
    return v;
  });
}

// ───────────────────────────── traffic (high-frequency, outside React) ─────────────────────────────

export type Traffic = { rps: number; errors: number; p95: number; replicas: Record<string, number> };
export const traffic = {
  data: {} as Record<string, Traffic>,
  history: {} as Record<string, number[]>,
  subs: new Set<() => void>(),
  tick: 0,
};

/** Latest build/deploy log line per service, for the live ticker on canvas nodes. */
export const deployTail = {
  data: {} as Record<string, { line: string; ts: number }>,
  subs: new Set<() => void>(),
};

export function useDeployTail(serviceId: string, enabled: boolean) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const fn = () => force((n) => n + 1);
    deployTail.subs.add(fn);
    return () => {
      deployTail.subs.delete(fn);
    };
  }, [enabled]);
  return enabled ? deployTail.data[serviceId] ?? null : null;
}

export function useTraffic(serviceId: string | null | undefined): Traffic | null {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    traffic.subs.add(fn);
    return () => {
      traffic.subs.delete(fn);
    };
  }, []);
  return serviceId ? traffic.data[serviceId] ?? null : null;
}

// ───────────────────────────── loaders ─────────────────────────────

export async function checkAuth() {
  const s = await api.get<{ setUp: boolean; authenticated: boolean; authMode: 'password' | 'none' }>('/auth/status');
  store.set({ auth: { checked: true, ...s } });
  return s;
}

export async function loadSystem() {
  const system = await api.get<SystemInfo>('/system');
  store.set({ system });
}

let refreshTimer: number | null = null;
function refreshProjectsSoon() {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void loadProjects();
  }, 300);
}

export async function loadProjects() {
  const projects = await api.get<ProjectListItem[]>('/projects');
  store.set({ projects, projectsLoaded: true });
  return projects;
}

export async function loadTemplates() {
  if (store.get().templates.length) return;
  store.set({ templates: await api.get<Template[]>('/templates') });
}

export async function loadProject(idOrSlug: string) {
  store.set({ loadingProject: true });
  try {
    const snap = await api.get<any>(`/projects/${idOrSlug}`);
    const services: Record<string, ServiceView> = {};
    for (const s of snap.services) services[s.id] = s;
    const deployments: Record<string, Deployment> = {};
    for (const d of snap.deployments) deployments[d.id] = d;
    store.set({
      current: {
        project: snap.project,
        services,
        order: snap.services.map((s: ServiceView) => s.id),
        deployments,
        replicas: snap.replicas,
        edges: snap.edges,
        volumes: Object.fromEntries((snap.volumes ?? []).map((v: VolumeRecord) => [v.id, v])),
        proxyPort: snap.proxyPort,
      },
      loadingProject: false,
    });
    const act = await api.get<ActivityEntry[]>(`/projects/${snap.project.id}/activity?limit=60`);
    store.set({ activity: act });
    return snap.project as Project;
  } catch (e) {
    store.set({ loadingProject: false, current: null });
    throw e;
  }
}

/** Recompute reference edges locally (variables changed). */
const REF = /\$\{\{\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)\s*\}\}/g;
function computeEdges(services: Record<string, ServiceView>) {
  const list = Object.values(services);
  const edges: { from: string; to: string }[] = [];
  for (const s of list) {
    const targets = new Set<string>();
    for (const v of Object.values(s.env)) for (const m of v.matchAll(REF)) {
      const t = list.find((x) => x.id !== s.id && (x.slug === m[1] || x.name === m[1]));
      if (t) targets.add(t.id);
    }
    for (const t of targets) edges.push({ from: s.id, to: t });
  }
  return edges;
}

// ───────────────────────────── realtime ─────────────────────────────

export const deployLogBus = new EventTarget();
let stopEvents: (() => void) | null = null;
const toastListeners = new Set<(ev: ServerEvent) => void>();
export function onServerEvent(fn: (ev: ServerEvent) => void): () => void {
  toastListeners.add(fn);
  return () => {
    toastListeners.delete(fn);
  };
}

export function connectEvents() {
  stopEvents?.();
  let first = true;
  stopEvents = sse(
    '/events',
    {
      message: (ev: ServerEvent) => applyEvent(ev),
    },
    () => {
      store.set({ connected: true });
      if (!first) {
        // Resync after reconnect: we may have missed events.
        const cur = store.get().current;
        if (cur) void loadProject(cur.project.id).catch(() => {});
        void loadProjects().catch(() => {});
      }
      first = false;
    },
    { staleMs: 6000, onDown: () => store.set({ connected: false }) }, // traffic ticks arrive every second
  );
}

function applyEvent(ev: ServerEvent) {
  for (const fn of toastListeners) fn(ev);
  const s = store.get();
  const cur = s.current;
  switch (ev.type) {
    case 'traffic': {
      traffic.data = ev.services;
      traffic.tick = ev.tick;
      for (const [sid, t] of Object.entries(ev.services)) {
        const h = (traffic.history[sid] ??= []);
        h.push(t.rps);
        if (h.length > 60) h.shift();
      }
      for (const fn of traffic.subs) fn();
      return;
    }
    case 'deployment.log': {
      const clean = ev.line.trim();
      if (!clean || /^\s*│/.test(clean)) return;
      deployTail.data[ev.serviceId] = { line: clean, ts: ev.ts };
      for (const fn of deployTail.subs) fn();
      return;
    }
    case 'project.updated': {
      const exists = s.projects.some((p) => p.id === ev.project.id);
      store.set({
        projects: exists
          ? s.projects.map((p) => (p.id === ev.project.id ? { ...p, ...ev.project } : p))
          : [...s.projects, { ...ev.project, serviceCount: 0, environments: 0, running: 0, services: [] }],
        current: cur && cur.project.id === ev.project.id ? { ...cur, project: ev.project } : cur,
      });
      if (ev.project.parentId) refreshProjectsSoon(); // environment counts on the base project
      return;
    }
    case 'project.deleted': {
      store.set({ projects: s.projects.filter((p) => p.id !== ev.projectId) });
      refreshProjectsSoon();
      return;
    }
    case 'service.updated': {
      const svc = ev.service as ServiceView;
      // keep project list summaries fresh
      store.set({
        projects: s.projects.map((p) => {
          if (p.id !== svc.projectId) return p;
          const others = p.services.filter((x) => x.id !== svc.id);
          const services = [
            ...others,
            {
              id: svc.id,
              name: svc.name,
              icon: svc.icon,
              status: svc.status,
              server: svc.server?.id ?? 'local',
              kind: svc.source.type,
              protocol: svc.protocol,
              publicHttp: svc.publicHttp,
              domains: svc.domains,
              publicTcpPort: svc.publicTcpPort,
            },
          ];
          return { ...p, services, serviceCount: services.length, running: services.filter((x) => x.status === 'running').length };
        }),
      });
      if (!cur || cur.project.id !== svc.projectId) return;
      const services = { ...cur.services, [svc.id]: svc };
      const order = cur.order.includes(svc.id) ? cur.order : [...cur.order, svc.id];
      store.set({ current: { ...cur, services, order, edges: computeEdges(services) } });
      return;
    }
    case 'service.deleted': {
      store.set({
        projects: s.projects.map((p) =>
          p.id === ev.projectId ? { ...p, services: p.services.filter((x) => x.id !== ev.serviceId), serviceCount: p.serviceCount - 1 } : p,
        ),
      });
      if (!cur || cur.project.id !== ev.projectId) return;
      const services = { ...cur.services };
      delete services[ev.serviceId];
      store.set({ current: { ...cur, services, order: cur.order.filter((x) => x !== ev.serviceId), edges: computeEdges(services) } });
      return;
    }
    case 'volume.updated': {
      if (!cur || cur.project.id !== ev.volume.projectId) return;
      store.set({ current: { ...cur, volumes: { ...cur.volumes, [ev.volume.id]: ev.volume } } });
      return;
    }
    case 'volume.deleted': {
      if (!cur || cur.project.id !== ev.projectId) return;
      const volumes = { ...cur.volumes };
      delete volumes[ev.volumeId];
      store.set({ current: { ...cur, volumes } });
      return;
    }
    case 'deployment.updated': {
      if (!cur || cur.project.id !== ev.deployment.projectId) return;
      store.set({ current: { ...cur, deployments: { ...cur.deployments, [ev.deployment.id]: ev.deployment } } });
      return;
    }
    case 'replicas': {
      if (!cur || cur.project.id !== ev.projectId) return;
      store.set({ current: { ...cur, replicas: { ...cur.replicas, [ev.serviceId]: ev.replicas } } });
      return;
    }
    case 'activity': {
      if (cur && ev.entry.projectId && ev.entry.projectId !== cur.project.id) return;
      store.set({ activity: [ev.entry, ...s.activity].slice(0, 200) });
      return;
    }
  }
}

// ───────────────────────────── selectors ─────────────────────────────

export function deploymentsFor(cur: ProjectState | null, serviceId: string): Deployment[] {
  if (!cur) return [];
  return Object.values(cur.deployments)
    .filter((d) => d.serviceId === serviceId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function latestDeployment(cur: ProjectState | null, serviceId: string): Deployment | null {
  return deploymentsFor(cur, serviceId)[0] ?? null;
}
