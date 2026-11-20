import { useState, useSyncExternalStore } from 'react';
import { api } from './api.ts';
import { store, useStore, createStore } from './store.ts';
import type { ServiceView, VolumeRecord } from './types.ts';
import { Button, Modal, Field, Switch, toast, toastError, confirmDialog, type MenuItem } from '../components/ui.tsx';
import { Icon, ServiceGlyph } from '../components/Icon.tsx';

export function bytes(n: number | null | undefined) {
  if (n == null || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export type VolumeGroup = VolumeRecord & { members: number };

/** One entry per volume or per-replica set (leader + total size + member count). */
export function groupVolumes(all: VolumeRecord[]): VolumeGroup[] {
  const sets = new Map<string, VolumeRecord[]>();
  const out: VolumeGroup[] = [];
  for (const v of all) {
    if (!v.setId) out.push({ ...v, members: 1 });
    else sets.set(v.setId, [...(sets.get(v.setId) ?? []), v]);
  }
  for (const [setId, members] of sets) {
    const leader = members.find((m) => m.id === setId) ?? members[0];
    const total = members.reduce((a, m) => a + (m.sizeBytes && m.sizeBytes > 0 ? m.sizeBytes : 0), 0);
    out.push({ ...leader, sizeBytes: total, members: members.length });
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

// ───────────────────────────── dialogs ─────────────────────────────

type VolumeDialog =
  | { kind: 'attach'; volumeId?: string; serviceId?: string; mountPath?: string }
  | { kind: 'new'; at?: { x: number; y: number } }
  | { kind: 'rename'; volumeId: string }
  | null;
const dialogs = createStore<{ d: VolumeDialog }>({ d: null });
export const openVolumeDialog = (d: VolumeDialog) => dialogs.set({ d });

// ───────────────────────────── actions ─────────────────────────────

/** Where each database template keeps its data — detaching that volume empties the database. */
const DATA_DIRS: Record<string, string> = { postgres: '/var/lib/postgresql/data', mysql: '/var/lib/mysql', mongo: '/data/db', redis: '/data', minio: '/data' };

export async function detachVolume(v: VolumeRecord) {
  const svc = v.serviceId ? store.get().current?.services[v.serviceId] : null;
  const ok = await confirmDialog({
    title: `Detach ${v.name}?`,
    body: (
      <>
        {svc ? (
          <>
            <b>{svc.name}</b> restarts without it{DATA_DIRS[svc.templateId ?? ''] === v.mountPath ? ' — the database will start empty' : ''}.{' '}
          </>
        ) : null}
        The data stays in the volume ({bytes(v.sizeBytes)}); attach it to any service in this project later.
      </>
    ),
    confirm: 'Detach',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.post(`/volumes/${v.id}/detach`);
    toast({ title: `${v.name} detached`, body: 'Drag it onto a service to attach it again.', tone: 'ok' });
  } catch (e) {
    toastError(e, 'Could not detach');
  }
}

export async function deleteVolume(v: VolumeRecord) {
  const ok = await confirmDialog({
    title: `Delete ${v.name}?`,
    body: `All ${bytes(v.sizeBytes)} of data in this volume is permanently deleted. This cannot be undone.`,
    confirm: 'Delete volume',
    danger: true,
    typeToConfirm: v.name,
  });
  if (!ok) return;
  try {
    await api.del(`/volumes/${v.id}`);
    toast({ title: `${v.name} deleted`, tone: 'idle' });
  } catch (e) {
    toastError(e, 'Could not delete');
  }
}

export function volumeMenu(v: VolumeRecord): MenuItem[] {
  const svc = v.serviceId ? store.get().current?.services[v.serviceId] : null;
  const items: MenuItem[] = [{ type: 'label', label: `${v.name} · ${bytes(v.sizeBytes)}` }];
  if (svc) items.push({ label: `Detach from ${svc.name}`, icon: 'link', onSelect: () => void detachVolume(v) });
  else items.push({ label: 'Attach to a service…', icon: 'link', onSelect: () => openVolumeDialog({ kind: 'attach', volumeId: v.id }) });
  items.push({ label: 'Rename', icon: 'edit', onSelect: () => openVolumeDialog({ kind: 'rename', volumeId: v.id }) });
  items.push({ type: 'sep' });
  items.push(svc ? { label: 'Delete (detach first)', icon: 'trash', disabled: true, onSelect: () => {} } : { label: 'Delete volume', icon: 'trash', danger: true, onSelect: () => void deleteVolume(v) });
  return items;
}

// ───────────────────────────── host ─────────────────────────────

export function VolumeDialogHost() {
  const d = useSyncExternalStore(dialogs.subscribe, () => dialogs.get().d);
  const close = () => dialogs.set({ d: null });
  if (!d) return null;
  if (d.kind === 'rename') return <RenameDialog volumeId={d.volumeId} onClose={close} />;
  if (d.kind === 'new') return <AttachDialog onClose={close} createAt={d.at ?? { x: 0, y: 0 }} />;
  return <AttachDialog onClose={close} volumeId={d.volumeId} serviceId={d.serviceId} mountPath={d.mountPath} />;
}

function RenameDialog({ volumeId, onClose }: { volumeId: string; onClose: () => void }) {
  const v = useStore((s) => s.current?.volumes[volumeId]);
  const [name, setName] = useState(v?.name ?? '');
  if (!v) return null;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.patch(`/volumes/${v.id}`, { name });
      onClose();
    } catch (err) {
      toastError(err, 'Could not rename');
    }
  };
  return (
    <Modal open onClose={onClose} width={420}>
      <form onSubmit={save} className="modal-body col" style={{ gap: 14 }}>
        <h2 className="h2">Rename volume</h2>
        <Field label="Name">
          <input className="input mono" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || name === v.name}>
            Rename
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Attach a volume to a service — an existing detached one, or a brand new one. */
function AttachDialog({ onClose, volumeId, serviceId, mountPath, createAt }: { onClose: () => void; volumeId?: string; serviceId?: string; mountPath?: string; createAt?: { x: number; y: number } }) {
  const cur = useStore((s) => s.current);
  const services = cur ? cur.order.map((id) => cur.services[id]).filter(Boolean) : [];
  const detached = cur ? groupVolumes(Object.values(cur.volumes)).filter((v) => !v.serviceId) : [];
  const [perReplica, setPerReplica] = useState(false);
  const fixedVolume = volumeId ? cur?.volumes[volumeId] : null;
  const [choice, setChoice] = useState<string>(volumeId ?? (createAt ? 'new' : detached[0]?.id ?? 'new'));
  const [target, setTarget] = useState<string>(serviceId ?? (createAt ? '' : services[0]?.id ?? ''));
  const chosen = choice === 'new' ? null : cur?.volumes[choice] ?? null;
  const [path, setPath] = useState(mountPath ?? chosen?.mountPath ?? '/data');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const svc: ServiceView | undefined = target ? cur?.services[target] : undefined;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cur) return;
    setBusy(true);
    try {
      if (choice === 'new') {
        await api.post(`/projects/${cur.project.id}/volumes`, { name: name || undefined, serviceId: target || undefined, mountPath: path, perReplica, ...(createAt ?? {}) });
        toast({ title: target ? `Volume attached to ${svc?.name}` : 'Volume created', body: target ? `${svc?.name} redeploys with it at ${path}.` : 'Drag it onto a service to attach it.', tone: 'ok' });
      } else {
        await api.post(`/volumes/${choice}/attach`, { serviceId: target, mountPath: path });
        toast({ title: `${chosen?.name} attached to ${svc?.name}`, body: `${svc?.name} redeploys with it at ${path}.`, tone: 'ok' });
      }
      onClose();
    } catch (err) {
      toastError(err, 'Could not attach');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} width={500}>
      <form onSubmit={submit} className="modal-body col" style={{ gap: 16 }}>
        <div>
          <h2 className="h2">{createAt ? 'New volume' : fixedVolume ? `Attach ${fixedVolume.name}` : 'Attach a volume'}</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Volumes keep data across deploys and can move between services. A service with a volume runs as one replica.
          </p>
        </div>
        {!fixedVolume && !createAt && (
          <Field label="Volume">
            <div className="vol-choices">
              <button type="button" className={`vol-choice ${choice === 'new' ? 'on' : ''}`} onClick={() => setChoice('new')}>
                <Icon name="plus" size={14} />
                <span className="grow">New empty volume</span>
              </button>
              {detached.map((v) => (
                <button
                  type="button"
                  key={v.id}
                  className={`vol-choice ${choice === v.id ? 'on' : ''}`}
                  onClick={() => {
                    setChoice(v.id);
                    setPath(v.mountPath);
                  }}
                >
                  <Icon name="database" size={14} />
                  <span className="grow mono">{v.name}{v.members > 1 ? ` ×${v.members}` : v.setId ? ' (per replica)' : ''}</span>
                  <span className="faint mono">{bytes(v.sizeBytes)}</span>
                </button>
              ))}
            </div>
          </Field>
        )}
        {choice === 'new' && (
          <>
            <Field label="Name" hint="Optional — letters, digits, dot, dash, underscore.">
              <input className="input mono" placeholder={svc ? `${svc.slug}-data` : 'volume'} value={name} onChange={(e) => setName(e.target.value.replace(/[^a-zA-Z0-9_.-]/g, ''))} />
            </Field>
            <label className="setting-row" style={{ cursor: 'pointer' }}>
              <div className="grow">
                <div className="title">One volume per replica</div>
                <div className="desc">Each replica gets its own volume, so the service can keep scaling — for software that replicates its own data (database clusters, Redis replicas…).</div>
              </div>
              <Switch checked={perReplica} onChange={setPerReplica} />
            </label>
          </>
        )}
        <Field label={createAt ? 'Attach to (optional)' : 'Service'}>
          <div className="vol-choices">
            {createAt && (
              <button type="button" className={`vol-choice ${target === '' ? 'on' : ''}`} onClick={() => setTarget('')}>
                <Icon name="minus" size={14} />
                <span className="grow">Keep it detached for now</span>
              </button>
            )}
            {services.map((s) => (
              <button type="button" key={s.id} className={`vol-choice ${target === s.id ? 'on' : ''}`} onClick={() => setTarget(s.id)}>
                <ServiceGlyph icon={s.icon} name={s.name} size={20} />
                <span className="grow">{s.name}</span>
                {s.volumes.length > 0 && <span className="faint mono">{s.volumes.length} volume{s.volumes.length > 1 ? 's' : ''}</span>}
              </button>
            ))}
          </div>
        </Field>
        {(target || !createAt) && (
          <Field label="Mount path" hint={svc?.templateId === 'postgres' ? 'Postgres keeps its data in /var/lib/postgresql/data.' : 'Where the volume appears inside the container.'}>
            <input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/data" />
          </Field>
        )}
        {svc && svc.replicas > 1 && !(choice === 'new' ? perReplica : chosen?.setId) && <div className="callout callout-warn"><Icon name="alert" size={15} /><div className="grow">{svc.name} runs {svc.replicas} replicas — it will be scaled to 1 so they don't share the data.</div></div>}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon="database" loading={busy} disabled={(!createAt && !target) || (!!(target || !createAt) && !path.startsWith('/'))}>
            {choice === 'new' ? (target ? 'Create and attach' : 'Create volume') : 'Attach'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
