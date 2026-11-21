import { useState } from 'react';
import { useStore, loadProjects } from '../lib/store.ts';
import { api } from '../lib/api.ts';
import { navigate, projectPath } from '../lib/router.ts';
import { Button, Modal, toastError, toast, Empty, Switch, Field } from '../components/ui.tsx';
import { Icon, BrandMark, ServiceGlyph } from '../components/Icon.tsx';
import { serviceTone, timeAgo } from '../lib/format.ts';
import { ProjectMark } from '../components/ProjectMark.tsx';
import type { Project, ProjectListItem } from '../lib/types.ts';

type ProjectsView = 'grid' | 'list';
const VIEW_KEY = 'servify.projects.view';
function savedView(): ProjectsView | null {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === 'grid' || v === 'list' ? v : null;
  } catch {
    return null;
  }
}

const DOWN = new Set(['crashed', 'failed', 'degraded']);
const MAX_DOTS = 14;

type StatusFilter = 'all' | 'attention' | 'running' | 'stopped' | 'empty';
const STATUS_FILTERS: [StatusFilter, string][] = [
  ['all', 'All'],
  ['attention', 'Needs attention'],
  ['running', 'Running'],
  ['stopped', 'Stopped'],
  ['empty', 'Empty'],
];
/** One state per project: anything down wins, then empty, then running vs. all stopped. */
function statusOf(p: ProjectListItem): Exclude<StatusFilter, 'all'> {
  if (p.services.some((s) => DOWN.has(s.status))) return 'attention';
  if (p.serviceCount === 0) return 'empty';
  return p.running > 0 ? 'running' : 'stopped';
}

type SortKey = 'name' | 'recent' | 'services' | 'newest';
const SORTS: [SortKey, string][] = [
  ['name', 'Name'],
  ['recent', 'Recently deployed'],
  ['services', 'Most services'],
  ['newest', 'Newest'],
];
const SORT_KEY = 'servify.projects.sort';
function savedSort(): SortKey {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return SORTS.some(([k]) => k === v) ? (v as SortKey) : 'name';
  } catch {
    return 'name';
  }
}
const byName = (a: ProjectListItem, b: ProjectListItem) => a.name.localeCompare(b.name);
const SORTERS: Record<SortKey, (a: ProjectListItem, b: ProjectListItem) => number> = {
  name: byName,
  recent: (a, b) => (b.lastDeployAt ?? 0) - (a.lastDeployAt ?? 0) || byName(a, b),
  services: (a, b) => b.serviceCount - a.serviceCount || byName(a, b),
  newest: (a, b) => b.createdAt - a.createdAt,
};

/** Servers other than this machine that a project runs on. */
const remoteServers = (p: ProjectListItem) => (p.servers ?? []).filter((s) => s.id !== 'local');

function ProjectList({ projects }: { projects: ProjectListItem[] }) {
  return (
    <div className="project-list rise-in" style={{ animationDelay: '80ms' }}>
      {projects.map((p) => {
        const down = p.services.filter((s) => DOWN.has(s.status)).length;
        return (
          <button key={p.id} className="project-row" onClick={() => navigate(projectPath(p.slug))}>
            <ProjectMark project={p} size={18} />
            <span className="project-row-title">
              <span className="project-row-name truncate">{p.name}</span>
              {remoteServers(p).map((s) => (
                <span key={s.id} className="project-row-server" title={`Runs on ${s.name}`}>
                  <Icon name="server" size={11} />
                  {s.name}
                </span>
              ))}
            </span>
            <span className="project-row-dots" aria-hidden>
              {p.services.slice(0, MAX_DOTS).map((s) => (
                <i key={s.id} data-tone={serviceTone[s.status as keyof typeof serviceTone] ?? 'idle'} title={`${s.name} · ${s.status}`} />
              ))}
              {p.services.length > MAX_DOTS && <span className="faint">+{p.services.length - MAX_DOTS}</span>}
            </span>
            <span className="project-row-count mono">{p.serviceCount === 0 ? 'empty' : `${p.running}/${p.serviceCount} online`}</span>
            <span className="project-row-state">
              {down > 0 && (
                <span className="badge" data-tone="err">
                  <span className="dot" />
                  {down} down
                </span>
              )}
            </span>
            <span className="project-row-env faint">{p.environments > 0 ? `${p.environments + 1} envs` : ''}</span>
            <span className="project-row-deployed faint" title={p.lastDeployAt ? new Date(p.lastDeployAt).toLocaleString() : 'Never deployed'}>
              {p.lastDeployAt ? timeAgo(p.lastDeployAt) : '—'}
            </span>
            <Icon name="arrowRight" size={15} className="project-arrow" />
          </button>
        );
      })}
    </div>
  );
}

