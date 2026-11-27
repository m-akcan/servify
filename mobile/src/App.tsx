import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { servers, type SavedServer } from './lib/servers.ts';
import { client, SignedOutError } from './lib/client.ts';
import { openStream } from './lib/stream.ts';
import { SessionContext, NavContext, type Route, type Session, type Nav } from './session.tsx';
import { ToastHost, SheetHost, closeSheet, Spinner, toast } from './ui/kit.tsx';
import { Connect } from './views/Connect.tsx';
import { Home } from './views/Home.tsx';
import { ProjectView } from './views/Project.tsx';
import { ServiceView } from './views/Service.tsx';
import { Settings } from './views/Settings.tsx';
import type { ServerEvent } from '../../server/src/types.ts';

type Boot =
  | { phase: 'loading' }
  | { phase: 'connect'; prefill?: SavedServer; reason?: string; canCancel: boolean }
  | { phase: 'ready'; server: SavedServer; token: string };

export function App() {
  const [boot, setBoot] = useState<Boot>({ phase: 'loading' });

  const open = useCallback(async (id: string | null, reason?: string) => {
    const list = servers.list();
    const s = list.find((x) => x.id === id) ?? list[0];
    if (!s) return setBoot({ phase: 'connect', canCancel: false });
    const token = await servers.token(s.id);
    if (!token) return setBoot({ phase: 'connect', prefill: s, reason: reason ?? 'Sign in again to continue.', canCancel: list.length > 1 });
    servers.setActive(s.id);
    setBoot({ phase: 'ready', server: s, token });
  }, []);

  useEffect(() => {
    void open(servers.activeId());
  }, [open]);

  if (boot.phase === 'loading') {
    return (
      <div className="screen center">
        <Spinner />
      </div>
    );
  }
  return (
    <>
      {boot.phase === 'connect' ? (
        <Connect
          prefill={boot.prefill}
          reason={boot.reason}
          onCancel={boot.canCancel ? () => void open(servers.list().find((s) => s.id !== boot.prefill?.id)?.id ?? null) : undefined}
          onDone={(id) => void open(id)}
        />
      ) : (
        <SignedIn
          key={boot.server.id}
          server={boot.server}
          token={boot.token}
          onSwitch={(id) => void open(id)}
          onAddServer={() => setBoot({ phase: 'connect', canCancel: true })}
          onSignedOut={async (reason) => {
            const id = boot.server.id;
            // A reason means the token stopped working (a 401, which a proxy in front of Servify can send too):
            // only the token is forgotten, the server stays in the list and asks for the password again. Signing
            // out by hand removes the server from this phone.
            if (reason !== undefined) await servers.forgetToken(id).catch(() => {});
            else await servers.remove(id).catch(() => {});
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

function SignedIn({
  server,
  token,
  onSwitch,
  onAddServer,
  onSignedOut,
}: {
  server: SavedServer;
  token: string;
  onSwitch: (id: string) => void;
  onAddServer: () => void;
  onSignedOut: (reason?: string) => void;
}) {
  const [stack, setStack] = useState<Route[]>([{ name: 'home' }]);
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

  // Refresh the server's version label once per launch.
  useEffect(() => {
    api
      .get<{ version: string }>('/auth/status')
      .then((s) => {
        if (s.version !== server.version) servers.update(server.id, { version: s.version });
      })
      .catch(() => {});
  }, [api, server.id, server.version]);

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
      </NavContext.Provider>
    </SessionContext.Provider>
  );
}
