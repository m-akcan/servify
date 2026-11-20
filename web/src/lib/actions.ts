import { api } from './api.ts';
import { toast, toastError, confirmDialog, type MenuItem } from '../components/ui.tsx';
import type { Deployment, ServiceView } from './types.ts';
import { navigate, projectPath } from './router.ts';
import { store } from './store.ts';

export async function deploy(s: ServiceView) {
  try {
    await api.post<Deployment>(`/services/${s.id}/deploy`);
    toast({ title: `Deploying ${s.name}`, body: s.pendingChanges.length ? `Applying ${s.pendingChanges.join(', ')}` : undefined, tone: 'build' });
  } catch (e) {
    toastError(e, 'Deploy failed to start');
  }
}

export async function restart(s: ServiceView) {
  try {
    await api.post(`/services/${s.id}/restart`);
    toast({ title: `Restarting ${s.name}`, body: 'Rolling fresh replicas with zero downtime', tone: 'build' });
  } catch (e) {
    toastError(e);
  }
}

export async function stop(s: ServiceView) {
  try {
    await api.post(`/services/${s.id}/stop`);
    toast({ title: `${s.name} stopped`, tone: 'idle', action: { label: 'Undo', onClick: () => void start(s) } });
  } catch (e) {
    toastError(e);
  }
}

export async function start(s: ServiceView) {
  try {
    await api.post(`/services/${s.id}/start`);
    toast({ title: `Starting ${s.name}`, tone: 'build' });
  } catch (e) {
    toastError(e);
  }
}

export async function scale(s: ServiceView, replicas: number) {
  try {
    await api.post(`/services/${s.id}/scale`, { replicas });
  } catch (e) {
    toastError(e, 'Could not scale');
  }
}

export async function remove(s: ServiceView) {
  const ok = await confirmDialog({
    title: `Delete ${s.name}?`,
    body: s.volumes.length ? 'This removes all replicas, built images and the persistent volume data. This cannot be undone.' : 'This removes all replicas and built images. This cannot be undone.',
    confirm: 'Delete service',
    danger: true,
    typeToConfirm: s.volumes.length ? s.name : undefined,
  });
  if (!ok) return;
  try {
    const cur = store.get().current;
    if (cur) navigate(projectPath(cur.project.slug), { replace: true });
    await api.del(`/services/${s.id}`);
    toast({ title: `${s.name} deleted`, tone: 'idle' });
  } catch (e) {
    toastError(e);
  }
}

export async function rollback(s: ServiceView, d: Deployment) {
  const ok = await confirmDialog({
    title: 'Roll back?',
    body: `Redeploy the image from ${new Date(d.createdAt).toLocaleString()} (${d.sourceLabel}). Current settings for env are taken from that deployment.`,
    confirm: 'Roll back',
  });
  if (!ok) return;
  try {
    await api.post(`/services/${s.id}/rollback`, { deploymentId: d.id });
    toast({ title: `Rolling back ${s.name}`, tone: 'build' });
  } catch (e) {
    toastError(e);
  }
}

export function serviceMenu(s: ServiceView, opts: { open: (tab?: string) => void }): MenuItem[] {
  const items: MenuItem[] = [
    { label: 'Open details', icon: 'sliders', kbd: '↵', onSelect: () => opts.open() },
    { label: 'Logs', icon: 'logs', onSelect: () => opts.open('logs') },
    { label: 'Metrics', icon: 'chart', onSelect: () => opts.open('metrics') },
  ];
  const deployed = !!s.activeDeploymentId;
  if (s.url && deployed) items.push({ label: 'Open URL', icon: 'external', onSelect: () => window.open(s.url!, '_blank') });
  items.push({ type: 'sep' });
  items.push({ label: !deployed ? 'Deploy' : s.pendingChanges.length ? 'Deploy changes' : 'Redeploy', icon: 'rocket', onSelect: () => void deploy(s) });
  if (s.activeDeploymentId) items.push({ label: 'Restart', icon: 'refresh', onSelect: () => void restart(s) });
  if (!s.volumes.length && s.protocol !== 'none') {
    items.push({ label: 'Add replica', icon: 'layers', onSelect: () => void scale(s, s.replicas + 1) });
    if (s.replicas > 1) items.push({ label: 'Remove replica', icon: 'minus', onSelect: () => void scale(s, s.replicas - 1) });
  }
  if (deployed) items.push(s.stopped ? { label: 'Start', icon: 'play', onSelect: () => void start(s) } : { label: 'Stop', icon: 'stop', onSelect: () => void stop(s) });
  items.push({ type: 'sep' });
  items.push({ label: 'Delete service', icon: 'trash', danger: true, kbd: '⌫', onSelect: () => void remove(s) });
  return items;
}
