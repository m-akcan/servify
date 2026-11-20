import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { useStore, store } from '../lib/store.ts';
import type { ApiToken, ActivityEntry } from '../lib/types.ts';
import { Button, Modal, Segmented, CopyButton, toastError, confirmDialog, toast, Empty } from '../components/ui.tsx';
import { Icon } from '../components/Icon.tsx';
import { timeAgo } from '../lib/format.ts';

const TOOLS = [
  ['overview', 'All projects & services at a glance'],
  ['create_service', 'Deploy from image, git, local folder or template'],
  ['deploy_service', 'Build + deploy with zero downtime'],
  ['wait_for_deployment', 'Block until a deploy finishes, with log tail'],
  ['scale_service', 'Change replicas behind the load balancer'],
  ['set_variables', 'Env vars with ${{ service.VAR }} references'],
  ['get_service_logs', 'Runtime logs across replicas'],
  ['get_metrics', 'req/s, p95, CPU, memory per replica'],
  ['exec_command', 'Run a command inside a replica'],
  ['rollback_service', 'Redeploy any previous version'],
  ['update_service', 'Ports, domains, health checks, autoscaling…'],
  ['backup_service', 'Dump a database or archive volumes; restore_backup to roll data back'],
  ['import_compose', 'Turn a docker-compose.yml into a project'],
  ['create_environment', 'Staging copies and pull-request previews'],
  ['get_activity', 'Audit trail of who did what'],
];

function Snippet({ title, code }: { title: string; code: string }) {
  return (
    <div className="snippet">
      <div className="snippet-head">
        <span className="label">{title}</span>
        <CopyButton text={code} label="Copy" />
      </div>
      <pre className="no-canvas-wheel">{code}</pre>
    </div>
  );
}

