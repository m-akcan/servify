import { api } from './api.ts';
import { toast, toastError, confirmDialog, type MenuItem } from '../components/ui.tsx';
import type { Deployment, ServiceView } from './types.ts';
import { openVolumeDialog } from './volumes.tsx';
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
  const keepVolumes = s.volumes.length > 0;
  if (s.volumes.length) {
    // Volumes outlive services: keep them as detached volumes unless asked otherwise.
    const keep = await confirmDialog({
      title: `Delete ${s.name}?`,
      body: `Its ${s.volumes.length === 1 ? 'volume' : `${s.volumes.length} volumes`} (${s.volumes.map((v) => v.name).join(', ')}) will stay on the canvas as detached volumes with the data intact. Replicas and built images are removed.`,
      confirm: 'Delete, keep the data',
      danger: true,
      typeToConfirm: s.name,
    });
    if (!keep) return;
  } else {
    const ok = await confirmDialog({ title: `Delete ${s.name}?`, body: 'This removes all replicas and built images. This cannot be undone.', confirm: 'Delete service', danger: true });
    if (!ok) return;
  }
  try {
    const cur = store.get().current;
    if (cur) navigate(projectPath(cur.project.slug), { replace: true });
    await api.del(`/services/${s.id}${keepVolumes ? '?keepVolumes=1' : ''}`);
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

export async function duplicate(s: ServiceView) {
  try {
    await api.post(`/services/${s.id}/duplicate`);
    toast({ title: `Duplicated ${s.name}`, tone: 'build' });
  } catch (e) {
    toastError(e, 'Could not duplicate');
  }
}

/** Wire `from` to `to` by adding a variable reference on `from`. */
export async function connectServices(from: ServiceView, to: ServiceView, key: string, value: string) {
  try {
    await api.put(`/services/${from.id}/variables`, { variables: { [key]: value } });
    toast({
      title: `Connected ${from.name} → ${to.name}`,
      body: `${key} = ${value}${from.activeDeploymentId ? ' · deploy to apply' : ''}`,
      tone: 'ok',
      action: from.activeDeploymentId ? { label: 'Deploy', onClick: () => void deploy(from) } : undefined,
    });
  } catch (e) {
    toastError(e, 'Could not connect');
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
  items.push({ label: 'Duplicate', icon: 'copy', onSelect: () => void duplicate(s) });
  items.push({ label: 'Attach volume…', icon: 'database', onSelect: () => openVolumeDialog({ kind: 'attach', serviceId: s.id }) });
  items.push({ type: 'sep' });
  items.push({ label: 'Delete service', icon: 'trash', danger: true, kbd: '⌫', onSelect: () => void remove(s) });
  return items;
}
