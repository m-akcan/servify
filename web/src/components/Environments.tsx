import { useState } from 'react';
import { api } from '../lib/api.ts';
import { useStore, loadProjects } from '../lib/store.ts';
import { navigate, projectPath } from '../lib/router.ts';
import type { ProjectListItem } from '../lib/types.ts';
import { Button, Modal, Field, Switch, toast, toastError, openMenuAt, confirmDialog, type MenuItem } from './ui.tsx';
import { Icon } from './Icon.tsx';

/** "production ▾" crumb: switch environments, open a new one, toggle PR previews. */
export function EnvironmentCrumb({ current }: { current: ProjectListItem }) {
  const projects = useStore((s) => s.projects);
  const [creating, setCreating] = useState(false);
  const base = current.parentId ? projects.find((p) => p.id === current.parentId) ?? current : current;
  const envs = [base, ...projects.filter((p) => p.parentId === base.id)];
  const isProd = !current.parentId;
  const label = current.preview ? `PR #${current.preview.number}` : current.envName ?? 'production';

  const open = (el: HTMLElement) => {
    const items: MenuItem[] = [{ type: 'label', label: 'Environments' }];
    for (const e of envs) {
      items.push({
        label: e.preview ? `pr-${e.preview.number} · ${e.preview.title || e.preview.branch}`.slice(0, 40) : e.parentId ? e.envName ?? e.slug : 'production',
        icon: e.id === current.id ? 'check' : e.preview ? 'branch' : 'dot',
        onSelect: () => navigate(projectPath(e.slug)),
      });
    }
    items.push({ type: 'sep' }, { label: 'New environment…', icon: 'plus', onSelect: () => setCreating(true) });
    items.push({
      label: base.previews?.enabled ? 'Turn off pull-request previews' : 'Turn on pull-request previews',
      icon: 'branch',
      onSelect: async () => {
        try {
          await api.patch(`/projects/${base.id}/previews`, { enabled: !base.previews?.enabled });
          void loadProjects();
          toast({
            title: base.previews?.enabled ? 'Previews off' : 'Previews on',
            body: base.previews?.enabled ? undefined : 'Each same-repo pull request gets its own environment. Needs the git webhook (Settings → Git webhooks).',
            tone: 'ok',
          });
        } catch (e) {
          toastError(e);
        }
      },
    });
    if (!isProd)
      items.push({ type: 'sep' }, {
        label: `Delete ${label}`,
        icon: 'trash',
        danger: true,
        onSelect: async () => {
          const ok = await confirmDialog({
            title: `Delete ${label}?`,
            body: `Every service, container and volume of this environment is removed. Production (${base.name}) is not touched.`,
            confirm: 'Delete environment',
            danger: true,
          });
          if (!ok) return;
          try {
            await api.del(`/projects/${current.id}`);
            navigate(projectPath(base.slug));
            void loadProjects();
          } catch (e) {
            toastError(e);
          }
        },
      });
    openMenuAt(el, items);
  };

  return (
    <>
      <button className={`crumb env-crumb ${isProd ? '' : current.preview ? 'is-preview' : 'is-env'}`} onClick={(e) => open(e.currentTarget)} aria-label="Switch environment">
        <Icon name={current.preview ? 'branch' : 'layers'} size={13} />
        {label}
        {envs.length > 1 && <span className="env-count">{envs.length}</span>}
        <Icon name="chevronDown" size={13} />
      </button>
      {creating && <NewEnvironmentModal base={base} onClose={() => setCreating(false)} />}
    </>
  );
}

function NewEnvironmentModal({ base, onClose }: { base: ProjectListItem; onClose: () => void }) {
  const [name, setName] = useState('staging');
  const [branch, setBranch] = useState('');
  const [deploy, setDeploy] = useState(true);
  const [busy, setBusy] = useState(false);
  const current = useStore((s) => s.current);
  const hasGit = current ? Object.values(current.services).some((s) => s.source.type === 'git') : true;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const env = await api.post<{ slug: string }>(`/projects/${base.id}/environments`, { name, branch: branch || undefined, deploy });
      await loadProjects();
      toast({ title: `${name} created`, body: deploy ? 'Deploying a copy of every service…' : undefined, tone: 'ok' });
      onClose();
      navigate(projectPath(env.slug));
    } catch (err) {
      toastError(err, 'Could not create the environment');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} width={480}>
      <form onSubmit={submit} className="modal-body col" style={{ gap: 16 }}>
        <div>
          <h2 className="h2">New environment</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            A full copy of <b>{base.name}</b> — every service, variable and setting — with its own URLs and fresh, empty volumes. Custom domains stay with production.
          </p>
        </div>
        <Field label="Name">
          <input className="input" autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {hasGit && (
          <Field label="Branch" hint="Git services build from this branch instead. Leave empty to use the same branches as production.">
            <input className="input mono" placeholder="develop" value={branch} onChange={(e) => setBranch(e.target.value)} />
          </Field>
        )}
        <label className="row" style={{ gap: 10, fontSize: 13 }}>
          <Switch checked={deploy} onChange={setDeploy} /> Deploy it right away
        </label>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon="layers" loading={busy}>
            Create environment
          </Button>
        </div>
      </form>
    </Modal>
  );
}
