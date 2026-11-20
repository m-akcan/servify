import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from './api.ts';
import { store, useStore, createStore } from './store.ts';
import type { ServiceView, VolumeRecord } from './types.ts';
import { Button, Modal, Field, Switch, Segmented, toast, toastError, confirmDialog, type MenuItem } from '../components/ui.tsx';
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
  | { kind: 'host'; serviceId: string }
  | { kind: 'share'; volumeId: string }
  | { kind: 'adopt'; serviceId?: string }
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

/** Forget a volume but keep its Docker volume and data (e.g. one taken over from Compose). */
export async function forgetVolume(v: VolumeRecord) {
  const ok = await confirmDialog({ title: `Forget ${v.name}?`, body: `Servify stops managing it. The Docker volume ${v.dockerName} and its data stay on the machine.`, confirm: 'Forget' });
  if (!ok) return;
  try {
    await api.del(`/volumes/${v.id}?keepData=1`);
    toast({ title: `${v.name} forgotten — data kept`, tone: 'idle' });
  } catch (e) {
    toastError(e, 'Could not forget it');
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
  if (!v.setId) items.push({ label: 'Share read-only with…', icon: 'eye', onSelect: () => openVolumeDialog({ kind: 'share', volumeId: v.id }) });
  items.push({ label: 'Rename', icon: 'edit', onSelect: () => openVolumeDialog({ kind: 'rename', volumeId: v.id }) });
  items.push({ type: 'sep' });
  if (!svc) items.push({ label: 'Forget (keep the data)', icon: 'eyeOff', onSelect: () => void forgetVolume(v) });
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
  if (d.kind === 'host') return <HostFolderDialog serviceId={d.serviceId} onClose={close} />;
  if (d.kind === 'share') return <ShareDialog volumeId={d.volumeId} onClose={close} />;
  if (d.kind === 'adopt') return <AdoptDialog serviceId={d.serviceId} onClose={close} />;
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
              <button type="button" className="vol-choice" onClick={() => (onClose(), openVolumeDialog({ kind: 'adopt', serviceId: target || undefined }))}>
                <Icon name="download" size={14} />
                <span className="grow">An existing Docker volume…</span>
                <span className="faint">take it over, no copy</span>
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

// ───────────────────────────── host folders, shares, adopting ─────────────────────────────

/** Mount a folder of the server into a service (owner only, under SERVIFY_HOST_MOUNTS). */
function HostFolderDialog({ serviceId, onClose }: { serviceId: string; onClose: () => void }) {
  const svc = useStore((s) => s.current?.services[serviceId]);
  const [hostPath, setHostPath] = useState('');
  const [path, setPath] = useState('/data');
  const [readOnly, setReadOnly] = useState(false);
  const [selinux, setSelinux] = useState<'' | 'z' | 'Z'>('');
  const [busy, setBusy] = useState(false);
  if (!svc) return null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const name = (hostPath.replace(/\/+$/, '').split('/').pop() || 'host').replace(/[^a-zA-Z0-9_.-]/g, '-');
      const volumes = [...svc.volumes, { name, mountPath: path, hostPath, ...(readOnly ? { readOnly } : {}), ...(selinux ? { selinux } : {}) }];
      await api.patch(`/services/${svc.id}`, { volumes });
      if (svc.activeDeploymentId && !svc.stopped) await api.post(`/services/${svc.id}/deploy`);
      toast({ title: `${hostPath} mounted at ${path}`, body: svc.activeDeploymentId ? `${svc.name} redeploys with it.` : undefined, tone: 'ok' });
      onClose();
    } catch (err) {
      toastError(err, 'Could not mount the folder');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} width={500}>
      <form onSubmit={submit} className="modal-body col" style={{ gap: 16 }}>
        <div>
          <h2 className="h2">Mount a host folder</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            A folder on {svc.server && svc.server.id !== 'local' ? svc.server.name : 'this machine'}, shared live with {svc.name} — for media libraries or files you edit in place. Only folders under <code className="inline-code">SERVIFY_HOST_MOUNTS</code> are allowed. Servify never backs them up, wipes or deletes them.
          </p>
        </div>
        <Field label="Folder on the server">
          <input className="input mono" autoFocus placeholder="/srv/media" value={hostPath} onChange={(e) => setHostPath(e.target.value)} />
        </Field>
        <Field label="Mount path" hint="Where it appears inside the container.">
          <input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} />
        </Field>
        <label className="setting-row" style={{ cursor: 'pointer' }}>
          <div className="grow">
            <div className="title">Read-only</div>
            <div className="desc">The container can read but not change the files (and the service can still scale).</div>
          </div>
          <Switch checked={readOnly} onChange={setReadOnly} />
        </label>
        <Field label="SELinux label" hint="Only on SELinux machines (Fedora, RHEL). “Shared” lets other containers use the folder too; “Private” locks it to this one. Relabelling a folder other programs use can break them — leave it off unless the container gets “permission denied”.">
          <Segmented value={selinux} onChange={setSelinux} options={[{ value: '', label: 'Off' }, { value: 'z', label: 'Shared (z)' }, { value: 'Z', label: 'Private (Z)' }]} />
        </Field>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon="folder" loading={busy} disabled={!hostPath.startsWith('/') || !path.startsWith('/')}>
            Mount folder
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Mount a volume read-only into another service of the project (e.g. a backup sidecar). */
function ShareDialog({ volumeId, onClose }: { volumeId: string; onClose: () => void }) {
  const cur = useStore((s) => s.current);
  const v = cur?.volumes[volumeId];
  const services = cur ? cur.order.map((id) => cur.services[id]).filter((x) => x && x.id !== v?.serviceId && x.source.type !== 'external') : [];
  const [target, setTarget] = useState(services[0]?.id ?? '');
  const [path, setPath] = useState(v?.mountPath ?? '/data');
  const [busy, setBusy] = useState(false);
  if (!v) return null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(`/volumes/${v.id}/share`, { serviceId: target, mountPath: path });
      toast({ title: `${cur?.services[target]?.name} reads ${v.name}`, body: `Mounted read-only at ${path}.`, tone: 'ok' });
      onClose();
    } catch (err) {
      toastError(err, 'Could not share it');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} width={480}>
      <form onSubmit={submit} className="modal-body col" style={{ gap: 16 }}>
        <div>
          <h2 className="h2">Share {v.name} read-only</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>Another service can read this volume — say a backup container reading a game server’s world — but never change it. It isn’t backed up, wiped or deleted from there.</p>
        </div>
        <Field label="Service">
          <div className="vol-choices">
            {services.map((x) => (
              <button type="button" key={x.id} className={`vol-choice ${target === x.id ? 'on' : ''}`} onClick={() => setTarget(x.id)}>
                <ServiceGlyph icon={x.icon} name={x.name} size={20} />
                <span className="grow">{x.name}</span>
              </button>
            ))}
          </div>
        </Field>
        <Field label="Mount path">
          <input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} />
        </Field>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon="eye" loading={busy} disabled={!target || !path.startsWith('/')}>
            Share read-only
          </Button>
        </div>
      </form>
    </Modal>
  );
}

