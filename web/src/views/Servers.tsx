import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import type { PublicServer, ServerCreated } from '../lib/types.ts';
import { Button, Badge, Modal, Segmented, CopyButton, toast, toastError, confirmDialog, openMenuAt } from '../components/ui.tsx';
import { Icon } from '../components/Icon.tsx';
import { timeAgo } from '../lib/format.ts';
import { bytes } from '../lib/volumes.tsx';

const STATUS_TONE = { online: 'ok', offline: 'err', pending: 'warn' } as const;
const STATUS_LABEL = { online: 'Online', offline: 'Offline', pending: 'Waiting for agent' } as const;

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

/** Machines Servify runs services on: this one, plus any server connected with `servify agent`. */
export function ServersView() {
  const [servers, setServers] = useState<PublicServer[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [join, setJoin] = useState<(ServerCreated & { title: string }) | null>(null);
  const [how, setHow] = useState<'docker' | 'node'>('docker');
  const [renaming, setRenaming] = useState<PublicServer | null>(null);
  const [newName, setNewName] = useState('');
  const busyRef = useRef(false);

  const load = () =>
    api
      .get<PublicServer[]>('/servers')
      .then(setServers)
      .catch(() => {});
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const r = await api.post<ServerCreated>('/servers', { name: name.trim() });
      setAdding(false);
      setName('');
      setJoin({ ...r, title: `Connect ${r.server.name}` });
      void load();
    } catch (err) {
      toastError(err, 'Could not add the server');
    } finally {
      busyRef.current = false;
    }
  };

  const rotate = async (s: PublicServer) => {
    const yes = await confirmDialog({ title: `New token for ${s.name}?`, body: 'The current token stops working and the agent disconnects. Run the new command on the server to reconnect it.', confirm: 'New token' });
    if (!yes) return;
    try {
      const r = await api.post<ServerCreated>(`/servers/${s.id}/token`);
      setJoin({ ...r, title: `Reconnect ${s.name}` });
      void load();
    } catch (err) {
      toastError(err);
    }
  };
  const rename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renaming || !newName.trim()) return;
    try {
      await api.patch(`/servers/${renaming.id}`, { name: newName.trim() });
      setRenaming(null);
      void load();
    } catch (err) {
      toastError(err);
    }
  };
  const remove = async (s: PublicServer) => {
    const yes = await confirmDialog({
      title: `Remove ${s.name}?`,
      body: s.services ? `It still runs ${s.services} service${s.services === 1 ? '' : 's'} — move or delete them first.` : 'The agent is told to stop and its token stops working. Containers already on that machine are left alone.',
      confirm: 'Remove',
      danger: true,
    });
    if (!yes) return;
    try {
      await api.del(`/servers/${s.id}`);
      toast({ title: `${s.name} removed`, tone: 'idle' });
      void load();
    } catch (err) {
      toastError(err, 'Could not remove the server');
    }
  };

  const live = join ? servers?.find((s) => s.id === join.server.id) : null;

  return (
    <div className="page">
      <div className="page-inner">
        <div className="rise-in row" style={{ alignItems: 'flex-end', gap: 16 }}>
          <div className="grow">
            <div className="label">Infrastructure</div>
            <h1 className="h1" style={{ marginTop: 6 }}>
              Servers
            </h1>
            <p className="muted" style={{ maxWidth: 640, marginTop: 8 }}>
              Run services on other machines. A server only needs Docker: a small agent connects out to this Servify, so the server needs no open ports. Pick a server when you create a service, or move one later.
            </p>
          </div>
          <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
            Add server
          </Button>
        </div>

        <div className="servers-list rise-in" style={{ animationDelay: '60ms' }}>
          {(servers ?? []).map((s) => (
            <section key={s.id} className={`card server-card ${s.status}`}>
              <div className="server-icon">
                <Icon name={s.local ? 'home' : 'server'} size={18} />
              </div>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 8 }}>
                  <b className="truncate">{s.name}</b>
                  <Badge tone={STATUS_TONE[s.status]} live={s.status === 'pending'}>
                    {STATUS_LABEL[s.status]}
                  </Badge>
                </div>
                <div className="faint mono server-meta">
                  {s.local
                    ? 'Servify itself runs here'
                    : s.info
                      ? [s.info.hostname, s.info.address, `docker ${s.info.dockerVersion}`, s.info.cpus ? `${s.info.cpus} CPU` : '', s.info.memBytes ? bytes(s.info.memBytes) : ''].filter(Boolean).join('  ·  ')
                      : 'Run the join command on the server'}
                  {!s.local && s.status === 'offline' && s.lastSeenAt ? `  ·  last seen ${timeAgo(s.lastSeenAt)}` : ''}
                  {!s.local && s.status === 'online' && s.connectedAt ? `  ·  connected ${timeAgo(s.connectedAt)}` : ''}
                </div>
              </div>
              <div className="server-counts">
                <span>
                  <b>{s.services}</b> service{s.services === 1 ? '' : 's'}
                </span>
                <span>
                  <b>{s.replicas}</b> container{s.replicas === 1 ? '' : 's'}
                </span>
              </div>
              {!s.local && (
                <button
                  className="btn btn-ghost btn-sm btn-icon"
                  aria-label={`${s.name} actions`}
                  onClick={(e) =>
                    openMenuAt(
                      e.currentTarget,
                      [
                        { label: 'Rename', icon: 'edit', onSelect: () => (setNewName(s.name), setRenaming(s)) },
                        { label: 'New token & join command', icon: 'key', onSelect: () => void rotate(s) },
                        { type: 'sep' },
                        { label: 'Remove server', icon: 'trash', danger: true, onSelect: () => void remove(s) },
                      ],
                      'right',
                    )
                  }
                >
                  <Icon name="more" size={15} />
                </button>
              )}
            </section>
          ))}
        </div>

        <section className="card server-notes rise-in" style={{ animationDelay: '120ms' }}>
          <div className="h3" style={{ marginBottom: 8 }}>
            How it works
          </div>
          <ul className="muted">
            <li>Builds, image pulls, backups and logs run on the server itself; only the results travel back.</li>
            <li>The router here sends traffic to replicas on any server, through the agent’s encrypted connection.</li>
            <li>Volumes stay on the server that holds them, so services with volumes don’t move between servers.</li>
            <li>
              Private names like <code className="inline-code">db</code> resolve between services on the <b>same</b> server. Keep services that talk to each other together, or use the public URL or TCP address.
            </li>
            <li>If a server goes offline, its services keep running there. Servify shows them as unreachable and changes nothing until it’s back.</li>
          </ul>
        </section>
      </div>

      <Modal open={adding} onClose={() => setAdding(false)} width={440}>
        <form onSubmit={add} style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <h2 className="h2">Add a server</h2>
          <label className="field">
            <span className="label">Name</span>
            <input className="input input-lg" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="hetzner-1, nas, gpu-box…" maxLength={60} />
            <span className="field-hint">You’ll get a one-line command to run on that machine.</span>
          </label>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!name.trim()}>
              Add server
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={!!renaming} onClose={() => setRenaming(null)} width={400}>
        <form onSubmit={rename} style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <h2 className="h2">Rename server</h2>
          <input className="input input-lg" autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={60} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!newName.trim()}>
              Rename
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={!!join} onClose={() => setJoin(null)} width={640}>
        {join && (
          <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="row" style={{ gap: 12 }}>
              <div className="confirm-icon" data-tone="signal">
                <Icon name="server" size={18} />
              </div>
              <div className="grow">
                <h2 className="h2">{join.title}</h2>
                <div className="faint" style={{ fontSize: 12 }}>Run this on the server. The token is shown only now.</div>
              </div>
              {live?.status === 'online' ? (
                <Badge tone="ok">Connected</Badge>
              ) : (
                <Badge tone="warn" live>
                  Waiting…
                </Badge>
              )}
            </div>
            <Segmented
              value={how}
              onChange={setHow}
              options={[
                { value: 'docker', label: 'Docker (recommended)' },
                { value: 'node', label: 'Node.js' },
              ]}
            />
            <div className="join-snippet">
              <Snippet title={how === 'docker' ? 'On the server — needs only Docker' : 'From a Servify checkout on the server'} code={how === 'docker' ? join.join.docker : join.join.node} />
            </div>
            <div className="faint" style={{ fontSize: 12, lineHeight: 1.5 }}>
              The server must reach <code className="inline-code">{join.join.url}</code>. If that address is wrong for your network, start Servify with <code className="inline-code">SERVIFY_AGENT_PUBLIC_HOST=&lt;address&gt;</code>. The agent checks this Servify’s certificate fingerprint before it sends its token.
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <Button variant="primary" onClick={() => setJoin(null)}>
                {live?.status === 'online' ? 'Done' : 'Close'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
