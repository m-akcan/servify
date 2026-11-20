import { useEffect, useState } from 'react';
import type { ServiceView, BackupRecord } from '../lib/types.ts';
import { api } from '../lib/api.ts';
import { Button, Switch, Stepper, Badge, Empty, confirmDialog, toast, toastError, Tooltip } from '../components/ui.tsx';
import { Icon } from '../components/Icon.tsx';
import { describeCron, timeAgo, duration } from '../lib/format.ts';
import { navigate } from '../lib/router.ts';

type Destination = { id: string; name: string; type: 'local' | 's3'; bucket?: string; path?: string };

const PRESETS = [
  { label: 'Daily 03:00', value: '0 3 * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Hourly', value: '0 * * * *' },
  { label: 'Weekly', value: '0 3 * * 0' },
];

const METHOD: Record<string, { title: string; body: string }> = {
  pg_dumpall: { title: 'PostgreSQL dump', body: 'A consistent pg_dumpall of every database, taken while Postgres keeps serving.' },
  mysqldump: { title: 'MySQL dump', body: 'A single-transaction mysqldump of all databases, routines and triggers.' },
  mongodump: { title: 'MongoDB dump', body: 'A mongodump archive of every database.' },
  volume: { title: 'Volume archive', body: 'A compressed archive of every volume attached to this service.' },
};

