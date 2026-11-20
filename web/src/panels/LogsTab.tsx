import { useEffect, useMemo, useRef, useState } from 'react';
import type { ServiceView, LogLine } from '../lib/types.ts';
import { sse, api } from '../lib/api.ts';
import { LogView, type ViewLine } from '../components/LogView.tsx';
import { Icon } from '../components/Icon.tsx';
import { Tooltip } from '../components/ui.tsx';
import { useStore, deploymentsFor } from '../lib/store.ts';
import { timeAgo } from '../lib/format.ts';
import { toastError } from '../components/ui.tsx';

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
  const current = useStore((st) => st.current);
  const deps = deploymentsFor(current, s.id).filter((d) => d.startedAt);
  /** null = live stream; otherwise a frozen view loaded from history. */
  const [history, setHistory] = useState<{ label: string } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const liveLines = useRef<(LogLine & { key: number })[]>([]);

  const loadHistory = async (params: Record<string, string>, label: string) => {
    try {
      const qs = new URLSearchParams({ tail: '2000', ...params }).toString();
      const arr = await api.get<LogLine[]>(`/services/${s.id}/logs?${qs}`);
      if (!history) liveLines.current = lines;
      setHistory({ label });
      setPaused(true);
      setLines(arr.map((l) => ({ ...l, key: k.current++ })));
    } catch (e) {
      toastError(e, 'Could not load logs');
    }
  };
  const backToLive = () => {
    setHistory(null);
    setLines(liveLines.current);
    setPaused(false);
  };
  const loadOlder = async () => {
    const oldest = lines[0]?.ts;
    setLoadingOlder(true);
    try {
      const arr = await api.get<LogLine[]>(`/services/${s.id}/logs?tail=500${oldest ? `&until=${oldest - 1}` : ''}`);
      if (!arr.length) return toastError(new Error('That is everything kept for this service (7 days).'), 'No earlier logs');
      setLines((prev) => [...arr.map((l) => ({ ...l, key: k.current++ })), ...prev]);
    } catch (e) {
      toastError(e, 'Could not load logs');
    } finally {
      setLoadingOlder(false);
    }
  };

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
      { pauseWhenHidden: true },
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
        {deps.length > 0 && (
          <select
            className="select logs-dep-select"
            value=""
            onChange={(e) => {
              const d = deps.find((x) => x.id === e.target.value);
              if (d) void loadHistory({ deployment: d.id }, `deployment ${d.id.slice(-6)} · ${timeAgo(d.createdAt)}`);
            }}
            aria-label="Show logs of a deployment"
          >
            <option value="">Deployment…</option>
            {deps.slice(0, 20).map((d) => (
              <option key={d.id} value={d.id}>
                {d.id === s.activeDeploymentId ? '● ' : ''}
                {d.id.slice(-6)} · {d.status} · {timeAgo(d.createdAt)}
              </option>
            ))}
          </select>
        )}
        <Tooltip label="Load earlier lines">
          <button className="btn btn-ghost btn-sm btn-icon" onClick={() => void loadOlder()} aria-label="Load earlier" disabled={loadingOlder}>
            <Icon name="history" size={14} />
          </button>
        </Tooltip>
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
        <Tooltip label="Download visible logs">
          <button
            className="btn btn-ghost btn-sm btn-icon"
            aria-label="Download"
            onClick={() => {
              const text = view.map((l) => `${new Date(l.ts).toISOString()} ${l.tag ?? ''} ${l.text}`.replace(/  +/g, ' ')).join('\n');
              const a = document.createElement('a');
              a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
              a.download = `${s.slug}-${new Date().toISOString().slice(0, 19)}.log`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            }}
          >
            <Icon name="download" size={14} />
          </button>
        </Tooltip>
        <Tooltip label="Clear">
          <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setLines([])} aria-label="Clear">
            <Icon name="trash" size={14} />
          </button>
        </Tooltip>
        {history ? (
          <button className="live-pill history" onClick={backToLive}>
            BACK TO LIVE
          </button>
        ) : (
          <span className={`live-pill ${connected && !paused ? 'on' : ''}`}>{paused ? 'PAUSED' : connected ? 'LIVE' : '…'}</span>
        )}
      </div>
      {(history || (query.length > 1 && !history)) && (
        <div className="logs-history-bar">
          {history ? (
            <>
              <Icon name="history" size={13} />
              <span className="grow">
                Showing <b>{history.label}</b> from the log history
              </span>
              <button className="link" onClick={backToLive}>
                Back to live
              </button>
            </>
          ) : (
            <>
              <Icon name="search" size={13} />
              <span className="grow">Filtering what's loaded.</span>
              <button className="link" onClick={() => void loadHistory({ search: query }, `“${query}” across 7 days`)}>
                Search the last 7 days
              </button>
            </>
          )}
        </div>
      )}
      <LogView lines={view} showTs={showTs} highlight={query} live={!paused} emptyText={s.activeDeploymentId ? 'No output yet. Logs from all replicas stream here.' : 'Deploy the service to see runtime logs.'} className="runtime-log" />
    </div>
  );
}
