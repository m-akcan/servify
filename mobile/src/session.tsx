import { createContext, useContext, useEffect, useRef } from 'react';
import type { Client } from './lib/client.ts';
import type { SavedServer } from './lib/servers.ts';
import type { ServerEvent } from '../../server/src/types.ts';

export type Session = {
  server: SavedServer;
  api: Client;
  token: string;
  live: boolean;
  subscribe: (fn: (ev: ServerEvent) => void) => () => void;
};

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('no session');
  return s;
}

/** Run `fn` for live events; `fn` may change between renders without resubscribing. */
export function useServerEvents(fn: (ev: ServerEvent) => void) {
  const { subscribe } = useSession();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => subscribe((ev) => ref.current(ev)), [subscribe]);
}

/** Calls `fn` at most once per `ms`, trailing (for refetching after bursts of events). */
export function useDebounced(fn: () => void, ms = 700) {
  const ref = useRef(fn);
  ref.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return () => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      ref.current();
    }, ms);
  };
}

export type Route =
  | { name: 'home' }
  | { name: 'project'; id: string; title: string }
  | { name: 'service'; id: string; title: string }
  | { name: 'settings' }
  | { name: 'traffic' };

export type Nav = { push: (r: Route) => void; back: () => void; reset: (r?: Route) => void };
export const NavContext = createContext<Nav | null>(null);
export function useNav(): Nav {
  const n = useContext(NavContext);
  if (!n) throw new Error('no nav');
  return n;
}
