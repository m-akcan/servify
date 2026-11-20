import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'project'; project: string; service?: string; tab?: string }
  | { name: 'agents' }
  | { name: 'servers' }
  | { name: 'settings'; section?: string };

function parse(path: string): Route {
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'p' && parts[1]) return { name: 'project', project: parts[1], service: parts[2], tab: parts[3] };
  if (parts[0] === 'agents') return { name: 'agents' };
  if (parts[0] === 'servers') return { name: 'servers' };
  if (parts[0] === 'settings') return { name: 'settings', section: parts[1] };
  return { name: 'home' };
}

let current = parse(location.pathname);
const subs = new Set<() => void>();

window.addEventListener('popstate', () => {
  current = parse(location.pathname);
  for (const fn of subs) fn();
});

export function navigate(path: string, opts: { replace?: boolean } = {}) {
  if (path === location.pathname) return;
  if (opts.replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  current = parse(path);
  for (const fn of subs) fn();
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => current,
  );
}

export function projectPath(project: string, service?: string, tab?: string) {
  let p = `/p/${encodeURIComponent(project)}`;
  if (service) p += `/${encodeURIComponent(service)}`;
  if (service && tab) p += `/${tab}`;
  return p;
}
