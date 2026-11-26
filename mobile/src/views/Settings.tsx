import { useSession, useNav } from '../session.tsx';
import { servers } from '../lib/servers.ts';
import { Icon, TopBar, confirmSheet } from '../ui/kit.tsx';
import { timeAgo } from '../../../web/src/lib/format.ts';

declare const __APP_VERSION__: string;

export function Settings({ onSwitch, onAddServer, onSignOut }: { onSwitch: (id: string) => void; onAddServer: () => void; onSignOut: () => void }) {
  const { server } = useSession();
  const nav = useNav();
  const list = servers.list();
  return (
    <>
      <TopBar title="Settings" onBack={nav.back} />
      <div className="scroll">
        <div className="section-title">
          <span className="label">Servers</span>
        </div>
        <div className="card list">
          {list.map((s) => (
            <button
              key={s.id}
              className="item"
              onClick={() => {
                if (s.id !== server.id) onSwitch(s.id);
                else nav.back();
              }}
            >
              <Icon name="server" size={18} />
              <div className="grow">
                <div className="title mono ellipsis" style={{ fontSize: 13 }}>
                  {s.label}
                </div>
                <div className="meta ellipsis">
                  Servify {s.version} · signed in {timeAgo(s.addedAt)}
                </div>
              </div>
              {s.id === server.id ? <Icon name="check" size={18} style={{ color: 'var(--signal)' }} /> : <Icon name="chevronRight" size={18} className="chev" />}
            </button>
          ))}
          <button className="item" onClick={onAddServer}>
            <Icon name="plus" size={18} />
            <div className="grow title">Add a server</div>
          </button>
        </div>

        <div className="section-title">
          <span className="label">This phone</span>
        </div>
        <dl className="card kv">
          <dt>Signed in as</dt>
          <dd>{server.deviceName}</dd>
          <dt>Server</dt>
          <dd className="mono" style={{ fontSize: 12 }}>
            {server.url}
          </dd>
        </dl>
        <div className="hint" style={{ margin: '8px 2px 0' }}>
          This phone acts as you on this Servify. You can also sign it out from the dashboard under Settings → Security.
        </div>
        <button
          className="btn btn-danger btn-block"
          style={{ marginTop: 16 }}
          onClick={async () => {
            if (await confirmSheet({ title: `Sign out of ${server.label}?`, body: "This phone's access is revoked on the server. You'll need the password to sign in again.", confirm: 'Sign out', danger: true }))
              onSignOut();
          }}
        >
          <Icon name="logout" size={18} />
          Sign out
        </button>

        <div className="section-title">
          <span className="label">Alerts</span>
        </div>
        <div className="card" style={{ padding: 14, fontSize: 13 }}>
          <div className="dim">
            For push alerts when a service crashes or a deploy fails, add an <b>ntfy</b> channel in the dashboard (Settings → Notifications) and install the ntfy app on this phone.
          </div>
        </div>

        <div className="faint mono" style={{ fontSize: 11, textAlign: 'center', marginTop: 32 }}>
          Servify for Android {__APP_VERSION__}
        </div>
      </div>
    </>
  );
}
