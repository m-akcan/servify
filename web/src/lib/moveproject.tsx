import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { api } from './api.ts';
import { createStore, useStore } from './store.ts';
import type { MovePlan, Project } from '../../../server/src/types.ts';
import { navigate, projectPath } from './router.ts';
import { Button, Modal, Field, toast, toastError } from '../components/ui.tsx';
import { Icon } from '../components/Icon.tsx';

/** "Move to project…": pick a project (or a new one), see what the move would break, then move. */
const dialog = createStore<{ serviceId: string | null }>({ serviceId: null });
export const openMoveDialog = (serviceId: string) => dialog.set({ serviceId });

export function MoveProjectDialogHost() {
  const serviceId = useSyncExternalStore(dialog.subscribe, () => dialog.get().serviceId);
  if (!serviceId) return null;
  return <MoveProjectDialog key={serviceId} serviceId={serviceId} onClose={() => dialog.set({ serviceId: null })} />;
}

const NEW = '__new__';
/** Warnings that mean something stops working: the move then says so on its button. */
const BREAKING = new Set(['used_by', 'uses', 'shared_missing']);

function MoveProjectDialog({ serviceId, onClose }: { serviceId: string; onClose: () => void }) {
  const svc = useStore((s) => s.current?.services[serviceId]);
  const projects = useStore((s) => s.projects);
  // Environments and previews are copies of their production project: never a destination.
  const targets = projects.filter((p) => p.id !== svc?.projectId && !p.parentId);
  const [target, setTarget] = useState<string>(targets[0]?.id ?? NEW);
  const [newName, setNewName] = useState('');
  const [name, setName] = useState('');
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Re-plan when the destination or the name changes (debounced while typing a name).
  useEffect(() => {
    if (!svc) return;
    let stale = false;
    setPlan(null); // nothing moves on the plan for another destination or name
    const t = setTimeout(
      () => {
        api
          .post<MovePlan>(`/services/${svc.id}/move-project`, { dryRun: true, project: target === NEW ? undefined : target, name: name.trim() || undefined })
          .then((p) => !stale && (setPlan(p), setPlanError(null)))
          .catch((e) => !stale && (setPlan(null), setPlanError((e as Error).message)));
      },
      name ? 300 : 0,
    );
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [svc?.id, target, name]);

  const nameTaken = plan?.blockers.some((b) => b.code === 'name_taken') ?? false;
  const [renaming, setRenaming] = useState(false);
  useEffect(() => {
    if (nameTaken && !renaming) {
      setRenaming(true);
      if (!name && plan?.suggestedName) setName(plan.suggestedName);
    }
  }, [nameTaken]);

  const breaking = useMemo(() => plan?.warnings.filter((w) => BREAKING.has(w.code)) ?? [], [plan]);
  const notes = useMemo(() => plan?.warnings.filter((w) => !BREAKING.has(w.code)) ?? [], [plan]);
  if (!svc) return null;
  const targetName = target === NEW ? newName.trim() || 'the new project' : targets.find((p) => p.id === target)?.name ?? '';
  const blocked = !plan || plan.blockers.length > 0 || (target === NEW && !newName.trim());

  const move = async (e: React.FormEvent) => {
    e.preventDefault();
    if (blocked || busy) return;
    setBusy(true);
    let created: Project | null = null;
    try {
      let to = target;
      if (target === NEW) {
        created = await api.post<Project>('/projects', { name: newName.trim() });
        to = created.id;
      }
      // The user has seen what breaks: force goes ahead with it.
      await api.post(`/services/${svc.id}/move-project`, { project: to, force: breaking.length > 0, name: renaming && name.trim() ? name.trim() : undefined });
      const dest = created ?? targets.find((p) => p.id === to);
      toast({
        title: `Moved ${svc.name} to ${dest?.name ?? 'the project'}${renaming && name.trim() && name.trim() !== svc.name ? ` as ${name.trim()}` : ''}`,
        body: plan?.restart ? 'Restarting it on that project’s private network.' : undefined,
        tone: plan?.restart ? 'build' : 'ok',
      });
      onClose();
      if (dest) navigate(projectPath(dest.slug));
    } catch (err) {
      // Nothing moved: don't leave the project made for it behind.
      if (created) await api.del(`/projects/${created.id}`).catch(() => {});
      toastError(err, 'Could not move the service');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} width={560} labelledBy="move-title">
      <form onSubmit={move} className="modal-body col" style={{ gap: 16 }}>
        <div>
          <h2 className="h2" id="move-title">
            Move {svc.name} to another project
          </h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            It keeps its deploy history, variables, domains, volumes (the same data, nothing is copied), backups, logs and metrics.
          </p>
        </div>

        <Field label="Project">
          <select className="select" value={target} onChange={(e) => (setTarget(e.target.value), setRenaming(false), setName(''))} aria-label="Target project" autoFocus>
            {targets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value={NEW}>New project…</option>
          </select>
        </Field>
        {target === NEW && (
          <Field label="New project name">
            <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Shared services" />
          </Field>
        )}
        {renaming && (
          <Field label={`Name in ${targetName}`} hint="Its private host name follows the new name.">
            <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        )}

        {planError && (
          <div className="callout callout-err">
            <Icon name="alert" size={15} />
            <div>{planError}</div>
          </div>
        )}
        {plan?.blockers
          .filter((b) => b.code !== 'same_project')
          .map((b) => (
            <div key={b.code} className="callout callout-err">
              <Icon name="alert" size={15} />
              <div>{b.message}</div>
            </div>
          ))}
        {breaking.map((w) => (
          <div key={w.code} className="callout callout-warn">
            <Icon name="alert" size={15} />
            <div className="col" style={{ gap: 6 }}>
              <div>{w.code === 'used_by' ? `These services stay in ${plan!.from.name} and use ${svc.name}: they won’t reach it after the move.` : w.code === 'uses' ? `${svc.name} uses these services, which stay in ${plan!.from.name}: those references stop working.` : w.message}</div>
              {w.services && (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {w.services.map((x) => (
                    <li key={x.id}>
                      <b>{x.name}</b>: <span className="mono">{x.keys.join(', ')}</span>
                      <span className="faint"> ({x.how === 'variable' ? 'variable reference' : x.how === 'hostname' ? 'by host name' : 'reference and host name'})</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ))}
        {plan && (plan.restart || notes.length > 0) && (
          <div className="callout callout-info">
            <Icon name="info" size={15} />
            <div className="col" style={{ gap: 4 }}>
              {plan.restart && <div>Its containers are recreated on {targetName}’s private network: a brief restart, same image, no pre-deploy command.</div>}
              {notes.map((w) => (
                <div key={w.code}>{w.message}.</div>
              ))}
            </div>
          </div>
        )}

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant={breaking.length ? 'danger' : 'primary'} icon="arrowRight" loading={busy} disabled={blocked}>
            {breaking.length ? 'Move anyway' : 'Move'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
