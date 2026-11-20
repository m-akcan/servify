import { useEffect, useRef, useState } from 'react';
import { Modal, Button, Field, Stepper, toastError, toast } from '../components/ui.tsx';
import { Icon, ServiceGlyph, type IconName } from '../components/Icon.tsx';
import { useStore, loadTemplates } from '../lib/store.ts';
import { api } from '../lib/api.ts';
import { useAutoHeight } from '../motion/hooks.ts';
import type { Pt } from '../canvas/geometry.ts';
import type { Template } from '../lib/types.ts';

type Kind = 'git' | 'image' | 'local' | 'template';

const SOURCES: { kind: Kind; title: string; desc: string; icon: IconName }[] = [
  { kind: 'git', title: 'Git repository', desc: 'GitHub or any git URL. Dockerfile or zero-config build.', icon: 'github' },
  { kind: 'image', title: 'Docker image', desc: 'Any public or local image from a registry.', icon: 'box' },
  { kind: 'local', title: 'Local folder', desc: 'Build straight from a directory on this machine.', icon: 'folder' },
  { kind: 'template', title: 'Template', desc: 'Databases, caches and tools in one click.', icon: 'template' },
];

const IMAGE_SUGGESTIONS = ['nginx:alpine', 'traefik/whoami', 'caddy:2-alpine', 'httpd:alpine', 'ghcr.io/', 'node:22-alpine'];

