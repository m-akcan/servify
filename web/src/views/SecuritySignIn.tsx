import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/api.ts';
import { onServerEvent, checkAuth } from '../lib/store.ts';
import { timeAgo } from '../lib/format.ts';
import { passkeysHere, getAssertion, addPasskey, cancelled, needsReauth, type PasskeySignIn, type PasswordSignIn } from '../lib/signin.ts';
import { Button, Badge, Modal, confirmDialog, toast, toastError } from '../components/ui.tsx';
import { Icon } from '../components/Icon.tsx';

type Policy = 'everywhere' | 'private' | 'off';
type Passkey = { id: string; name: string; rpId: string; createdAt: number; lastUsedAt: number | null; deviceType: string; backedUp: boolean; usable: boolean };
type Pairing = { id: string; code: string; name: string; ip: string | null; createdAt: number; expiresAt: number };
type SecurityState = {
  authMode: 'password' | 'none';
  passwordPolicy: Policy;
  passkeys: Passkey[];
  usablePasskeys: number;
  passkeySignIn: PasskeySignIn;
  passwordSignIn: PasswordSignIn;
  session: { browser: boolean; freshUntil: number | null; reauthMinutes: number; idleDays: number; maxDays: number };
  sessions: number;
  devices: number;
  pendingPairings: number;
};

const POLICIES: { id: Policy; title: string; desc: string }[] = [
  { id: 'everywhere', title: 'Everywhere', desc: 'The password works from any network that can reach the dashboard.' },
  { id: 'private', title: 'Private networks only', desc: 'Home, office and VPN addresses (and this machine). From the internet, only passkeys and approved phones get in.' },
  { id: 'off', title: 'Off', desc: 'Passkeys only. Needs at least one passkey; if you lose it, run servify auth reset on the Servify machine.' },
];

export const formatCode = (code: string) => `${code.slice(0, 4)} ${code.slice(4)}`;

function Card({ title, desc, icon, right, children }: { title: string; desc?: ReactNode; icon?: ReactNode; right?: ReactNode; children?: ReactNode }) {
  return (
    <section className="card s-card rise-in">
      <div className="s-card-head">
        {icon && <div className="s-card-icon">{icon}</div>}
        <div className="grow">
          <div className="h3">{title}</div>
          {desc && <div className="s-card-desc">{desc}</div>}
        </div>
        {right}
      </div>
      {children && <div className="s-card-body">{children}</div>}
    </section>
  );
}

