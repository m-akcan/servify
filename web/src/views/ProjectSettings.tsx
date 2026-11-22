import { useEffect, useState } from 'react';
import type { Project } from '../lib/types.ts';
import { Modal, Button, Field, confirmDialog, toastError, toast } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { navigate } from '../lib/router.ts';
import { loadProjects } from '../lib/store.ts';
import { Icon, BrandMark } from '../components/Icon.tsx';
import { ProjectMark, PROJECT_ICONS, PROJECT_LOGOS } from '../components/ProjectMark.tsx';

const COLORS = ['#d4f25a', '#7ce0c3', '#f2a65a', '#9fb4ff', '#f27a9b', '#c9a7ff', '#5ad1f2', '#ecebe4'];

type SharedRow = { key: string; value: string; secret: boolean };
const rowsOf = (p: Project): SharedRow[] => Object.entries(p.variables ?? {}).map(([key, value]) => ({ key, value, secret: (p.secretKeys ?? []).includes(key) }));

function SharedVariables({ rows, setRows }: { rows: SharedRow[]; setRows: (r: SharedRow[]) => void }) {
  const set = (i: number, patch: Partial<SharedRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="shared-vars">
      {rows.map((r, i) => (
        <div className="shared-var-row" key={i}>
          <input className="input mono" placeholder="NAME" value={r.key} onChange={(e) => set(i, { key: e.target.value.replace(/[^A-Za-z0-9_]/g, '_') })} spellCheck={false} />
          <input className="input mono" placeholder="value" type={r.secret ? 'password' : 'text'} value={r.value} onChange={(e) => set(i, { value: e.target.value })} spellCheck={false} />
          <button type="button" className={`btn btn-ghost btn-sm btn-icon ${r.secret ? 'on' : ''}`} title={r.secret ? 'Secret (hidden from read-only access)' : 'Mark as secret'} onClick={() => set(i, { secret: !r.secret })}>
            <Icon name={r.secret ? 'lock' : 'eye'} size={14} />
          </button>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" title="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
      <button type="button" className="link" style={{ alignSelf: 'flex-start', fontSize: 12 }} onClick={() => setRows([...rows, { key: '', value: '', secret: false }])}>
        + Add a shared variable
      </button>
    </div>
  );
}

export function ProjectSettings({ open, onClose, project }: { open: boolean; onClose: () => void; project: Project }) {
  const [name, setName] = useState(project.name);
  const [color, setColor] = useState(project.color);
  const [icon, setIcon] = useState<string | null>(project.icon ?? null);
  const [iconTab, setIconTab] = useState<'none' | 'icons' | 'logos' | 'emoji'>('none');
  const [shared, setShared] = useState<SharedRow[]>(rowsOf(project));
  useEffect(() => {
    if (open) {
      setName(project.name);
      setColor(project.color);
      setIcon(project.icon ?? null);
      setShared(rowsOf(project));
      setIconTab(!project.icon ? 'none' : project.icon.startsWith('b:') ? 'logos' : project.icon.startsWith('e:') ? 'emoji' : 'icons');
    }
  }, [open, project]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const clean = shared.filter((r) => r.key.trim());
      const before = JSON.stringify(rowsOf(project));
      const sharedChanged = JSON.stringify(clean) !== before;
      const r = await api.patch<Project & { usesShared?: { id: string; name: string }[] }>(`/projects/${project.id}`, {
        name,
        color,
        icon,
        ...(sharedChanged ? { variables: Object.fromEntries(clean.map((x) => [x.key.trim(), x.value])), secretKeys: clean.filter((x) => x.secret).map((x) => x.key.trim()) } : {}),
      });
      await loadProjects();
      const users = r.usesShared ?? [];
      if (sharedChanged && users.length) {
        const yes = await confirmDialog({
          title: `Redeploy ${users.length} service${users.length === 1 ? '' : 's'}?`,
          body: `${users.map((u) => u.name).join(', ')} use${users.length === 1 ? 's' : ''} shared variables and pick${users.length === 1 ? 's' : ''} up the change on the next deploy.`,
          confirm: 'Redeploy now',
        });
        if (yes) for (const u of users) await api.post(`/services/${u.id}/deploy`).catch((e) => toastError(e, `Could not redeploy ${u.name}`));
      }
      toast({ title: 'Project updated', tone: 'ok' });
      onClose();
    } catch (err) {
      toastError(err);
    }
  };

  const del = async () => {
    const ok = await confirmDialog({
      title: `Delete ${project.name}?`,
      body: 'Every service, container, image and volume in this project will be removed. This cannot be undone.',
      confirm: 'Delete project',
      danger: true,
      typeToConfirm: project.slug,
    });
    if (!ok) return;
    try {
      onClose();
      navigate('/', { replace: true });
      await api.del(`/projects/${project.id}`);
      await loadProjects();
      toast({ title: 'Project deleted', tone: 'idle' });
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <Modal open={open} onClose={onClose} width={460}>
      <form onSubmit={save} style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h2 className="h2">Project settings</h2>
        <Field label="Name">
          <input className="input input-lg" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Color">
          <div className="row" style={{ gap: 8 }}>
            {COLORS.map((c) => (
              <button type="button" key={c} className={`color-swatch ${color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
            ))}
          </div>
        </Field>
        <Field label="Icon" hint="Shown with the color in the project list, on cards and in the top bar.">
          <div className="icon-picker">
            <div className="row" style={{ gap: 10 }}>
              <ProjectMark project={{ color, icon }} size={30} />
              <div className="seg-tabs">
                {(['none', 'icons', 'logos', 'emoji'] as const).map((t) => (
                  <button
                    type="button"
                    key={t}
                    className={iconTab === t ? 'on' : ''}
                    onClick={() => {
                      if (t === 'none') setIcon(null);
                      setIconTab(t);
                    }}
                  >
                    {t === 'none' ? 'Color only' : t === 'icons' ? 'Icons' : t === 'logos' ? 'Logos' : 'Emoji'}
                  </button>
                ))}
              </div>
            </div>
            {iconTab === 'icons' && (
              <div className="icon-grid">
                {PROJECT_ICONS.map((n) => (
                  <button type="button" key={n} title={n} className={`icon-cell ${icon === `i:${n}` ? 'on' : ''}`} onClick={() => setIcon(`i:${n}`)}>
                    <Icon name={n} size={17} />
                  </button>
                ))}
              </div>
            )}
            {iconTab === 'logos' && (
              <div className="icon-grid">
                {PROJECT_LOGOS.map((b) => (
                  <button type="button" key={b.key} title={b.title} className={`icon-cell ${icon === `b:${b.key}` ? 'on' : ''}`} onClick={() => setIcon(`b:${b.key}`)}>
                    <BrandMark icon={b.key} size={17} />
                  </button>
                ))}
              </div>
            )}
            {iconTab === 'emoji' && (
              <input
                className="input"
                placeholder="Type or paste an emoji, e.g. 🎮"
                maxLength={16}
                value={icon?.startsWith('e:') ? icon.slice(2) : ''}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  setIcon(v ? `e:${[...v].slice(0, 2).join('')}` : null);
                }}
              />
            )}
          </div>
        </Field>
        <Field label="Shared variables" hint="Every service in this project (and its environments) can use them as ${{shared.NAME}} in its variables. An environment's own shared variables override the project's.">
          <SharedVariables rows={shared} setRows={setShared} />
        </Field>
        <Field label="Export" hint="A servify.json spec of every service — import it elsewhere, commit it, or hand it to an agent. Secrets are left blank.">
          <div className="row">
            <Button
              type="button"
              icon="download"
              onClick={async () => {
                try {
                  const spec = await api.get<unknown>(`/projects/${project.id}/export`);
                  const blob = new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' });
                  const a = document.createElement('a');
                  a.href = URL.createObjectURL(blob);
                  a.download = `${project.slug}.servify.json`;
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
                } catch (err) {
                  toastError(err);
                }
              }}
            >
              Download servify.json
            </Button>
            <Button
              type="button"
              icon="copy"
              onClick={async () => {
                try {
                  const spec = await api.get<any>(`/projects/${project.id}/export?secrets=1`);
                  const r = await api.post<{ project: Project }>('/projects/import', { spec, deploy: false, name: `${project.name} (copy)` });
                  await loadProjects();
                  onClose();
                  navigate(`/p/${r.project.slug}`);
                  toast({ title: 'Project duplicated', body: 'Services are configured but not deployed yet — deploy the ones you need.', tone: 'ok' });
                } catch (err) {
                  toastError(err, 'Could not duplicate');
                }
              }}
            >
              Duplicate project
            </Button>
          </div>
        </Field>
        <div className="row">
          <Button type="button" variant="danger" icon="trash" onClick={() => void del()}>
            Delete project
          </Button>
          <div className="spacer" />
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
