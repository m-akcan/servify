/**
 * Database browser: list databases and tables, page through rows and run SQL in a service's own database
 * container, with the client that ships in the image (psql / mysql / mariadb) and the credentials from its
 * environment — nothing to install, no port to open. SQL travels as an environment variable, never through a
 * shell string. Queries are read-only unless the caller asks for writes; output is capped.
 */
import { deployments as deploymentsTable } from './db.ts';
import { dockerForContainer } from './nodes.ts';
import { replicasOf } from './engine.ts';
import { getServiceOrThrow } from './ops.ts';
import { HttpError } from './util.ts';
import type { DatabaseKind, Service } from './types.ts';

export type Result = { columns: string[]; rows: (string | null)[][]; truncated: boolean; message: string | null; ms: number };
type Kind = Extract<DatabaseKind, 'postgres' | 'mysql'>;

const NULL = '__svf_null_7f3a__';
const MAX_ROWS = 1000;
const PAGE_MAX = 500;

const PG = `psql -X -v ON_ERROR_STOP=1 --csv -P null=${NULL} -U "\${POSTGRES_USER:-postgres}" -d "\${SVF_DB:-\${POSTGRES_DB:-\${POSTGRES_USER:-postgres}}}" -c "$SVF_SQL"`;
// Root when its password is known, otherwise the app user the image created.
const MY = [
  'if [ -n "${MYSQL_ROOT_PASSWORD:-${MARIADB_ROOT_PASSWORD:-}}" ]; then U=root; export MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}";',
  'else U="${MYSQL_USER:-${MARIADB_USER:-root}}"; export MYSQL_PWD="${MYSQL_PASSWORD:-${MARIADB_PASSWORD:-}}"; fi;',
  'D="${SVF_DB:-${MYSQL_DATABASE:-${MARIADB_DATABASE:-}}}";',
  '"$(command -v mysql || command -v mariadb)" -u"$U" --batch --default-character-set=utf8mb4 ${D:+-D "$D"} -e "$SVF_SQL"',
].join(' ');

function target(svc: Service): { kind: Kind; containerId: string } {
  const dep = svc.activeDeploymentId ? deploymentsTable.get(svc.activeDeploymentId) : null;
  const kind = dep?.database ?? (svc.templateId === 'postgres' ? 'postgres' : svc.templateId === 'mysql' ? 'mysql' : null);
  if (kind !== 'postgres' && kind !== 'mysql') throw new HttpError(400, kind === 'mongo' ? 'MongoDB isn’t supported by the browser yet' : `${svc.name} isn’t a PostgreSQL or MySQL database`);
  const reps = replicasOf(svc.id).filter((r) => r.dockerState === 'running' && r.deploymentId === svc.activeDeploymentId).sort((a, b) => a.index - b.index);
  if (!reps.length) throw new HttpError(409, `${svc.name} isn’t running`);
  return { kind, containerId: reps[0].containerId };
}

/** RFC 4180, as psql writes it; an unquoted NULL marker is a SQL NULL. */
function parseCsv(text: string, complete: boolean): (string | null)[][] {
  const rows: (string | null)[][] = [];
  let row: (string | null)[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  let i = 0;
  const end = () => {
    row.push(!wasQuoted && field === NULL ? null : field);
    field = '';
    wasQuoted = false;
  };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = wasQuoted = true;
    else if (c === ',') end();
    else if (c === '\n' || (c === '\r' && text[i + 1] === '\n')) {
      if (c === '\r') i++;
      end();
      rows.push(row);
      row = [];
    } else field += c;
    i++;
  }
  if (complete && (field || row.length)) {
    end();
    rows.push(row);
  }
  return rows;
}

/** mysql --batch: tab-separated, backslash escapes, NULL spelled out. */
function parseBatch(text: string, complete: boolean): (string | null)[][] {
  const lines = text.split('\n');
  if (!complete || lines[lines.length - 1] === '') lines.pop();
  const unescape = (v: string) => (v === 'NULL' ? null : v.replace(/\\(.)/g, (_, ch) => ({ n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\' })[ch as string] ?? ch));
  return lines.map((l) => l.split('\t').map(unescape));
}

async function run(svc: Service, sql: string, opts: { db?: string | null; write?: boolean; timeoutMs?: number } = {}): Promise<Result> {
  const t = target(svc);
  const started = Date.now();
  const env: Record<string, string> = { SVF_SQL: t.kind === 'mysql' && !opts.write ? `SET SESSION TRANSACTION READ ONLY; ${sql}` : sql };
  if (opts.db) env.SVF_DB = opts.db;
  if (t.kind === 'postgres') env.PGOPTIONS = `-c statement_timeout=${opts.timeoutMs ?? 30_000}${opts.write ? '' : ' -c default_transaction_read_only=on'}`;
  const r = await dockerForContainer(t.containerId)
    .execCapture(t.containerId, ['/bin/sh', '-c', t.kind === 'postgres' ? PG : MY], { env, timeoutMs: (opts.timeoutMs ?? 30_000) + 15_000 })
    .catch((e) => {
      throw new HttpError(504, `the query ${(e as Error).message}`);
    });
  if (r.exitCode !== 0) {
    const msg = r.stderr.replace(/^psql:[^:]*:\d+: /gm, '').replace(/^ERROR \d+ \([^)]*\)( at line \d+)?: /m, '').trim();
    throw new HttpError(400, msg || `the client exited with ${r.exitCode}`);
  }
  const all = t.kind === 'postgres' ? parseCsv(r.stdout, !r.truncated) : parseBatch(r.stdout, !r.truncated);
  const ms = Date.now() - started;
  // psql prints command tags (UPDATE 3) for statements without rows; mysql prints nothing.
  const tag = /^[A-Z][A-Z ]*( \d+)*$/;
  if (!all.length || (t.kind === 'postgres' && all.every((row) => row.length === 1 && tag.test(row[0] ?? '')))) {
    return { columns: [], rows: [], truncated: false, message: all.map((row) => row[0]).join(' · ') || 'Done', ms };
  }
  const [columns, ...rows] = all;
  return { columns: columns.map((c) => c ?? ''), rows: rows.slice(0, MAX_ROWS), truncated: r.truncated || rows.length > MAX_ROWS, message: null, ms };
}

const pgIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const myIdent = (s: string) => `\`${s.replace(/`/g, '``')}\``;
const pgLit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export async function databases(serviceId: string) {
  const svc = getServiceOrThrow(serviceId);
  const { kind } = target(svc);
  if (kind === 'postgres') {
    const r = await run(svc, 'SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname', { db: 'postgres' });
    const current = (await run(svc, 'SELECT current_database()')).rows[0]?.[0] ?? 'postgres';
    const names = r.rows.map((x) => x[0]!);
    return { kind, databases: [current, ...names.filter((n) => n !== current)], current };
  }
  const r = await run(svc, 'SHOW DATABASES');
  const cur = await run(svc, 'SELECT DATABASE()');
  const system = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);
  const dbs = r.rows.map((x) => x[0]!).filter((d) => !system.has(d));
  return { kind, databases: dbs, current: cur.rows[0]?.[0] ?? dbs[0] ?? null };
}

