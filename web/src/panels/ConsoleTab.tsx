import { useEffect, useRef, useState } from 'react';
import type { ServiceView } from '../lib/types.ts';
import { api } from '../lib/api.ts';
import { useStore } from '../lib/store.ts';
import { Icon } from '../components/Icon.tsx';

type Entry = { id: number; cmd: string; replica: number | null; output?: string; exit?: number; running: boolean; ms?: number };

/** Run one-off commands inside a replica (migrations, diagnostics) — the same capability agents get. */
export function ConsoleTab({ service: s }: { service: ServiceView }) {
  const replicas = useStore((st) => (st.current?.replicas[s.id] ?? []).filter((r) => r.deploymentId === s.activeDeploymentId && r.dockerState === 'running'));
  const [replica, setReplica] = useState<number | null>(null);
  const [cmd, setCmd] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [hist, setHist] = useState<string[]>([]);
  const [hi, setHi] = useState(-1);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Focus after the panel finishes sliding in.
    const t = setTimeout(() => inputRef.current?.focus(), 350);
    return () => clearTimeout(t);
  }, []);
  const nextId = useRef(1);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [entries]);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    const command = cmd.trim();
    if (!command) return;
    const id = nextId.current++;
    setEntries((x) => [...x, { id, cmd: command, replica, running: true }]);
    setHist((h) => [command, ...h.filter((c) => c !== command)].slice(0, 50));
    setHi(-1);
    setCmd('');
    const t0 = performance.now();
    try {
      const r = await api.post<{ exitCode: number; output: string }>(`/services/${s.id}/exec`, { command, replica: replica ?? undefined });
      setEntries((x) => x.map((en) => (en.id === id ? { ...en, running: false, output: r.output, exit: r.exitCode, ms: performance.now() - t0 } : en)));
    } catch (err) {
      setEntries((x) => x.map((en) => (en.id === id ? { ...en, running: false, output: (err as Error).message, exit: -1 } : en)));
    }
  };

  if (!replicas.length) {
    return <div className="tab-pad faint" style={{ fontSize: 12 }}>No running replica to run commands in.</div>;
  }

  return (
    <div className="console">
      <div className="console-bar">
        <span className="label">Run in</span>
        <div className="replica-filter">
          <button className={replica === null ? 'on' : ''} onClick={() => setReplica(null)}>
            any
          </button>
          {replicas.map((r) => (
            <button key={r.containerId} className={replica === r.index ? 'on' : ''} onClick={() => setReplica(r.index)}>
              #{r.index}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={() => setEntries([])}>
          Clear
        </button>
      </div>
      <div className="console-out no-canvas-wheel" ref={scroller}>
        {entries.length === 0 && (
          <div className="faint console-hint">
            Commands run with <code className="inline-code">/bin/sh -c</code> inside the replica. Try <code className="inline-code">env | sort</code> or <code className="inline-code">ls -la</code>.
          </div>
        )}
        {entries.map((en) => (
          <div key={en.id} className="console-entry">
            <div className="console-cmd mono">
              <span className="console-prompt">{s.slug}{en.replica !== null ? `#${en.replica}` : ''} $</span> {en.cmd}
              {en.running && <span className="spinner" style={{ marginLeft: 8, width: 11, height: 11 }} />}
              {!en.running && (
                <span className={`console-exit ${en.exit === 0 ? 'ok' : 'err'}`}>
                  {en.exit === 0 ? '✓' : `exit ${en.exit}`}
                  {en.ms != null && ` · ${Math.round(en.ms)}ms`}
                </span>
              )}
            </div>
            {en.output && <pre className="console-output mono">{en.output}</pre>}
          </div>
        ))}
      </div>
      <form className="console-input" onSubmit={run}>
        <Icon name="chevronRight" size={14} />
        <input
          ref={inputRef}
          className="mono"
          value={cmd}
          spellCheck={false}
          placeholder="Type a command and press Enter"
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' && hist.length) {
              e.preventDefault();
              const n = Math.min(hist.length - 1, hi + 1);
              setHi(n);
              setCmd(hist[n]);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              const n = hi - 1;
              setHi(n);
              setCmd(n >= 0 ? hist[n] : '');
            }
          }}
        />
      </form>
    </div>
  );
}
