import { useState } from 'react';
import { useStore, loadProjects } from '../lib/store.ts';
import { api } from '../lib/api.ts';
import { navigate, projectPath } from '../lib/router.ts';
import { Button, Modal, toastError, toast, Empty, Switch, Field } from '../components/ui.tsx';
import { Icon, BrandMark, ServiceGlyph } from '../components/Icon.tsx';
import { serviceTone } from '../lib/format.ts';
import type { Project } from '../lib/types.ts';

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
        const r = await api.post<{ project: Project; warnings: string[] }>('/projects/import-compose', { yaml, env: envText || undefined, basePath: basePath || undefined, deploy });
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
        ) : (
          <div className="project-grid">
            {bases.map((p, i) => (
              <button key={p.id} className="project-card rise-in" style={{ animationDelay: `${80 + i * 50}ms` }} onClick={() => navigate(projectPath(p.slug))}>
                <MiniCanvas services={p.services} />
                <div className="project-meta">
                  <span className="crumb-dot" style={{ background: p.color }} />
                  <div className="grow">
                    <div className="project-name truncate">{p.name}</div>
                    <div className="faint" style={{ fontSize: 12 }}>
                      {p.serviceCount} service{p.serviceCount === 1 ? '' : 's'}
                      {p.serviceCount > 0 && ` · ${p.running} online`}
                      {p.environments > 0 && ` · ${p.environments + 1} environments`}
                    </div>
                  </div>
                  <Icon name="arrowRight" size={16} className="project-arrow" />
                </div>
              </button>
            ))}
            <button className="project-card project-new rise-in" style={{ animationDelay: `${80 + bases.length * 50}ms` }} onClick={() => setOpen(true)}>
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