export function formatSize(n: number | null) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function BackupsTab({ service: s }: { service: ServiceView }) {
  const [list, setList] = useState<BackupRecord[]>([]);
  const [dests, setDests] = useState<Destination[]>([]);
  const [busy, setBusy] = useState(false);
  const cfg = s.backup ?? { enabled: false, schedule: '0 3 * * *', retention: 7, destinationId: 'local' };
  const [draft, setDraft] = useState(cfg);
  const [custom, setCustom] = useState(!PRESETS.some((p) => p.value === cfg.schedule));
  const dirty = JSON.stringify(draft) !== JSON.stringify(cfg);

  const load = () => api.get<BackupRecord[]>(`/services/${s.id}/backups`).then(setList).catch(() => {});
  useEffect(() => {
    void load();
    api.get<{ backups: { destinations: Destination[] } }>('/settings').then((r) => setDests(r.backups.destinations)).catch(() => {});
  }, [s.id]);
  // Poll while something is in flight (backups run in the background).
  const running = list.some((b) => b.status === 'running') || s.restoring;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [running, s.id]);
  useEffect(() => {
    if (!s.restoring) void load();
  }, [s.restoring]);

  if (!s.backupMethod) {
    return (
      <div className="tab-pad">
        <Empty icon="database" title="Nothing to back up" body="This service has no volumes and isn't a database Servify knows how to dump. Add a volume in Settings to keep data across deploys." />
      </div>
    );
  }
  const m = METHOD[s.backupMethod];

  const save = async () => {
    try {
      await api.patch(`/services/${s.id}`, { backup: draft });
      toast({ title: draft.enabled ? 'Backup schedule saved' : 'Scheduled backups off', tone: 'ok' });
    } catch (e) {
      toastError(e, 'Could not save');
    }
  };

  const now = async () => {
    setBusy(true);
    try {
      const b = await api.post<BackupRecord>(`/services/${s.id}/backups`, { destinationId: draft.destinationId });
      if (b.status === 'failed') toastError(new Error(b.error ?? 'unknown error'), 'Backup failed');
      else toast({ title: `Backed up ${s.name}`, body: `${formatSize(b.sizeBytes)} on ${b.destinationName}`, tone: 'ok' });
    } catch (e) {
      toastError(e, 'Backup failed');
    } finally {
      setBusy(false);
      void load();
    }
  };

  const restore = async (b: BackupRecord) => {
    const ok = await confirmDialog({
      title: `Restore ${s.name}?`,
      body: (
        <>
          The current data is replaced by the backup from <b>{new Date(b.createdAt).toLocaleString()}</b>. Servify takes a safety backup first, then restarts {s.name}; expect a short interruption.
        </>
      ),
      confirm: 'Restore',
      danger: true,
      typeToConfirm: s.name,
    });
    if (!ok) return;
    try {
      await api.post(`/backups/${b.id}/restore`);
      toast({ title: 'Restore started', body: 'Follow progress in the activity feed.', tone: 'build' });
    } catch (e) {
      toastError(e, 'Could not restore');
    }
  };

  const remove = async (b: BackupRecord) => {
    if (!(await confirmDialog({ title: 'Delete this backup?', body: `The file on ${b.destinationName} is deleted too. This can't be undone.`, confirm: 'Delete', danger: true }))) return;
    try {
      await api.del(`/backups/${b.id}`);
      void load();
    } catch (e) {
      toastError(e, 'Could not delete');
    }
  };

  return (
    <div className="tab-pad col" style={{ gap: 16 }}>
      <section className="card backup-hero">
        <div className="backup-hero-icon">
          <Icon name={s.backupMethod === 'volume' ? 'archive' : 'database'} size={18} />
        </div>
        <div className="grow">
          <div className="h3">{m.title}</div>
          <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
            {m.body} Restores take a safety backup first.
          </div>
        </div>
        <Button variant="primary" size="sm" icon="download" loading={busy} disabled={s.restoring || !s.activeDeploymentId} onClick={() => void now()}>
          Back up now
        </Button>
      </section>

      {s.restoring && (
        <div className="callout callout-build">
          <span className="spinner" style={{ width: 12, height: 12 }} />
          Restoring {s.name}… the service restarts with the backup's data.
        </div>
      )}

      <section className="card settings-card">
        <div className="setting-row">
          <div className="grow">
            <div className="section-title">Scheduled backups</div>
            <div className="section-desc">{draft.enabled ? describeCron(draft.schedule) : 'Off — only manual backups'}</div>
          </div>
          <Switch checked={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} label="Scheduled backups" />
        </div>
        {draft.enabled && (
          <div className="col rise-in" style={{ gap: 14, marginTop: 14 }}>
            <div className="chip-row">
              {PRESETS.map((p) => (
                <button
                  key={p.value}
                  className={`chip ${!custom && draft.schedule === p.value ? 'chip-on' : ''}`}
                  onClick={() => {
                    setCustom(false);
                    setDraft({ ...draft, schedule: p.value });
                  }}
                >
                  {p.label}
                </button>
              ))}
              <button className={`chip ${custom ? 'chip-on' : ''}`} onClick={() => setCustom(true)}>
                Custom
              </button>
            </div>
            {custom && <input className="input mono" value={draft.schedule} onChange={(e) => setDraft({ ...draft, schedule: e.target.value })} placeholder="0 3 * * *" aria-label="Cron expression" />}
            <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
              <label className="field" style={{ flex: '1 1 180px' }}>
                <span className="label">Store on</span>
                <select className="select" value={draft.destinationId} onChange={(e) => setDraft({ ...draft, destinationId: e.target.value })}>
                  {dests.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                      {d.type === 's3' ? ` (s3://${d.bucket})` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <div className="field">
                <span className="label">Keep last</span>
                <Stepper value={draft.retention} min={1} max={365} onChange={(v) => setDraft({ ...draft, retention: v })} />
              </div>
            </div>
          </div>
        )}
        <div className="row" style={{ marginTop: 14, gap: 8 }}>
          <button className="link" style={{ fontSize: 12 }} onClick={() => navigate('/settings/backups')}>
            Add an S3 destination
          </button>
          <div className="spacer" />
          <Button size="sm" variant={dirty ? 'primary' : 'secondary'} disabled={!dirty} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </section>

      <section className="card">
        <div className="chart-head" style={{ padding: '12px 14px 4px' }}>
          <span className="h3">History</span>
          <span className="faint mono" style={{ fontSize: 11 }}>
            {list.filter((b) => b.status === 'succeeded').length} stored
          </span>
        </div>
        {list.length === 0 ? (
          <div style={{ padding: 14 }}>
            <Empty icon="archive" title="No backups yet" body="Back up now, or turn on a schedule." />
          </div>
        ) : (
          <div className="backup-list">
            {list.map((b) => (
              <div className={`backup-row ${b.status}`} key={b.id}>
                <Badge tone={b.status === 'succeeded' ? 'ok' : b.status === 'failed' ? 'err' : 'build'} live={b.status === 'running'}>
                  {b.status === 'running' ? 'Running' : b.status === 'failed' ? 'Failed' : (b.trigger as string) === 'pre-restore' ? 'Safety' : b.trigger === 'schedule' ? 'Scheduled' : 'Manual'}
                </Badge>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <span>{new Date(b.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
                    {b.restoredAt && <span className="badge" data-tone="signal">restored {timeAgo(b.restoredAt)}</span>}
                  </div>
                  <div className="faint mono truncate" style={{ fontSize: 11, marginTop: 2 }}>
                    {b.status === 'failed' ? b.error : `${formatSize(b.sizeBytes)} · ${b.destinationName} · ${duration((b.finishedAt ?? Date.now()) - b.startedAt)} · by ${b.actor}`}
                  </div>
                </div>
                {b.status === 'succeeded' && (
                  <div className="row" style={{ gap: 2 }}>
                    <Tooltip label="Download">
                      <a className="btn btn-ghost btn-sm btn-icon" href={`/api/backups/${b.id}/download`} aria-label="Download">
                        <Icon name="download" size={14} />
                      </a>
                    </Tooltip>
                    <Button size="sm" variant="ghost" icon="history" disabled={s.restoring} onClick={() => void restore(b)}>
                      Restore
                    </Button>
                  </div>
                )}
                {b.status !== 'running' && (
                  <Tooltip label="Delete">
                    <button className="btn btn-ghost btn-sm btn-icon" onClick={() => void remove(b)} aria-label="Delete backup">
                      <Icon name="trash" size={14} />
                    </button>
                  </Tooltip>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
