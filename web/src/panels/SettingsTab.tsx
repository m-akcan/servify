import { useEffect, useState } from 'react';
import type { ServiceView, Protocol, PublicServer } from '../lib/types.ts';
import { api } from '../lib/api.ts';
import { Button, Segmented, Switch, Field, Stepper, toastError, toast, Tooltip, CopyButton, confirmDialog } from '../components/ui.tsx';
import { navigate } from '../lib/router.ts';
import { openVolumeDialog, detachVolume, bytes } from '../lib/volumes.tsx';
import { Icon } from '../components/Icon.tsx';
import { remove, stop, start } from '../lib/actions.ts';
import { useStore } from '../lib/store.ts';
import { describeCron, timeAgo } from '../lib/format.ts';

async function patch(id: string, body: Record<string, unknown>, quiet = false) {
  try {
    await api.patch(`/services/${id}`, body);
    if (!quiet) toast({ title: 'Saved', tone: 'ok', duration: 1600 });
    return true;
  } catch (e) {
    toastError(e, 'Could not save');
    return false;
  }
}

/** Text input that commits on blur / Enter and resyncs from the server. */
/** One entry per line, committed on blur. */
function CommitLines({ value, onCommit, placeholder }: { value: string[]; onCommit: (v: string[]) => void; placeholder?: string }) {
  const text = value.join('\n');
  const [v, setV] = useState(text);
  useEffect(() => setV(text), [text]);
  return (
    <textarea
      className="textarea mono"
      style={{ minHeight: 64 }}
      value={v}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== text && onCommit(v.split('\n').map((l) => l.trim()).filter(Boolean))}
    />
  );
}

/** KEY=VALUE lines, committed on blur. */
function CommitKeyValues({ value, onCommit, placeholder }: { value: Record<string, string> | null | undefined; onCommit: (v: Record<string, string> | null) => void; placeholder?: string }) {
  const text = Object.entries(value ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');
  const [v, setV] = useState(text);
  useEffect(() => setV(text), [text]);
  return (
    <textarea
      className="textarea mono"
      style={{ minHeight: 64 }}
      value={v}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (v === text) return;
        const out: Record<string, string> = {};
        for (const line of v.split('\n')) {
          const i = line.indexOf('=');
          const k = (i < 0 ? line : line.slice(0, i)).trim();
          if (k) out[k] = i < 0 ? '' : line.slice(i + 1).trim();
        }
        onCommit(Object.keys(out).length ? out : null);
      }}
    />
  );
}

function CommitInput({ value, onCommit, placeholder, mono, type = 'text', disabled }: { value: string; onCommit: (v: string) => void; placeholder?: string; mono?: boolean; type?: string; disabled?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    if (v !== value) onCommit(v);
  };
  return (
    <input
      className={`input ${mono ? 'mono' : ''}`}
      value={v}
      type={type}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setV(value);
      }}
      spellCheck={false}
    />
  );
}

function Section({ title, desc, children, icon }: { title: string; desc?: string; children: React.ReactNode; icon: any }) {
  return (
    <section className="section">
      <div className="section-head">
        <div className="section-icon">
          <Icon name={icon} size={15} />
        </div>
        <div className="grow">
          <div className="section-title">{title}</div>
          {desc && <div className="section-desc">{desc}</div>}
        </div>
      </div>
      <div className="section-body">{children}</div>
    </section>
  );
}

const PRESETS: [string, string][] = [
  ['*/5 * * * *', 'Every 5 min'],
  ['@hourly', 'Hourly'],
  ['0 3 * * *', 'Daily 03:00'],
  ['0 9 * * 1-5', 'Weekdays 09:00'],
  ['@weekly', 'Weekly'],
];

function ScheduleField({ service: s }: { service: ServiceView }) {
  return (
    <>
      <Field label="Cron expression" hint={s.schedule ? `${describeCron(s.schedule)}${(s.deployedSchedule ?? null) !== s.schedule ? ' · takes effect on the next deploy (replicas are replaced by scheduled runs)' : ''}` : s.deployedSchedule ? 'Cleared — deploy to switch back to always-on replicas' : 'Empty = a normal always-on service'}>
        <CommitInput mono value={s.schedule ?? ''} placeholder="e.g. */15 * * * *" onCommit={(v) => void patch(id(s), { schedule: v || null })} />
      </Field>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {PRESETS.map(([v, l]) => (
          <button key={v} type="button" className={`chip ${s.schedule === v ? 'chip-on' : ''}`} onClick={() => void patch(id(s), { schedule: v })}>
            {l}
          </button>
        ))}
        {s.schedule && (
          <button type="button" className="chip" onClick={() => void patch(id(s), { schedule: null })}>
            <Icon name="x" size={11} /> Clear
          </button>
        )}
      </div>
      {s.schedule && (
        <Field label="Time zone" hint={s.scheduleTz ? `The schedule is read in ${s.scheduleTz} time. Takes effect right away.` : 'Empty = the server’s local time. A name like Europe/Berlin or UTC.'}>
          <CommitInput mono value={s.scheduleTz ?? ''} placeholder="server time" onCommit={(v) => void patch(id(s), { scheduleTz: v.trim() || null })} />
        </Field>
      )}
    </>
  );
}
const id = (s: ServiceView) => s.id;