export type Table = { schema: string | null; name: string; kind: string; rows: number | null; bytes: number | null };

export async function tables(serviceId: string, db: string | null): Promise<Table[]> {
  const svc = getServiceOrThrow(serviceId);
  const { kind } = target(svc);
  if (kind === 'postgres') {
    const r = await run(
      svc,
      `SELECT n.nspname, c.relname, c.relkind, c.reltuples::bigint, pg_total_relation_size(c.oid)
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
       ORDER BY n.nspname <> 'public', n.nspname, c.relname`,
      { db },
    );
    const kinds: Record<string, string> = { r: 'table', p: 'table', v: 'view', m: 'materialized view', f: 'foreign table' };
    return r.rows.map(([schema, name, k, rows, bytes]) => ({ schema, name: name!, kind: kinds[k!] ?? 'table', rows: rows && Number(rows) >= 0 ? Number(rows) : null, bytes: bytes ? Number(bytes) : null }));
  }
  if (!db) return [];
  const r = await run(svc, `SELECT table_name, table_type, table_rows, data_length + index_length FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name`, { db });
  return r.rows.map(([name, k, rows, bytes]) => ({ schema: null, name: name!, kind: k === 'VIEW' ? 'view' : 'table', rows: rows == null ? null : Number(rows), bytes: bytes == null ? null : Number(bytes) }));
}

export async function rows(serviceId: string, q: { db: string | null; schema: string | null; table: string; limit?: number; offset?: number; order?: string | null; dir?: string | null }) {
  const svc = getServiceOrThrow(serviceId);
  const { kind } = target(svc);
  const list = await tables(serviceId, q.db);
  const t = list.find((x) => x.name === q.table && (kind === 'mysql' || x.schema === q.schema));
  if (!t) throw new HttpError(404, `no table ${q.schema ? `${q.schema}.` : ''}${q.table}`);
  const limit = Math.min(PAGE_MAX, Math.max(1, Math.floor(q.limit ?? 100)));
  const offset = Math.max(0, Math.floor(q.offset ?? 0));
  const ident = kind === 'postgres' ? `${pgIdent(t.schema!)}.${pgIdent(t.name)}` : myIdent(t.name);
  // Column names come from the catalog, so ORDER BY only ever names a real column.
  const cols =
    kind === 'postgres'
      ? (await run(svc, `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = ${pgLit(t.schema!)} AND table_name = ${pgLit(t.name)} ORDER BY ordinal_position`, { db: q.db })).rows
      : (await run(svc, `SELECT column_name, column_type FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = '${t.name.replace(/'/g, "''").replace(/\\/g, '\\\\')}' ORDER BY ordinal_position`, { db: q.db })).rows;
  const order = q.order && cols.some((c) => c[0] === q.order) ? `${kind === 'postgres' ? pgIdent(q.order) : myIdent(q.order)} ${q.dir === 'desc' ? 'DESC' : 'ASC'}` : null;
  const data = await run(svc, `SELECT * FROM ${ident}${order ? ` ORDER BY ${order}` : ''} LIMIT ${limit} OFFSET ${offset}`, { db: q.db });
  const counted = await run(svc, `SELECT count(*) FROM (SELECT 1 FROM ${ident} LIMIT 100001) s`, { db: q.db }).catch(() => null);
  const n = counted ? Number(counted.rows[0]?.[0]) : null;
  return {
    table: t,
    columns: data.columns.length ? data.columns : cols.map((c) => c[0]!),
    types: Object.fromEntries(cols.map((c) => [c[0], c[1]])),
    rows: data.rows,
    total: n == null ? null : n > 100_000 ? null : n,
    totalAtLeast: n != null && n > 100_000 ? 100_000 : null,
    limit,
    offset,
  };
}

export async function query(serviceId: string, sql: string, opts: { db?: string | null; write?: boolean }) {
  const svc = getServiceOrThrow(serviceId);
  if (!sql.trim()) throw new HttpError(400, 'nothing to run');
  if (sql.length > 100_000) throw new HttpError(400, 'that query is too long');
  try {
    return await run(svc, sql, opts);
  } catch (e) {
    if (!opts.write && e instanceof HttpError && /read-only transaction|READ ONLY transaction/i.test(e.message)) {
      throw new HttpError(400, `${e.message} — turn on “Allow writes” to change data`);
    }
    throw e;
  }
}