export function NewServiceModal({
  open,
  onClose,
  projectId,
  at,
  getCenter,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  at: Pt | null;
  getCenter: () => Pt;
  onCreated: (id: string) => void;
}) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ repo: '', branch: '', rootDir: '', image: '', path: '', name: '', port: '', replicas: 1, token: '', dockerfile: '', advanced: false });
  const templates = useStore((s) => s.templates);
  const heightRef = useRef<HTMLDivElement>(null);
  useAutoHeight(heightRef, [kind, form.advanced, templates.length]);

  useEffect(() => {
    if (open) {
      void loadTemplates();
      setKind(null);
      setForm({ repo: '', branch: '', rootDir: '', image: '', path: '', name: '', port: '', replicas: 1, token: '', dockerfile: '', advanced: false });
    }
  }, [open]);

  const set = (k: keyof typeof form, v: any) => setForm((f) => ({ ...f, [k]: v }));

  const create = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const pos = at ?? (() => {
        const c = getCenter();
        return { x: c.x - 128, y: c.y - 60 };
      })();
      const r = await api.post<{ service: { id: string; name: string } }>(`/projects/${projectId}/services`, { ...body, x: Math.round(pos.x / 20) * 20, y: Math.round(pos.y / 20) * 20 });
      toast({ title: `${r.service.name} created`, body: 'First deploy started', tone: 'build' });
      onCreated(r.service.id);
    } catch (e) {
      toastError(e, 'Could not create service');
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const common: Record<string, unknown> = {};
    if (form.name.trim()) common.name = form.name.trim();
    if (form.port.trim()) common.port = Number(form.port);
    if (kind === 'git') void create({ ...common, repo: form.repo, branch: form.branch || undefined, rootDir: form.rootDir || undefined, token: form.token || undefined, dockerfile: form.dockerfile || undefined, replicas: form.replicas });
    if (kind === 'image') void create({ ...common, image: form.image, replicas: form.replicas });
    if (kind === 'local') void create({ ...common, path: form.path, dockerfile: form.dockerfile || undefined, replicas: form.replicas });
  };

  const canSubmit = (kind === 'git' && form.repo.trim()) || (kind === 'image' && form.image.trim()) || (kind === 'local' && form.path.trim().startsWith('/'));

  return (
    <Modal open={open} onClose={onClose} width={640} className="new-service">
      <div className="ns-head">
        {kind && (
          <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setKind(null)} aria-label="Back">
            <Icon name="chevronLeft" size={16} />
          </button>
        )}
        <div className="grow">
          <div className="h2">{kind ? SOURCES.find((s) => s.kind === kind)!.title : 'New service'}</div>
          <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
            {kind ? SOURCES.find((s) => s.kind === kind)!.desc : 'What would you like to run?'}
          </div>
        </div>
        <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="Close">
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="ns-body-wrap" ref={heightRef}>
        <div className="ns-body" key={kind ?? 'pick'}>
          {!kind && (
            <>
              <div className="ns-sources">
                {SOURCES.map((s, i) => (
                  <button key={s.kind} className="ns-source" style={{ animationDelay: `${i * 35}ms` }} onClick={() => setKind(s.kind)}>
                    <div className="ns-source-icon">
                      <Icon name={s.icon} size={20} />
                    </div>
                    <div className="grow">
                      <div className="ns-source-title">{s.title}</div>
                      <div className="ns-source-desc">{s.desc}</div>
                    </div>
                    <Icon name="chevronRight" size={16} className="ns-chev" />
                  </button>
                ))}
              </div>
              <div className="label" style={{ margin: '18px 2px 10px' }}>
                Quick start
              </div>
              <div className="ns-quick">
                {templates.slice(0, 6).map((t, i) => (
                  <button key={t.id} className="ns-chip" style={{ animationDelay: `${120 + i * 30}ms` }} disabled={busy} onClick={() => void create({ templateId: t.id })}>
                    <ServiceGlyph icon={t.icon} name={t.name} size={22} />
                    {t.name}
                  </button>
                ))}
              </div>
            </>
          )}

          {kind === 'template' && <TemplateGallery templates={templates} busy={busy} onPick={(t) => void create({ templateId: t.id })} />}

          {(kind === 'git' || kind === 'image' || kind === 'local') && (
            <form className="ns-form" onSubmit={submit}>
              {kind === 'git' && (
                <>
                  <Field label="Repository" hint="owner/repo, a full git URL, or a GitHub /tree/branch/path link">
                    <input className="input input-lg mono" autoFocus placeholder="vercel/next-learn  or  https://github.com/…" value={form.repo} onChange={(e) => set('repo', e.target.value)} />
                  </Field>
                  <div className="ns-grid">
                    <Field label="Branch">
                      <input className="input mono" placeholder="default" value={form.branch} onChange={(e) => set('branch', e.target.value)} />
                    </Field>
                    <Field label="Root directory">
                      <input className="input mono" placeholder="/" value={form.rootDir} onChange={(e) => set('rootDir', e.target.value)} />
                    </Field>
                  </div>
                </>
              )}
              {kind === 'image' && (
                <>
                  <Field label="Image" hint="Pulled from Docker Hub or any registry your Docker can reach">
                    <input className="input input-lg mono" autoFocus placeholder="nginx:alpine" value={form.image} onChange={(e) => set('image', e.target.value)} />
                  </Field>
                  <div className="ns-suggest">
                    {IMAGE_SUGGESTIONS.map((s) => (
                      <button type="button" key={s} className="chip mono" onClick={() => set('image', s)}>
                        {s}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {kind === 'local' && (
                <Field label="Absolute path" hint="A folder with a Dockerfile, or a Node/Python/Go/Rust/static project — Servify detects how to build it">
                  <input className="input input-lg mono" autoFocus placeholder="/Users/you/code/my-app" value={form.path} onChange={(e) => set('path', e.target.value)} />
                </Field>
              )}

              <div className="ns-grid">
                <Field label="Name" hint="Optional">
                  <input className="input" placeholder="auto" value={form.name} onChange={(e) => set('name', e.target.value)} />
                </Field>
                <Field label="Replicas" hint="Load balanced automatically">
                  <Stepper value={form.replicas} min={1} max={16} onChange={(v) => set('replicas', v)} />
                </Field>
              </div>

              <button type="button" className="ns-adv-toggle" onClick={() => set('advanced', !form.advanced)}>
                <Icon name="chevronRight" size={14} style={{ transform: form.advanced ? 'rotate(90deg)' : undefined, transition: 'transform 220ms var(--ease-out)' }} />
                Advanced
              </button>
              {form.advanced && (
                <div className="ns-grid fade-in">
                  <Field label="Port" hint="Auto-detected from the image">
                    <input className="input mono" inputMode="numeric" placeholder="auto" value={form.port} onChange={(e) => set('port', e.target.value.replace(/\D/g, ''))} />
                  </Field>
                  {kind !== 'image' && (
                    <Field label="Dockerfile path" hint="Relative to the root">
                      <input className="input mono" placeholder="Dockerfile" value={form.dockerfile} onChange={(e) => set('dockerfile', e.target.value)} />
                    </Field>
                  )}
                  {kind === 'git' && (
                    <Field label="Access token" hint="For private repositories. Stored locally.">
                      <input className="input mono" type="password" placeholder="ghp_…" value={form.token} onChange={(e) => set('token', e.target.value)} />
                    </Field>
                  )}
                </div>
              )}

              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
                <Button type="button" variant="ghost" onClick={() => setKind(null)}>
                  Back
                </Button>
                <Button type="submit" variant="primary" icon="rocket" loading={busy} disabled={!canSubmit}>
                  Deploy
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </Modal>
  );
}

function TemplateGallery({ templates, busy, onPick }: { templates: Template[]; busy: boolean; onPick: (t: Template) => void }) {
  const cats: Template['category'][] = ['database', 'cache', 'storage', 'app', 'tool'];
  const names: Record<string, string> = { database: 'Databases', cache: 'Caches', storage: 'Storage', app: 'Web', tool: 'Tools' };
  let i = 0;
  return (
    <div className="tpl-gallery">
      {cats.map((c) => {
        const list = templates.filter((t) => t.category === c);
        if (!list.length) return null;
        return (
          <div key={c}>
            <div className="label" style={{ margin: '4px 2px 8px' }}>
              {names[c]}
            </div>
            <div className="tpl-grid">
              {list.map((t) => (
                <button key={t.id} className="tpl-card" disabled={busy} style={{ animationDelay: `${i++ * 25}ms` }} onClick={() => onPick(t)}>
                  <ServiceGlyph icon={t.icon} name={t.name} size={32} />
                  <div className="grow">
                    <div className="tpl-name">
                      {t.name}
                      {t.singleton && <Icon name="database" size={11} style={{ opacity: 0.5 }} />}
                    </div>
                    <div className="tpl-desc">{t.description}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
