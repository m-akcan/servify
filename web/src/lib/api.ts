export class ApiError extends Error {
  status: number;
  /** The server's machine-readable reason, e.g. 'safety_backup' (retry with skipSafetyBackup). */
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data: any = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth')) window.dispatchEvent(new CustomEvent('servify:unauthorized'));
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, typeof data?.code === 'string' ? data.code : undefined);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  patch: <T>(p: string, b: unknown) => request<T>('PATCH', p, b),
  put: <T>(p: string, b: unknown) => request<T>('PUT', p, b),
  del: <T>(p: string) => request<T>('DELETE', p),
};

/**
 * Server-Sent Events with automatic reconnect and typed handlers.
 * Exactly one EventSource and at most one pending retry exist at any time — browsers allow only
 * ~6 connections per host, so leaked streams would stall every other request.
 */
export function sse(
  path: string,
  handlers: Record<string, (data: any) => void>,
  onOpen?: () => void,
  opts: { staleMs?: number; onDown?: () => void; pauseWhenHidden?: boolean } = {},
): () => void {
  let es: EventSource | null = null;
  let timer: number | null = null;
  let closed = false;
  let retry = 500;
  let lastSeen = Date.now();
  const staleMs = opts.staleMs ?? 35_000; // the server pings every 15s

  const drop = () => {
    es?.close();
    es = null;
  };
  const schedule = (delay: number) => {
    if (timer !== null) clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      connect();
    }, delay);
  };
  const connect = () => {
    if (closed) return;
    if (opts.pauseWhenHidden && document.hidden) return; // resumes on visibilitychange
    drop();
    const src = new EventSource(`/api${path}`, { withCredentials: true });
    es = src;
    lastSeen = Date.now();
    src.onopen = () => {
      if (es !== src) return;
      retry = 500;
      lastSeen = Date.now();
      onOpen?.();
    };
    src.addEventListener('ping', () => {
      if (es === src) lastSeen = Date.now();
    });
    for (const [event, fn] of Object.entries(handlers)) {
      src.addEventListener(event, (e) => {
        if (es !== src) return; // superseded stream
        lastSeen = Date.now();
        const raw = (e as MessageEvent).data;
        if (!raw) return;
        try {
          fn(JSON.parse(raw));
        } catch {
          fn(raw);
        }
      });
    }
    src.onerror = () => {
      if (es !== src) return; // errors from an old stream are irrelevant
      opts.onDown?.();
      drop();
      if (closed) return;
      schedule(retry);
      retry = Math.min(retry * 2, 8000);
    };
  };
  // Watchdog: a proxy can keep a dead stream "open" forever.
  const watchdog = window.setInterval(() => {
    if (closed || !es || timer !== null || Date.now() - lastSeen < staleMs) return;
    opts.onDown?.();
    drop();
    schedule(0);
  }, 2000);
  const onVisibility = () => {
    if (!opts.pauseWhenHidden || closed) return;
    if (document.hidden) {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      drop();
    } else if (!es && timer === null) connect();
  };
  document.addEventListener('visibilitychange', onVisibility);
  connect();
  return () => {
    closed = true;
    clearInterval(watchdog);
    if (timer !== null) clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    drop();
  };
}