/** "Confirm it's you": the password (where the policy allows it here) or a passkey. Resolves true when confirmed. */
function ReauthModal({ state, open, onDone }: { state: SecurityState; open: boolean; onDone: (ok: boolean) => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'password' | 'passkey' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pk = passkeysHere(state.passkeySignIn);
  const hasPasskeyHere = pk.ok && state.passkeys.some((p) => p.rpId === pk.rpId);
  useEffect(() => {
    if (open) {
      setPassword('');
      setError(null);
    }
  }, [open]);
  const run = async (kind: 'password' | 'passkey') => {
    setBusy(kind);
    setError(null);
    try {
      await api.post('/auth/reauth', kind === 'password' ? { password } : await getAssertion());
      onDone(true);
    } catch (e) {
      if (!cancelled(e)) setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal open={open} onClose={() => onDone(false)} width={420}>
      <form
        className="confirm"
        onSubmit={(e) => {
          e.preventDefault();
          void run('password');
        }}
      >
        <div className="confirm-icon" data-tone="signal">
          <Icon name="shield" size={18} />
        </div>
        <h3 className="h2">Confirm it’s you</h3>
        <div className="muted confirm-body">Changing how you sign in needs your password or a passkey (good for {state.session.reauthMinutes} minutes).</div>
        {state.passwordSignIn.allowed ? (
          <input className="input" type="password" placeholder="Owner password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        ) : (
          <div className="faint" style={{ fontSize: 12 }}>{state.passwordSignIn.reason}</div>
        )}
        {error && (
          <div className="auth-error" style={{ justifyContent: 'flex-start' }}>
            <Icon name="alert" size={14} /> {error}
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8, gap: 8, flexWrap: 'wrap' }}>
          <Button type="button" variant="ghost" onClick={() => onDone(false)}>
            Cancel
          </Button>
          {hasPasskeyHere && (
            <Button type="button" variant="secondary" icon="key" loading={busy === 'passkey'} onClick={() => void run('passkey')}>
              Use a passkey
            </Button>
          )}
          {state.passwordSignIn.allowed && (
            <Button type="submit" variant="primary" loading={busy === 'password'} disabled={!password}>
              Confirm
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}

/** Offered right after the first passkey: limit the password to private networks (pre-selected). */
function PolicyOffer({ open, onClose, apply }: { open: boolean; onClose: () => void; apply: (p: Policy) => Promise<void> }) {
  const [choice, setChoice] = useState<Policy>('private');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setChoice('private');
  }, [open]);
  return (
    <Modal open={open} onClose={onClose} width={480}>
      <div className="confirm">
        <div className="confirm-icon" data-tone="signal">
          <Icon name="key" size={18} />
        </div>
        <h3 className="h2">Passkey added</h3>
        <div className="muted confirm-body">Now that you have a passkey, you can stop the password from working over the internet. Where should the password still work?</div>
        <div className="policy-options">
          {POLICIES.filter((p) => p.id !== 'off').map((p) => (
            <label key={p.id} className={`policy-option ${choice === p.id ? 'on' : ''}`}>
              <input type="radio" name="offer-policy" checked={choice === p.id} onChange={() => setChoice(p.id)} />
              <div>
                <b>{p.title}</b>
                <div className="faint" style={{ fontSize: 12 }}>{p.desc}</div>
              </div>
            </label>
          ))}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await apply(choice);
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {choice === 'everywhere' ? 'Keep it as it is' : 'Limit to private networks'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function SignInCards() {
  const [state, setState] = useState<SecurityState | null>(null);
  const [pairings, setPairings] = useState<Pairing[]>([]);
  const [reauth, setReauth] = useState(false);
  const [offer, setOffer] = useState(false);
  const reauthWait = useRef<((ok: boolean) => void) | null>(null);
  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([api.get<SecurityState>('/auth/security'), api.get<Pairing[]>('/auth/pairings')]);
      setState(s);
      setPairings(p);
    } catch (e) {
      toastError(e, 'Could not load sign-in settings');
    }
  }, []);
  useEffect(() => {
    void load();
    return onServerEvent((ev) => {
      if (ev.type === 'auth.pairing') void load();
    });
  }, [load]);
  // Pending requests expire: drop them from the list on time.
  useEffect(() => {
    if (!pairings.length) return;
    const t = setInterval(() => setPairings((ps) => ps.filter((p) => p.expiresAt > Date.now())), 5000);
    return () => clearInterval(t);
  }, [pairings.length]);

  /** Run fn; when the server wants a fresh confirmation, ask for it and run fn once more. */
  const fresh = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      if (!needsReauth(e)) throw e;
      setReauth(true);
      const ok = await new Promise<boolean>((r) => (reauthWait.current = r));
      if (!ok) return undefined;
      return await fn();
    }
  };

  if (!state) return null;
  if (state.authMode === 'none') {
    return (
      <Card title="Sign-in" icon={<Icon name="key" size={17} />} desc="Sign-in is turned off on this Servify (SERVIFY_AUTH=none), so passkeys, the password policy and phone approval don’t apply." />
    );
  }

  const pk = passkeysHere(state.passkeySignIn);
  const browser = state.session.browser;

  const add = async () => {
    try {
      const r = await fresh(() => addPasskey(''));
      if (!r) return;
      toast({ title: 'Passkey added', tone: 'ok' });
      await load();
      if (r.suggestPolicy) setOffer(true);
    } catch (e) {
      if (!cancelled(e)) toastError(e, 'Passkey not added');
    }
  };
  const rename = async (p: Passkey) => {
    const name = window.prompt('Name this passkey', p.name)?.trim();
    if (!name || name === p.name) return;
    try {
      await api.patch(`/auth/passkeys/${p.id}`, { name });
      await load();
    } catch (e) {
      toastError(e);
    }
  };
  const remove = async (p: Passkey) => {
    if (!(await confirmDialog({ title: `Remove ${p.name}?`, body: `It stops signing you in to ${p.rpId}. Also delete it from your password manager or device.`, confirm: 'Remove', danger: true }))) return;
    try {
      if ((await fresh(() => api.del(`/auth/passkeys/${p.id}`))) === undefined) return;
      toast({ title: `Removed ${p.name}` });
      await load();
    } catch (e) {
      toastError(e);
    }
  };
  const setPolicy = async (policy: Policy) => {
    try {
      if ((await fresh(() => api.put('/auth/password-policy', { policy }))) === undefined) return;
      toast({ title: policy === 'everywhere' ? 'The password works everywhere' : policy === 'private' ? 'The password now works on private networks only' : 'Password sign-in is off', tone: 'ok' });
      await load();
    } catch (e) {
      toastError(e);
    }
  };
  const decide = async (p: Pairing, approve: boolean) => {
    if (approve && !(await confirmDialog({ title: `Approve ${p.name}?`, body: <>Only if the phone shows <b className="mono">{formatCode(p.code)}</b>. It will act as you until you sign it out.</>, confirm: 'Approve' }))) return;
    try {
      await api.post(`/auth/pairings/${p.id}/${approve ? 'approve' : 'deny'}`);
      toast({ title: approve ? `Approved ${p.name}` : `Denied ${p.name}`, tone: approve ? 'ok' : 'signal' });
      await load();
    } catch (e) {
      toastError(e);
    }
  };
  const denyAll = async () => {
    try {
      await api.post('/auth/pairings/deny-all');
      await load();
    } catch (e) {
      toastError(e);
    }
  };
  const signOutAll = async () => {
    let phones = false;
    const ok = await confirmDialog({
      title: 'Sign out everywhere?',
      body: (
        <>
          Every dashboard session ends — this one too — and you sign in again.
          <label className="row" style={{ gap: 8, marginTop: 12 }}>
            <input type="checkbox" onChange={(e) => (phones = e.target.checked)} /> Also sign out every phone ({state.devices})
          </label>
        </>
      ),
      confirm: 'Sign out everywhere',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.post('/auth/signout-all', { devices: phones });
      await checkAuth();
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <>
      <Card
        title="Phones waiting for approval"
        icon={<Icon name="phone" size={17} />}
        desc="A phone that can’t use the password asks to be let in and shows a code. Approve it only if the code on the phone matches."
        right={
          pairings.length > 1 ? (
            <Button size="sm" variant="ghost" onClick={() => void denyAll()}>
              Deny all
            </Button>
          ) : undefined
        }
      >
        {pairings.length === 0 ? (
          <div className="faint" style={{ fontSize: 13 }} data-testid="no-pairings">
            None right now. In the app, choose “Approve from the dashboard” and the request shows up here.
          </div>
        ) : (
          <div className="token-list" data-testid="pairings">
            {pairings.map((p) => (
              <div className="token-row" key={p.id}>
                <div className="pair-code mono">{formatCode(p.code)}</div>
                <div className="grow">
                  <b>{p.name}</b>
                  <div className="faint mono" style={{ fontSize: 11, marginTop: 2 }}>
                    {p.ip ?? 'unknown address'}  ·  asked {timeAgo(p.createdAt)}  ·  expires in {Math.max(0, Math.round((p.expiresAt - Date.now()) / 60_000))} min
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => void decide(p, false)}>
                  Deny
                </Button>
                <Button size="sm" variant="primary" onClick={() => void decide(p, true)}>
                  Approve
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card
        title="Passkeys"
        icon={<Icon name="key" size={17} />}
        desc="Sign in with a passkey kept in your password manager (Bitwarden, Vaultwarden, 1Password…) or on your device. A passkey belongs to the host name it was added on."
        right={
          browser && pk.ok ? (
            <Button size="sm" variant="secondary" icon="plus" onClick={() => void add()} data-testid="add-passkey">
              Add a passkey
            </Button>
          ) : undefined
        }
      >
        {!pk.ok && browser && (
          <div className="callout" style={{ marginBottom: 12 }} data-testid="passkeys-unavailable-here">
            <Icon name="info" size={15} />
            <div className="grow">{pk.reason}</div>
          </div>
        )}
        {state.passkeys.length === 0 ? (
          <div className="faint" style={{ fontSize: 13 }}>No passkeys yet.</div>
        ) : (
          <div className="token-list" data-testid="passkey-list">
            {state.passkeys.map((p) => (
              <div className="token-row" key={p.id}>
                <div className="token-icon">
                  <Icon name="key" size={15} />
                </div>
                <div className="grow">
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <b>{p.name}</b>
                    <Badge tone={p.usable ? 'idle' : 'warn'}>{p.rpId}</Badge>
                    {!p.usable && <Badge tone="warn">host no longer served</Badge>}
                  </div>
                  <div className="faint mono" style={{ fontSize: 11, marginTop: 2 }}>
                    added {timeAgo(p.createdAt)}  ·  {p.lastUsedAt ? `used ${timeAgo(p.lastUsedAt)}` : 'never used'}  ·  {p.deviceType === 'multiDevice' ? 'synced' : 'this device only'}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => void rename(p)}>
                  Rename
                </Button>
                {browser && (
                  <Button size="sm" variant="ghost" onClick={() => void remove(p)}>
                    Remove
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Password sign-in" icon={<Icon name="lock" size={17} />} desc="Where the owner password works — in the dashboard and in the phone app. Passkeys and approved phones work everywhere.">
        <div className="policy-options" data-testid="password-policy">
          {POLICIES.map((p) => {
            const disabled = !browser || (p.id === 'off' && state.usablePasskeys === 0);
            return (
              <label key={p.id} className={`policy-option ${state.passwordPolicy === p.id ? 'on' : ''} ${disabled ? 'disabled' : ''}`}>
                <input type="radio" name="password-policy" checked={state.passwordPolicy === p.id} disabled={disabled} onChange={() => void setPolicy(p.id)} />
                <div>
                  <b>{p.title}</b>
                  <div className="faint" style={{ fontSize: 12 }}>
                    {p.desc}
                    {p.id === 'off' && state.usablePasskeys === 0 ? ' Add a passkey first.' : ''}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
        {!state.passwordSignIn.allowed && (
          <div className="faint" style={{ fontSize: 12, marginTop: 10 }}>
            From where you are now, the password is refused.
          </div>
        )}
        {!browser && <div className="faint" style={{ fontSize: 12, marginTop: 10 }}>Change this from the dashboard in a browser.</div>}
      </Card>

      <Card
        title="Sessions"
        icon={<Icon name="logout" size={17} />}
        desc={`Dashboard sessions end after ${state.session.idleDays} days without use, and ${state.session.maxDays} days after signing in at the latest.`}
        right={
          <Button size="sm" variant="danger" onClick={() => void signOutAll()} data-testid="signout-all">
            Sign out everywhere
          </Button>
        }
      >
        <div className="faint" style={{ fontSize: 13 }}>
          {state.sessions} dashboard session{state.sessions === 1 ? '' : 's'} and {state.devices} signed-in phone{state.devices === 1 ? '' : 's'}.
        </div>
      </Card>

      <ReauthModal
        state={state}
        open={reauth}
        onDone={(ok) => {
          setReauth(false);
          reauthWait.current?.(ok);
          reauthWait.current = null;
        }}
      />
      <PolicyOffer open={offer} onClose={() => setOffer(false)} apply={(p) => (p === 'everywhere' ? Promise.resolve() : setPolicy(p))} />
    </>
  );
}
