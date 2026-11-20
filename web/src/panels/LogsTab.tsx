import { useEffect, useMemo, useRef, useState } from 'react';
import type { ServiceView, LogLine } from '../lib/types.ts';
import { sse } from '../lib/api.ts';
import { LogView, type ViewLine } from '../components/LogView.tsx';
import { Icon } from '../components/Icon.tsx';
import { Tooltip } from '../components/ui.tsx';
import { useStore } from '../lib/store.ts';

const HUES = [78, 160, 30, 220, 330, 270, 190, 0];

export function LogsTab({ service: s }: { service: ServiceView }) {
  const [lines, setLines] = useState<(LogLine & { key: number })[]>([]);
  const [query, setQuery] = useState('');
  const [replica, setReplica] = useState<number | null>(null);
  const [showTs, setShowTs] = useState(true);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const buffer = useRef<(LogLine & { key: number })[]>([]);
  const k = useRef(0);
  const replicas = useStore((st) => st.current?.replicas[s.id] ?? []);

  useEffect(() => {
    setLines([]);
    k.current = 0;
    const stop = sse(
      `/services/${s.id}/logs/stream?tail=400`,
      {
        backlog: (arr: LogLine[]) => setLines(arr.map((l) => ({ ...l, key: k.current++ }))),
        lines: (arr: LogLine[]) => {
          const mapped = arr.map((l) => ({ ...l, key: k.current++ }));
          if (pausedRef.current) {
            buffer.current.push(...mapped);
            return;
          }
          setLines((prev) => [...prev, ...mapped].slice(-4000));
        },
      },
      () => setConnected(true),
    );
    return () => {
      stop();
      setConnected(false);
    };
  }, [s.id]);

  useEffect(() => {
    if (!paused && buffer.current.length) {
      const b = buffer.current;
      buffer.current = [];
      setLines((prev) => [...prev, ...b].slice(-4000));
    }
  }, [paused]);

  const indices = useMemo(() => [...new Set([...replicas.map((r) => r.index), ...lines.map((l) => l.replica)])].sort((a, b) => a - b), [replicas, lines]);
  const view: ViewLine[] = useMemo(() => {
    const q = query.toLowerCase();
    return lines
      .filter((l) => (replica === null || l.replica === replica) && (!q || l.text.toLowerCase().includes(q)))
      .map((l) => ({ key: l.key, ts: l.ts, text: l.text, err: l.stream === 'stderr' && /error|fatal|panic|exception/i.test(l.text), tag: indices.length > 1 ? `#${l.replica}` : undefined, tagHue: HUES[l.replica % HUES.length] }));
  }, [lines, query, replica, indices.length]);

  return (
    <div className="logs-tab">
      <div className="logs-toolbar">
        <div className="logs-search">
          <Icon name="search" size={14} />
          <input placeholder="Filter logs…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && (
            <span className="faint mono" style={{ fontSize: 11 }}>
              {view.length}
            </span>
          )}
        </div>
        {indices.length > 1 && (
          <div className="replica-filter">
            <button className={replica === null ? 'on' : ''} onClick={() => setReplica(null)}>
              All
            </button>
            {indices.map((i) => (
              <button key={i} className={replica === i ? 'on' : ''} onClick={() => setReplica(replica === i ? null : i)} style={{ ['--h' as any]: HUES[i % HUES.length] }}>
                <span className="rf-dot" />#{i}
              </button>
            ))}
          </div>
        )}
        <div className="spacer" />
        <Tooltip label={showTs ? 'Hide timestamps' : 'Show timestamps'}>
          <button className={`btn btn-ghost btn-sm btn-icon ${showTs ? 'active' : ''}`} onClick={() => setShowTs(!showTs)} aria-label="Timestamps">
            <Icon name="clock" size={14} />
          </button>
        </Tooltip>
        <Tooltip label={paused ? `Resume${buffer.current.length ? ` (${buffer.current.length} new)` : ''}` : 'Pause stream'}>
          <button className={`btn btn-ghost btn-sm btn-icon ${paused ? 'active' : ''}`} onClick={() => setPaused(!paused)} aria-label="Pause">
            <Icon name={paused ? 'play' : 'pause'} size={14} />
          </button>
        </Tooltip>
        <Tooltip label="Clear">
          <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setLines([])} aria-label="Clear">
            <Icon name="trash" size={14} />
          </button>
        </Tooltip>
        <span className={`live-pill ${connected && !paused ? 'on' : ''}`}>{paused ? 'PAUSED' : connected ? 'LIVE' : '…'}</span>
      </div>
      <LogView lines={view} showTs={showTs} highlight={query} live={!paused} emptyText={s.activeDeploymentId ? 'No output yet. Logs from all replicas stream here.' : 'Deploy the service to see runtime logs.'} className="runtime-log" />
    </div>
  );
}
