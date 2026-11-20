import { useEffect } from 'react';
import { useStore, checkAuth, loadProjects, loadSystem, connectEvents, store } from './lib/store.ts';
import { useRoute } from './lib/router.ts';
import { MenuHost, ToastHost, ConfirmHost } from './components/ui.tsx';
import { AuthScreen } from './views/Auth.tsx';
import { Home } from './views/Home.tsx';
import { ProjectView } from './views/ProjectView.tsx';
import { AgentsView } from './views/Agents.tsx';
import { CommandPalette } from './components/CommandPalette.tsx';
import { Shell } from './views/Shell.tsx';
import { EventToasts } from './components/EventToasts.tsx';
import { Shortcuts } from './components/Shortcuts.tsx';
import { SettingsView } from './views/SettingsView.tsx';
import { ServersView } from './views/Servers.tsx';

export function App() {
  const auth = useStore((s) => s.auth);
  const route = useRoute();

  useEffect(() => {
    void checkAuth().catch(() => store.set({ auth: { checked: true, setUp: true, authenticated: false, authMode: 'password' } }));
    const onUnauth = () => void checkAuth();
    window.addEventListener('servify:unauthorized', onUnauth);
    return () => window.removeEventListener('servify:unauthorized', onUnauth);
  }, []);

  useEffect(() => {
    if (!auth.authenticated) return;
    void loadProjects();
    void loadSystem();
    connectEvents();
  }, [auth.authenticated]);

  if (!auth.checked) return <div className="boot" />;
  if (!auth.authenticated) return <AuthScreen setUp={auth.setUp} />;

  return (
    <>
      <Shell>
        {route.name === 'home' && <Home />}
        {route.name === 'project' && <ProjectView key={route.project} slug={route.project} serviceSlug={route.service} tab={route.tab} />}
        {route.name === 'agents' && <AgentsView />}
        {route.name === 'servers' && <ServersView />}
        {route.name === 'settings' && <SettingsView section={route.section} />}
      </Shell>
      <CommandPalette />
      <MenuHost />
      <ConfirmHost />
      <ToastHost />
      <EventToasts />
      <Shortcuts />
    </>
  );
}