export function AgentsView({ settings }: { settings?: boolean }) {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('claude');
  const [scope, setScope] = useState<'write' | 'read'>('write');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [client, setClient] = useState<'claude-code' | 'json' | 'stdio' | 'rest'>('claude-code');
  const [agentActivity, setAgentActivity] = useState<ActivityEntry[]>([]);
  const system = useStore((s) => s.system);

  const load = () => api.get<ApiToken[]>('/tokens').then(setTokens).catch(() => {});
  useEffect(() => {
    void load();
    api
      .get<ActivityEntry[]>('/activity?limit=200')
      .then((a) => setAgentActivity(a.filter((x) => x.actorType === 'agent').slice(0, 30)))
      .catch(() => {});
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api.post<{ token: string }>('/tokens', { name, scope });
      setNewToken(r.token);
      setCreating(false);
      void load();
    } catch (err) {
      toastError(err);
    }
  };

  const revoke = async (t: ApiToken) => {
    if (!(await confirmDialog({ title: `Revoke “${t.name}”?`, body: 'Agents using this token lose access immediately.', confirm: 'Revoke', danger: true }))) return;
    await api.del(`/tokens/${t.id}`);
    toast({ title: 'Token revoked', tone: 'idle' });
    void load();
  };

  const origin = location.origin.includes(':5173') ? `http://localhost:${system?.api.port ?? 7700}` : location.origin;
  const tok = newToken ?? '<YOUR_TOKEN>';
  const snippets = {
    'claude-code': `claude mcp add --transport http servify ${origin}/mcp \\\n  --header "Authorization: Bearer ${tok}"`,
    json: JSON.stringify({ mcpServers: { servify: { type: 'http', url: `${origin}/mcp`, headers: { Authorization: `Bearer ${tok}` } } } }, null, 2),
    stdio: JSON.stringify({ mcpServers: { servify: { command: 'node', args: [system?.binPath ?? '/path/to/servify/server/bin/servify.mjs', 'mcp'], env: { SERVIFY_URL: origin, SERVIFY_TOKEN: tok } } } }, null, 2),
    rest: `curl ${origin}/api/projects \\\n  -H "Authorization: Bearer ${tok}"\n\ncurl -X POST ${origin}/api/services/<id>/scale \\\n  -H "Authorization: Bearer ${tok}" \\\n  -H "content-type: application/json" -d '{"replicas": 3}'`,
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="rise-in">
          <div className="label">{settings ? 'Settings' : 'Agent access'}</div>
          <h1 className="h1" style={{ marginTop: 6 }}>
            Agents & API
          </h1>
          <p className="muted" style={{ maxWidth: 620, marginTop: 8 }}>
            Let Claude, Cursor or any MCP-capable agent deploy, scale and debug your services. Every action an agent takes is attributed to its token and shows up in the activity feed and on deployments.
          </p>
        </div>

        <div className="agents-grid">
          <section className="card agents-card rise-in" style={{ animationDelay: '60ms' }}>
            <div className="row" style={{ marginBottom: 14 }}>
              <div className="grow">
                <div className="h3">API tokens</div>
                <div className="faint" style={{ fontSize: 12 }}>Used as Bearer tokens for MCP and the REST API.</div>
              </div>
              <Button variant="primary" icon="plus" size="sm" onClick={() => setCreating(true)}>
                New token
              </Button>
            </div>
            {tokens.length === 0 ? (
              <Empty icon="key" title="No tokens yet" body="Create one to connect your first agent." />
            ) : (
              <div className="token-list">
                {tokens.map((t) => (
                  <div className="token-row" key={t.id}>
                    <div className="token-icon">
                      <Icon name="bot" size={15} />
                    </div>
                    <div className="grow">
                      <div className="row" style={{ gap: 8 }}>
                        <b>{t.name}</b>
                        <span className="badge" data-tone={t.scope === 'write' ? 'signal' : 'idle'}>
                          {t.scope === 'write' ? 'full access' : 'read only'}
                        </span>
                      </div>
                      <div className="faint mono" style={{ fontSize: 11, marginTop: 2 }}>
                        {t.prefix}…  ·  created {timeAgo(t.createdAt)}  ·  {t.lastUsedAt ? `used ${timeAgo(t.lastUsedAt)}` : 'never used'}
                      </div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => void revoke(t)}>
                      Revoke
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="card agents-card rise-in" style={{ animationDelay: '120ms' }}>
            <div className="h3" style={{ marginBottom: 4 }}>
              Connect an agent
            </div>
            <div className="faint" style={{ fontSize: 12, marginBottom: 12 }}>
              MCP endpoint <code className="inline-code">{origin}/mcp</code> · Streamable HTTP
            </div>
            <Segmented
              value={client}
              onChange={setClient}
              options={[
                { value: 'claude-code', label: 'Claude Code' },
                { value: 'json', label: 'mcp.json' },
                { value: 'stdio', label: 'stdio' },
                { value: 'rest', label: 'REST' },
              ]}
            />
            <div style={{ marginTop: 12 }}>
              <Snippet title={client === 'claude-code' ? 'Terminal' : client === 'rest' ? 'curl' : 'Config'} code={snippets[client]} />
            </div>
            {!newToken && <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>Create a token to fill it into these snippets.</div>}
          </section>

          <section className="card agents-card rise-in" style={{ animationDelay: '180ms' }}>
            <div className="h3" style={{ marginBottom: 12 }}>
              Tools agents get
            </div>
            <div className="tool-list">
              {TOOLS.map(([n, d]) => (
                <div key={n} className="tool-row">
                  <code className="mono">{n}</code>
                  <span className="faint">{d}</span>
                </div>
              ))}
              <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>+ 17 more: export/import projects, cron runs, load tests, stop/start, deployments, logs…</div>
            </div>
          </section>

          <section className="card agents-card rise-in" style={{ animationDelay: '210ms' }}>
            <div className="h3" style={{ marginBottom: 4 }}>
              Try asking your agent
            </div>
            <div className="faint" style={{ fontSize: 12, marginBottom: 12 }}>
              Once connected, plain requests like these just work.
            </div>
            <div className="col" style={{ gap: 6 }}>
              {[
                'Deploy github.com/me/api with 3 replicas, add Postgres, and wire DATABASE_URL.',
                'Why is my web service failing? Check the last deploy log and the runtime logs.',
                'Load test the web service at 100 req/s and tell me if autoscaling kicks in.',
                'Add a nightly 03:00 job that runs `npm run cleanup` in the api image.',
                'Export the shop project as servify.json and recreate it as shop-staging.',
              ].map((p) => (
                <div key={p} className="prompt-row">
                  <Icon name="sparkle" size={13} />
                  <span className="grow">{p}</span>
                  <CopyButton text={p} />
                </div>
              ))}
            </div>
          </section>

          <section className="card agents-card rise-in" style={{ animationDelay: '240ms' }}>
            <div className="h3" style={{ marginBottom: 12 }}>
              Recent agent activity
            </div>
            {agentActivity.length === 0 ? (
              <div className="faint" style={{ fontSize: 12 }}>Agents haven’t done anything yet.</div>
            ) : (
              <div className="col" style={{ gap: 8 }}>
                {agentActivity.map((a) => (
                  <div key={a.id} className="row" style={{ gap: 10, fontSize: 12 }}>
                    <span className="actor-pill agent">
                      <Icon name="bot" size={10} />
                      {a.actor}
                    </span>
                    <span className="grow truncate">{a.summary}</span>
                    <span className="faint">{timeAgo(a.ts)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {system && (
            <section className="card agents-card rise-in" style={{ animationDelay: '300ms' }}>
              <div className="h3" style={{ marginBottom: 12 }}>
                This instance
              </div>
              <div className="kv">
                <span>Version</span>
                <code>{system.version}</code>
                <span>Dashboard</span>
                <code>
                  {system.api.host}:{system.api.port}
                </code>
                <span>Edge router</span>
                <code>
                  {system.proxy.host}:{system.proxy.port}
                </code>
                <span>Docker</span>
                <code>{system.docker.endpoint ?? '—'}</code>
                <span>Data</span>
                <code>{system.dataDir}</code>
                <span>Auth</span>
                <code>{system.authMode}</code>
              </div>
            </section>
          )}
        </div>
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} width={440}>
        <form onSubmit={create} style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <h2 className="h2">New API token</h2>
          <label className="field">
            <span className="label">Name</span>
            <input className="input input-lg" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="claude, cursor, ci…" />
            <span className="field-hint">Shown on everything this agent does.</span>
          </label>
          <label className="field">
            <span className="label">Access</span>
            <Segmented
              value={scope}
              onChange={setScope}
              options={[
                { value: 'write', label: 'Full access' },
                { value: 'read', label: 'Read only' },
              ]}
            />
          </label>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!name.trim()}>
              Create token
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={!!newToken} onClose={() => setNewToken(null)} width={520}>
        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="confirm-icon" data-tone="signal">
            <Icon name="key" size={18} />
          </div>
          <h2 className="h2">Copy your token</h2>
          <p className="muted" style={{ margin: 0 }}>
            It won’t be shown again. The setup snippets on this page now include it.
          </p>
          <div className="token-reveal mono">
            <span className="truncate">{newToken}</span>
            <CopyButton text={newToken ?? ''} label="Copy" />
          </div>
          <Snippet title="Claude Code" code={snippets['claude-code']} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="primary" onClick={() => setNewToken(null)}>
              Done
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

void store;
