import { useEffect, useState } from 'react';
import { useSession } from '../session.tsx';
import { appUpdate, checkForAppUpdate, currentOffer, dismiss, dismissedCode, onOffer, type AppUpdate } from '../lib/appupdate.ts';
import { Icon, confirmSheet, toastError } from '../ui/kit.tsx';

type Phase = 'idle' | 'downloading' | 'installing' | 'waiting';

const mb = (n: number) => `${(n / 1024 ** 2).toFixed(1)} MB`;

/**
 * "Update available: X.Y.Z" when the signed-in Servify offers a newer app. Only mounted while signed in, so never
 * while the app is locked. Checks when the app opens and when it comes back (at most every 6 hours).
 */
export function UpdateBanner() {
  const { server, api, token } = useSession();
  const [offer, setOffer] = useState<AppUpdate | null>(currentOffer());
  const [dismissed, setDismissed] = useState(dismissedCode());
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      onOffer((u) => {
        setOffer(u);
        setDismissed(dismissedCode());
      }),
    [],
  );
  useEffect(() => {
    const run = () => void checkForAppUpdate(server.id, api).catch(() => {});
    run();
    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [server.id, api]);
  useEffect(() => appUpdate.onProgress(setProgress), []);
  useEffect(
    () =>
      appUpdate.onInstallStatus((s) => {
        if (s.status === 'pending_user_action') setPhase('waiting');
        if (s.status === 'failed') {
          setPhase('idle');
          setError(s.message ? `Android didn't install the update: ${s.message}` : 'The update was cancelled.');
        }
      }),
    [],
  );

  if (!appUpdate.available || !offer) return null;
  if (phase === 'idle' && !error && offer.versionCode <= dismissed) return null;

  const start = async () => {
    setError(null);
    const st = await appUpdate.status().catch((e) => {
      toastError(e);
      return null;
    });
    if (!st) return;
    if (!st.canInstall) {
      const ok = await confirmSheet({
        title: 'Allow Servify to install its updates',
        body: 'Android only installs apps from sources you allow. On the next screen, turn on “Allow from this source” for Servify, then come back and tap Update again. Servify only installs an update that is signed with the same key as this app.',
        confirm: 'Open Android settings',
      });
      if (ok) await appUpdate.openInstallSettings().catch(toastError);
      return;
    }
    setPhase('downloading');
    setProgress(null);
    try {
      // Ask again first: the offer may be up to 6 hours old, and the server may have mirrored a newer app since.
      const fresh = await checkForAppUpdate(server.id, api, { force: true });
      if (!fresh) {
        setPhase('idle');
        return;
      }
      await appUpdate.download(server.url, token, fresh);
      setPhase('installing');
      await appUpdate.install();
      setPhase('waiting');
    } catch (e) {
      setPhase('idle');
      setError((e as Error)?.message ?? String(e));
    }
  };

  const pct = progress && progress.total > 0 ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : 0;
  return (
    <div className="update-banner" role="status">
      <div className="update-row">
        <Icon name="download" size={18} />
        <div className="grow">
          <div className="title">Update available: {offer.versionName}</div>
          <div className="meta">
            {phase === 'downloading'
              ? `Downloading from your Servify… ${progress ? `${mb(progress.received)} of ${mb(progress.total)}` : ''}`
              : phase === 'installing'
                ? 'Checking the download and opening the installer…'
                : phase === 'waiting'
                  ? 'Confirm the update in Android’s installer. Servify restarts afterwards.'
                  : `From ${new URL(server.url).host} · ${mb(offer.size)}`}
          </div>
        </div>
        {phase === 'idle' && (
          <>
            <button className="btn btn-primary btn-small" onClick={() => void start()}>
              Update
            </button>
            <button
              className="icon-btn"
              aria-label="Not now"
              onClick={() => {
                dismiss(offer.versionCode);
                setDismissed(offer.versionCode);
                setError(null);
              }}
            >
              <Icon name="x" size={18} />
            </button>
          </>
        )}
      </div>
      {phase === 'downloading' && (
        <div className="update-progress" aria-label={`${pct}%`}>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
      {error && (
        <div className="update-error" role="alert">
          <Icon name="alert" size={14} />
          <div>{error}</div>
        </div>
      )}
    </div>
  );
}
