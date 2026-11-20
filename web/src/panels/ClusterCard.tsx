import { useState } from 'react';
import type { ServiceView } from '../lib/types.ts';
import { api } from '../lib/api.ts';
import { Button, Badge, Switch, Stepper, confirmDialog, toast, toastError, Tooltip } from '../components/ui.tsx';
import { Icon } from '../components/Icon.tsx';
import { bytes } from '../lib/volumes.tsx';
import { timeAgo } from '../lib/format.ts';

const ROLE_TONE = { primary: 'signal', standby: 'ok', starting: 'build', down: 'err', fenced: 'warn', rebuilding: 'build' } as const;
const ROLE_LABEL = { primary: 'Primary', standby: 'Standby', starting: 'Starting', down: 'Down', fenced: 'Fenced', rebuilding: 'Rebuilding' } as const;

/** Primary + standbys, replication lag, failover settings and actions for a database cluster. */
export function ClusterCard({ service: s }: { service: ServiceView }) {
  const c = s.clusterStatus;
  const [busy, setBusy] = useState<string | null>(null);
  if (!c) return null;
  const standbys = c.members.filter((m) => m.role === 'standby');
  const streaming = standbys.filter((m) => m.syncState && m.syncState !== 'not streaming').length;

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast({ title: ok, tone: 'ok' });
    } catch (e) {
      toastError(e, 'Cluster action failed');
    } finally {
      setBusy(null);
    }
  };
  const makePrimary = async (index: number) => {
    const yes = await confirmDialog({
      title: `Make #${index} the primary?`,
      body: `Writes pause for a few seconds while #${c.primary} hands over. #${c.primary} is then rebuilt as a standby from #${index}.`,
      confirm: 'Switch primary',
    });
    if (yes) await run(`sw${index}`, () => api.post(`/services/${s.id}/cluster/switchover`, { to: index }), `#${index} is now the primary`);
  };
  const rebuild = async (index: number) => {
    const yes = await confirmDialog({ title: `Rebuild #${index}?`, body: `Its data is wiped and copied fresh from the primary (#${c.primary}). Use this if a standby stopped streaming.`, confirm: 'Rebuild', danger: true });
    if (yes) await run(`rb${index}`, () => api.post(`/services/${s.id}/cluster/rebuild`, { index }), `Rebuilding #${index}`);
  };
  const patch = (cluster: Record<string, unknown>) => run('cfg', () => api.patch(`/services/${s.id}`, { cluster }), 'Saved');

  return (
    <section className="card cluster-card">
      <div className="scale-head">
        <div className="grow">
          <div className="h3">PostgreSQL cluster</div>
          <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
            Writes go to the primary (<span className="mono">{s.slug}</span>), reads can use the standbys (<span className="mono">{s.slug}-read</span>).
            {c.lastFailoverAt ? ` Last failover ${timeAgo(c.lastFailoverAt)}.` : ''}
          </div>
        </div>
        {c.operation ? (
          <Badge tone="build" live>
            {c.operation}…
          </Badge>
        ) : c.degradedAsync ? (
          <Tooltip label="No standby is streaming: commits are not waiting for a copy">
            <span>
              <Badge tone="warn">async</Badge>
            </span>
          </Tooltip>
        ) : (
          <Badge tone={streaming === standbys.length && standbys.length > 0 ? 'ok' : 'warn'}>
            {streaming}/{Math.max(0, c.members.length - 1)} streaming
          </Badge>
        )}
      </div>
      <div className="cluster-members">
        {c.members.map((m) => (
          <div key={m.index} className={`cluster-member ${m.role}`}>
            <span className="cm-index mono">#{m.index}</span>
            <Badge tone={ROLE_TONE[m.role]} live={m.role === 'starting' || m.role === 'rebuilding'}>
              {ROLE_LABEL[m.role]}
            </Badge>
            <span className="grow faint mono cm-meta">
              {m.role === 'primary'
                ? `${m.streaming ?? 0} standby${m.streaming === 1 ? '' : 's'} attached`
                : m.role === 'standby'
                  ? `${m.syncState === 'quorum' || m.syncState === 'sync' ? 'synchronous' : m.syncState ?? 'async'} · lag ${m.lagBytes == null ? '—' : bytes(m.lagBytes)}`
                  : m.role === 'fenced'
                    ? 'kept out of service'
                    : ''}
            </span>
            {m.role === 'standby' && (
              <div className="row" style={{ gap: 2 }}>
                <Button size="sm" variant="ghost" icon="arrowUpRight" loading={busy === `sw${m.index}`} disabled={!!c.operation || !!busy} onClick={() => void makePrimary(m.index)}>
                  Make primary
                </Button>
                <Tooltip label="Wipe and re-clone from the primary">
                  <button className="btn btn-ghost btn-sm btn-icon" disabled={!!c.operation || !!busy} onClick={() => void rebuild(m.index)} aria-label={`Rebuild #${m.index}`}>
                    <Icon name="refresh" size={14} />
                  </button>
                </Tooltip>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="cluster-settings">
        <div className="setting-row">
          <div className="grow">
            <div className="title">Automatic failover</div>
            <div className="desc">{c.failoverAfterSec ? `Promote a standby when the primary is unreachable for ${c.failoverAfterSec}s.` : 'Off — use “Make primary” yourself.'}</div>
          </div>
          {c.failoverAfterSec > 0 && <Stepper value={c.failoverAfterSec} min={5} max={300} onChange={(v) => void patch({ failoverAfterSec: v })} />}
          <Switch checked={c.failoverAfterSec > 0} onChange={(v) => void patch({ failoverAfterSec: v ? 15 : 0 })} />
        </div>
        <div className="setting-row">
          <div className="grow">
            <div className="title">Synchronous replication</div>
            <div className="desc">Each commit waits for a standby, so a failover loses nothing. Falls back to async if no standby is streaming.</div>
          </div>
          <Switch checked={c.synchronous} onChange={(v) => void patch({ synchronous: v })} />
        </div>
      </div>
    </section>
  );
}
