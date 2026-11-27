import { useEffect, useState } from 'react';
import { useSession, useNav } from '../session.tsx';
import { servers } from '../lib/servers.ts';
import { appLock, lockErrorCode, type LockStatus } from '../lib/secure.ts';
import { trust } from '../lib/trust.ts';
import { appUpdate, checkForAppUpdate, currentOffer, onOffer, dismiss } from '../lib/appupdate.ts';
import { APP_VERSION, APP_VERSION_CODE } from '../lib/appversion.ts';
import { Icon, TopBar, confirmSheet, toast, toastError } from '../ui/kit.tsx';
import { timeAgo } from '../../../web/src/lib/format.ts';

export function Settings({ onSwitch, onAddServer, onSignOut }: { onSwitch: (id: string) => void; onAddServer: () => void; onSignOut: () => void }) {
  const { server } = useSession();
  const nav = useNav();
  const list = servers.list();
  const [pin, setPin] = useState<string | null>(null);
  useEffect(() => {
    void trust.pinned(server.url).then(setPin, () => setPin(null));
  }, [server.url]);
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
          {pin && (
            <>
              <dt>Trusted CA</dt>
              <dd className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                SHA-256 {pin}
              </dd>
            </>
          )}
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

        <LockSettings />

        <AppUpdates />

        <div className="section-title">
          <span className="label">Alerts</span>
        </div>
        <div className="card" style={{ padding: 14, fontSize: 13 }}>
          <div className="dim">
            For push alerts when a service crashes or a deploy fails, add an <b>ntfy</b> channel in the dashboard (Settings → Notifications) and install the ntfy app on this phone.
          </div>
        </div>

        <div className="faint mono" style={{ fontSize: 11, textAlign: 'center', marginTop: 32 }}>
          Servify for Android {APP_VERSION}
        </div>
      </div>
    </>
  );
}

const TIMEOUTS: { ms: number; label: string }[] = [
  { ms: 0, label: 'Right away' },
  { ms: 60_000, label: '1 minute' },
  { ms: 5 * 60_000, label: '5 minutes' },
  { ms: 15 * 60_000, label: '15 minutes' },
];

function LockSettings() {
  const [st, setSt] = useState<LockStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => void appLock.status().then(setSt, () => setSt(null));
  useEffect(() => {
    refresh();
    // Coming back from Android settings, where a screen lock may have been set up.
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  if (!st) return null;

  const toggle = async () => {
    setBusy(true);
    try {
      if (st.enabled) {
        await appLock.disable();
        toast('App lock is off');
      } else {
        await appLock.enable();
        toast('App lock is on');
      }
    } catch (e) {
      if (lockErrorCode(e) !== 'cancelled') toastError(e);
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const how = st.biometrics ? 'Fingerprint, face or screen lock' : 'Your screen lock (PIN, pattern or password)';

  return (
    <>
      <div className="section-title">
        <span className="label">App lock</span>
      </div>
      <div className="card">
        <button className="item" role="switch" aria-checked={st.enabled} disabled={busy || (!st.available && !st.enabled)} onClick={() => void toggle()}>
          <Icon name="lock" size={18} />
          <div className="grow">
            <div className="title">Lock Servify</div>
            <div className="meta">{st.available ? how : 'Needs a screen lock on this phone'}</div>
          </div>
          <span className="switch" aria-checked={st.enabled} />
        </button>
        {st.enabled && (
          <>
            <div className="hint" style={{ padding: '0 14px 8px', marginTop: 0 }}>
              Lock again after the app has been in the background for
            </div>
            <div className="seg">
              {TIMEOUTS.map((t) => (
                <button
                  key={t.ms}
                  className="chip-btn"
                  aria-pressed={st.timeoutMs === t.ms}
                  onClick={async () => {
                    await appLock.setTimeout(t.ms).catch(toastError);
                    refresh();
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="hint" style={{ margin: '8px 2px 0' }}>
        {st.available ? (
          <>
            Asks for your {st.biometrics ? 'fingerprint, face or ' : ''}screen lock when the app opens and after it was in the background. While it's on, the sign-in
            token is encrypted with a key the phone only releases right after you unlock.
          </>
        ) : (
          <>
            This phone has no screen lock, so anyone holding it can open Servify.{' '}
            <button className="link" onClick={() => void appLock.openSecuritySettings().catch(toastError)}>
              Set one up in Android settings
            </button>
            , then turn the lock on here.
          </>
        )}
      </div>
    </>
  );
}

/** This app's version and a manual check against the signed-in Servify's mirrored app. */
function AppUpdates() {
  const { server, api } = useSession();
  const [busy, setBusy] = useState(false);
  const [offer, setOffer] = useState(currentOffer());
  useEffect(() => onOffer(setOffer), []);
  if (!appUpdate.available) return null;
  const check = async () => {
    setBusy(true);
    try {
      // Asked for by hand: the banner shows again even for a version dismissed before.
      dismiss(0);
      const u = await checkForAppUpdate(server.id, api, { force: true });
      if (u) toast(`Update available: ${u.versionName}`);
      else toast('You have the newest app this Servify offers.');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="section-title">
        <span className="label">App updates</span>
      </div>
      <div className="card">
        <button className="item" disabled={busy} aria-busy={busy} onClick={() => void check()}>
          <Icon name="refresh" size={18} />
          <div className="grow">
            <div className="title">Check for updates</div>
            <div className="meta">
              This app: {APP_VERSION} ({APP_VERSION_CODE}){offer ? ` · ${offer.versionName} available` : ''}
            </div>
          </div>
        </button>
      </div>
      <div className="hint" style={{ margin: '8px 2px 0' }}>
        Your Servify keeps a copy of the app from its signed release. Updates come from it, over your network or VPN, and are only installed when they are signed with the same key as this app.
      </div>
    </>
  );
}
