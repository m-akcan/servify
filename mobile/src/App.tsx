import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { servers, type SavedServer } from './lib/servers.ts';
import { appLock, lockErrorCode } from './lib/secure.ts';
import { trust } from './lib/trust.ts';
import { client, SignedOutError } from './lib/client.ts';
import { openStream } from './lib/stream.ts';
import { SessionContext, NavContext, type Route, type Session, type Nav } from './session.tsx';
import { ToastHost, SheetHost, closeSheet, Spinner, toast, toastError, confirmSheet, Icon } from './ui/kit.tsx';
import { Connect, Mark } from './views/Connect.tsx';
import { Home } from './views/Home.tsx';
import { ProjectView } from './views/Project.tsx';
import { ServiceView } from './views/Service.tsx';
import { Settings } from './views/Settings.tsx';
import { Traffic } from './views/Traffic.tsx';
import { UpdateBanner } from './views/UpdateBanner.tsx';
import { resetOffer } from './lib/appupdate.ts';
import type { ServerEvent } from '../../server/src/types.ts';

type Boot =
  | { phase: 'loading' }
  /** The app lock is on and not unlocked. Nothing that holds a token is mounted. */
  | { phase: 'locked'; resume: string | null }
  | { phase: 'connect'; prefill?: SavedServer; reason?: string; canCancel: boolean }
  | { phase: 'ready'; server: SavedServer; token: string };

const LOCK_RESET = 'The app lock was turned off because this phone no longer has a screen lock, and the saved sign-in was removed with it. Sign in again to continue.';
const OFFERED_KEY = 'servify.lockOffered';

export function App() {
  const [boot, setBoot] = useState<Boot>({ phase: 'loading' });
  // Each server's screen stack, so locking and unlocking (which unmounts everything) returns to the same screen.
  const stacks = useRef(new Map<string, Route[]>());

  const open = useCallback(async (id: string | null, reason?: string) => {
    const list = servers.list();
    const s = list.find((x) => x.id === id) ?? list[0];
    if (!s) return setBoot({ phase: 'connect', canCancel: false, reason });
    let token: string | null = null;
    try {
      token = await servers.token(s.id);
    } catch (e) {
      const code = lockErrorCode(e);
      // Locked, or the unlock prompt was dismissed: back to the lock screen, the token stays where it is.
      if (code === 'locked' || code === 'cancelled' || code === 'lockout') return setBoot({ phase: 'locked', resume: s.id });
      reason = code === 'lock_reset' ? LOCK_RESET : (e as Error).message;
    }
    if (!token) return setBoot({ phase: 'connect', prefill: s, reason: reason ?? 'Sign in again to continue.', canCancel: list.length > 1 });
    servers.setActive(s.id);
    setBoot({ phase: 'ready', server: s, token });
  }, []);

  useEffect(() => {
    void (async () => {
      // Pins of servers that were trusted but never signed in to (or removed while offline) go.
      await trust.prune(servers.list().map((s) => s.url));
      const st = await appLock.status().catch(() => null);
      if (st?.locked) return setBoot({ phase: 'locked', resume: servers.activeId() });
      void open(servers.activeId(), st?.wasReset ? LOCK_RESET : undefined);
    })();
  }, [open]);

  // Locked again after a while in the background: drop everything that holds the token.
  useEffect(
    () =>
      appLock.onLocked(() => {
        closeSheet();
        setBoot((b) => (b.phase === 'locked' ? b : { phase: 'locked', resume: b.phase === 'ready' ? b.server.id : servers.activeId() }));
      }),
    [],
  );

  // Offer the app lock once: to new users after their first sign-in, to existing ones after the update.
  const offered = useRef(false);
  useEffect(() => {
    if (boot.phase !== 'ready' || offered.current) return;
    offered.current = true;
    const t = setTimeout(() => void offerLock(), 800);
    return () => clearTimeout(t);
  }, [boot.phase]);

  if (boot.phase === 'loading') {
    return (
      <div className="screen center">
        <Spinner />
      </div>
    );
  }
  return (
    <>
      {boot.phase === 'locked' ? (
        <LockScreen onUnlocked={() => void open(boot.resume)} />
      ) : boot.phase === 'connect' ? (
        <Connect
          prefill={boot.prefill}
          reason={boot.reason}
          onCancel={
            boot.canCancel
              ? () => {
                  void trust.prune(servers.list().map((s) => s.url));
                  void open(servers.list().find((s) => s.id !== boot.prefill?.id)?.id ?? null);
                }
              : undefined
          }
          onDone={(id) => void open(id)}
        />
      ) : (
        <SignedIn
          key={boot.server.id}
          server={boot.server}
          token={boot.token}
          initialStack={stacks.current.get(boot.server.id)}
          onStack={(st) => stacks.current.set(boot.server.id, st)}
          onSwitch={(id) => void open(id)}
          onAddServer={() => setBoot({ phase: 'connect', canCancel: true })}
          onSignedOut={async (reason) => {
            const id = boot.server.id;
            // A reason means the token stopped working (a 401, which a proxy in front of Servify can send too):
            // only the token is forgotten, the server stays in the list and asks for the password again. Signing
            // out by hand removes the server from this phone.
            if (reason !== undefined) await servers.forgetToken(id).catch(() => {});
            else await servers.remove(id).catch(() => {});
            stacks.current.delete(id);
            // Keep the address so signing back in is one step.
            setBoot({ phase: 'connect', prefill: boot.server, reason, canCancel: servers.list().some((s) => s.id !== id) });
          }}
        />
      )}
      <SheetHost />
      <ToastHost />
    </>
  );
}