type DockerVolume = { name: string; sizeBytes: number | null; compose: string | null; usedBy: { name: string; state: string }[] };

/** Take over a Docker volume that already exists on the server (e.g. a Compose project's database). */
function AdoptDialog({ serviceId, onClose }: { serviceId?: string; onClose: () => void }) {
  const cur = useStore((s) => s.current);
  const services = cur ? cur.order.map((id) => cur.services[id]).filter((x) => x && x.source.type !== 'external') : [];
  const [target, setTarget] = useState(serviceId ?? '');
  const svc = target ? cur?.services[target] : undefined;
  const server = svc?.server?.id ?? 'local';
  const [list, setList] = useState<DockerVolume[] | null>(null);
  const [pick, setPick] = useState('');
  const [path, setPath] = useState('/data');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setList(null);
    setPick('');
    api
      .get<DockerVolume[]>(`/servers/${server}/docker-volumes`)
      .then(setList)
      .catch((e) => setError((e as Error).message));
  }, [server]);
  const chosen = list?.find((x) => x.name === pick);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cur) return;
    setBusy(true);
    try {
      await api.post(`/projects/${cur.project.id}/volumes/adopt`, { dockerName: pick, serviceId: target || undefined, mountPath: path, server });
      toast({ title: `${pick} is now a Servify volume`, body: target ? `${svc?.name} redeploys with it at ${path}. Nothing was copied.` : 'Nothing was copied.', tone: 'ok' });
      onClose();
    } catch (err) {
      toastError(err, 'Could not take it over');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} width={560}>
      <form onSubmit={submit} className="modal-body col" style={{ gap: 16 }}>
        <div>
          <h2 className="h2">Take over a Docker volume</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>Use data that already exists on {server === 'local' ? 'this machine' : svc?.server?.name} — for example from a Compose project — without copying it. Stop the old containers first (<code className="inline-code">docker compose down</code>, without <code className="inline-code">-v</code>).</p>
        </div>
        <Field label="Docker volume">
          <div className="vol-choices adopt-list no-canvas-wheel">
            {error && <div className="faint">{error}</div>}
            {!list && !error && <div className="faint">Looking…</div>}
            {list?.length === 0 && <div className="faint">No other Docker volumes on this server.</div>}
            {list?.map((x) => (
              <button type="button" key={x.name} className={`vol-choice ${pick === x.name ? 'on' : ''}`} disabled={x.usedBy.length > 0} onClick={() => setPick(x.name)} title={x.usedBy.length ? `Still used by ${x.usedBy.map((u) => `${u.name} (${u.state})`).join(', ')}` : undefined}>
                <Icon name="database" size={14} />
                <span className="grow mono truncate">{x.name}</span>
                {x.usedBy.length > 0 ? <span className="faint">used by {x.usedBy[0].name}{x.usedBy.length > 1 ? ` +${x.usedBy.length - 1}` : ''}</span> : <span className="faint mono">{bytes(x.sizeBytes)}</span>}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Attach to (optional)">
          <select className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Keep it detached for now</option>
            {services.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
        {target && (
          <Field label="Mount path">
            <input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} />
          </Field>
        )}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon="download" loading={busy} disabled={!chosen || (!!target && !path.startsWith('/'))}>
            Take over
          </Button>
        </div>
      </form>
    </Modal>
  );
}
