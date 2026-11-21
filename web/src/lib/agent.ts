import { api } from './api.ts';
import { toast, toastError } from '../components/ui.tsx';
import type { PublicServer } from './types.ts';

/** Update a server's agent in place (Servify writes the new script into the agent's container and restarts it). */
export async function upgradeAgent(server: Pick<PublicServer, 'id' | 'name'>): Promise<boolean> {
  try {
    const r = await api.post<{ upgraded: boolean; version: string }>(`/servers/${server.id}/agent/upgrade`);
    toast({ title: r.upgraded ? `${server.name}: agent updated to ${r.version}` : `${server.name}: agent is already ${r.version}`, tone: 'ok' });
    return true;
  } catch (err) {
    toastError(err, `Could not update the agent on ${server.name}`);
    return false;
  }
}
