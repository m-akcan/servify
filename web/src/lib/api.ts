export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
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

/** Server-Sent Events with automatic reconnect and typed handlers. */
export function sse(path: string, handlers: Record<string, (data: any) => void>, onOpen?: () => void): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let retry = 500;
  const connect = () => {
    if (closed) return;
    es = new EventSource(`/api${path}`, { withCredentials: true });
    es.onopen = () => {
      retry = 500;
      onOpen?.();
    };
    for (const [event, fn] of Object.entries(handlers)) {
      es.addEventListener(event, (e) => {
        const raw = (e as MessageEvent).data;
        if (!raw) return;
        try {
          fn(JSON.parse(raw));
        } catch {
          fn(raw);
        }
      });
    }
    es.onerror = () => {
      es?.close();
      if (closed) return;
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 8000);
    };
  };
  connect();
  return () => {
    closed = true;
    es?.close();
  };
}
