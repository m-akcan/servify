/**
 * Server-Sent Events over fetch, so the token goes in the Authorization header (EventSource can't
 * send headers, and a token in the URL would end up in logs). Reconnects with backoff and treats a
 * stream that goes quiet for longer than the server's ping interval as dead.
 */
import { appHeaders } from './appversion.ts';

export type StreamHandlers = Record<string, (data: any) => void>;

export function openStream(
  base: string,
  token: string,
  path: string,
  handlers: StreamHandlers,
  opts: { onState?: (live: boolean) => void; staleMs?: number } = {},
): () => void {
  let closed = false;
  let ctrl: AbortController | null = null;
  let retry = 1000;
  let lastSeen = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const staleMs = opts.staleMs ?? 40_000; // Servify pings every 15s

  const dispatch = (event: string, data: string) => {
    lastSeen = Date.now();
    const fn = handlers[event];
    if (!fn || !data) return;
    try {
      fn(JSON.parse(data));
    } catch {
      fn(data);
    }
  };

  const connect = async () => {
    if (closed) return;
    ctrl = new AbortController();
    const mine = ctrl;
    try {
      const res = await fetch(`${base}/api${path}`, {
        headers: { ...appHeaders(base), authorization: `Bearer ${token}`, accept: 'text/event-stream' },
        credentials: 'omit',
        cache: 'no-store',
        signal: mine.signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      retry = 1000;
      lastSeen = Date.now();
      opts.onState?.(true);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      let event = 'message';
      let data: string[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (line === '') {
            dispatch(event, data.join('\n'));
            event = 'message';
            data = [];
          } else if (line.startsWith(':')) {
            lastSeen = Date.now();
          } else {
            const i = line.indexOf(':');
            const field = i < 0 ? line : line.slice(0, i);
            const val = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
            if (field === 'event') event = val;
            else if (field === 'data') data.push(val);
          }
        }
      }
      throw new Error('stream ended');
    } catch {
      if (closed || mine !== ctrl) return;
      opts.onState?.(false);
      timer = setTimeout(() => {
        timer = null;
        void connect();
      }, retry);
      retry = Math.min(retry * 2, 15_000);
    }
  };

  const watchdog = setInterval(() => {
    if (closed || !ctrl || timer || Date.now() - lastSeen < staleMs) return;
    ctrl.abort(); // the catch above schedules the reconnect
  }, 5000);

  const onVisible = () => {
    // Phones suspend network in the background; reconnect right away when the app comes back.
    if (document.visibilityState === 'visible' && Date.now() - lastSeen > 20_000 && !closed) {
      if (timer) clearTimeout(timer);
      timer = null;
      ctrl?.abort();
      void connect();
    }
  };
  document.addEventListener('visibilitychange', onVisible);
  void connect();

  return () => {
    closed = true;
    clearInterval(watchdog);
    if (timer) clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
    ctrl?.abort();
  };
}
