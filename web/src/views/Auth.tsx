import { useState } from 'react';
import { api } from '../lib/api.ts';
import { checkAuth } from '../lib/store.ts';
import { Button } from '../components/ui.tsx';
import { Logo } from './Shell.tsx';
import { Icon } from '../components/Icon.tsx';

export function AuthScreen({ setUp }: { setUp: boolean }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);
  const creating = !setUp;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (creating && password !== confirm) {
      setError('Passwords don’t match');
      setShake((n) => n + 1);
      return;
    }
    setBusy(true);
    try {
      await api.post(creating ? '/auth/setup' : '/auth/login', { password });
      await checkAuth();
    } catch (err) {
      setError((err as Error).message);
      setShake((n) => n + 1);
    } finally {
      setBusy(false);
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
          {creating ? 'Your private, local-first platform. Choose an owner password to secure the dashboard.' : 'Enter your owner password to continue.'}
        </p>
        <input
          className="input input-lg"
          type="password"
          placeholder={creating ? 'New password (6+ characters)' : 'Password'}
          autoFocus
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
        {error && (
          <div className="auth-error">
            <Icon name="alert" size={14} /> {error}
          </div>
        )}
        <Button variant="primary" size="lg" type="submit" loading={busy} style={{ width: '100%', marginTop: 16 }} iconRight="arrowRight">
          {creating ? 'Create & continue' : 'Sign in'}
        </Button>
        <div className="auth-foot">
          <Icon name="lock" size={12} /> Everything stays on this machine. No telemetry, no cloud.
        </div>
      </form>
    </div>
  );
}