/** Which project the service belongs to; moving takes its volumes and history along. */
function ServiceProject({ service: s }: { service: ServiceView }) {
  const projects = useStore((st) => st.projects);
  const others = projects.filter((p) => p.id !== s.projectId);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  if (!others.length) return null;
  const move = async () => {
    const to = others.find((p) => p.id === target);
    if (!to) return;
    const yes = await confirmDialog({
      title: `Move ${s.name} to ${to.parentId ? `${projects.find((p) => p.id === to.parentId)?.name ?? ''} · ${to.envName ?? to.name}` : to.name}?`,
      body: `Its volumes, deploy history and backups go along, and its containers restart on that project's private network (a few seconds). Domains and ports stay the same.`,
      confirm: 'Move',
    });
    if (!yes) return;
    setBusy(true);
    try {
      await api.post(`/services/${s.id}/move-project`, { project: target });
      toast({ title: `Moved ${s.name} to ${to.name}`, tone: 'ok' });
      navigate(`/p/${to.slug}`);
    } catch (e) {
      toastError(e, 'Could not move the service');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="setting-row">
      <div className="grow">
        <div className="title">Project</div>
        <div className="desc">Move it to another project. Services that use its variables (or whose variables it uses) have to change those references first.</div>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <select className="select" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Target project">
          <option value="">Choose a project…</option>
          {others.map((p) => (
            <option key={p.id} value={p.id}>
              {p.parentId ? `${projects.find((x) => x.id === p.parentId)?.name ?? ''} · ${p.envName ?? p.name}` : p.name}
            </option>
          ))}
        </select>
        <Button icon="arrowRight" loading={busy} disabled={!target} onClick={() => void move()}>
          Move
        </Button>
      </div>
    </div>
  );
}

/** Which machine runs the service; moving redeploys it there. */
function ServiceServer({ service: s }: { service: ServiceView }) {
  const [servers, setServers] = useState<PublicServer[]>([]);
  const [target, setTarget] = useState(s.server?.id ?? 'local');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .get<PublicServer[]>('/servers')
      .then(setServers)
      .catch(() => {});
  }, []);
  useEffect(() => setTarget(s.server?.id ?? 'local'), [s.server?.id]);
  const current = s.server?.id ?? 'local';
  const move = async () => {
    const to = servers.find((x) => x.id === target);
    if (!to) return;
    const yes = await confirmDialog({
      title: `Move ${s.name} to ${to.name}?`,
      body: `Servify deploys ${s.name} on ${to.name} (building or pulling the image there), switches traffic once it is healthy, then removes the old replicas.`,
      confirm: 'Move',
    });
    if (!yes) return;
    setBusy(true);
    try {
      await api.post(`/services/${s.id}/move`, { server: target });
      toast({ title: `Moving ${s.name} to ${to.name}`, tone: 'build' });
    } catch (e) {
      toastError(e, 'Could not move the service');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="setting-row">
        <div className="grow">
          <div className="title">
            Runs on <b>{s.server?.name ?? 'This machine'}</b>
            {s.server && !s.server.online && <span className="badge" data-tone="err" style={{ marginLeft: 8 }}>offline</span>}
          </div>
          <div className="desc">
            {s.volumes.length
              ? 'Its volumes live on this server, so it stays here. To move it: back it up, then restore into a service on the other server.'
              : servers.length > 1
                ? 'Moving redeploys it on the other server with no downtime, then retires the old replicas.'
                : 'Add a server to run services on other machines.'}
          </div>
        </div>
        {servers.length > 1 && !s.volumes.length ? (
          <div className="row" style={{ gap: 6 }}>
            <select className="select" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Server">
              {servers.map((x) => (
                <option key={x.id} value={x.id} disabled={x.status !== 'online'}>
                  {x.name}
                  {x.status !== 'online' ? ' (offline)' : ''}
                </option>
              ))}
            </select>
            <Button icon="arrowRight" loading={busy} disabled={target === current} onClick={() => void move()}>
              Move
            </Button>
          </div>
        ) : (
          servers.length <= 1 && (
            <Button variant="ghost" icon="server" onClick={() => navigate('/servers')}>
              Servers
            </Button>
          )
        )}
      </div>
      {!!s.crossServerRefs?.length && (
        <div className="callout">
          <Icon name="link" size={14} />
          <span>
            {s.name} uses {s.crossServerRefs.join(', ')}, which run{s.crossServerRefs.length === 1 ? 's' : ''} on another server. Their private names still work: Servify relays connections to their main port through this machine. For chatty traffic (a database on every request), keeping them on one server is faster.
          </span>
        </div>
      )}
    </>
  );
}

function ServiceVolumes({ service: s }: { service: ServiceView }) {
  const vols = useStore((st) => st.current?.volumes);
  const attached = s.volumes.filter((m) => !m.hostPath && !m.borrowed).map((m) => ({ m, v: m.volumeId ? vols?.[m.volumeId] : undefined }));
  const extra = s.volumes.filter((m) => m.hostPath || m.borrowed);
  const unmount = async (mountPath: string) => {
    try {
      await api.post(`/services/${s.id}/unmount`, { mountPath });
      toast({ title: `Removed ${mountPath}`, body: 'Nothing was deleted.', tone: 'ok' });
    } catch (e) {
      toastError(e, 'Could not remove it');
    }
  };
  return (
    <>
      {extra.map((m) => (
        <div key={m.mountPath} className="setting-row volume-row">
          <Icon name={m.hostPath ? 'folder' : 'eye'} size={14} />
          <span className="mono truncate" style={{ minWidth: 0, maxWidth: '45%' }} title={m.hostPath ?? undefined}>{m.hostPath ?? (m.volumeId && vols?.[m.volumeId]?.name) ?? m.name}</span>
          <Icon name="arrowRight" size={12} className="faint" />
          <span className="mono grow truncate">{m.mountPath}</span>
          <span className="badge" data-tone="idle">{m.hostPath ? 'host folder' : 'shared'}{m.readOnly || m.borrowed ? ' · read-only' : ''}{m.selinux ? ` · :${m.selinux}` : ''}</span>
          <Button size="sm" variant="ghost" icon="x" onClick={() => void unmount(m.mountPath)}>
            Remove
          </Button>
        </div>
      ))}
      {attached.map(({ m, v }) => (
        <div key={m.volumeId ?? m.name} className="setting-row volume-row">
          <Icon name="database" size={14} />
          <span className="mono">{m.name}</span>
          <Icon name="arrowRight" size={12} className="faint" />
          <span className="mono grow truncate">{m.mountPath}</span>
          {v && <span className="faint mono" style={{ fontSize: 11 }}>{bytes(v.sizeBytes)}</span>}
          {s.activeDeploymentId && !s.stopped && (
            <a className="btn btn-ghost btn-sm" href={`/api/services/${s.id}/volumes/${encodeURIComponent(m.name)}/download`} download>
              <Icon name="download" size={14} />
              Download
            </a>
          )}
          {v && (
            <Button size="sm" variant="ghost" icon="link" onClick={() => void detachVolume(v)}>
              Detach
            </Button>
          )}
        </div>
      ))}
      <div className="row">
        <Button icon="plus" onClick={() => openVolumeDialog({ kind: 'attach', serviceId: s.id })}>
          Attach volume
        </Button>
        <Button variant="ghost" icon="folder" onClick={() => openVolumeDialog({ kind: 'host', serviceId: s.id })}>
          Host folder
        </Button>
        <span className="faint" style={{ fontSize: 12 }}>
          A new empty one, or a detached volume from this project.
        </span>
      </div>
    </>
  );
}

