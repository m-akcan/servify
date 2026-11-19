import { EventEmitter } from 'node:events';
import type { ServerEvent, ActivityEntry } from './types.ts';
import { activityTable } from './db.ts';
import { id } from './util.ts';

class Bus extends EventEmitter {
  publish(ev: ServerEvent) {
    this.emit('event', ev);
  }
  subscribe(fn: (ev: ServerEvent) => void): () => void {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}

export const bus = new Bus();
bus.setMaxListeners(0);

/** Who is performing an action — threaded through the service layer so agent actions are attributable. */
export type Actor = { type: 'user' | 'agent' | 'system'; name: string };
export const SYSTEM: Actor = { type: 'system', name: 'servify' };

export function recordActivity(actor: Actor, action: string, summary: string, projectId: string | null = null, serviceId: string | null = null) {
  const entry: ActivityEntry = {
    id: id('act'),
    ts: Date.now(),
    actorType: actor.type,
    actor: actor.name,
    projectId,
    serviceId,
    action,
    summary,
  };
  activityTable.insert({ ...entry, createdAt: entry.ts });
  bus.publish({ type: 'activity', entry });
  return entry;
}