export function NewProjectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const p = await api.post<Project>('/projects', { name });
      await loadProjects();
      onClose();
      setName('');
      navigate(projectPath(p.slug));
    } catch (err) {
      toastError(err, 'Could not create project');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} width={440}>
      <form onSubmit={submit} style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <h2 className="h2">New project</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            A project is a canvas of services that share a private network.
          </p>
        </div>
        <input className="input input-lg" autoFocus placeholder="e.g. my-saas" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
            Create project
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function MiniCanvas({ services }: { services: { id: string; status: any }[] }) {
  // Abstract preview: a dot-grid with one tile per service.
  const cols = Math.max(3, Math.ceil(Math.sqrt(services.length + 1)));
  return (
    <div className="mini-canvas">
      <div className="mini-tiles" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {services.slice(0, 12).map((s, i) => (
          <span key={s.id} className="mini-tile" data-tone={serviceTone[s.status as keyof typeof serviceTone] ?? 'idle'} style={{ animationDelay: `${i * 40}ms` }}>
            <i />
          </span>
        ))}
      </div>
    </div>
  );
}

type ComposePlan = {
  name: string;
  warnings: string[];
  services: { slug: string; name: string; aliases: string[]; source: { type: string; image?: string; path?: string; repo?: string }; templateId: string | null; protocol: string; port: number | null; replicas: number; volumes: { name: string }[] }[];
};

const COMPOSE_SAMPLE = `services:
  web:
    build: ./web
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: postgres://app:\${DB_PASSWORD}@db:5432/app
    depends_on: [db]
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes: [pgdata:/var/lib/postgresql/data]
volumes:
  pgdata: {}`;

function iconForPlan(s: ComposePlan['services'][number]): string {
  if (s.templateId) return ({ postgres: 'postgres', redis: 'redis', mysql: 'mysql', mongo: 'mongo', minio: 'bucket', nginx: 'nginx', n8n: 'flow', adminer: 'table', whoami: 'wave', 'uptime-kuma': 'pulse', ollama: 'spark' } as Record<string, string>)[s.templateId] ?? 'box';
  if (s.source.type === 'local') return 'folder';
  if (s.source.type === 'git') return 'git';
  const img = s.source.image ?? '';
  for (const [re, k] of [[/node/, 'node'], [/python/, 'python'], [/nginx/, 'nginx'], [/caddy/, 'caddy'], [/rabbitmq/, 'rabbitmq'], [/grafana/, 'grafana'], [/prometheus/, 'prometheus'], [/mariadb/, 'mariadb'], [/traefik/, 'wave']] as [RegExp, string][]) if (re.test(img)) return k;
  return 'box';
}

function ImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<'compose' | 'servify'>('compose');
  const [text, setText] = useState('');
  const [yaml, setYaml] = useState('');
  const [envText, setEnvText] = useState('');
  const [basePath, setBasePath] = useState('');
  const [showEnv, setShowEnv] = useState(false);
  const [plan, setPlan] = useState<ComposePlan | null>(null);
  const [deploy, setDeploy] = useState(true);
  const [adoptVolumes, setAdoptVolumes] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  let parsed: any = null;
  let error: string | null = null;
  if (mode === 'servify' && text.trim()) {
    try {
      parsed = JSON.parse(text);
      if (parsed.servify !== 1 || !Array.isArray(parsed.services)) error = 'Not a servify.json spec';
    } catch {
      error = 'Invalid JSON';
    }
  }
  const finish = (slug: string) => {
    void loadProjects();
    onClose();
    setText('');
    setYaml('');
    setPlan(null);
    navigate(projectPath(slug));
  };
  const submit = async () => {
    setBusy(true);
    try {
      if (mode === 'servify') {
        const r = await api.post<{ project: Project }>('/projects/import', { spec: parsed, deploy });
        finish(r.project.slug);
      } else {
        const r = await api.post<{ project: Project; warnings: string[] }>('/projects/import-compose', { yaml, env: envText || undefined, basePath: basePath || undefined, deploy, adoptVolumes });
        if (r.warnings.length) toast({ title: `Imported with ${r.warnings.length} note${r.warnings.length === 1 ? '' : 's'}`, body: r.warnings[0], tone: 'warn' });
        finish(r.project.slug);
      }
    } catch (e) {
      toastError(e, 'Import failed');
    } finally {
      setBusy(false);
    }
  };
  const preview = async () => {
    setBusy(true);
    try {
      setPlan(await api.post<ComposePlan>('/projects/import-compose', { yaml, env: envText || undefined, basePath: basePath || undefined, dryRun: true }));
    } catch (e) {
      setPlan(null);
      toastError(e, 'Could not read the compose file');
    } finally {
      setBusy(false);
    }
  };
  const dropInto = (set: (v: string) => void) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDrag(true);
    },
    onDragLeave: () => setDrag(false),
    onDrop: async (e: React.DragEvent) => {
      e.preventDefault();
      setDrag(false);
      const f = e.dataTransfer.files[0];
      if (f) set(await f.text());
    },
  });
  return (
    <Modal open={open} onClose={onClose} width={620}>
      <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <h2 className="h2">Import a project</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Bring an existing stack over — services, variables, volumes and replicas carry across.
          </p>
        </div>
        <div className="seg-tabs">
          <button className={mode === 'compose' ? 'on' : ''} onClick={() => setMode('compose')}>
            <BrandMark icon="docker" size={14} />
            Docker Compose
          </button>
          <button className={mode === 'servify' ? 'on' : ''} onClick={() => setMode('servify')}>
            <Icon name="braces" size={14} />
            servify.json
          </button>
        </div>
        {mode === 'servify' ? (
          <>
            <textarea
              className={`textarea mono import-area ${drag ? 'drag' : ''}`}
              placeholder={'{\n  "servify": 1,\n  "name": "my-stack",\n  "services": [ … ]\n}'}
              value={text}
              onChange={(e) => setText(e.target.value)}
              {...dropInto(setText)}
            />
            {parsed && !error && (
              <div className="faint" style={{ fontSize: 12 }}>
                <b style={{ color: 'var(--text)' }}>{parsed.name}</b> · {parsed.services.length} services: {parsed.services.map((s: any) => s.name).join(', ')}
              </div>
            )}
            {error && <div style={{ color: 'var(--err)', fontSize: 12 }}>{error}</div>}
          </>
        ) : (
          <>
            <textarea
              className={`textarea mono import-area ${drag ? 'drag' : ''}`}
              placeholder={COMPOSE_SAMPLE}
              value={yaml}
              onChange={(e) => {
                setYaml(e.target.value);
                setPlan(null);
              }}
              {...dropInto((v) => {
                setYaml(v);
                setPlan(null);
              })}
              aria-label="docker-compose.yml"
            />
            <Field label="Folder of the compose file" hint="Optional — needed for build: contexts, env_file and .env. Files outside it are never read.">
              <input
                className="input mono"
                placeholder="/Users/you/code/my-stack"
                value={basePath}
                onChange={(e) => {
                  setBasePath(e.target.value);
                  setPlan(null);
                }}
              />
            </Field>
            {showEnv ? (
              <Field label=".env" hint="Values for ${VAR} placeholders.">
                <textarea className="textarea mono" style={{ minHeight: 70 }} placeholder="DB_PASSWORD=…" value={envText} onChange={(e) => setEnvText(e.target.value)} />
              </Field>
            ) : (
              <button className="link" style={{ alignSelf: 'flex-start', fontSize: 12 }} onClick={() => setShowEnv(true)}>
                Paste a .env file
              </button>
            )}
            {plan && (
              <div className="compose-plan rise-in">
                <div className="row" style={{ gap: 8 }}>
                  <b>{plan.name}</b>
                  <span className="faint" style={{ fontSize: 12 }}>
                    {plan.services.length} service{plan.services.length === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="compose-services">
                  {plan.services.map((s) => (
                    <div className="compose-svc" key={s.slug}>
                      <ServiceGlyph icon={iconForPlan(s)} name={s.slug} size={26} />
                      <div className="grow" style={{ minWidth: 0 }}>
                        <div className="truncate">
                          <b>{s.slug}</b>
                          {s.aliases.length > 0 && <span className="faint"> · also “{s.aliases.join('”, “')}”</span>}
                        </div>
                        <div className="faint mono truncate" style={{ fontSize: 11 }}>
                          {s.source.type === 'image' ? s.source.image : s.source.type === 'local' ? `build ${s.source.path}` : s.source.repo} · {s.protocol === 'none' ? 'worker' : `${s.protocol}:${s.port}`}
                          {s.replicas > 1 ? ` · ×${s.replicas}` : ''}
                          {s.volumes.length ? ` · ${s.volumes.map((v) => v.name).join(', ')}` : ''}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                {plan.warnings.length > 0 && (
                  <ul className="compose-warnings">
                    {plan.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
        {mode === 'compose' && (
          <label className="row" style={{ gap: 10, fontSize: 13 }} title="Uses the Docker volumes this Compose project already created (<project>_<volume>) instead of empty ones. Run `docker compose down` first — without -v.">
            <Switch checked={adoptVolumes} onChange={setAdoptVolumes} /> Take over the existing Docker volumes (keeps the data; run <code className="inline-code">docker compose down</code> first)
          </label>
        )}
        <label className="row" style={{ gap: 10, fontSize: 13 }}>
          <Switch checked={deploy} onChange={setDeploy} /> Deploy everything after import
        </label>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {mode === 'compose' && !plan ? (
            <Button variant="primary" icon="eye" loading={busy} disabled={!yaml.trim()} onClick={() => void preview()}>
              Preview
            </Button>
          ) : (
            <Button variant="primary" icon="download" loading={busy} disabled={mode === 'servify' ? !parsed || !!error : !plan} onClick={() => void submit()}>
              Import
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function Home() {
  const projects = useStore((s) => s.projects);
  const bases = projects.filter((p) => !p.parentId);
  const loaded = useStore((s) => s.projectsLoaded);
  const system = useStore((s) => s.system);
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [view, setViewState] = useState<ProjectsView | null>(savedView);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [server, setServer] = useState('all');
  const [sort, setSortState] = useState<SortKey>(savedSort);
  const shown = view ?? (bases.length > 8 ? 'list' : 'grid');
  const setView = (v: ProjectsView) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {}
  };
  const setSort = (v: SortKey) => {
    setSortState(v);
    try {
      localStorage.setItem(SORT_KEY, v);
    } catch {}
  };
  const showTools = bases.length > 6;
  const servers = [...new Map(bases.flatMap((p) => p.servers ?? []).map((s) => [s.id, s])).values()].sort((a, b) => (a.id === 'local' ? -1 : b.id === 'local' ? 1 : a.name.localeCompare(b.name)));
  const q = query.trim().toLowerCase();
  const matchesText = (p: ProjectListItem) => !q || p.name.toLowerCase().includes(q) || p.services.some((s) => s.name.toLowerCase().includes(q));
  const matchesServer = (p: ProjectListItem) => server === 'all' || (p.servers ?? []).some((s) => s.id === server);
  // Status counts follow the text and server filters, so they always add up to what "All" shows.
  const narrowed = bases.filter((p) => matchesText(p) && matchesServer(p));
  const counts = { all: narrowed.length, attention: 0, running: 0, stopped: 0, empty: 0 } as Record<StatusFilter, number>;
  for (const p of narrowed) counts[statusOf(p)]++;
  const visible = narrowed.filter((p) => status === 'all' || statusOf(p) === status);
  const listed = [...visible].sort(SORTERS[sort]);
  const filtering = !!q || status !== 'all' || server !== 'all';
  const clearFilters = () => {
    setQuery('');
    setStatus('all');
    setServer('all');
  };

  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-head rise-in">
          <div>
            <div className="label">Workspace</div>
            <h1 className="h1" style={{ marginTop: 6 }}>
              Projects
            </h1>
          </div>
          <div className="spacer" />
          <div className="row">
            {bases.length > 0 && (
              <>
                <div className="seg-tabs" role="group" aria-label="Project layout">
                  <button className={shown === 'grid' ? 'on' : ''} onClick={() => setView('grid')} title="Cards" aria-pressed={shown === 'grid'}>
                    <Icon name="grid" size={14} />
                  </button>
                  <button className={shown === 'list' ? 'on' : ''} onClick={() => setView('list')} title="List" aria-pressed={shown === 'list'}>
                    <Icon name="list" size={14} />
                  </button>
                </div>
              </>
            )}
            <Button icon="download" onClick={() => setImporting(true)}>
              Import
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>
              New project
            </Button>
          </div>
        </div>

        {system && (
          <div className="sys-strip rise-in" style={{ animationDelay: '60ms' }}>
            <div className="sys-item">
              <span className={`sys-dot ${system.docker.ok ? 'ok' : 'err'}`} />
              <span className="label">Docker</span>
              <span className="mono">{system.docker.ok ? `${system.docker.version} · ${system.docker.os}` : 'unreachable'}</span>
            </div>
            {system.docker.ok && (
              <>
                <div className="sys-item">
                  <Icon name="cpu" size={13} />
                  <span className="mono">{system.docker.cpus} CPU</span>
                </div>
                <div className="sys-item">
                  <Icon name="memory" size={13} />
                  <span className="mono">{system.docker.memGb} GB</span>
                </div>
              </>
            )}
            <div className="sys-item">
              <Icon name="globe" size={13} />
              <span className="mono">*.{system.proxy.baseDomain}:{system.proxy.port}</span>
            </div>
            <div className="spacer" />
            <div className="sys-item faint">
              <Icon name="lock" size={12} />
              <span>Local-only · {system.api.host}</span>
            </div>
          </div>
        )}

        {showTools && (
          <div className="project-tools rise-in" style={{ animationDelay: '70ms' }}>
            <label className="project-filter">
              <Icon name="search" size={14} />
              <input placeholder="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter projects and services" />
            </label>
            <div className="project-status-filter" role="group" aria-label="Filter by status">
              {STATUS_FILTERS.map(([k, label]) => (
                <button key={k} className={`status-pill ${status === k ? 'on' : ''}`} data-kind={k} onClick={() => setStatus(k)} aria-pressed={status === k} disabled={k !== 'all' && counts[k] === 0 && status !== k}>
                  {k !== 'all' && <span className="status-pill-dot" />}
                  {label}
                  <span className="status-pill-count">{counts[k]}</span>
                </button>
              ))}
            </div>
            <div className="spacer" />
            {servers.length > 1 && (
              <select className="select project-tool-select" value={server} onChange={(e) => setServer(e.target.value)} aria-label="Filter by server">
                <option value="all">All servers</option>
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
            <select className="select project-tool-select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort projects">
              {SORTS.map(([k, label]) => (
                <option key={k} value={k}>
                  Sort: {label}
                </option>
              ))}
            </select>
          </div>
        )}

        {loaded && projects.length === 0 ? (
          <div className="home-empty rise-in" style={{ animationDelay: '120ms' }}>
            <Empty icon="sparkle" title="Nothing here yet" body="Create a project, then drop in services from GitHub, Docker images, a local folder or a template.">
              <div className="row" style={{ marginTop: 10, gap: 8 }}>
                <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>
                  Create your first project
                </Button>
                <Button
                  icon="sparkle"
                  onClick={async () => {
                    try {
                      const p = await api.post<Project>('/projects', { name: 'Demo' });
                      await api.post(`/projects/${p.id}/demo`);
                      await loadProjects();
                      navigate(projectPath(p.slug));
                    } catch (e) {
                      toastError(e, 'Could not create the demo');
                    }
                  }}
                >
                  Try the demo
                </Button>
              </div>
            </Empty>
          </div>
        ) : filtering && visible.length === 0 ? (
          <div className="home-empty project-no-match rise-in">
            <span className="faint">{q ? `No project or service matches “${query.trim()}”` : 'No project matches these filters'}{status !== 'all' || server !== 'all' ? ' with the current filters' : ''}.</span>
            <Button size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          </div>
        ) : shown === 'list' ? (
          <ProjectList projects={listed} />
        ) : (
          <div className="project-grid">
            {listed.map((p, i) => (
              <button key={p.id} className="project-card rise-in" style={{ animationDelay: `${80 + i * 50}ms` }} onClick={() => navigate(projectPath(p.slug))}>
                <MiniCanvas services={p.services} />
                <div className="project-meta">
                  <ProjectMark project={p} size={22} />
                  <div className="grow">
                    <div className="project-name truncate">{p.name}</div>
                    <div className="faint" style={{ fontSize: 12 }}>
                      {p.serviceCount} service{p.serviceCount === 1 ? '' : 's'}
                      {p.serviceCount > 0 && ` · ${p.running} online`}
                      {p.environments > 0 && ` · ${p.environments + 1} environments`}
                      {remoteServers(p).length > 0 && ` · on ${remoteServers(p).map((s) => s.name).join(', ')}`}
                    </div>
                  </div>
                  <Icon name="arrowRight" size={16} className="project-arrow" />
                </div>
              </button>
            ))}
            <button className="project-card project-new rise-in" style={{ animationDelay: `${80 + listed.length * 50}ms` }} onClick={() => setOpen(true)}>
              <Icon name="plus" size={20} />
              <span>New project</span>
            </button>
          </div>
        )}
      </div>
      <NewProjectModal open={open} onClose={() => setOpen(false)} />
      <ImportModal open={importing} onClose={() => setImporting(false)} />
    </div>
  );
}
