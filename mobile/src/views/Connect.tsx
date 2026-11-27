import { useEffect, useRef, useState } from 'react';
import { parseAddress } from '../lib/address.ts';
import { call, answers, ApiError } from '../lib/client.ts';
import { servers, type SavedServer } from '../lib/servers.ts';
import { trust, fingerprintRows, commonName, type Inspection } from '../lib/trust.ts';
import { Icon, Spinner } from '../ui/kit.tsx';

type Status = { app?: string; setUp: boolean; authMode: 'password' | 'none'; version: string };

/** "Servify on Pixel 7" reads better in the dashboard's device list than "Android phone". */
function defaultDeviceName(): string {
  const m = navigator.userAgent.match(/Android [\d.]+; ([^;)]+?)(?: Build\/|\)|;)/);
  const model = m?.[1]?.trim();
  if (!model || model === 'K' || /^sdk_/.test(model)) return 'Android phone';
  return model;
}

export function Mark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="#0b0c0a" stroke="rgba(236,235,228,.12)" />
      <g fill="#d4f25a">
        <rect x="7" y="7" width="8" height="8" rx="2" />
        <rect x="17" y="7" width="8" height="8" rx="2" opacity=".55" />
        <rect x="7" y="17" width="8" height="8" rx="2" opacity=".55" />
        <rect x="17" y="17" width="8" height="8" rx="2" opacity=".25" />
      </g>
    </svg>
  );
}

