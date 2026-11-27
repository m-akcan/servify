import { useState } from 'react';
import { api } from '../lib/api.ts';
import { checkAuth, useStore } from '../lib/store.ts';
import { passkeysHere, signInWithPasskey, cancelled } from '../lib/signin.ts';
import { Button } from '../components/ui.tsx';
import { Logo } from './Shell.tsx';
import { Icon } from '../components/Icon.tsx';

export function AuthScreen({ setUp }: { setUp: boolean }) {
  const auth = useStore((s) => s.auth);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'password' | 'passkey' | null>(null);
  const [shake, setShake] = useState(0);
  const creating = !setUp;
  const passkey = passkeysHere(auth.passkeySignIn);
  const passwordOk = creating || auth.passwordSignIn?.allowed !== false;

  const fail = (err: unknown) => {
    setError((err as Error).message);
    setShake((n) => n + 1);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (creating && password !== confirm) return fail(new Error('Passwords don’t match'));
    setBusy('password');
    try {
      await api.post(creating ? '/auth/setup' : '/auth/login', { password });
      await checkAuth();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const withPasskey = async () => {
    setError(null);
    setBusy('passkey');
    try {
      await signInWithPasskey();
      await checkAuth();
    } catch (err) {
      if (!cancelled(err)) fail(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="auth">
      <div className="auth-grid" />
      <form className="auth-card rise-in" onSubmit={submit} key={shake} data-shake={shake > 0}>
        <div className="auth-logo">
          <Logo size={40} />
        </div>
        <h1 className="h1" style={{ fontSize: 24 }}>
          {creating ? 'Welcome to Servify' : 'Welcome back'}
        </h1>
        <p className="muted" style={{ margin: '4px 0 22px' }}>
          {creating ? 'Your private, local-first platform. Choose an owner password to secure the dashboard.' : passwordOk ? 'Enter your owner password to continue.' : 'Sign in with your passkey to continue.'}
        </p>
        {!creating && passkey.ok && (
          <>
            <Button variant={passwordOk ? 'secondary' : 'primary'} size="lg" type="button" loading={busy === 'passkey'} onClick={() => void withPasskey()} style={{ width: '100%' }} icon="key" data-testid="passkey-signin">
              Sign in with a passkey
            </Button>
            {passwordOk && <div className="auth-or">or</div>}
          </>
        )}
        {passwordOk ? (
          <>
            <input
              className="input input-lg"
              type="password"
              placeholder={creating ? 'New password (6+ characters)' : 'Password'}
              autoFocus={creating || !passkey.ok}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={creating ? 'new-password' : 'current-password'}
            />
            {creating && (
              <input
                className="input input-lg"
                type="password"
                placeholder="Confirm password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                style={{ marginTop: 10 }}
              />
            )}
          </>
        ) : (
          <div className="auth-note" data-testid="password-refused">
            <Icon name="lock" size={13} /> {auth.passwordSignIn && !auth.passwordSignIn.allowed ? auth.passwordSignIn.reason : ''}
          </div>
        )}
        {error && (
          <div className="auth-error">
            <Icon name="alert" size={14} /> {error}
          </div>
        )}
        {passwordOk && (
          <Button variant="primary" size="lg" type="submit" loading={busy === 'password'} style={{ width: '100%', marginTop: 16 }} iconRight="arrowRight">
            {creating ? 'Create & continue' : 'Sign in'}
          </Button>
        )}
        {!creating && !passkey.ok && auth.authMode !== 'none' && (
          <div className="auth-note" data-testid="passkey-unavailable">
            <Icon name="key" size={13} /> {passkey.reason}
          </div>
        )}
        <div className="auth-foot">
          <Icon name="lock" size={12} /> Everything stays on this machine. No telemetry, no cloud.
        </div>
      </form>
    </div>
  );
}
