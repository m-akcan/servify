import { useEffect, useRef, useState } from 'react';
import type { ServiceView } from '../lib/types.ts';
import { api } from '../lib/api.ts';
import { Button, Switch, Empty, CopyButton, Segmented, Kbd } from '../components/ui.tsx';
import { Icon } from '../components/Icon.tsx';
import { bytes } from '../lib/volumes.tsx';

type Info = { kind: 'postgres' | 'mysql'; databases: string[]; current: string | null };
type Table = { schema: string | null; name: string; kind: string; rows: number | null; bytes: number | null };
type Page = { columns: string[]; types: Record<string, string>; rows: (string | null)[][]; total: number | null; totalAtLeast: number | null; limit: number; offset: number };
type Result = { columns: string[]; rows: (string | null)[][]; truncated: boolean; message: string | null; ms: number };

const PAGE = 100;
const keyOf = (t: Table) => `${t.schema ?? ''}.${t.name}`;
const fmt = (n: number) => n.toLocaleString();

function Grid({ columns, rows, types, sort, onSort, onCell }: { columns: string[]; rows: (string | null)[][]; types?: Record<string, string>; sort?: { col: string; dir: 'asc' | 'desc' } | null; onSort?: (col: string) => void; onCell: (v: string | null, col: string) => void }) {
  if (!columns.length) return null;
  return (
    <div className="db-grid-wrap">
      <table className="db-grid">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} onClick={onSort ? () => onSort(c) : undefined} className={onSort ? 'sortable' : undefined} title={types?.[c]}>
                <span>{c}</span>
                {sort?.col === c && <Icon name={sort.dir === 'asc' ? 'chevronUp' : 'chevronDown'} size={11} />}
                {types?.[c] && <span className="db-type">{types[c]}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((v, j) => (
                <td key={j} className={v === null ? 'null' : undefined} onClick={() => onCell(v, columns[j])}>
                  {v === null ? 'NULL' : v.length > 120 ? `${v.slice(0, 120)}…` : v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Browse and query the service's own PostgreSQL or MySQL database. */
export function DataTab({ service: s }: { service: ServiceView }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [db, setDb] = useState<string | null>(null);
  const [tables, setTables] = useState<Table[] | null>(null);
  const [table, setTable] = useState<string | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<{ col: string; dir: 'asc' | 'desc' } | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'browse' | 'query'>('browse');
  const [sql, setSql] = useState('');
  const [write, setWrite] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [cell, setCell] = useState<{ col: string; value: string | null } | null>(null);
  const sqlRef = useRef<HTMLTextAreaElement>(null);
  const running_ = s.status === 'running' || s.status === 'degraded';

  useEffect(() => {
    if (!running_) return;
    api
      .get<Info>(`/services/${s.id}/db`)
      .then((i) => {
        setInfo(i);
        setDb(i.current ?? i.databases[0] ?? null);
      })
      .catch((e) => setError((e as Error).message));
  }, [s.id, running_]);

  useEffect(() => {
    if (!info) return;
    setTables(null);
    setTable(null);
    setPage(null);
    api
      .get<Table[]>(`/services/${s.id}/db/tables?db=${encodeURIComponent(db ?? '')}`)
      .then((t) => {
        setTables(t);
        if (t.length) setTable(keyOf(t[0]));
      })
      .catch((e) => setError((e as Error).message));
  }, [info, db]);

  const current = tables?.find((t) => keyOf(t) === table) ?? null;
  const loadPage = () => {
    if (!current) return;
    setLoading(true);
    const qs = new URLSearchParams({ db: db ?? '', schema: current.schema ?? '', table: current.name, limit: String(PAGE), offset: String(offset), ...(sort ? { order: sort.col, dir: sort.dir } : {}) });
    api
      .get<Page>(`/services/${s.id}/db/rows?${qs}`)
      .then((p) => {
        setPage(p);
        setError(null);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  };
  useEffect(loadPage, [table, offset, sort]);

  const pick = (key: string) => {
    setTable(key);
    setOffset(0);
    setSort(null);
    setCell(null);
  };
  const run = async () => {
    if (!sql.trim() || running) return;
    setRunning(true);
    setQueryError(null);
    setCell(null);
    try {
      setResult(await api.post<Result>(`/services/${s.id}/db/query`, { sql, db, write }));
      if (write) api.get<Table[]>(`/services/${s.id}/db/tables?db=${encodeURIComponent(db ?? '')}`).then(setTables).catch(() => {});
    } catch (e) {
      setResult(null);
      setQueryError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  if (!running_) return <Empty icon="database" title="The database isn’t running" body="Start or deploy it to browse its data." />;
  if (error && !info) return <Empty icon="database" title="Can’t open the database" body={error} />;
  if (!info) return <div className="db-loading faint">Connecting…</div>;

  const total = page?.total ?? null;
  const shownTo = page ? page.offset + page.rows.length : 0;
  return (
    <div className="db-browser">
      <div className="db-bar">
        <select className="select" value={db ?? ''} onChange={(e) => setDb(e.target.value)} aria-label="Database">
          {info.databases.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <Segmented
          size="sm"
          value={mode}
          onChange={(m) => {
            setMode(m);
            if (m === 'query') setTimeout(() => sqlRef.current?.focus(), 50);
          }}
          options={[
            { value: 'browse', label: 'Tables' },
            { value: 'query', label: 'Query' },
          ]}
        />
      </div>

      {mode === 'browse' ? (
        <>
          {tables && tables.length === 0 ? (
            <Empty icon="database" title="No tables yet" body={`${db} is empty.`} />
          ) : (
            <div className="db-bar">
              <select className="select grow" value={table ?? ''} onChange={(e) => pick(e.target.value)} aria-label="Table" disabled={!tables}>
                {(tables ?? []).map((t) => (
                  <option key={keyOf(t)} value={keyOf(t)}>
                    {t.schema && t.schema !== 'public' ? `${t.schema}.` : ''}
                    {t.name}
                    {t.kind !== 'table' ? ` (${t.kind})` : ''}
                    {t.rows != null ? ` · ~${fmt(t.rows)} rows` : ''}
                    {t.bytes ? ` · ${bytes(t.bytes)}` : ''}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="ghost" icon="refresh" iconOnly loading={loading} onClick={loadPage} aria-label="Reload" />
            </div>
          )}
          {error && info && <div className="db-error">{error}</div>}
          {page && (
            <>
              <Grid
                columns={page.columns}
                rows={page.rows}
                types={page.types}
                sort={sort}
                onSort={(col) => {
                  setOffset(0);
                  setSort((cur) => (cur?.col === col ? (cur.dir === 'asc' ? { col, dir: 'desc' } : null) : { col, dir: 'asc' }));
                }}
                onCell={(value, col) => setCell({ col, value })}
              />
              <div className="db-foot faint">
                <span>
                  {page.rows.length ? `${fmt(page.offset + 1)}–${fmt(shownTo)}` : 'No rows'}
                  {total != null ? ` of ${fmt(total)}` : page.totalAtLeast ? ` of ${fmt(page.totalAtLeast)}+` : ''}
                </span>
                <span className="spacer" />
                <Button size="sm" variant="ghost" icon="chevronLeft" iconOnly disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} aria-label="Previous page" />
                <Button size="sm" variant="ghost" icon="chevronRight" iconOnly disabled={total != null ? shownTo >= total : page.rows.length < PAGE} onClick={() => setOffset(offset + PAGE)} aria-label="Next page" />
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <textarea
            ref={sqlRef}
            className="input mono db-sql"
            rows={5}
            spellCheck={false}
            placeholder={info.kind === 'postgres' ? 'SELECT * FROM users ORDER BY created_at DESC LIMIT 20' : 'SELECT * FROM users LIMIT 20'}
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void run();
              }
            }}
          />
          <div className="db-bar">
            <label className="row faint" style={{ gap: 8, fontSize: 12 }}>
              <Switch checked={write} onChange={setWrite} label="Allow writes" />
              <span className={write ? 'db-write-on' : undefined}>{write ? 'Writes allowed' : 'Read-only'}</span>
            </label>
            <span className="spacer" />
            <span className="faint" style={{ fontSize: 11 }}>
              <Kbd>⌘</Kbd> <Kbd>↵</Kbd>
            </span>
            <Button size="sm" variant={write ? 'danger' : 'primary'} icon="play" loading={running} disabled={!sql.trim()} onClick={() => void run()}>
              Run
            </Button>
          </div>
          {queryError && <div className="db-error">{queryError}</div>}
          {result && (
            <>
              {result.message ? (
                <div className="db-message">
                  <Icon name="check" size={13} /> {result.message}
                </div>
              ) : (
                <Grid columns={result.columns} rows={result.rows} onCell={(value, col) => setCell({ col, value })} />
              )}
              <div className="db-foot faint">
                <span>
                  {result.message ? '' : `${fmt(result.rows.length)} row${result.rows.length === 1 ? '' : 's'}${result.truncated ? ' (first 1,000)' : ''} · `}
                  {result.ms} ms
                </span>
              </div>
            </>
          )}
        </>
      )}

      {cell && (
        <div className="db-cell">
          <div className="row" style={{ gap: 6 }}>
            <b className="mono">{cell.col}</b>
            <span className="spacer" />
            {cell.value !== null && <CopyButton text={cell.value} />}
            <Button size="sm" variant="ghost" icon="x" iconOnly onClick={() => setCell(null)} aria-label="Close" />
          </div>
          <pre className="mono">{cell.value === null ? 'NULL' : cell.value}</pre>
        </div>
      )}
    </div>
  );
}
