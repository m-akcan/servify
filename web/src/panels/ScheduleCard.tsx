import { useEffect, useState } from 'react';
import type { ServiceView, JobRun } from '../lib/types.ts';
import { api } from '../lib/api.ts';
import { onServerEvent } from '../lib/store.ts';
import { Badge, Button, toastError } from '../components/ui.tsx';
import { Icon } from '../components/Icon.tsx';
import { describeCron, duration, timeAgo } from '../lib/format.ts';

function countdown(ts: number) {
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return new Date(ts).toLocaleString();
}

/** Overview card for cron services: schedule, countdown, run now, run history. */
export function ScheduleCard({ service: s }: { service: ServiceView }) {
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    let alive = true;
    api.get<JobRun[]>(`/services/${s.id}/runs?limit=20`).then((r) => alive && setRuns(r)).catch(() => {});
    const off = onServerEvent((ev) => {
      if (ev.type !== 'job.run' || ev.run.serviceId !== s.id) return;
      setRuns((prev) => [ev.run, ...prev.filter((r) => r.id !== ev.run.id)].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20));
    });
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      alive = false;
      off();
      clearInterval(i);
    };
  }, [s.id]);
  const runningNow = runs.some((r) => r.status === 'running');

  return (
    <section className="card scale-card">
      <div className="scale-head">
        <div className="sched-icon">
          <Icon name="clock" size={18} />
        </div>
        <div className="grow">
          <div className="h3">{describeCron(s.schedule ?? '')}</div>
          <div className="faint mono" style={{ fontSize: 11, marginTop: 2 }}>
            {s.schedule}
            {s.nextRunAt && !runningNow ? ` · next ${countdown(s.nextRunAt)}` : ''}
            {!s.activeDeploymentId ? ' · deploy to arm the schedule' : ''}
          </div>
        </div>
        <Button
          variant="primary"
          size="sm"
          icon="play"
          loading={starting || runningNow}
          disabled={!s.activeDeploymentId}
          onClick={async () => {
            setStarting(true);
            try {
              await api.post(`/services/${s.id}/run`);
            } catch (e) {
              toastError(e, 'Could not start run');
            } finally {
              setStarting(false);
            }
          }}
        >
          {runningNow ? 'Running' : 'Run now'}
        </Button>
      </div>
      <div className="replica-list">
        {runs.length === 0 && <div className="faint" style={{ fontSize: 12, padding: '10px 16px' }}>No runs yet.</div>}
        {runs.map((r) => (
          <div key={r.id} className="run-row-wrap">
            <button className="run-row" onClick={() => setOpen(open === r.id ? null : r.id)}>
              <Badge tone={r.status === 'succeeded' ? 'ok' : r.status === 'failed' ? 'err' : 'warn'} live={r.status === 'running'}>
                {r.status}
              </Badge>
              <span className="mono faint" style={{ fontSize: 11 }}>
                {r.exitCode != null ? `exit ${r.exitCode}` : ''}
              </span>
              <span className="grow" />
              <span className="actor-pill">
                <Icon name={r.trigger === 'schedule' ? 'clock' : r.trigger === 'agent' ? 'bot' : 'user'} size={10} />
                {r.trigger === 'schedule' ? 'schedule' : r.actor}
              </span>
              <span className="faint" style={{ fontSize: 11, minWidth: 110, textAlign: 'right' }}>
                {timeAgo(r.startedAt)} · {duration((r.finishedAt ?? Date.now()) - r.startedAt)}
              </span>
              <Icon name="chevronDown" size={13} className="deploy-chev" style={{ transform: open === r.id ? 'rotate(180deg)' : undefined }} />
            </button>
            {open === r.id && <pre className="run-output mono no-canvas-wheel">{r.output || (r.status === 'running' ? 'Running…' : '(no output)')}</pre>}
          </div>
        ))}
      </div>
    </section>
  );
}