export function Connect({ prefill, reason, onDone, onCancel }: { prefill?: SavedServer; reason?: string; onDone: (id: string) => void; onCancel?: () => void }) {
  const [step, setStep] = useState<'address' | 'trust' | 'password'>('address');
  const [cert, setCert] = useState<{ url: string; host: string; hostname: string; ins: Inspection } | null>(null);
  const [address, setAddress] = useState(prefill?.url ?? '');
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<Status | null>(null);
  const [insecure, setInsecure] = useState(false);
  const [password, setPassword] = useState('');
  const [deviceName, setDeviceName] = useState(prefill?.deviceName ?? defaultDeviceName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pwRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === 'password') setTimeout(() => pwRef.current?.focus(), 250);
  }, [step]);

  const check = async () => {
    setError(null);
    const p = parseAddress(address);
    if (!p.ok) return setError(p.error);
    setBusy(true);
    try {
      // Look at an https:// server's certificate before talking to it. (Checking only after a request failed
      // isn't enough: the WebView may still hold a connection it was allowed to make under a pin since removed.)
      if (!p.insecure && (await certificateStep(p.url, p.host))) return;
      let s: Status;
      try {
        s = await call<Status>(p.url, null, 'GET', '/auth/status', undefined, 10_000);
      } catch (e) {
        if (e instanceof ApiError && e.status === 0 && (await answers(p.url))) {
          throw new ApiError(0, `Something answers at ${p.host}, but it doesn't accept the app. If it's your Servify, update it to a version with phone sign-in, then try again.`);
        }
        throw e;
      }
      if (!s || typeof s !== 'object' || typeof s.setUp !== 'boolean') throw new ApiError(0, `${p.host} answered, but it isn't a Servify.`);
      if (s.app !== 'servify') throw new ApiError(0, 'This Servify is too old for the app. Update it to a version with phone sign-in, then try again.');
      if (s.authMode === 'none') throw new ApiError(0, 'Sign-in is turned off on this Servify (SERVIFY_AUTH=none). Set an owner password to use the app.');
      if (!s.setUp) throw new ApiError(0, "This Servify has no owner password yet. Open its dashboard in a browser once to set one.");
      setUrl(p.url);
      setStatus(s);
      setInsecure(p.insecure);
      setStep('password');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * An https:// address may have a certificate this phone doesn't trust, such as one from Servify's own CA.
   * Look at it (without sending anything) and offer to trust that CA for this server after the user compared
   * its fingerprint. Returns true when the trust step is shown; throws when the certificate can't be trusted.
   */
  const certificateStep = async (u: string, host: string): Promise<boolean> => {
    const ins = await trust.inspect(u).catch(() => null);
    if (!ins || !ins.reachable || !ins.tls) return false; // the request that follows reports what's wrong
    if (ins.systemTrusted && ins.hostMatches) return false; // publicly trusted: the problem is elsewhere
    if (ins.pinned && ins.pinMatches) return false; // already trusted here
    const hostname = new URL(u).hostname.replace(/^\[|\]$/g, '');
    if (!ins.hostMatches) {
      const names = ins.names?.length ? ins.names.join(', ') : commonName(ins.leafSubject);
      throw new ApiError(
        0,
        `The certificate at ${host} is for ${names}, not for ${hostname}. Use an address the certificate names. Servify issues certificates for the domains routed to it, so route a domain to the dashboard and use that.`,
      );
    }
    if (!ins.ca) throw new ApiError(0, ins.caProblem ?? `The certificate at ${host} isn't trusted by this phone.`);
    setCert({ url: u, host, hostname, ins });
    setStep('trust');
    return true;
  };

  const trustIt = async () => {
    if (!cert?.ins.ca) return;
    setError(null);
    setBusy(true);
    try {
      await trust.pin(cert.url, cert.ins.ca.fingerprint);
    } catch (e) {
      setBusy(false);
      return setError((e as Error).message);
    }
    setBusy(false);
    setStep('address');
    setCert(null);
    await check();
  };

  const signIn = async () => {
    setError(null);
    if (!password) return setError('Enter your Servify password.');
    setBusy(true);
    try {
      const r = await call<{ token: string; device: { id: string; name: string } }>(url, null, 'POST', '/auth/device', { password, name: deviceName.trim() || 'Android phone' });
      const id = prefill && prefill.url === url ? prefill.id : `srv_${Date.now().toString(36)}`;
      await servers.add(
        { id, url, label: new URL(url).host, version: status?.version ?? '', deviceName: r.device.name, deviceId: r.device.id, addedAt: Date.now() },
        r.token,
      );
      setPassword('');
      onDone(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <div className="connect">
        <div className="brand">
          <Mark />
          <span className="brand-name">Servify</span>
          <span className="grow" />
          {onCancel && (
            <button className="icon-btn" onClick={onCancel} aria-label="Cancel">
              <Icon name="x" size={20} />
            </button>
          )}
        </div>

        {step === 'trust' && cert?.ins.ca ? (
          <TrustStep
            cert={cert}
            busy={busy}
            error={error}
            onTrust={() => void trustIt()}
            onCancel={() => {
              setStep('address');
              setCert(null);
              setError(null);
            }}
          />
        ) : step === 'address' ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void check();
            }}
          >
            <h2>{prefill ? 'Sign in again' : 'Connect to your Servify'}</h2>
            <p className="dim" style={{ margin: 0 }}>
              {reason ?? 'Enter the address you open the dashboard with. At home that is usually its local IP, away from home your VPN address.'}
            </p>
            <label className="field">
              <span className="label">Server address</span>
              <input
                className="input mono"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="192.168.1.20:7700"
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                autoFocus={!prefill}
              />
            </label>
            <div className="hint">
              Plain http:// works on your home network and VPN. Public addresses need https://. For https:// with Servify's own certificate, the app asks you to check it first.
            </div>
            {error && (
              <div className="error" role="alert">
                <Icon name="alert" size={16} />
                <div>{error}</div>
              </div>
            )}
            <button className="btn btn-primary btn-block" style={{ marginTop: 24 }} disabled={busy} type="submit">
              {busy ? <Spinner /> : 'Continue'}
            </button>
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void signIn();
            }}
          >
            <h2>Sign in</h2>
            <div className="card server-found">
              <Icon name="server" size={18} />
              <div className="grow">
                <div className="mono ellipsis" style={{ fontSize: 13 }}>
                  {new URL(url).host}
                </div>
                <div className="faint" style={{ fontSize: 12 }}>
                  Servify {status?.version}
                  {insecure ? ' · plain http' : ' · https'}
                </div>
              </div>
              <button
                type="button"
                className="link"
                style={{ fontSize: 13, fontWeight: 600 }}
                onClick={() => {
                  setStep('address');
                  setError(null);
                }}
              >
                Change
              </button>
            </div>
            <label className="field">
              <span className="label">Owner password</span>
              <input
                ref={pwRef}
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>
            <label className="field">
              <span className="label">Name this phone</span>
              <input className="input" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} maxLength={60} />
            </label>
            <div className="hint">Shown in the dashboard under Settings → Security, where you can sign this phone out.</div>
            {error && (
              <div className="error" role="alert">
                <Icon name="alert" size={16} />
                <div>{error}</div>
              </div>
            )}
            <button className="btn btn-primary btn-block" style={{ marginTop: 24 }} disabled={busy} type="submit">
              {busy ? <Spinner /> : 'Sign in'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function TrustStep({
  cert,
  busy,
  error,
  onTrust,
  onCancel,
}: {
  cert: { url: string; host: string; hostname: string; ins: Inspection };
  busy: boolean;
  error: string | null;
  onTrust: () => void;
  onCancel: () => void;
}) {
  const ca = cert.ins.ca!;
  const changed = !!cert.ins.pinned && cert.ins.pinned !== ca.fingerprint;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onTrust();
      }}
    >
      <h2>{changed ? 'The certificate changed' : 'Check the certificate'}</h2>
      <p className="dim" style={{ margin: 0 }}>
        <span className="mono">{cert.host}</span>{' '}
        {ca.isLeaf ? 'uses a self-signed certificate' : (
          <>
            uses a certificate from <b>{commonName(ca.subject)}</b>
          </>
        )}
        , which this phone doesn't trust. If it's your Servify, compare the fingerprint below with its local CA: download that in the dashboard
        under Settings → HTTPS and check it with the command below.
      </p>
      {changed && (
        <div className="note" role="alert">
          <Icon name="alert" size={16} />
          <div>
            You trusted a different certificate for this address before ({cert.ins.pinned!.slice(0, 11)}…). Only continue if you know why it changed, for example
            because Servify was set up again.
          </div>
        </div>
      )}
      <div className="card fingerprint">
        <span className="label">SHA-256 fingerprint</span>
        <div className="mono">
          {fingerprintRows(ca.fingerprint).map((r) => (
            <div key={r}>{r}</div>
          ))}
        </div>
      </div>
      <div className="hint">
        On the server: <span className="mono">openssl x509 -noout -fingerprint -sha256 -in servify-local-ca.pem</span>
      </div>
      <div className="hint">
        If they match, this phone trusts this CA for <span className="mono">{cert.host}</span> only, and only for certificates that name {cert.hostname}. If they don't
        match, stop: something may be intercepting the connection.
      </div>
      {error && (
        <div className="error" role="alert">
          <Icon name="alert" size={16} />
          <div>{error}</div>
        </div>
      )}
      <button className="btn btn-primary btn-block" style={{ marginTop: 24 }} disabled={busy} type="submit">
        {busy ? <Spinner /> : 'They match, trust it'}
      </button>
      <button className="btn btn-block" style={{ marginTop: 10 }} type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}
