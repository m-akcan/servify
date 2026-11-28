import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { bytes } from '../lib/volumes.tsx';
import { timeAgo } from '../lib/format.ts';
import { Button, Badge, Empty, Switch, confirmDialog, toast, toastError, dismissToast } from '../components/ui.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';

type Kind = 'container' | 'volume' | 'image' | 'network';
type Item = { key: string; kind: Kind; nodeId: string; ref: string; name: string; sizeBytes: number | null; createdAt: number | null; project: string | null; service: string | null; note: string; volumeId?: string };
type Machine = { nodeId: string; name: string; online: boolean; error: string | null; items: Item[]; totalBytes: number };
type Report = { scannedAt: number; machines: Machine[]; totalBytes: number };
type Result = { key: string; ok: boolean; name?: string; freedBytes?: number; error?: string; code?: string };

const ICON: Record<Kind, IconName> = { container: 'box', volume: 'database', image: 'layers', network: 'network' };
const PLURAL: Record<Kind, string> = { container: 'stopped containers', volume: 'volumes', image: 'images', network: 'networks' };

/** Settings → Reclaim space: Servify's leftovers on every server, deleted one by one or as a selection. */
export function ReclaimSpace() {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [backup, setBackup] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get<Report>('/reclaim');
      setReport(r);
      const keys = new Set(r.machines.flatMap((m) => m.items.map((i) => i.key)));
      setSelected((cur) => new Set([...cur].filter((k) => keys.has(k))));
    } catch (e) {
      toastError(e, 'Could not look for leftovers');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const all = report?.machines.flatMap((m) => m.items) ?? [];
  const picked = all.filter((i) => selected.has(i.key));
  const sum = (items: Item[]) => items.reduce((s, i) => s + (i.sizeBytes ?? 0), 0);
  const toggle = (key: string, on: boolean) => setSelected((cur) => {
    const next = new Set(cur);
    if (on) next.add(key);
    else next.delete(key);
    return next;
  });

  const remove = async (items: Item[]) => {
    if (!items.length) return;
    const kinds = (['container', 'volume', 'image', 'network'] as Kind[]).map((k) => [k, items.filter((i) => i.kind === k).length] as const).filter(([, n]) => n);
    const volumes = items.filter((i) => i.kind === 'volume');
    const single = items.length === 1 ? items[0] : null;
    const ok = await confirmDialog({
      title: single ? `Delete ${single.kind} ${single.name}?` : `Delete ${items.length} items?`,
      body: (
        <>
          <div>
            {kinds.map(([k, n]) => `${n} ${n === 1 ? k : PLURAL[k]}`).join(', ')} · about {bytes(sum(items))}.
          </div>
          {!single && (
            <ul className="mono" style={{ margin: '8px 0', paddingLeft: 18, fontSize: 12, maxHeight: 160, overflow: 'auto' }}>
              {items.slice(0, 12).map((i) => (
                <li key={i.key}>{i.name}</li>
              ))}
              {items.length > 12 && <li>…and {items.length - 12} more</li>}
            </ul>
          )}
          <div style={{ marginTop: 6 }}>
            {volumes.length ? `The data in ${volumes.length === 1 ? 'the volume' : `${volumes.length} volumes`} is deleted for good${!volumes.some((v) => v.volumeId) ? ' (Servify has no record of it, so no safety backup is taken)' : backup ? ' (volumes Servify still has a record of get a safety backup first, or a recent one is reused)' : ', without a safety backup'}. ` : ''}
            This can't be undone. Each item is checked again first; anything that's in use by then is left alone.
          </div>
        </>
      ),
      confirm: single ? 'Delete' : `Delete ${items.length}`,
      danger: true,
      ...(volumes.length ? { typeToConfirm: 'delete' } : {}),
    });
    if (!ok) return;
    setBusy(true);
    const pending = toast({ title: `Deleting ${items.length === 1 ? items[0].name : `${items.length} items`}…`, body: volumes.length && backup ? 'Making sure a recent backup of the volume data exists first.' : undefined, tone: 'build', duration: 600_000 });
    try {
      const run = (keys: string[], skip: boolean) => api.post<{ results: Result[]; freedBytes: number }>('/reclaim/delete', { keys, skipSafetyBackup: skip });
      let r = await run(items.map((i) => i.key), !backup);
      let results = r.results;
      let freed = r.freedBytes;
      const noBackup = results.filter((x) => !x.ok && x.code === 'safety_backup');
      if (noBackup.length) {
        dismissToast(pending);
        const anyway = await confirmDialog({
          title: `Delete ${noBackup.length === 1 ? noBackup[0].name : `${noBackup.length} volumes`} without a backup?`,
          body: `${noBackup[0].error?.replace(/^no safety backup: /, '').replace(/^./, (c) => c.toUpperCase())}. Nothing of ${noBackup.length === 1 ? 'it' : 'them'} was deleted yet. Deleting now loses the data for good.`,
          confirm: 'Delete without a backup',
          danger: true,
          typeToConfirm: 'delete',
        });
        if (anyway) {
          r = await run(noBackup.map((x) => x.key), true);
          results = [...results.filter((x) => !noBackup.includes(x)), ...r.results];
          freed += r.freedBytes;
        }
      }
      const done = results.filter((x) => x.ok).length;
      const failed = results.filter((x) => !x.ok);
      toast({
        title: done ? `Deleted ${done} item${done === 1 ? '' : 's'} · ${bytes(freed)} freed` : 'Nothing was deleted',
        body: failed.length ? failed.slice(0, 3).map((x) => `${x.name ?? x.key}: ${x.error}`).join('\n') + (failed.length > 3 ? `\n…and ${failed.length - 3} more` : '') : undefined,
        tone: failed.length ? 'warn' : 'ok',
        duration: failed.length ? 12_000 : undefined,
      });
    } catch (e) {
      toastError(e, 'Could not delete');
    } finally {
      dismissToast(pending);
      setBusy(false);
      void load();
    }
  };

  const machinesWithItems = report?.machines.filter((m) => m.items.length).length ?? 0;
  return (
    <>
      <section className="card s-card rise-in">
        <div className="s-card-head">
          <div className="s-card-icon">
            <Icon name="layers" size={17} />
          </div>
          <div className="grow">
            <div className="h3">Reclaim space</div>
            <div className="s-card-desc">
              What Servify created and nothing uses any more: volumes kept when their service or project was deleted, built images and stopped containers of deleted services, networks of deleted projects. Only this Servify's own leftovers are listed — never anything a service still uses (stopped ones included), volumes taken over from the host, volumes you detached on purpose, backups, the images kept for rollbacks, or images pulled from a registry.
            </div>
          </div>
          <Button size="sm" variant="ghost" icon="refresh" loading={loading} onClick={() => void load()}>
            Refresh
          </Button>
        </div>
        {report && (
          <div className="s-card-body">
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <div className="grow">
                <div className="h2 mono">{bytes(report.totalBytes)}</div>
                <div className="faint" style={{ fontSize: 12.5 }}>
                  reclaimable · {all.length} item{all.length === 1 ? '' : 's'}
                  {machinesWithItems > 1 ? ` on ${machinesWithItems} servers` : ''} · checked {timeAgo(report.scannedAt)}
                </div>
              </div>
              {all.some((i) => i.volumeId) && <Switch checked={backup} onChange={setBackup} label="Safety backup of volume data first" />}
              <Button variant="danger" size="sm" icon="trash" disabled={!picked.length || busy} loading={busy} onClick={() => void remove(picked)}>
                Delete selected{picked.length ? ` (${picked.length} · ${bytes(sum(picked))})` : ''}
              </Button>
            </div>
            <p className="faint" style={{ marginTop: 8, fontSize: 12 }}>
              Image sizes include layers other images may share, so the space freed can be smaller. Leftovers younger than two minutes are not shown yet.
            </p>
          </div>
        )}
      </section>

      {report?.machines.map((m) => {
        const allOn = m.items.length > 0 && m.items.every((i) => selected.has(i.key));
        return (
          <section className="card s-card rise-in" key={m.nodeId}>
            <div className="s-card-head">
              <div className="s-card-icon">
                <Icon name="server" size={17} />
              </div>
              <div className="grow">
                <div className="h3">{m.nodeId === 'local' ? 'This machine' : m.name}</div>
                <div className="s-card-desc">{!m.online ? 'Offline — not checked' : m.error ? `Could not check: ${m.error}` : m.items.length ? `${bytes(m.totalBytes)} in ${m.items.length} item${m.items.length === 1 ? '' : 's'}` : 'Nothing to reclaim'}</div>
              </div>
              {m.items.length > 1 && (
                <label className="row faint" style={{ gap: 6, fontSize: 12.5, cursor: 'pointer' }}>
                  <input type="checkbox" style={{ accentColor: 'var(--signal)' }} checked={allOn} onChange={(e) => setSelected((cur) => {
                    const next = new Set(cur);
                    for (const i of m.items) e.target.checked ? next.add(i.key) : next.delete(i.key);
                    return next;
                  })} />
                  Select all
                </label>
              )}
            </div>
            {m.online && !m.error && (
              <div className="s-card-body">
                {m.items.length === 0 ? (
                  <Empty icon="check" title="All clean" body="Nothing Servify created here is left over." />
                ) : (
                  <div className="token-list">
                    {m.items.map((i) => {
                      const from = [i.project && `project ${i.project}`, i.service && `service ${i.service}`].filter(Boolean).join(' · ');
                      return (
                        <label className="token-row" key={i.key} style={{ cursor: 'pointer' }}>
                          <input type="checkbox" style={{ accentColor: 'var(--signal)' }} checked={selected.has(i.key)} onChange={(e) => toggle(i.key, e.target.checked)} aria-label={`Select ${i.name}`} />
                          <div className="token-icon">
                            <Icon name={ICON[i.kind]} size={15} />
                          </div>
                          <div className="grow" style={{ minWidth: 0 }}>
                            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                              <b className="mono truncate" style={{ fontSize: 13 }}>{i.name}</b>
                              <Badge tone="idle">{i.kind}</Badge>
                            </div>
                            <div className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>
                              {i.note}
                              {from ? ` · ${from}` : ''}
                              {i.createdAt ? ` · created ${timeAgo(i.createdAt)}` : ''}
                            </div>
                          </div>
                          <span className="mono" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>{i.kind === 'network' ? '' : bytes(i.sizeBytes)}</span>
                          <Button
                            size="sm"
                            variant="ghost"
                            icon="trash"
                            disabled={busy}
                            onClick={(e) => {
                              e.preventDefault();
                              void remove([i]);
                            }}
                          >
                            Delete
                          </Button>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}
