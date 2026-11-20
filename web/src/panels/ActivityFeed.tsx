import { useEffect, useState } from 'react';
import { useStore } from '../lib/store.ts';
import { Icon } from '../components/Icon.tsx';
import { usePresence } from '../motion/hooks.ts';
import { timeAgo } from '../lib/format.ts';
import { Segmented } from '../components/ui.tsx';
import type { ActivityEntry } from '../lib/types.ts';

const actionIcon = (a: string): any => {
  if (a.startsWith('deployment.failed')) return 'alert';
  if (a.startsWith('deployment.active')) return 'check';
  if (a.startsWith('deployment')) return 'rocket';
  if (a.includes('scale')) return 'layers';
  if (a.includes('variables')) return 'braces';
  if (a.includes('deleted')) return 'trash';
  if (a.includes('created')) return 'plus';
  if (a.includes('exec')) return 'terminal';
  if (a.includes('stopped')) return 'stop';
  if (a.includes('started')) return 'play';
  if (a.includes('crash')) return 'alert';
  if (a.includes('git')) return 'git';
  return 'dot';
};

const tone = (e: ActivityEntry) => (e.action.includes('failed') || e.action.includes('crash') ? 'err' : e.action.includes('active') ? 'ok' : e.actorType === 'agent' ? 'signal' : 'idle');

export function ActivityFeed({ open, onClose }: { open: boolean; onClose: () => void }) {
  const activity = useStore((s) => s.activity);
  const { mounted, state } = usePresence(open, 280);
  const [filter, setFilter] = useState<'all' | 'agent' | 'user' | 'system'>('all');
  const [, tick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const i = setInterval(() => tick((n) => n + 1), 10000);
    return () => clearInterval(i);
  }, [open]);
  if (!mounted) return null;
  const list = activity.filter((a) => filter === 'all' || a.actorType === filter);
  return (
    <div className="activity glass" data-state={state}>
      <div className="activity-head">
        <Icon name="activity" size={15} />
        <span className="h3 grow">Activity</span>
        <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="Close">
          <Icon name="x" size={15} />
        </button>
      </div>
      <div style={{ padding: '0 12px 10px' }}>
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'agent', label: 'Agents' },
            { value: 'user', label: 'You' },
            { value: 'system', label: 'System' },
          ]}
        />
      </div>
      <div className="activity-list no-canvas-wheel">
        {list.length === 0 && <div className="faint" style={{ padding: 20, textAlign: 'center', fontSize: 12 }}>Nothing yet.</div>}
        {list.map((e, i) => (
          <div key={e.id} className="act-row" style={{ animationDelay: `${Math.min(i, 12) * 18}ms` }}>
            <div className="act-icon" data-tone={tone(e)}>
              <Icon name={actionIcon(e.action)} size={12} />
            </div>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="act-summary">{e.summary}</div>
              <div className="act-meta">
                <span className={`actor-pill ${e.actorType}`}>
                  <Icon name={e.actorType === 'agent' ? 'bot' : e.actorType === 'system' ? 'zap' : 'user'} size={10} />
                  {e.actor}
                </span>
                <span>{timeAgo(e.ts)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