/** Ports published straight on the server (owner only). */
function PublishedPorts({ service: s }: { service: ServiceView }) {
  const [rows, setRows] = useState(s.ports ?? []);
  const [draft, setDraft] = useState({ container: '', host: '', protocol: 'tcp' as 'tcp' | 'udp' });
  const [busy, setBusy] = useState(false);
  useEffect(() => setRows(s.ports ?? []), [JSON.stringify(s.ports ?? [])]);
  const save = async (next: NonNullable<ServiceView['ports']>) => {
    setBusy(true);
    try {
      await api.patch(`/services/${s.id}`, { ports: next });
      setRows(next);
      if (s.activeDeploymentId && !s.stopped) {
        await api.post(`/services/${s.id}/deploy`);
        toast({ title: 'Ports saved', body: `${s.name} restarts with them (one replica, the old one stops first).`, tone: 'ok' });
      } else toast({ title: 'Ports saved', body: 'They open on the next start.', tone: 'ok' });
      setDraft({ container: '', host: '', protocol: draft.protocol });
    } catch (e) {
      toastError(e, 'Could not save the ports');
    } finally {
      setBusy(false);
    }
  };
  const c = Number(draft.container);
  const h = Number(draft.host || draft.container);
  return (
    <>
      {rows.map((p) => (
        <div key={`${p.host}/${p.protocol}`} className="setting-row volume-row">
          <Icon name="network" size={14} />
          <span className="mono">
            {p.hostIp ?? '0.0.0.0'}:{p.host}
          </span>
          <Icon name="arrowRight" size={12} className="faint" />
          <span className="mono grow">container {p.container}</span>
          <span className="badge" data-tone="idle">
            {p.protocol.toUpperCase()}
          </span>
          <Button size="sm" variant="ghost" icon="x" disabled={busy} onClick={() => void save(rows.filter((x) => x !== p))}>
            Remove
          </Button>
        </div>
      ))}
      <div className="row ports-add" style={{ gap: 8 }}>
        <input className="input mono" style={{ width: 120 }} placeholder="container" inputMode="numeric" value={draft.container} onChange={(e) => setDraft({ ...draft, container: e.target.value.replace(/\D/g, '') })} />
        <Icon name="arrowRight" size={12} className="faint" />
        <input className="input mono" style={{ width: 120 }} placeholder={draft.container || 'host'} inputMode="numeric" value={draft.host} onChange={(e) => setDraft({ ...draft, host: e.target.value.replace(/\D/g, '') })} />
        <Segmented size="sm" value={draft.protocol} onChange={(v) => setDraft({ ...draft, protocol: v })} options={[{ value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' }]} />
        <Button icon="plus" loading={busy} disabled={!(c > 0 && c < 65536 && h > 0 && h < 65536)} onClick={() => void save([...rows, { container: c, host: h, protocol: draft.protocol }])}>
          Publish
        </Button>
      </div>
    </>
  );
}

/** Where a redirect service sends visitors. */
function RedirectSettings({ service: s }: { service: ServiceView }) {
  const src = s.source.type === 'redirect' ? s.source : null;
  if (!src) return null;
  return (
    <>
      <Field label="Redirect to" hint="Visitors of this service's domains are sent here.">
        <CommitInput mono value={src.to} onCommit={(v) => void patch(s.id, { redirect: v })} />
      </Field>
      <div className="setting-row">
        <div className="grow">
          <div className="title">Keep the path</div>
          <div className="desc">/blog?page=2 goes to the same path on the new address. Off: everything lands on the address above.</div>
        </div>
        <Switch checked={src.keepPath} onChange={(v) => void patch(s.id, { keepPath: v })} />
      </div>
      <Field label="Kind">
        <Segmented<string>
          value={String(src.code)}
          onChange={(v) => void patch(s.id, { redirectCode: Number(v) })}
          options={[
            { value: '308', label: 'Permanent (308)' },
            { value: '301', label: '301' },
            { value: '307', label: 'Temporary (307)' },
            { value: '302', label: '302' },
          ]}
        />
      </Field>
    </>
  );
}

/** The target of an external route, and whether it answers. */
function ExternalAddress({ service: s }: { service: ServiceView }) {
  const src = s.source.type === 'external' ? s.source : null;
  if (!src) return null;
  const t = s.external;
  return (
    <>
      <Field label="Address" hint="Host and port on your network, plain HTTP (Servify does the HTTPS). For TCP routes, the TCP proxy port forwards here.">
        <CommitInput mono value={src.url} onCommit={(v) => void patch(s.id, { external: v })} />
      </Field>
      {s.protocol === 'tcp' && (
        <div className="setting-row">
          <div className="grow">
            <div className="title">Forward UDP too</div>
            <div className="desc">The TCP proxy port {s.publicTcpPort ?? ''} also relays UDP to the same address — for game servers and voice chat.</div>
          </div>
          <Switch checked={!!src.udp} onChange={(v) => void patch(s.id, { udp: v })} />
        </div>
      )}
      <div className="faint" style={{ fontSize: 12 }}>
        {t?.healthy === true ? `Answering · checked ${t.lastProbe ? new Date(t.lastProbe).toLocaleTimeString() : ''}` : t?.healthy === false ? 'Not answering — the router shows a “service unavailable” page until it does.' : 'Checking…'}
      </div>
    </>
  );
}

function tlsLabel(info?: ServiceView['domainInfo'][number]) {
  if (!info) return 'HTTP';
  if (info.tls === 'issued') return `HTTPS · certificate valid until ${info.expiresAt ? new Date(info.expiresAt).toLocaleDateString() : '?'}`;
  if (info.tls === 'pending') return 'HTTPS · requesting a certificate…';
  if (info.tls === 'failed') return `HTTPS · certificate failed: ${info.error ?? 'unknown error'}`;
  if (info.tls === 'local') return 'Local name — served with the Servify local CA on the HTTPS port';
  return 'HTTP only — turn on HTTPS in Settings';
}

function ImageUpdates({ service: s }: { service: ServiceView }) {
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  if (s.source.type !== 'image' || s.source.image.includes('@')) return null;
  const u = s.imageUpdate ?? null;
  const base = s.source.image.trim().replace(/:[^:/]+$/, '');
  const check = async () => {
    setChecking(true);
    try {
      const r = await api.post<{ status: string; reason?: string } | null>(`/services/${s.id}/image-check`);
      if (r?.status === 'unknown') toast({ title: 'Could not check for updates', body: r.reason, tone: 'warn' });
    } catch (e) {
      toastError(e, 'Check failed');
    } finally {
      setChecking(false);
    }
  };
  // Databases and services with volumes may upgrade their data in place: an old image might not start on it again.
  const stateful = !!s.backupMethod;
  const update = async (tag: string | null, major = false) => {
    if (tag && stateful) {
      const ok = await confirmDialog({
        title: `Switch ${s.name} to ${base}:${tag}?`,
        body: `${major ? 'A new major version' : 'A newer version'} may upgrade ${s.name}’s data in place, and going back to the old image may not work afterwards. Servify backs it up first and only switches if the backup succeeds.`,
        confirm: 'Back up and switch',
      });
      if (!ok) return;
    } else if (major && !(await confirmDialog({ title: `Update ${s.name} to ${base}:${tag}?`, body: 'A new major version can change behaviour. Check its release notes first.', confirm: 'Update' }))) return;
    setUpdating(tag ?? 'same');
    try {
      if (tag && stateful) toast({ title: `Backing up ${s.name} before switching…`, tone: 'build' });
      await api.post(`/services/${s.id}/update-image`, tag ? { tag } : {});
      toast({ title: tag ? `Updating ${s.name} to ${tag}` : `Pulling ${s.source.type === 'image' ? s.source.image : ''} again`, tone: 'build' });
    } catch (e) {
      toastError(e, 'Update failed');
    } finally {
      setUpdating(null);
    }
  };
  const status = !u
    ? 'Not checked yet.'
    : u.status === 'unknown'
      ? `Can't tell: ${u.reason ?? 'unknown'}.`
      : u.status === 'changed'
        ? `A newer image was published as ${u.ref}.`
        : u.newerTag || u.newerMajor
          ? `${u.ref} is the newest image for its tag.`
          : 'Up to date.';
  return (
    <div className="image-updates">
      <div className="row" style={{ gap: 8 }}>
        <Icon name={u?.status === 'changed' || u?.newerTag || u?.newerMajor ? 'arrowUp' : u?.status === 'current' ? 'check' : 'refresh'} size={13} />
        <span className="grow">
          {status}
          {u && <span className="faint"> Checked {timeAgo(u.checkedAt)}.</span>}
        </span>
        <Button size="sm" variant="ghost" icon="refresh" loading={checking} onClick={() => void check()}>
          Check now
        </Button>
      </div>
      {(u?.status === 'changed' || u?.newerTag || u?.newerMajor) && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {u.status === 'changed' && (
            <Button size="sm" variant="primary" icon="download" loading={updating === 'same'} onClick={() => void update(null)}>
              Update {u.ref.replace(/^.*\//, '')}
            </Button>
          )}
          {u.newerTag && (
            <Button size="sm" variant={u.status === 'changed' ? 'secondary' : 'primary'} loading={updating === u.newerTag} onClick={() => void update(u.newerTag!)}>
              Switch to {u.newerTag}
            </Button>
          )}
          {u.newerMajor && (
            <Button size="sm" variant="ghost" loading={updating === u.newerMajor} onClick={() => void update(u.newerMajor!, true)}>
              {u.newerMajor} (new major)
            </Button>
          )}
        </div>
      )}
      <div className="setting-row">
        <div className="grow">
          <div className="title">Update automatically</div>
          <div className="desc">Redeploy when a new image is published under the same tag. Never for databases, clusters or new tags.</div>
        </div>
        <Switch checked={!!s.imageAutoUpdate} onChange={(v) => void patch(s.id, { imageAutoUpdate: v })} />
      </div>
    </div>
  );
}

/** Builds: updates of the base image their Dockerfile starts from. Applying one rebuilds; never automatic. */
function BaseImageUpdates({ service: s }: { service: ServiceView }) {
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  if (!s.baseImage) return null;
  const u = s.imageUpdate?.base ? s.imageUpdate : null;
  const ref = s.baseImage;
  const repo = ref.replace(/:[^:/]+$/, '');
  const check = async () => {
    setChecking(true);
    try {
      const r = await api.post<{ status: string; reason?: string } | null>(`/services/${s.id}/image-check`);
      if (r?.status === 'unknown') toast({ title: 'Could not check the base image', body: r.reason, tone: 'warn' });
    } catch (e) {
      toastError(e, 'Check failed');
    } finally {
      setChecking(false);
    }
  };
  const stateful = !!s.backupMethod;
  const update = async (tag: string | null, major = false) => {
    if (tag) {
      const ok = await confirmDialog({
        title: `Rebuild ${s.name} on ${repo}:${tag}?`,
        body: `Sets the build argument ${u?.tagArg} to ${tag} and rebuilds.${major ? ' A new major version can change behaviour — check its release notes first.' : ''}${stateful ? ` It may upgrade ${s.name}’s data in place: Servify backs it up first and only rebuilds if the backup succeeds.` : ''}`,
        confirm: stateful ? 'Back up and rebuild' : 'Rebuild',
      });
      if (!ok) return;
    }
    setUpdating(tag ?? 'same');
    try {
      await api.post(`/services/${s.id}/update-image`, tag ? { tag } : {});
      toast({ title: tag ? `Rebuilding ${s.name} on ${repo}:${tag}` : `Pulling ${ref} and rebuilding ${s.name}`, tone: 'build' });
    } catch (e) {
      toastError(e, 'Update failed');
    } finally {
      setUpdating(null);
    }
  };
  const tags = [u?.newerTag, u?.newerMajor].filter(Boolean) as string[];
  // Follows "Base image <ref>".
  const status = !u
    ? ' · not checked yet.'
    : tags.length
      ? ` → ${tags.join(', ')} available${u.status === 'changed' ? '; a newer image was also published under the same tag' : ''}.`
      : u.status === 'changed'
        ? ': a newer image was published under the same tag.'
        : u.status === 'unknown'
          ? ` · can't tell: ${u.reason ?? 'unknown'}.`
          : ' · up to date.';
  const pending = !!u && (u.status === 'changed' || tags.length > 0);
  return (
    <div className="image-updates">
      <div className="row" style={{ gap: 8 }}>
        <Icon name={pending ? 'arrowUp' : u?.status === 'current' ? 'check' : 'refresh'} size={13} />
        <span className="grow">
          <span className="faint">Base image </span>
          <span className="mono">{ref}</span>
          {status}
          {u && <span className="faint"> Checked {timeAgo(u.checkedAt)}.</span>}
        </span>
        <Button size="sm" variant="ghost" icon="refresh" loading={checking} onClick={() => void check()}>
          Check now
        </Button>
      </div>
      {pending && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {u!.status === 'changed' && (
            <Button size="sm" variant="primary" icon="download" loading={updating === 'same'} onClick={() => void update(null)}>
              Pull {ref.replace(/^.*\//, '')} and rebuild
            </Button>
          )}
          {u!.tagArg && u!.newerTag && (
            <Button size="sm" variant={u!.status === 'changed' ? 'secondary' : 'primary'} loading={updating === u!.newerTag} onClick={() => void update(u!.newerTag!)}>
              Rebuild on {u!.newerTag}
            </Button>
          )}
          {u!.tagArg && u!.newerMajor && (
            <Button size="sm" variant="ghost" loading={updating === u!.newerMajor} onClick={() => void update(u!.newerMajor!, true)}>
              {u!.newerMajor} (new major)
            </Button>
          )}
          {!u!.tagArg && tags.length > 0 && <span className="faint" style={{ fontSize: 12 }}>The tag is written in the Dockerfile: change it there to switch.</span>}
        </div>
      )}
    </div>
  );
}

function DeployHook({ serviceId }: { serviceId: string }) {
  const [path, setPath] = useState<string | null>(null);
  const system = useStore((st) => st.system);
  useEffect(() => {
    api.get<{ path: string }>(`/services/${serviceId}/deploy-hook`).then((r) => setPath(r.path)).catch(() => setPath(null));
  }, [serviceId]);
  if (!path) return null;
  const url = `http://<your-host>:${system?.proxy.port ?? 8080}${path}`;
  return (
    <Field label="Deploy hook" hint="POST to this URL from CI to deploy. Served by the router, so it works wherever your apps are reachable.">
      <div className="row" style={{ gap: 6 }}>
        <input className="input mono" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        <CopyButton text={url.replace('<your-host>', 'localhost')} label="Copy" />
      </div>
    </Field>
  );
}

export function SettingsTab({ service: s }: { service: ServiceView }) {
  const proxyPort = useStore((st) => st.current?.proxyPort ?? 8080);
  const project = useStore((st) => st.current?.project);
  const [domainDraft, setDomainDraft] = useState('');
  const id = s.id;
  const src = s.source;
  const ext = src.type === 'external' || src.type === 'redirect';

  return (
    <div className="settings">
      <Section title="General" icon="edit">
        <Field label="Name">
          <CommitInput value={s.name} onCommit={(v) => void patch(id, { name: v })} />
        </Field>
      </Section>

      {src.type === 'external' && (
        <Section title="Address" icon="external" desc="This service is a route: the router sends its traffic to another machine. Nothing runs here.">
          <ExternalAddress service={s} />
        </Section>
      )}
      {src.type === 'redirect' && (
        <Section title="Redirect" icon="arrowUpRight" desc="Its domains answer with a redirect. Nothing runs here.">
          <RedirectSettings service={s} />
        </Section>
      )}
      {!ext && (
      <Section title="Source" icon={src.type === 'git' ? 'github' : src.type === 'local' || src.type === 'upload' ? 'folder' : 'box'} desc="Changes apply on the next deploy.">
        <Segmented
          value={src.type}
          onChange={(t) => {
            if (t === src.type) return;
            if (t === 'image') void patch(id, { image: 'nginx:alpine' });
            if (t === 'git') void patch(id, { repo: 'https://github.com/owner/repo' });
            if (t === 'local') void patch(id, { path: '/path/to/project' });
          }}
          options={[
            { value: 'image', label: 'Image' },
            { value: 'git', label: 'Git' },
            { value: 'local', label: 'Local folder' },
          ]}
        />
        {src.type === 'image' && (
          <Field label="Image">
            <CommitInput mono value={src.image} onCommit={(v) => void patch(id, { image: v })} />
          </Field>
        )}
        {src.type === 'image' && <ImageUpdates service={s} />}
        {src.type === 'upload' && (
          <div className="image-updates">
            <div className="row" style={{ gap: 8 }}>
              <Icon name="upload" size={13} />
              <span className="grow">
                {src.uploadedAt ? (
                  <>
                    Uploaded {timeAgo(src.uploadedAt)}
                    {src.label ? <> from <span className="mono">{src.label}</span></> : null} · {src.files.toLocaleString()} files, {bytes(src.bytes)}
                  </>
                ) : (
                  'Waiting for the first upload.'
                )}
              </span>
            </div>
            <div className="faint" style={{ fontSize: 12 }}>
              Deploy from your project folder with <span className="mono">servify up</span>. Redeploys build the latest upload again.
            </div>
            <div className="row" style={{ gap: 6 }}>
              <input className="input mono" readOnly value={`servify link ${project?.slug ?? ''} ${s.slug ?? s.name} && servify up`} onFocus={(e) => e.currentTarget.select()} />
              <CopyButton text={`servify link ${project?.slug ?? ''} ${s.slug ?? s.name} && servify up`} label="Copy" />
            </div>
          </div>
        )}
        {src.type === 'git' && (
          <>
            <Field label="Repository">
              <CommitInput mono value={src.repo} onCommit={(v) => void patch(id, { repo: v })} />
            </Field>
            <div className="ns-grid">
              <Field label="Branch">
                <CommitInput mono value={src.branch ?? ''} placeholder="default" onCommit={(v) => void patch(id, { branch: v })} />
              </Field>
              <Field label="Root directory">
                <CommitInput mono value={src.rootDir ?? ''} placeholder="/" onCommit={(v) => void patch(id, { rootDir: v })} />
              </Field>
              <Field label="Dockerfile">
                <CommitInput mono value={src.dockerfile ?? ''} placeholder="auto" onCommit={(v) => void patch(id, { dockerfile: v })} />
              </Field>
              <Field label="Access token">
                <CommitInput mono type="password" value={src.token ?? ''} placeholder="for private repos" onCommit={(v) => void patch(id, { token: v })} />
              </Field>
            </div>
            <div className="setting-row">
              <div className="grow">
                <div className="title">Auto-deploy on push</div>
                <div className="desc">
                  Instant with a git webhook (<button className="link" onClick={() => navigate('/settings/webhooks')}>set one up</button>); otherwise checked every minute.
                </div>
              </div>
              <Switch checked={s.autoDeploy} onChange={(v) => void patch(id, { autoDeploy: v })} />
            </div>
          </>
        )}
        <DeployHook serviceId={s.id} />
        {src.type === 'local' && (
          <div className="ns-grid">
            <Field label="Path">
              <CommitInput mono value={src.path} onCommit={(v) => void patch(id, { path: v })} />
            </Field>
            <Field label="Dockerfile">
              <CommitInput mono value={src.dockerfile ?? ''} placeholder="auto" onCommit={(v) => void patch(id, { path: src.path, dockerfile: v })} />
            </Field>
          </div>
        )}
        {src.type !== 'image' && (
          <Field label="Build command" hint="Overrides the detected build step (zero-config builds only)">
            <CommitInput mono value={s.buildCommand ?? ''} placeholder="auto" onCommit={(v) => void patch(id, { buildCommand: v || null })} />
          </Field>
        )}
        {src.type !== 'image' && (
          <div className="ns-grid">
            <Field label="Build target" hint="Multi-stage Dockerfile stage to build (--target)">
              <CommitInput mono value={s.buildTarget ?? ''} placeholder="last stage" onCommit={(v) => void patch(id, { buildTarget: v || null })} />
            </Field>
            <Field label="Build arguments" hint="KEY=value per line (--build-arg); ${VAR} uses this service's variables. Kept in the image's history — no secrets.">
              <CommitKeyValues value={s.buildArgs} placeholder={'NODE_ENV=production\nVITE_API_BASE=${API_URL}'} onCommit={(v) => void patch(id, { buildArgs: v })} />
            </Field>
          </div>
        )}
        {src.type !== 'image' && <BaseImageUpdates service={s} />}
        {src.type === 'git' && (
          <Field label="Watch paths" hint="Deploy on push only when files matching these globs change — one per line, ! excludes (e.g. apps/web/**, !**/*.md). Empty: every push deploys.">
            <CommitLines value={s.watchPaths ?? []} placeholder={'apps/web/**\npackages/shared/**\n!**/*.md'} onCommit={(v) => void patch(id, { watchPaths: v.length ? v : null })} />
          </Field>
        )}
        <Field label="Pre-deploy command" hint="Runs once per new deploy in a one-off container from the new image — e.g. migrations. If it fails, the deploy stops and the running version stays.">
          <CommitInput mono value={s.preDeployCommand ?? ''} placeholder="e.g. pnpm prisma migrate deploy" onCommit={(v) => void patch(id, { preDeployCommand: v || null })} />
        </Field>
        <Field label="Start command" hint="Runs via /bin/sh -c, replacing the image's default command">
          <CommitInput mono value={s.startCommand ?? ''} placeholder="image default" onCommit={(v) => void patch(id, { startCommand: v || null })} />
        </Field>
        {(s.cmd?.length || s.entrypoint?.length) && (
          <div className="setting-row">
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="title">Container arguments</div>
              <div className="desc mono truncate">
                {s.entrypoint?.length ? `entrypoint ${JSON.stringify(s.entrypoint)} · ` : ''}
                {s.cmd?.length ? `command ${JSON.stringify(s.cmd)}` : 'image command'}
              </div>
              <div className="desc">{s.startCommand ? 'Ignored while a start command is set.' : 'Overrides only what is listed, like Docker Compose (from an import).'}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => void patch(id, { cmd: null, entrypoint: null })}>
              Clear
            </Button>
          </div>
        )}
      </Section>
      )}

      {!ext && (
        <Section title="Schedule" icon="clock" desc="Run this service as a cron job: a one-off container on a schedule instead of always-on replicas.">
          <ScheduleField service={s} />
        </Section>
      )}

      <Section title="Networking" icon="globe">
        <Segmented<Protocol>
          value={s.protocol}
          onChange={(v) => void patch(id, { protocol: v })}
          options={[
            { value: 'http', label: 'HTTP' },
            { value: 'tcp', label: 'TCP' },
            ...(ext ? [] : [{ value: 'none' as Protocol, label: 'Worker' }]),
          ]}
        />
        {s.protocol !== 'none' && !ext && (
          <Field label="Container port" hint="Auto-detected from EXPOSE when empty. PORT is injected into the container.">
            <CommitInput mono value={s.port ? String(s.port) : ''} placeholder="auto" onCommit={(v) => void patch(id, { port: v ? Number(v) : null })} />
          </Field>
        )}
        {s.protocol === 'http' && (
          <>
            <div className="setting-row">
              <div className="grow">
                <div className="title">Public domain</div>
                <div className="desc mono">
                  {s.slug}.{project?.slug}.localhost:{proxyPort}
                </div>
              </div>
              <Switch checked={s.publicHttp} onChange={(v) => void patch(id, { publicHttp: v })} />
            </div>
            <Field
              label="Custom domains"
              hint={
                <>
                  Point the domain's DNS at this machine. With HTTPS on (<button className="link" onClick={() => navigate('/settings/https')}>Settings → HTTPS</button>) Servify gets a certificate automatically.
                </>
              }
            >
              <div className="domain-list">
                {s.domains.map((d) => {
                  const info = s.domainInfo?.find((x) => x.domain === d);
                  return (
                  <span key={d} className="chip mono domain-chip" data-tls={info?.tls ?? 'off'}>
                    <Tooltip label={tlsLabel(info)}>
                      <span className="tls-dot" />
                    </Tooltip>
                    <a href={info?.url ?? `http://${d}`} target="_blank" rel="noreferrer">
                      {d}
                    </a>
                    <button onClick={() => void patch(id, { domains: s.domains.filter((x) => x !== d) })} aria-label={`Remove ${d}`}>
                      <Icon name="x" size={12} />
                    </button>
                  </span>
                  );
                })}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!domainDraft.trim()) return;
                    void patch(id, { domains: [...s.domains, domainDraft.trim()] }).then((ok) => ok && setDomainDraft(''));
                  }}
                  className="row"
                  style={{ flex: 1, minWidth: 200 }}
                >
                  <input className="input mono" placeholder="app.example.com" value={domainDraft} onChange={(e) => setDomainDraft(e.target.value)} />
                  <Button type="submit" size="sm" icon="plus" disabled={!domainDraft.trim()}>
                    Add
                  </Button>
                </form>
              </div>
            </Field>
          </>
        )}
        {s.protocol !== 'none' && (
          <div className="setting-row">
            <div className="grow">
              <div className="title">TCP proxy</div>
              <div className="desc">{s.publicTcpPort ? `Reachable at localhost:${s.publicTcpPort} — load balanced across replicas` : 'Expose a raw TCP port on this machine (databases, gRPC, …)'}</div>
            </div>
            {s.publicTcpPort && (
              <div style={{ width: 96 }}>
                <CommitInput mono value={String(s.publicTcpPort)} onCommit={(v) => void patch(id, { publicTcpPort: Number(v) || null })} />
              </div>
            )}
            <Switch checked={!!s.publicTcpPort} onChange={(v) => void patch(id, { publicTcpPort: v ? 0 : null })} />
          </div>
        )}
      </Section>

      {s.protocol !== 'none' && (
        <Section title="Health checks" icon="pulse" desc="Replicas only receive traffic once healthy. Failing replicas are taken out of rotation.">
          <div className="ns-grid">
            <Field label="HTTP path" hint={s.protocol === 'http' ? 'Empty = TCP connect check' : 'TCP connect check'}>
              <CommitInput mono value={s.healthcheck.path ?? ''} placeholder="/healthz" disabled={s.protocol !== 'http'} onCommit={(v) => void patch(id, { healthcheck: { path: v || null } })} />
            </Field>
            <Field label="Interval (s)">
              <CommitInput mono value={String(s.healthcheck.intervalSec)} onCommit={(v) => void patch(id, { healthcheck: { intervalSec: Number(v) || 5 } })} />
            </Field>
            <Field label="Timeout (s)">
              <CommitInput mono value={String(s.healthcheck.timeoutSec)} onCommit={(v) => void patch(id, { healthcheck: { timeoutSec: Number(v) || 3 } })} />
            </Field>
            <Field label="Startup grace (s)">
              <CommitInput mono value={String(s.healthcheck.graceSec)} onCommit={(v) => void patch(id, { healthcheck: { graceSec: Number(v) || 60 } })} />
            </Field>
          </div>
        </Section>
      )}

      {s.protocol === 'http' && !ext && !s.cluster && !['pg_dumpall', 'mysqldump', 'mongodump'].includes(s.backupMethod ?? '') && (
        <Section title="Sleep when idle" icon="moon" desc="Stops the service after a while without requests and starts it again on the next one (the first request waits a few seconds). Only traffic through its URL or domains counts.">
          <div className="setting-row">
            <div className="grow">
              <div className="title">{s.sleepAfterMinutes ? `Sleeps after ${s.sleepAfterMinutes >= 60 ? `${s.sleepAfterMinutes / 60} h` : `${s.sleepAfterMinutes} min`} without requests` : 'Always on'}</div>
              <div className="desc">{s.sleeping ? 'Asleep now — the next request wakes it.' : 'Saves memory and CPU for apps that are rarely used.'}</div>
            </div>
            <select className="select" style={{ width: 'auto' }} value={String(s.sleepAfterMinutes ?? 0)} onChange={(e) => void patch(id, { sleepAfterMinutes: Number(e.target.value) || null })} aria-label="Sleep after">
              {[0, 5, 10, 15, 30, 60, 120, 360, 1440].map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? 'Never' : m >= 60 ? `${m / 60} h` : `${m} min`}
                </option>
              ))}
            </select>
          </div>
        </Section>
      )}

      {!s.volumes.length && !ext && !s.ports?.length && (
        <Section title="Autoscaling" icon="layers" desc="Adds replicas under load, removes them when it calms down.">
          <div className="setting-row">
            <div className="grow">
              <div className="title">Enable autoscaling</div>
              <div className="desc">
                Target {s.autoscale.metric === 'cpu' ? `${s.autoscale.target}% CPU` : `${s.autoscale.target} req/s`} per replica, between {s.autoscale.min} and {s.autoscale.max} replicas
              </div>
            </div>
            <Switch checked={s.autoscale.enabled} onChange={(v) => void patch(id, { autoscale: { enabled: v } })} />
          </div>
          {s.autoscale.enabled && (
            <div className="autoscale-grid fade-in">
              <Field label="Metric">
                <Segmented
                  value={s.autoscale.metric}
                  onChange={(v) => void patch(id, { autoscale: { metric: v, target: v === 'cpu' ? 70 : 50 } }, true)}
                  options={[
                    { value: 'rps', label: 'Requests' },
                    { value: 'cpu', label: 'CPU' },
                  ]}
                />
              </Field>
              <Field label={s.autoscale.metric === 'cpu' ? 'Target CPU %' : 'Target req/s'}>
                <CommitInput mono value={String(s.autoscale.target)} onCommit={(v) => void patch(id, { autoscale: { target: Number(v) || 50 } })} />
              </Field>
              <Field label="Min">
                <Stepper value={s.autoscale.min} min={1} max={s.autoscale.max} onChange={(v) => void patch(id, { autoscale: { min: v } }, true)} />
              </Field>
              <Field label="Max">
                <Stepper value={s.autoscale.max} min={s.autoscale.min} max={32} onChange={(v) => void patch(id, { autoscale: { max: v } }, true)} />
              </Field>
            </div>
          )}
        </Section>
      )}

      {!ext && (
      <>
      <Section title="Resources" icon="cpu" desc="Per-replica limits. Empty = unlimited.">
        <div className="ns-grid">
          <Field label="CPU cores">
            <CommitInput mono value={s.resources.cpus ? String(s.resources.cpus) : ''} placeholder="unlimited" onCommit={(v) => void patch(id, { resources: { cpus: v ? Number(v) : null } })} />
          </Field>
          <Field label="Memory (MB)">
            <CommitInput mono value={s.resources.memoryMb ? String(s.resources.memoryMb) : ''} placeholder="unlimited" onCommit={(v) => void patch(id, { resources: { memoryMb: v ? Number(v) : null } })} />
          </Field>
        </div>
      </Section>

      <Section title="Server" icon="server" desc="The machine this service runs on.">
        <ServiceServer service={s} />
        <ServiceProject service={s} />
      </Section>

      <Section title="Volumes" icon="database" desc="Persistent storage that survives deploys and can move between services. A service with a volume runs as one replica.">
        <ServiceVolumes service={s} />
      </Section>

      <Section title="Published ports" icon="network" desc="Open container ports straight on the server — TCP or UDP — for game servers, voice chat and anything the router doesn’t handle. One replica; anyone who can reach the server can reach these.">
        <PublishedPorts service={s} />
      </Section>
      </>
      )}

      <Section title="Danger zone" icon="alert">
        <div className="setting-row">
          <div className="grow">
            <div className="title">{s.stopped ? 'Start service' : 'Stop service'}</div>
            <div className="desc">{s.stopped ? 'Bring replicas back online with the last deployment.' : 'Remove all replicas but keep configuration, images and volumes.'}</div>
          </div>
          {s.stopped ? (
            <Button icon="play" onClick={() => void start(s)}>
              Start
            </Button>
          ) : (
            <Button icon="stop" onClick={() => void stop(s)}>
              Stop
            </Button>
          )}
        </div>
        <div className="setting-row">
          <div className="grow">
            <div className="title">Delete service</div>
            <div className="desc">Permanently remove the service, its images{s.volumes.length ? ' and volume data' : ''}.</div>
          </div>
          <Button variant="danger" icon="trash" onClick={() => void remove(s)}>
            Delete
          </Button>
        </div>
      </Section>
    </div>
  );
}
