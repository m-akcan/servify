import { useEffect } from 'react';
import { onServerEvent, store } from '../lib/store.ts';
import { toast } from './ui.tsx';
import { navigate, projectPath } from '../lib/router.ts';

/** Surface what happens in the background — especially what agents do — as toasts. */
export function EventToasts() {
  useEffect(() => {
    const seen = new Set<string>();
    return onServerEvent((ev) => {
      if (ev.type === 'deployment.updated') {
        const d = ev.deployment;
        if (d.status !== 'active' && d.status !== 'failed') return;
        const key = `${d.id}:${d.status}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (d.trigger === 'restart' && d.status === 'active' && d.actor === 'you') return;
        const cur = store.get().current;
        const svc = cur?.services[d.serviceId];
        if (!svc) return; // other projects: visible in their activity feed instead
        const name = svc.name;
        const by = d.actor !== 'you' ? ` · by ${d.actor}` : '';
        const open = () => {
          if (cur && svc) navigate(projectPath(cur.project.slug, svc.slug, 'deployments'));
        };
        if (d.status === 'active') toast({ title: `${name} is live`, body: `${d.sourceLabel}${by}`, tone: 'ok', action: svc ? { label: 'View', onClick: open } : undefined });
        else toast({ title: `${name} failed to deploy`, body: `${(d.error ?? '').slice(0, 120)}${by}`, tone: 'err', duration: 8000, action: svc ? { label: 'Logs', onClick: open } : undefined });
      }
      if (ev.type === 'job.run' && ev.run.status !== 'running') {
        const svc = store.get().current?.services[ev.run.serviceId];
        if (!svc) return;
        const name = svc.name;
        if (ev.run.status === 'failed') toast({ title: `${name} run failed`, body: `exit ${ev.run.exitCode ?? '?'} · ${ev.run.output.split('\n').filter(Boolean).pop()?.slice(0, 100) ?? ''}`, tone: 'err', duration: 7000 });
        else if (ev.run.trigger !== 'schedule') toast({ title: `${name} finished`, body: `exit 0 in ${Math.round(((ev.run.finishedAt ?? Date.now()) - ev.run.startedAt) / 100) / 10}s`, tone: 'ok' });
        return;
      }
      if (ev.type === 'activity') {
        const a = ev.entry;
        if (a.action === 'service.crashloop') toast({ title: 'Crash loop detected', body: a.summary, tone: 'err', duration: 8000 });
        else if (a.action === 'service.autoscaled') toast({ title: 'Autoscaled', body: a.summary, tone: 'signal' });
        else if (a.actorType === 'agent' && !a.action.startsWith('deployment.')) toast({ title: `${a.actor}`, body: a.summary, tone: 'signal' });
      }
    });
  }, []);
  return null;
}
