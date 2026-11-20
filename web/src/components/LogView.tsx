import { useEffect, useLayoutEffect, useRef, useState, memo } from 'react';
import { Icon } from './Icon.tsx';
import { clock } from '../lib/format.ts';

export type ViewLine = { key: number; ts: number; text: string; tag?: string; tagHue?: number; err?: boolean };

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function classify(text: string): string {
  if (/^(✓|✔)/.test(text)) return 'ok';
  if (/^(✗|✘|error|ERROR|Error:|fatal|FATAL|panic)/.test(text) || /\b(ERR|ERROR|FATAL)\b/.test(text)) return 'err';
  if (/^(!|warn|WARN)/.test(text) || /\bWARN(ING)?\b/.test(text)) return 'warn';
  if (/^▸/.test(text)) return 'step';
  if (/^\s*│/.test(text)) return 'dim';
  if (/^#\d+ /.test(text)) return 'build';
  return '';
}

const Line = memo(function Line({ l, showTs, highlight }: { l: ViewLine; showTs: boolean; highlight: string }) {
  const text = l.text.replace(ANSI, '');
  const cls = l.err ? 'err' : classify(text);
  let content: React.ReactNode = text || ' ';
  if (highlight) {
    const i = text.toLowerCase().indexOf(highlight.toLowerCase());
    if (i >= 0)
      content = (
        <>
          {text.slice(0, i)}
          <mark>{text.slice(i, i + highlight.length)}</mark>
          {text.slice(i + highlight.length)}
        </>
      );
  }
  return (
    <div className={`log-line ${cls}`}>
      {showTs && <span className="log-ts">{clock(l.ts)}</span>}
      {l.tag && (
        <span className="log-tag" style={{ ['--h' as any]: l.tagHue ?? 0 }}>
          {l.tag}
        </span>
      )}
      <span className="log-text">{content}</span>
    </div>
  );
});

export function LogView({ lines, showTs = true, highlight = '', emptyText = 'Waiting for output…', live = false, className = '' }: { lines: ViewLine[]; showTs?: boolean; highlight?: string; emptyText?: string; live?: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const stickRef = useRef(true);

  useLayoutEffect(() => {
    if (stickRef.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);

  useEffect(() => {
    const el = ref.current!;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      stickRef.current = atBottom;
      setStick(atBottom);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className={`logview ${className}`}>
      <div className="logview-scroll no-canvas-wheel" ref={ref}>
        {lines.length === 0 ? (
          <div className="log-empty">
            {live && <span className="log-cursor" />}
            {emptyText}
          </div>
        ) : (
          lines.map((l) => <Line key={l.key} l={l} showTs={showTs} highlight={highlight} />)
        )}
        {live && lines.length > 0 && <div className="log-line"><span className="log-cursor" /></div>}
      </div>
      {!stick && (
        <button
          className="log-jump"
          onClick={() => {
            stickRef.current = true;
            setStick(true);
            ref.current!.scrollTo({ top: ref.current!.scrollHeight, behavior: 'smooth' });
          }}
        >
          <Icon name="chevronDown" size={14} /> Latest
        </button>
      )}
    </div>
  );
}
