import { useEffect, useState } from 'react';
import type { ServiceView, PublicServer, VolumeRecord } from '../lib/types.ts';
import { api } from '../lib/api.ts';
import { Button, Modal, toast, toastError, confirmDialog } from '../components/ui.tsx';
import { Icon } from '../components/Icon.tsx';
import { bytes } from '../lib/volumes.tsx';
import { useStore } from '../lib/store.ts';

/** What the server says a move with data would take (GET /services/:id/move-plan). */
type MovePlan = {
  service: { id: string; name: string; stopped: boolean };
  from: { id: string; name: string; online: boolean };
  to: { id: string; name: string; online: boolean };
  volumes: { id: string; name: string; mountPath: string; members: number; sizeBytes: number | null }[];
  bytesTotal: number | null;
  targetFreeBytes: number | null;
  blockers: string[];
  warnings: string[];
};

const PHASE: Record<string, string> = {
  stopping: 'Stopping',
  copying: 'Copying data',
  starting: 'Starting on the new server',
  'rolling-back': 'Moving back',
};

/** "Move to <server>…" for a service with volumes: shows the plan (size, room, warnings, blockers), then starts it. */
export function MoveWithDataDialog({ service: s, target, onClose }: { service: ServiceView; target: PublicServer; onClose: () => void }) {
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .get<MovePlan>(`/services/${s.id}/move-plan?server=${encodeURIComponent(target.id)}`)
      .then(setPlan)
      .catch((e) => setError((e as Error).message));
  }, [s.id, target.id]);
  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(`/services/${s.id}/move`, { server: target.id, withData: true });
      toast({ title: `Moving ${s.name} to ${target.name}`, body: 'It is down while its data copies. Progress shows in its settings.', tone: 'build' });
      onClose();
    } catch (err) {
      toastError(err, 'Could not move the service');
    } finally {
      setBusy(false);
    }
  };
  const blocked = !!plan?.blockers.length;
  return (
    <Modal open onClose={onClose} width={540}>
      <form onSubmit={go} className="modal-body col" style={{ gap: 16 }}>
        <div>
          <h2 className="h2">
            Move {s.name} to {target.name}?
          </h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            {s.name} stops, its volumes are copied to {target.name}, and it starts there. If it doesn’t start healthy, it goes back to {s.server && s.server.id !== 'local' ? s.server.name : 'this machine'} on its untouched data. The old data stays where it is until you delete it.
          </p>
        </div>
        {error && (
          <div className="callout callout-warn">
            <Icon name="alert" size={14} />
            <span>{error}</span>
          </div>
        )}
        {!plan && !error && <div className="muted">Measuring the data…</div>}
        {plan && (
          <>
            <div className="move-plan">
              {plan.volumes.map((v) => (
                <div key={v.id} className="move-plan-row">
                  <Icon name="database" size={13} />
                  <span className="grow truncate mono">
                    {v.name}
                    {v.members > 1 ? ` ×${v.members}` : ''}
                  </span>
                  <span className="faint mono">{v.mountPath}</span>
                  <span className="mono">{bytes(v.sizeBytes)}</span>
                </div>
              ))}
              <div className="move-plan-row move-plan-total">
                <span className="grow">To copy</span>
                <span className="mono">{plan.bytesTotal == null ? 'unknown' : bytes(plan.bytesTotal)}</span>
              </div>
              <div className="move-plan-row">
                <span className="grow">Free on {plan.to.name}</span>
                <span className="mono">{plan.targetFreeBytes == null ? 'not reported' : bytes(plan.targetFreeBytes)}</span>
              </div>
            </div>
            {plan.blockers.map((b) => (
              <div key={b} className="callout callout-err">
                <Icon name="x" size={14} />
                <span>{b}</span>
              </div>
            ))}
            {plan.warnings.map((w) => (
              <div key={w} className="callout callout-warn">
                <Icon name="alert" size={14} />
                <span>{w}</span>
              </div>
            ))}
          </>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" onClick={onClose}>
            {blocked ? 'Close' : 'Cancel'}
          </Button>
          {!blocked && (
            <Button type="submit" variant="primary" icon="arrowRight" loading={busy} disabled={!plan}>
              Stop and move
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}

/** A move with data in progress, or how the last one ended; and the copy it left on the old server. */
export function MoveStatus({ service: s }: { service: ServiceView }) {
  const m = s.move;
  const copies = useStore((st) => Object.values(st.current?.volumes ?? {}).filter((v) => v.moveCopy?.serviceId === s.id && !v.moveCopy.keptAt && (!v.setId || v.setId === v.id)));
  return (
    <>
      {m && <MoveProgress service={s} />}
      {(!m || m.phase === 'done' || m.phase === 'failed') && copies.map((v) => <SourceCopyOffer key={v.id} volume={v} service={s} />)}
    </>
  );
}

function MoveProgress({ service: s }: { service: ServiceView }) {
  const m = s.move!;
  const running = !(m.phase === 'done' || m.phase === 'failed');
  const pct = m.bytesTotal ? Math.min(99, Math.round((m.bytesDone / m.bytesTotal) * 100)) : null;
  const dismiss = () => void api.del(`/services/${s.id}/move`).catch((e) => toastError(e, 'Could not dismiss'));
  if (!running) {
    return (
      <div className={`callout ${m.phase === 'done' ? 'callout-ok' : 'callout-warn'}`}>
        <Icon name={m.phase === 'done' ? 'check' : 'alert'} size={14} />
        <span className="grow">
          <b>{m.phase === 'done' ? `Moved to ${m.toName}` : `Move to ${m.toName} rolled back`}</b> · {m.message}
        </span>
        <Button size="sm" variant="ghost" icon="x" iconOnly aria-label="Dismiss" onClick={dismiss} />
      </div>
    );
  }
  return (
    <div className="callout callout-build move-progress">
      <Icon name="server" size={14} />
      <div className="grow col" style={{ gap: 6 }}>
        <div>
          <b>
            Moving to {m.toName} · {PHASE[m.phase] ?? m.phase}
          </b>
          {m.phase === 'copying' && (
            <span className="faint">
              {' '}
              · {bytes(m.bytesDone)}
              {m.bytesTotal != null ? ` of ${bytes(m.bytesTotal)}` : ''}
              {m.current ? ` · ${m.current}` : ''}
            </span>
          )}
        </div>
        <div className="ov-bar" style={{ ['--c' as any]: m.phase === 'rolling-back' ? 'var(--warn)' : 'var(--build)' }}>
          <i style={{ width: `${m.phase === 'starting' ? 100 : m.phase === 'stopping' ? 2 : (pct ?? 50)}%` }} />
        </div>
        <span className="faint" style={{ fontSize: 12 }}>
          {m.wasRunning ? `${s.name} is down until it starts on ${m.toName}. ` : ''}
          {m.phase === 'rolling-back' && m.error ? m.error : 'The data on the old server stays untouched until the move has finished.'}
        </span>
      </div>
    </div>
  );
}

function SourceCopyOffer({ volume: v, service: s }: { volume: VolumeRecord; service: ServiceView }) {
  const [busy, setBusy] = useState(false);
  // Deleting is offered only once the service has started healthy on the new server (the server checks the same).
  const live = useStore((st) => (s.activeDeploymentId ? st.current?.deployments[s.activeDeploymentId] : null));
  const proven = !!v.moveCopy!.provenAt || (!!live && live.status === 'active' && (live.nodeId ?? null) === v.moveCopy!.toNodeId && (s.nodeId ?? null) === v.moveCopy!.toNodeId);
  const discard = async () => {
    const yes = await confirmDialog({
      title: `Delete ${v.name}?`,
      body: `This is the data ${v.moveCopy!.serviceName} had before it moved (${bytes(v.sizeBytes)}). The service now runs on its copy, which is not affected. Deleting this one can’t be undone.`,
      confirm: 'Delete the old copy',
      danger: true,
    });
    if (!yes) return;
    setBusy(true);
    try {
      await api.post(`/volumes/${v.id}/discard-move-copy`, {});
      toast({ title: `Deleted ${v.name}`, tone: 'ok' });
    } catch (e) {
      toastError(e, 'Could not delete the copy');
    } finally {
      setBusy(false);
    }
  };
  const keep = () => void api.post(`/volumes/${v.id}/keep-move-copy`, {}).catch((e) => toastError(e, 'Could not keep the copy'));
  return (
    <div className="callout">
      <Icon name="archive" size={14} />
      <span className="grow">
        The data from before the move is still on the old server as <b className="mono">{v.name}</b> ({bytes(v.sizeBytes)}).{' '}
        {proven
          ? 'Once you’re happy with the move, delete it — or keep it a while as a safety copy (it stays on the canvas as a detached volume).'
          : `${s.name} hasn’t started on its new server yet, so this copy stays until it has.`}
      </span>
      <div className="row" style={{ gap: 6, flex: 'none' }}>
        <Button size="sm" variant="ghost" onClick={keep}>
          Keep
        </Button>
        {proven && (
          <Button size="sm" variant="danger" icon="trash" loading={busy} onClick={() => void discard()}>
            Delete
          </Button>
        )}
      </div>
    </div>
  );
}
