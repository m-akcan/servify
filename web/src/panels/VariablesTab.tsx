import { useEffect, useMemo, useRef, useState } from 'react';
import type { ServiceView } from '../lib/types.ts';
import { api } from '../lib/api.ts';
import { Button, Segmented, Tooltip, toast, toastError, CopyButton } from '../components/ui.tsx';
import { Icon } from '../components/Icon.tsx';
import { useStore } from '../lib/store.ts';

type Row = { id: number; key: string; value: string; secret: boolean };

function toRows(s: ServiceView): Row[] {
  return Object.entries(s.env).map(([key, value], i) => ({ id: i, key, value, secret: s.secretKeys.includes(key) }));
}

function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function toDotenv(rows: Row[]) {
  return rows
    .filter((r) => r.key)
    .map((r) => `${r.key}=${/[\s#"']/.test(r.value) ? JSON.stringify(r.value) : r.value}`)
    .join('\n');
}

/** Value input with ${{ service.VAR }} autocompletion. */
function RefInput({ value, onChange, secret, revealed, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; secret: boolean; revealed: boolean; placeholder?: string; autoFocus?: boolean }) {
  const current = useStore((s) => s.current);
  const ref = useRef<HTMLInputElement>(null);
  const [sugg, setSugg] = useState<{ items: { label: string; insert: string; hint: string }[]; active: number } | null>(null);

  const compute = (v: string, caret: number) => {
    const before = v.slice(0, caret);
    const m = before.match(/\$\{\{\s*([A-Za-z0-9_-]*)(?:\.([A-Za-z0-9_]*))?$/);
    if (!m || !current) return setSugg(null);
    const services = Object.values(current.services);
    let items: { label: string; insert: string; hint: string }[];
    if (m[2] === undefined) {
      items = services
        .filter((s) => s.slug.startsWith(m[1]) || s.name.toLowerCase().startsWith(m[1].toLowerCase()))
        .map((s) => ({ label: s.slug, insert: `${s.slug}.`, hint: `${Object.keys(s.env).length} vars` }));
    } else {
      const svc = services.find((s) => s.slug === m[1] || s.name === m[1]);
      const keys = svc ? [...Object.keys(svc.env), 'SERVIFY_PRIVATE_DOMAIN', 'PORT', 'SERVIFY_PUBLIC_URL'] : [];
      items = [...new Set(keys)].filter((k) => k.startsWith(m[2]!.toUpperCase()) || k.startsWith(m[2]!)).map((k) => ({ label: k, insert: `${k} }}`, hint: svc?.slug ?? '' }));
    }
    setSugg(items.length ? { items: items.slice(0, 8), active: 0 } : null);
  };

  const apply = (insert: string) => {
    const el = ref.current!;
    const caret = el.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const m = before.match(/\$\{\{\s*([A-Za-z0-9_-]*)(?:\.([A-Za-z0-9_]*))?$/)!;
    const start = caret - (m[2] !== undefined ? m[2].length : m[1].length);
    const next = value.slice(0, start) + insert + value.slice(caret);
    onChange(next);
    requestAnimationFrame(() => {
      const pos = start + insert.length;
      el.setSelectionRange(pos, pos);
      compute(next, pos);
    });
  };

  return (
    <div className="ref-input">
      <input
        ref={ref}
        className="input mono"
        type={secret && !revealed ? 'password' : 'text'}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        spellCheck={false}
        onChange={(e) => {
          onChange(e.target.value);
          compute(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onBlur={() => setTimeout(() => setSugg(null), 120)}
        onKeyDown={(e) => {
          if (!sugg) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setSugg({ ...sugg, active: (sugg.active + (e.key === 'ArrowDown' ? 1 : -1) + sugg.items.length) % sugg.items.length });
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            apply(sugg.items[sugg.active].insert);
          } else if (e.key === 'Escape') setSugg(null);
        }}
      />
      {sugg && (
        <div className="ref-sugg">
          {sugg.items.map((it, i) => (
            <button key={it.label} type="button" className={i === sugg.active ? 'on' : ''} onMouseDown={(e) => (e.preventDefault(), apply(it.insert))}>
              <Icon name={it.insert.endsWith('.') ? 'box' : 'braces'} size={12} />
              <span className="mono">{it.label}</span>
              <span className="faint" style={{ marginLeft: 'auto', fontSize: 11 }}>
                {it.hint}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function VariablesTab({ service: s }: { service: ServiceView }) {
  const [rows, setRows] = useState<Row[]>(() => toRows(s));
  const [mode, setMode] = useState<'table' | 'raw'>('table');
  const [raw, setRaw] = useState(() => toDotenv(toRows(s)));
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [resolved, setResolved] = useState<Record<string, string>>({});
  const [newRow, setNewRow] = useState({ key: '', value: '' });
  const nextId = useRef(1000);

  const serverKey = JSON.stringify([s.env, s.secretKeys]);
  const dirty = useMemo(() => {
    const local = mode === 'raw' ? parseDotenv(raw) : Object.fromEntries(rows.filter((r) => r.key).map((r) => [r.key, r.value]));
    const secretsLocal = rows.filter((r) => r.secret).map((r) => r.key).sort();
    return JSON.stringify(local) !== JSON.stringify(s.env) || (mode === 'table' && JSON.stringify(secretsLocal) !== JSON.stringify([...s.secretKeys].sort()));
  }, [rows, raw, mode, serverKey]);

  // Adopt server changes when we have no local edits.
  useEffect(() => {
    if (!dirty) {
      setRows(toRows(s));
      setRaw(toDotenv(toRows(s)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey]);

  useEffect(() => {
    api
      .get<{ env: Record<string, string> }>(`/services/${s.id}/variables/resolved`)
      .then((r) => setResolved(r.env))
      .catch(() => {});
  }, [s.id, serverKey]);

  const save = async () => {
    setSaving(true);
    try {
      let variables: Record<string, string>;
      let secretKeys: string[];
      if (mode === 'raw') {
        variables = parseDotenv(raw);
        secretKeys = s.secretKeys.filter((k) => k in variables).concat(Object.keys(variables).filter((k) => !(k in s.env) && /SECRET|PASSWORD|TOKEN|KEY/i.test(k)));
      } else {
        const valid = rows.filter((r) => r.key.trim());
        variables = Object.fromEntries(valid.map((r) => [r.key.trim(), r.value]));
        secretKeys = valid.filter((r) => r.secret).map((r) => r.key.trim());
      }
      await api.put(`/services/${s.id}/variables`, { variables, replace: true, secretKeys });
      toast({ title: 'Variables saved', body: s.activeDeploymentId ? 'Deploy to apply them to running replicas.' : undefined, tone: 'ok' });
    } catch (e) {
      toastError(e, 'Could not save variables');
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setRows(toRows(s));
    setRaw(toDotenv(toRows(s)));
  };

  const addRow = () => {
    const key = newRow.key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!key) return;
    setRows((r) => [...r.filter((x) => x.key !== key), { id: nextId.current++, key, value: newRow.value, secret: /SECRET|PASSWORD|TOKEN|KEY/i.test(key) }]);
    setNewRow({ key: '', value: '' });
  };

  const switchMode = (m: 'table' | 'raw') => {
    if (m === 'raw') setRaw(toDotenv(rows));
    else {
      const parsed = parseDotenv(raw);
      setRows(Object.entries(parsed).map(([key, value], i) => ({ id: nextId.current + i, key, value, secret: s.secretKeys.includes(key) || /SECRET|PASSWORD|TOKEN|KEY/i.test(key) })));
      nextId.current += 100;
    }
    setMode(m);
  };

  return (
    <div className="tab-pad col" style={{ gap: 14 }}>
      <div className="row">
        <div className="grow">
          <div className="h3">Environment variables</div>
          <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
            Reference other services with <code className="inline-code">{'${{ postgres.DATABASE_URL }}'}</code>
          </div>
        </div>
        <Segmented
          value={mode}
          onChange={switchMode}
          options={[
            { value: 'table', label: 'Table' },
            { value: 'raw', label: '.env' },
          ]}
        />
      </div>

      {mode === 'table' ? (
        <>
          <form
            className="var-add"
            onSubmit={(e) => {
              e.preventDefault();
              addRow();
            }}
          >
            <input className="input mono" placeholder="KEY" value={newRow.key} onChange={(e) => setNewRow({ ...newRow, key: e.target.value })} style={{ textTransform: 'uppercase' }} spellCheck={false} />
            <RefInput value={newRow.value} onChange={(v) => setNewRow({ ...newRow, value: v })} secret={false} revealed placeholder="value or ${{ service.VAR }}" />
            <Button type="submit" icon="plus" disabled={!newRow.key.trim()}>
              Add
            </Button>
          </form>
          <div className="var-list">
            {rows.length === 0 && <div className="faint" style={{ fontSize: 12, padding: 12, textAlign: 'center' }}>No variables yet.</div>}
            {rows.map((r) => {
              const isRef = /\$\{\{/.test(r.value);
              const shown = revealed.has(r.key);
              return (
                <div key={r.id} className="var-row">
                  <div className="var-key mono truncate" title={r.key}>
                    {r.secret && <Icon name="lock" size={11} />}
                    {r.key}
                  </div>
                  <div className="var-val">
                    <RefInput value={r.value} onChange={(v) => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, value: v } : x)))} secret={r.secret} revealed={shown} />
                    {isRef && resolved[r.key] !== undefined && (
                      <div className="var-resolved mono truncate" title={resolved[r.key]}>
                        <Icon name="arrowRight" size={10} /> {r.secret && !shown ? '•'.repeat(Math.min(24, resolved[r.key].length || 8)) : resolved[r.key] || '(empty)'}
                      </div>
                    )}
                  </div>
                  <div className="var-actions">
                    {r.secret && (
                      <Tooltip label={shown ? 'Hide' : 'Reveal'}>
                        <button
                          className="btn btn-ghost btn-sm btn-icon"
                          onClick={() =>
                            setRevealed((set) => {
                              const n = new Set(set);
                              if (n.has(r.key)) n.delete(r.key);
                              else n.add(r.key);
                              return n;
                            })
                          }
                        >
                          <Icon name={shown ? 'eyeOff' : 'eye'} size={14} />
                        </button>
                      </Tooltip>
                    )}
                    <Tooltip label={r.secret ? 'Mark as plain' : 'Mark as secret'}>
                      <button className={`btn btn-ghost btn-sm btn-icon ${r.secret ? 'active' : ''}`} onClick={() => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, secret: !x.secret } : x)))}>
                        <Icon name="lock" size={14} />
                      </button>
                    </Tooltip>
                    <CopyButton text={resolved[r.key] ?? r.value} />
                    <Tooltip label="Remove">
                      <button className="btn btn-ghost btn-sm btn-icon var-del" onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}>
                        <Icon name="trash" size={14} />
                      </button>
                    </Tooltip>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <textarea className="textarea mono raw-env no-canvas-wheel" value={raw} onChange={(e) => setRaw(e.target.value)} spellCheck={false} placeholder={'KEY=value\nOTHER=${{ redis.REDIS_URL }}'} />
      )}

      <div className="builtin-vars">
        <div className="label" style={{ marginBottom: 6 }}>
          Injected automatically
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {['PORT', 'SERVIFY_PRIVATE_DOMAIN', 'SERVIFY_PUBLIC_URL', 'SERVIFY_REPLICA_INDEX', 'SERVIFY_DEPLOYMENT_ID'].map((k) => (
            <span key={k} className="chip mono" style={{ fontSize: 11 }}>
              {k}
            </span>
          ))}
        </div>
      </div>

      <div className={`save-bar ${dirty ? 'show' : ''}`}>
        <Icon name="edit" size={14} />
        <span className="grow">Unsaved variable changes</span>
        <Button size="sm" variant="ghost" onClick={discard}>
          Discard
        </Button>
        <Button size="sm" variant="primary" loading={saving} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}
