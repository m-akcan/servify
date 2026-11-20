import { useState } from 'react';
import { useStore, loadProjects } from '../lib/store.ts';
import { api } from '../lib/api.ts';
import { navigate, projectPath } from '../lib/router.ts';
import { Button, Modal, toastError, Empty, Switch } from '../components/ui.tsx';
import { Icon } from '../components/Icon.tsx';
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

function ImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState('');
  const [deploy, setDeploy] = useState(true);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  let parsed: any = null;
  let error: string | null = null;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
      if (parsed.servify !== 1 || !Array.isArray(parsed.services)) error = 'Not a servify.json spec';
    } catch {
      error = 'Invalid JSON';
    }
  }
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ project: Project }>('/projects/import', { spec: parsed, deploy });
      await loadProjects();
      onClose();
      setText('');
      navigate(projectPath(r.project.slug));
    } catch (e) {
      toastError(e, 'Import failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} width={560}>
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <h2 className="h2">Import project</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Paste or drop a <code className="inline-code">servify.json</code> exported from Servify (or written by an agent).
          </p>
        </div>
        <textarea
          className={`textarea mono import-area ${drag ? 'drag' : ''}`}
          placeholder={'{\n  "servify": 1,\n  "name": "my-stack",\n  "services": [ … ]\n}'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={async (e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files[0];
            if (f) setText(await f.text());
          }}
        />
        {parsed && !error && (
          <div className="faint" style={{ fontSize: 12 }}>
            <b style={{ color: 'var(--text)' }}>{parsed.name}</b> · {parsed.services.length} services: {parsed.services.map((s: any) => s.name).join(', ')}
          </div>
        )}
        {error && <div style={{ color: 'var(--err)', fontSize: 12 }}>{error}</div>}
        <label className="row" style={{ gap: 10, fontSize: 13 }}>
          <Switch checked={deploy} onChange={setDeploy} /> Deploy everything after import
        </label>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="download" loading={busy} disabled={!parsed || !!error} onClick={() => void submit()}>
            Import
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function Home() {
  const projects = useStore((s) => s.projects);
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
            {projects.map((p, i) => (
              <button key={p.id} className="project-card rise-in" style={{ animationDelay: `${80 + i * 50}ms` }} onClick={() => navigate(projectPath(p.slug))}>
                <MiniCanvas services={p.services} />
                <div className="project-meta">
                  <span className="crumb-dot" style={{ background: p.color }} />
                  <div className="grow">
                    <div className="project-name truncate">{p.name}</div>
                    <div className="faint" style={{ fontSize: 12 }}>
                      {p.serviceCount} service{p.serviceCount === 1 ? '' : 's'}
                      {p.serviceCount > 0 && ` · ${p.running} online`}
                    </div>
                  </div>
                  <Icon name="arrowRight" size={16} className="project-arrow" />
                </div>
              </button>
            ))}
            <button className="project-card project-new rise-in" style={{ animationDelay: `${80 + projects.length * 50}ms` }} onClick={() => setOpen(true)}>
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
