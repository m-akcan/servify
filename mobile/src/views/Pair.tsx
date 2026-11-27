/**
 * Signing in by approval from the dashboard (Servify's pairing API), for when password sign-in is limited or off.
 *
 * The app asks for a pairing, shows the code, and polls; the owner compares the code on a signed-in device and
 * approves. The approving poll carries a normal device token, exactly once. Everything goes through `call()`, the
 * WebView fetch that the per-server certificate pinning already covers. Poll answers are never logged.
 */
import { useEffect, useRef, useState } from 'react';
import { call, ApiError } from '../lib/client.ts';
import { Icon, Spinner } from '../ui/kit.tsx';

type Device = { id: string; name: string };
type Started = { pairingId: string; code: string; expiresAt: number };
type Poll = { status: 'pending' | 'approved' | 'denied' | 'expired'; expiresAt?: number; token?: string; device?: Device };

type Phase =
  | { kind: 'starting' }
  | { kind: 'waiting'; code: string; deadline: number }
  | { kind: 'finishing' }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'throttled'; message: string; until: number }
  | { kind: 'error'; message: string };

const POLL_MS = 2500;

export function formatCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function PairStep({
  url,
  name,
  note,
  onApproved,
  onCancel,
}: {
  url: string;
  name: string;
  /** Why the app switched here (e.g. the server refused the password). */
  note?: string | null;
  /** Store the token like the password flow does and go on into the app. */
  onApproved: (token: string, device: Device) => Promise<void>;
  onCancel: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [offline, setOffline] = useState(false);
  const [now, setNow] = useState(Date.now());
  const gen = useRef(0); // bumped on cancel and on every new start: an older loop stops at its next check
  const alive = useRef(true);
  const started = useRef(false);
  const wake = useRef<(() => void) | null>(null);

  const live = (my: number) => alive.current && gen.current === my;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t);
        if (wake.current === done) wake.current = null;
        resolve();
      };
      const t = setTimeout(done, ms);
      wake.current = done;
    });

  /** A token that arrived after the user left this screen: sign it out again so no stray device stays listed. */
  const discard = (token: string) => void call(url, token, 'DELETE', '/auth/device').catch(() => {});

  const poll = async (my: number, pairingId: string, deadline: number) => {
    let delay = POLL_MS;
    while (live(my)) {
      await sleep(delay);
      if (!live(my)) return;
      delay = POLL_MS;
      try {
        const p = await call<Poll>(url, null, 'GET', `/auth/pair/${encodeURIComponent(pairingId)}`, undefined, 10_000);
        if (p?.status === 'approved' && typeof p.token === 'string' && p.device) {
          if (!live(my)) return discard(p.token);
          setPhase({ kind: 'finishing' });
          try {
            await onApproved(p.token, p.device);
          } catch (e) {
            discard(p.token);
            if (alive.current) setPhase({ kind: 'error', message: `Approved, but this phone couldn't save the sign-in: ${(e as Error).message}` });
          }
          return;
        }
        if (!live(my)) return;
        setOffline(false);
        if (p?.status === 'denied') return setPhase({ kind: 'denied' });
        if (p?.status === 'expired') return setPhase({ kind: 'expired' });
        // pending: keep going
      } catch (e) {
        if (!live(my)) return;
        const err = e instanceof ApiError ? e : new ApiError(0, (e as Error).message);
        if (err.status === 404) return setPhase({ kind: 'expired' });
        if (err.status === 429) {
          delay = Math.max(POLL_MS, (err.retryAfter ?? 5) * 1000);
          continue;
        }
        if (err.status === 0) {
          // Unreachable for a moment (Wi-Fi/VPN switching): keep trying until the pairing can't be alive any more.
          if (Date.now() > deadline + 60_000) return setPhase({ kind: 'expired' });
          setOffline(true);
          continue;
        }
        return setPhase({ kind: 'error', message: err.message });
      }
    }
  };

  const start = async () => {
    const my = ++gen.current;
    setOffline(false);
    setPhase({ kind: 'starting' });
    let r: Started;
    try {
      r = await call<Started>(url, null, 'POST', '/auth/pair/start', { name: name.trim().slice(0, 60) || 'Android phone' });
      if (!r || typeof r.pairingId !== 'string' || typeof r.code !== 'string') throw new ApiError(0, "The server's answer wasn't a pairing request. Update Servify and try again.");
    } catch (e) {
      if (!live(my)) return;
      const err = e as ApiError;
      if (err.status === 429) return setPhase({ kind: 'throttled', message: err.message, until: Date.now() + (err.retryAfter ?? 60) * 1000 });
      return setPhase({ kind: 'error', message: err.message });
    }
    if (!live(my)) return; // cancelled meanwhile: the request simply expires on the server
    // The countdown is for display only (phone and server clocks may differ); the server decides when it expires.
    let ttl = typeof r.expiresAt === 'number' ? r.expiresAt - Date.now() : NaN;
    if (!(ttl > 5_000 && ttl <= 10 * 60_000)) ttl = 5 * 60_000;
    const deadline = Date.now() + ttl;
    setPhase({ kind: 'waiting', code: r.code, deadline });
    void poll(my, r.pairingId, deadline);
  };

  // Entered by a tap (or right after the server refused the password): start once.
  useEffect(() => {
    alive.current = true;
    if (!started.current) {
      started.current = true;
      void start();
    }
    // Coming back to the app (e.g. after approving on the dashboard on this same phone): ask right away.
    const onVisible = () => {
      if (document.visibilityState === 'visible') wake.current?.();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive.current = false;
      wake.current?.();
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Countdown ticks.
  useEffect(() => {
    if (phase.kind !== 'waiting' && phase.kind !== 'throttled') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase.kind]);

  const cancel = () => {
    gen.current++;
    wake.current?.();
    onCancel();
  };

  const host = new URL(url).host;
  const errorBox = (message: string) => (
    <div className="error" role="alert">
      <Icon name="alert" size={16} />
      <div>{message}</div>
    </div>
  );

  return (
    <div>
      <h2>Approve this phone</h2>
      {note && (
        <div className="note" role="status" style={{ marginTop: 12 }}>
          <Icon name="alert" size={16} />
          <div>{note}</div>
        </div>
      )}

      {phase.kind === 'starting' || phase.kind === 'finishing' ? (
        <div className="pair-wait">
          <Spinner />
          <span className="dim">{phase.kind === 'starting' ? `Asking ${host} for a code…` : 'Approved. Signing in…'}</span>
        </div>
      ) : phase.kind === 'waiting' ? (
        <>
          <p className="dim" style={{ margin: '12px 0 0' }}>
            Open Servify on a signed-in device → <b>Settings → Security</b> (or the toast) and approve this code.
          </p>
          <div className="card pair-code" aria-label={`Code ${phase.code.split('').join(' ')}`}>
            <span className="mono">{formatCode(phase.code)}</span>
          </div>
          <div className="pair-wait" style={{ marginTop: 12 }}>
            <Spinner />
            <span className="dim">
              {offline
                ? `Can't reach ${host}. Still trying…`
                : phase.deadline > now
                  ? `Waiting for approval · ${clock(phase.deadline - now)}`
                  : 'Waiting for the server…'}
            </span>
          </div>
          <div className="hint">
            Only approve if the code on the dashboard matches exactly. The request is listed as <b>{name.trim() || 'Android phone'}</b> on {host}.
          </div>
        </>
      ) : phase.kind === 'denied' ? (
        <>
          {errorBox('The request was denied on the dashboard.')}
          <button className="btn btn-primary btn-block" style={{ marginTop: 24 }} onClick={() => void start()}>
            Start again
          </button>
        </>
      ) : phase.kind === 'expired' ? (
        <>
          <p className="dim" style={{ margin: '12px 0 0' }}>
            The code expired before it was approved. Codes last five minutes.
          </p>
          <button className="btn btn-primary btn-block" style={{ marginTop: 24 }} onClick={() => void start()}>
            Get a new code
          </button>
        </>
      ) : phase.kind === 'throttled' ? (
        <>
          {errorBox(phase.message)}
          <button className="btn btn-primary btn-block" style={{ marginTop: 24 }} disabled={phase.until > now} onClick={() => void start()}>
            {phase.until > now ? `Try again in ${clock(phase.until - now)}` : 'Try again'}
          </button>
        </>
      ) : (
        <>
          {errorBox(phase.message)}
          <button className="btn btn-primary btn-block" style={{ marginTop: 24 }} onClick={() => void start()}>
            Try again
          </button>
        </>
      )}

      {phase.kind !== 'finishing' && (
        <button className="btn btn-block" style={{ marginTop: 10 }} type="button" onClick={cancel}>
          {phase.kind === 'waiting' || phase.kind === 'starting' ? 'Cancel' : 'Back'}
        </button>
      )}
    </div>
  );
}
