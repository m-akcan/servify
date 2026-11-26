import { secure } from './secure.ts';

/** A Servify the app has signed in to. The token itself lives in the secure store, not here. */
export type SavedServer = {
  id: string;
  url: string;
  /** Shown in lists: the address host, or a name the user picks. */
  label: string;
  version: string;
  deviceName: string;
  deviceId: string;
  addedAt: number;
};

const LIST_KEY = 'servify.servers';
const ACTIVE_KEY = 'servify.active';

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: the app still works for this session */
  }
}

export const servers = {
  list(): SavedServer[] {
    return read<SavedServer[]>(LIST_KEY, []);
  },
  activeId(): string | null {
    return read<string | null>(ACTIVE_KEY, null);
  },
  setActive(id: string | null) {
    write(ACTIVE_KEY, id);
  },
  async add(s: SavedServer, token: string) {
    await secure.set(`token:${s.id}`, token);
    write(LIST_KEY, [...servers.list().filter((x) => x.id !== s.id), s]);
    servers.setActive(s.id);
  },
  update(id: string, patch: Partial<SavedServer>) {
    write(LIST_KEY, servers.list().map((s) => (s.id === id ? { ...s, ...patch } : s)));
  },
  async remove(id: string) {
    await secure.remove(`token:${id}`);
    const rest = servers.list().filter((s) => s.id !== id);
    write(LIST_KEY, rest);
    if (servers.activeId() === id) servers.setActive(rest[0]?.id ?? null);
  },
  token(id: string): Promise<string | null> {
    return secure.get(`token:${id}`);
  },
};