async function offerLock() {
  try {
    if (localStorage.getItem(OFFERED_KEY)) return;
  } catch {
    return;
  }
  const st = await appLock.status().catch(() => null);
  if (!st) return;
  try {
    localStorage.setItem(OFFERED_KEY, '1');
  } catch {
    /* asked again next time */
  }
  if (st.enabled) return;
  if (st.available) {
    const ok = await confirmSheet({
      title: 'Lock the app?',
      body: `This phone can control your server. Ask for your ${st.biometrics ? 'fingerprint, face or ' : ''}screen lock when Servify opens and after a minute in the background. You can change this in Settings.`,
      confirm: 'Turn on',
    });
    if (!ok) return;
    try {
      await appLock.enable();
      toast('App lock is on');
    } catch (e) {
      if (lockErrorCode(e) !== 'cancelled') toastError(e);
    }
  } else {
    const ok = await confirmSheet({
      title: 'This phone has no screen lock',
      body: 'Anyone holding it can control your server through this app. Set a PIN, pattern or password in Android settings, then turn on the app lock in Settings here.',
      confirm: 'Open Android settings',
    });
    if (ok) void appLock.openSecuritySettings().catch(() => {});
  }
}

function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const done = useRef(onUnlocked);
  done.current = onUnlocked;

  const unlock = useCallback(async () => {
    setBusy(true);
    setMsg(null);
    try {
      await appLock.unlock();
      done.current();
    } catch (e) {
      const code = lockErrorCode(e);
      if (code === 'lock_reset') return done.current();
      setMsg(code === 'cancelled' ? null : code === 'lockout' ? 'Too many attempts. Wait a moment, or use your PIN, pattern or password.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void appLock.shown(); // the native cover can go: this screen is up now
    const t = setTimeout(() => void unlock(), 200);
    return () => clearTimeout(t);
  }, [unlock]);

  return (
    <div className="screen">
      <div className="lock-screen">
        <Mark size={56} />
        <h2>Servify is locked</h2>
        <div className="dim">Unlock with your fingerprint, face or screen lock.</div>
        {msg && (
          <div className="error" role="alert" style={{ textAlign: 'left' }}>
            <Icon name="alert" size={16} />
            <div>{msg}</div>
          </div>
        )}
        {/* Never disabled: if the system prompt didn't come up, tapping again asks for a new one. */}
        <button className="btn btn-primary" aria-busy={busy} onClick={() => void unlock()}>
          <Icon name="lock" size={18} />
          Unlock
        </button>
      </div>
    </div>
  );
}

function SignedIn({
  server,
  token,
  initialStack,
  onStack,
  onSwitch,
  onAddServer,
  onSignedOut,
}: {
  server: SavedServer;
  token: string;
  initialStack?: Route[];
  onStack: (stack: Route[]) => void;
  onSwitch: (id: string) => void;
  onAddServer: () => void;
  onSignedOut: (reason?: string) => void;
}) {
  const [stack, setStack] = useState<Route[]>(() => initialStack ?? [{ name: 'home' }]);
  const stackRef = useRef(onStack);
  stackRef.current = onStack;
  useEffect(() => {
    stackRef.current(stack);
  }, [stack]);
  const [popped, setPopped] = useState(false);
  const [live, setLive] = useState(false);
  const subs = useRef(new Set<(ev: ServerEvent) => void>());
  const signedOutRef = useRef(onSignedOut);
  signedOutRef.current = onSignedOut;

  // The API client reports a revoked token; every screen shares this one handler.
  const api = useMemo(() => {
    const base = client(server.url, token);
    const guard =
      <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
      async (...a: A): Promise<R> => {
        try {
          return await f(...a);
        } catch (e) {
          if (e instanceof SignedOutError) signedOutRef.current(e.message);
          throw e;
        }
      };
    return { base: base.base, get: guard(base.get), post: guard(base.post), del: guard(base.del) } as typeof base;
  }, [server.url, token]);

  // One live event stream for the whole app.
  useEffect(
    () =>
      openStream(server.url, token, '/events', { message: (ev: ServerEvent) => subs.current.forEach((f) => f(ev)) }, { onState: setLive }),
    [server.url, token],
  );

  // A pinned server that can't be reached may have a new certificate (for example after Servify was set up
  // again, which makes a new CA). Connections stay blocked; offer to check the new one.
  useEffect(() => {
    if (live || !server.url.startsWith('https://')) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const ins = await trust.inspect(server.url).catch(() => null);
      if (cancelled || !ins?.reachable || !ins.tls || !ins.pinned || ins.pinMatches || (ins.systemTrusted && ins.hostMatches)) return;
      const ok = await confirmSheet({
        title: 'The certificate changed',
        body: `${new URL(server.url).host} now shows a different certificate than the one you trusted, so the app won't connect to it. If you expected this, check the new certificate and sign in again.`,
        confirm: 'Check it',
        danger: true,
      });
      if (ok && !cancelled) signedOutRef.current('Check the new certificate, then sign in again.');
    }, 8000);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [live, server.url]);

  // Refresh the server's version label once per launch.
  useEffect(() => {
    api
      .get<{ version: string }>('/auth/status')
      .then((s) => {
        if (s.version !== server.version) servers.update(server.id, { version: s.version });
      })
      .catch(() => {});
  }, [api, server.id, server.version]);

  // Another server's (or no) offer until this one has answered.
  useEffect(() => () => resetOffer(), [server.id]);

  const subscribe = useCallback((fn: (ev: ServerEvent) => void) => {
    subs.current.add(fn);
    return () => {
      subs.current.delete(fn);
    };
  }, []);

  const session: Session = useMemo(() => ({ server, api, token, live, subscribe }), [server, api, token, live, subscribe]);

  const nav: Nav = useMemo(
    () => ({
      push: (r) => {
        setPopped(false);
        setStack((s) => [...s, r]);
      },
      back: () => {
        setPopped(true);
        setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
      },
      reset: (r) => {
        setPopped(true);
        setStack([r ?? { name: 'home' }]);
      },
    }),
    [],
  );

  // Android back: close a sheet, else go back a screen, else leave the app.
  const depth = useRef(stack.length);
  depth.current = stack.length;
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const h = CapApp.addListener('backButton', () => {
      if (closeSheet()) return;
      if (depth.current > 1) nav.back();
      else void CapApp.minimizeApp();
    });
    return () => {
      void h.then((x) => x.remove());
    };
  }, [nav]);

  const top = stack[stack.length - 1];
  const cls = popped ? 'screen back-anim' : 'screen';
  return (
    <SessionContext.Provider value={session}>
      <NavContext.Provider value={nav}>
        <div className={cls} key={`${stack.length}:${top.name}:${'id' in top ? top.id : ''}`}>
          {top.name === 'home' && <Home />}
          {top.name === 'project' && <ProjectView id={top.id} title={top.title} />}
          {top.name === 'service' && <ServiceView id={top.id} title={top.title} />}
          {top.name === 'traffic' && <Traffic />}
          {top.name === 'settings' && (
            <Settings
              onSwitch={onSwitch}
              onAddServer={onAddServer}
              onSignOut={async () => {
                try {
                  await client(server.url, token).del('/auth/device');
                } catch {
                  toast('Signed out on this phone. Servify could not be reached, so remove the device under Settings → Security there.');
                }
                onSignedOut();
              }}
            />
          )}
        </div>
        {/* Signed in only: nothing of it exists while the app is locked. */}
        <UpdateBanner />
      </NavContext.Provider>
    </SessionContext.Provider>
  );
}
