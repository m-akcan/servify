import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api.ts';
import { useStore } from '../lib/store.ts';
import { navigate } from '../lib/router.ts';
import type { PublicCert } from '../lib/types.ts';
import { Button, Switch, Badge, Empty, Modal, CopyButton, Field, confirmDialog, toast, toastError, Tooltip } from '../components/ui.tsx';
import { Icon, BrandMark, type IconName } from '../components/Icon.tsx';
import { timeAgo } from '../lib/format.ts';

// ───────────────────────────── types ─────────────────────────────

const EVENTS = [
  ['deploy.failed', 'Deploy failed'],
  ['deploy.succeeded', 'Deploy succeeded'],
  ['service.crashed', 'Service down'],
  ['service.recovered', 'Service recovered'],
  ['job.failed', 'Cron job failed'],
  ['backup.failed', 'Backup or restore failed'],
  ['backup.succeeded', 'Backup succeeded'],
  ['cert.failed', 'Certificate failed'],
  ['preview.ready', 'Preview ready'],
  ['server.usage', 'Server disk, memory or CPU high'],
  ['image.update', 'Image update available'],
  ['servify.update', 'Servify updated (or an update failed)'],
] as const;
type EventKey = (typeof EVENTS)[number][0];

type ChannelType = 'slack' | 'discord' | 'telegram' | 'ntfy' | 'email' | 'webhook';
type Channel = {
  id?: string;
  name: string;
  type: ChannelType;
  enabled: boolean;
  events: EventKey[];
  url?: string;
  secret?: string;
  botToken?: string;
  chatId?: string;
  topic?: string;
  smtp?: { host: string; port: number; secure: boolean; user?: string; pass?: string; from: string; to: string };
};
type Destination = { id?: string; name: string; type: 'local' | 's3'; path?: string; endpoint?: string; region?: string; bucket?: string; prefix?: string; accessKeyId?: string; secretAccessKey?: string; forcePathStyle?: boolean };
type Settings = {
  dashboardUrl: string | null;
  https: { enabled: boolean; email: string; staging: boolean; directoryUrl: string | null; redirectHttp: boolean };
  notifications: { channels: Channel[] };
  backups: { destinations: Destination[] };
  webhooks: { secret: string };
  alerts: Alerts;
};
type Alerts = { enabled: boolean; diskPct: number; memPct: number; cpuPct: number };
type Delivery = { ts: number; channelId: string; event: string; ok: boolean; error?: string };
type HookDelivery = { ts: number; provider: string; event: string; repo: string | null; ok: boolean; result: string };

const CHANNEL_META: Record<ChannelType, { label: string; brand?: string; icon?: IconName; hint: string }> = {
  slack: { label: 'Slack', icon: 'hash', hint: 'Incoming webhook URL from a Slack app (api.slack.com/apps → Incoming Webhooks).' },
  discord: { label: 'Discord', brand: 'discord', hint: 'Channel settings → Integrations → Webhooks → Copy URL.' },
  telegram: { label: 'Telegram', brand: 'telegram', hint: 'A bot token from @BotFather and the chat id to post to.' },
  ntfy: { label: 'ntfy', icon: 'bell', hint: 'Push to your phone via ntfy.sh or a self-hosted ntfy server.' },
  email: { label: 'Email', icon: 'mail', hint: 'Any SMTP server — your provider, Gmail app password, Postmark, Resend…' },
  webhook: { label: 'Webhook', icon: 'webhook', hint: 'POSTs JSON to your URL, signed with HMAC-SHA256 when you set a secret.' },
};

function ChannelIcon({ type, size = 18 }: { type: ChannelType; size?: number }) {
  const m = CHANNEL_META[type];
  return m.brand ? <BrandMark icon={m.brand} size={size} /> : <Icon name={m.icon!} size={size} />;
}

const SECTIONS: { id: string; label: string; icon: IconName }[] = [
  { id: 'general', label: 'General', icon: 'sliders' },
  { id: 'https', label: 'HTTPS & domains', icon: 'certificate' },
  { id: 'notifications', label: 'Notifications', icon: 'bell' },
  { id: 'backups', label: 'Backup storage', icon: 'archive' },
  { id: 'webhooks', label: 'Git webhooks', icon: 'webhook' },
  { id: 'security', label: 'Security', icon: 'shield' },
];

// ───────────────────────────── page ─────────────────────────────

export function SettingsView({ section }: { section?: string }) {
  const active = SECTIONS.some((s) => s.id === section) ? section! : 'general';
  const [settings, setSettings] = useState<Settings | null>(null);
  const load = () => api.get<Settings>('/settings').then(setSettings).catch((e) => toastError(e, 'Could not load settings'));
  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="page">
      <div className="page-inner settings-page">
        <div className="rise-in">
          <div className="label">Instance</div>
          <h1 className="h1" style={{ marginTop: 6 }}>
            Settings
          </h1>
        </div>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <button key={s.id} className={active === s.id ? 'on' : ''} onClick={() => navigate(`/settings/${s.id}`, { replace: true })}>
                <Icon name={s.icon} size={15} />
                {s.label}
              </button>
            ))}
          </nav>
          <div className="settings-content" key={active}>
            {!settings ? (
              <div className="faint" style={{ padding: 20 }}>
                Loading…
              </div>
            ) : (
              <>
                {active === 'general' && <General settings={settings} reload={load} />}
                {active === 'https' && <Https settings={settings} reload={load} />}
                {active === 'notifications' && <Notifications settings={settings} reload={load} />}
                {active === 'backups' && <Backups settings={settings} reload={load} />}
                {active === 'webhooks' && <Webhooks settings={settings} reload={load} />}
                {active === 'security' && <Security />}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

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

// ───────────────────────────── general ─────────────────────────────

function General({ settings, reload }: { settings: Settings; reload: () => void }) {
  const system = useStore((s) => s.system);
  const [url, setUrl] = useState(settings.dashboardUrl ?? '');
  const save = async () => {
    try {
      await api.patch('/settings/general', { dashboardUrl: url || null });
      toast({ title: 'Saved', tone: 'ok' });
      reload();
    } catch (e) {
      toastError(e, 'Could not save');
    }
  };
  return (
    <>
      <Card title="Dashboard address" desc="Used for the links in notifications. Leave empty to use this machine's localhost address.">
        <div className="row" style={{ gap: 8 }}>
          <input className="input mono" placeholder={`http://localhost:${system?.api.port ?? 7700}`} value={url} onChange={(e) => setUrl(e.target.value)} />
          <Button variant="primary" size="sm" disabled={(settings.dashboardUrl ?? '') === url} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </Card>
      <StartAtLogin />
      <Updates />
      {system && (
        <Card title="This instance" desc="Configured with environment variables at startup (see the README).">
          <dl className="kv-grid">
            <dt>Version</dt>
            <dd className="mono">{system.version}</dd>
            <dt>Dashboard</dt>
            <dd className="mono">
              {system.api.host}:{system.api.port}
            </dd>
            <dt>HTTP router</dt>
            <dd className="mono">
              {system.proxy.host}:{system.proxy.port}
            </dd>
            <dt>HTTPS router</dt>
            <dd className="mono">
              {system.proxy.host}:{system.proxy.httpsPort}
            </dd>
            <dt>App domain</dt>
            <dd className="mono">*.&lt;project&gt;.{system.proxy.baseDomain}</dd>
            <dt>Docker</dt>
            <dd className="mono">{system.docker.ok ? `${system.docker.version} · ${system.docker.endpoint}` : system.docker.error}</dd>
            <dt>Data</dt>
            <dd className="mono">{system.dataDir}</dd>
          </dl>
        </Card>
      )}
    </>
  );
}

type Autostart = { supported: boolean; kind: 'launchd' | 'systemd' | null; enabled: boolean; supervised: boolean; file: string | null; logFile: string; stale: boolean };

/** "Start Servify at login": a launchd agent / systemd user unit. Changes take effect at the next login. */
function StartAtLogin() {
  const [st, setSt] = useState<Autostart | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .get<Autostart>('/settings/autostart')
      .then(setSt)
      .catch(() => {});
  }, []);
  if (!st) return null;
  const set = async (enabled: boolean) => {
    setBusy(true);
    try {
      setSt(await api.put<Autostart>('/settings/autostart', { enabled }));
      toast({ title: enabled ? 'Servify will start at login' : 'Servify won’t start at login', tone: enabled ? 'ok' : 'idle' });
    } catch (e) {
      toastError(e, 'Could not change it');
    } finally {
      setBusy(false);
    }
  };
  const desc = !st.supported
    ? 'Available on macOS and Linux. On Windows, run Servify with Docker Compose and restart: unless-stopped.'
    : st.enabled
      ? st.supervised
        ? 'On. Servify runs in the background, starts when you log in and restarts on its own if it crashes.'
        : 'On. From your next login Servify starts on its own, in the background. Right now it runs because you started it.'
      : st.supervised
        ? 'Off. Servify keeps running until you log out, then stays off.'
        : 'Off. Servify only runs while you keep it started. Your services keep running in Docker either way, but their addresses and the dashboard need Servify.';
  return (
    <Card
      title="Start Servify at login"
      desc={desc}
      icon={<Icon name="power" size={16} />}
      right={st.supported ? <Switch checked={st.enabled} disabled={busy} onChange={(v) => void set(v)} label="Start Servify at login" /> : undefined}
    >
      {st.enabled && (
        <div className="faint" style={{ fontSize: 12, lineHeight: 1.6 }}>
          {st.kind === 'launchd' ? 'launchd agent' : 'systemd user service'} <code className="inline-code">{st.file}</code> · logs in <code className="inline-code">{st.logFile}</code>
          {st.stale && (
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <span>It was saved with different settings than Servify runs with now.</span>
              <Button size="sm" disabled={busy} onClick={() => void set(true)}>
                Update
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

type Release = { version: string; tag: string; url: string; notes: string; publishedAt: string | null };
type UpdateStatus = {
  version: string;
  installDir: string;
  cannotUpdate: string | null;
  lastCheck: { at: number; release: Release | null; error?: string } | null;
  lastUpdate: { from: string; to: string; state: 'switched' | 'confirmed' | 'rolled-back' | 'failed'; error: string | null; finishedAt: number | null; previousKeptAt: string | null } | null;
};
type UpdateCheck = { current: string; latest: Release | null; available: boolean; error?: string };

/** Updating Servify itself: checks only when asked, installs a release and restarts (rolling back if it can't start). */
function Updates() {
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [phase, setPhase] = useState<'idle' | 'checking' | 'installing' | 'restarting'>('idle');
  const load = () =>
    api
      .get<UpdateStatus>('/system/update')
      .then(setSt)
      .catch(() => setSt(null));
  useEffect(() => {
    void load();
  }, []);
  if (!st) return null;
  const doCheck = async () => {
    setPhase('checking');
    try {
      const r = await api.post<UpdateCheck>('/system/update/check');
      setCheck(r);
      if (r.error) toast({ title: 'Could not check for updates', body: r.error, tone: 'err' });
      else if (!r.available) toast({ title: `${r.current} is the newest version`, tone: 'ok' });
    } catch (e) {
      toastError(e, 'Could not check for updates');
    } finally {
      setPhase('idle');
    }
  };
  const install = async (rel: Release) => {
    const yes = await confirmDialog({
      title: `Update Servify to ${rel.version}?`,
      body: `Servify downloads the release, checks and tests it, saves a copy of its database, then restarts on the new version (the dashboard is gone for a few seconds; your services keep running). If the new version can't start properly, it goes back to ${st.version} on its own.`,
      confirm: 'Update and restart',
    });
    if (!yes) return;
    setPhase('installing');
    try {
      await api.post('/system/update', { version: rel.version });
      setPhase('restarting');
      // Wait for the new version to answer (or the old one, after a rollback).
      const until = Date.now() + 8 * 60_000;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 2000));
        const h = await fetch('/api/health').then((r) => (r.ok ? r.json() : null), () => null);
        if (!h) continue;
        const s = await api.get<UpdateStatus>('/system/update').catch(() => null);
        if (s?.lastUpdate?.state === 'confirmed' && h.version === rel.version) {
          toast({ title: `Updated to ${rel.version}`, tone: 'ok' });
          location.reload();
          return;
        }
        if (s?.lastUpdate && (s.lastUpdate.state === 'rolled-back' || s.lastUpdate.state === 'failed')) {
          toast({ title: `The update to ${rel.version} didn’t work`, body: s.lastUpdate.error ?? undefined, tone: 'err' });
          setSt(s);
          setPhase('idle');
          return;
        }
      }
      toast({ title: 'Still restarting', body: 'Reload this page in a minute.', tone: 'idle' });
      setPhase('idle');
    } catch (e) {
      toastError(e, 'Could not update');
      setPhase('idle');
      void load();
    }
  };
  const last = st.lastUpdate;
  const rel = check?.available ? check.latest : null;
  return (
    <Card
      title="Updates"
      icon={<Icon name="arrowUp" size={16} />}
      desc={`Version ${st.version}. Servify looks for a new release only when you ask.`}
      right={
        <Button size="sm" disabled={phase !== 'idle'} onClick={() => void doCheck()}>
          {phase === 'checking' ? 'Checking…' : 'Check for updates'}
        </Button>
      }
    >
      {rel && (
        <div className="col" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Badge tone="ok">{rel.version} available</Badge>
            {rel.url && (
              <a className="faint" href={rel.url} target="_blank" rel="noreferrer">
                What’s new
              </a>
            )}
          </div>
          {st.cannotUpdate ? (
            <div className="faint" style={{ fontSize: 12.5 }}>
              Can’t update from here: {st.cannotUpdate}.
            </div>
          ) : (
            <div>
              <Button variant="primary" size="sm" disabled={phase !== 'idle'} onClick={() => void install(rel)}>
                {phase === 'installing' ? 'Downloading and testing…' : phase === 'restarting' ? 'Restarting…' : last && last.to === rel.version && last.state !== 'confirmed' ? `Try ${rel.version} again` : `Update to ${rel.version} and restart`}
              </Button>
            </div>
          )}
        </div>
      )}
      {last && last.state !== 'switched' && (
        <div className="faint" style={{ fontSize: 12, lineHeight: 1.6, marginTop: rel ? 10 : 0 }}>
          {last.state === 'confirmed'
            ? `Last update: ${last.from} → ${last.to}${last.finishedAt ? `, ${timeAgo(last.finishedAt)}` : ''}.${last.previousKeptAt ? ` The previous version is kept at ${last.previousKeptAt}.` : ''}`
            : `The last update didn’t work: ${last.error ?? `${last.to} couldn’t be installed`}.`}
        </div>
      )}
    </Card>
  );
}

// ───────────────────────────── HTTPS ─────────────────────────────

function Https({ settings, reload }: { settings: Settings; reload: () => void }) {
  const system = useStore((s) => s.system);
  const [draft, setDraft] = useState(settings.https);
  const [certs, setCerts] = useState<PublicCert[]>([]);
  const [advanced, setAdvanced] = useState(!!settings.https.directoryUrl);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.https);
  const loadCerts = () => api.get<PublicCert[]>('/certs').then(setCerts).catch(() => {});
  useEffect(() => {
    void loadCerts();
    const t = setInterval(loadCerts, 4000);
    return () => clearInterval(t);
  }, []);
  const save = async () => {
    try {
      await api.patch('/settings/https', { ...draft, directoryUrl: draft.directoryUrl || null });
      toast({ title: draft.enabled ? 'HTTPS on — requesting certificates' : 'HTTPS settings saved', tone: 'ok' });
      reload();
      setTimeout(loadCerts, 1500);
    } catch (e) {
      toastError(e, 'Could not save');
    }
  };
  const retry = async (host: string) => {
    try {
      await api.post(`/certs/${encodeURIComponent(host)}/retry`);
      toast({ title: `Requesting a certificate for ${host}`, tone: 'build' });
      setTimeout(loadCerts, 1500);
    } catch (e) {
      toastError(e, 'Could not retry');
    }
  };
  const httpPort = system?.proxy.port ?? 8080;
  const httpsPort = system?.proxy.httpsPort ?? 8443;
  const publicReady = httpPort === 80 && httpsPort === 443 && system?.proxy.host === '0.0.0.0';
  return (
    <>
      <Card
        title="Automatic HTTPS"
        icon={<BrandMark icon="letsencrypt" size={18} />}
        desc="Certificates for your custom domains from Let’s Encrypt, issued and renewed automatically. HTTP requests are redirected to HTTPS."
        right={<Switch checked={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} label="Automatic HTTPS" />}
      >
        <div className="col" style={{ gap: 14 }}>
          <Field label="Contact email" hint="Let’s Encrypt sends expiry warnings here. Never shared with anyone else.">
            <input className="input" type="email" placeholder="you@example.com" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
          </Field>
          <div className="setting-row">
            <div className="grow">
              <div className="title">Redirect HTTP to HTTPS</div>
              <div className="desc">For domains that have a certificate.</div>
            </div>
            <Switch checked={draft.redirectHttp} onChange={(v) => setDraft({ ...draft, redirectHttp: v })} />
          </div>
          <div className="setting-row">
            <div className="grow">
              <div className="title">Use the staging environment</div>
              <div className="desc">Untrusted test certificates with generous rate limits — handy while you set up DNS.</div>
            </div>
            <Switch checked={draft.staging} onChange={(v) => setDraft({ ...draft, staging: v })} />
          </div>
          {advanced ? (
            <Field label="Custom ACME directory" hint="Any ACME CA (ZeroSSL, a private step-ca, Pebble for testing). Overrides the staging switch.">
              <input className="input mono" placeholder="https://acme.example.com/directory" value={draft.directoryUrl ?? ''} onChange={(e) => setDraft({ ...draft, directoryUrl: e.target.value })} />
            </Field>
          ) : (
            <button className="link" style={{ alignSelf: 'flex-start', fontSize: 12 }} onClick={() => setAdvanced(true)}>
              Use a different ACME CA…
            </button>
          )}
          <div className="row">
            <div className="spacer" />
            <Button variant="primary" size="sm" disabled={!dirty} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      </Card>

      <div className={`callout ${publicReady ? 'callout-ok' : 'callout-info'} rise-in`}>
        <Icon name={publicReady ? 'check' : 'info'} size={15} />
        <div className="grow">
          {publicReady ? (
            <>The router listens publicly on ports 80 and 443 — ready to issue certificates once DNS points here.</>
          ) : (
            <>
              To get certificates, point each domain’s DNS at this machine and make ports <b>80</b> and <b>443</b> reach Servify. Right now the router listens on{' '}
              <span className="mono">
                {system?.proxy.host}:{httpPort}
              </span>{' '}
              and <span className="mono">:{httpsPort}</span> — start Servify with <span className="mono">SERVIFY_PROXY_HOST=0.0.0.0 SERVIFY_PROXY_PORT=80 SERVIFY_HTTPS_PORT=443</span> (or forward those ports).
            </>
          )}
        </div>
      </div>

      <Card title="Certificates" desc="One per custom domain (and per app hostname when the app domain is a real domain).">
        {certs.length === 0 ? (
          <Empty icon="certificate" title="No public domains yet" body="Add a custom domain to an HTTP service under Settings → Networking." />
        ) : (
          <div className="cert-list">
            {certs.map((c) => (
              <div className="cert-row" key={c.host}>
                <span className="tls-dot" data-tls={settings.https.enabled ? c.status : 'off'} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="mono">{c.host}</div>
                  <div className="faint truncate" style={{ fontSize: 11.5, marginTop: 2 }}>
                    {!settings.https.enabled
                      ? 'HTTPS is off'
                      : c.status === 'issued'
                        ? `Valid until ${new Date(c.expiresAt!).toLocaleDateString()} · renews automatically`
                        : c.status === 'failed'
                          ? `${c.error}${c.nextAttemptAt ? ` · next try ${new Date(c.nextAttemptAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`
                          : c.lastAttemptAt
                            ? 'Requesting…'
                            : 'Waiting'}
                  </div>
                </div>
                <Badge tone={c.status === 'issued' ? 'ok' : c.status === 'failed' ? 'err' : 'build'} live={c.status === 'pending' && settings.https.enabled}>
                  {c.status}
                </Badge>
                {settings.https.enabled && c.status !== 'pending' && (
                  <Button size="sm" variant="ghost" icon="refresh" onClick={() => void retry(c.host)}>
                    {c.status === 'issued' ? 'Renew' : 'Retry'}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card
        title="HTTPS on this machine"
        icon={<Icon name="lock" size={17} />}
        desc={
          <>
            Every app is also served at <span className="mono">https://&lt;service&gt;.&lt;project&gt;.localhost:{httpsPort}</span> with certificates from a private Servify CA. Trust it once to get a green lock locally.
          </>
        }
        right={
          <a className="btn btn-secondary btn-sm" href="/api/certs/local-ca.pem">
            <Icon name="download" size={14} />
            Local CA
          </a>
        }
      >
        <div className="snippet">
          <div className="snippet-head">
            <span className="label">macOS — trust the downloaded file</span>
            <CopyButton text="sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/Downloads/servify-local-ca.pem" label="Copy" />
          </div>
          <pre className="no-canvas-wheel">sudo security add-trusted-cert -d -r trustRoot \{'\n'}  -k /Library/Keychains/System.keychain ~/Downloads/servify-local-ca.pem</pre>
        </div>
      </Card>
    </>
  );
}

// ───────────────────────────── notifications ─────────────────────────────

function Notifications({ settings, reload }: { settings: Settings; reload: () => void }) {
  const [editing, setEditing] = useState<Channel | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [testing, setTesting] = useState<string | null>(null);
  const loadDeliveries = () => api.get<Delivery[]>('/settings/notifications/deliveries').then(setDeliveries).catch(() => {});
  useEffect(() => {
    void loadDeliveries();
  }, []);
  const channels = settings.notifications.channels;
  const byId = Object.fromEntries(channels.map((c) => [c.id, c]));

  const toggle = async (c: Channel, enabled: boolean) => {
    try {
      await api.post('/settings/notifications/channels', { ...c, enabled });
      reload();
    } catch (e) {
      toastError(e, 'Could not update');
    }
  };
  const test = async (c: Channel) => {
    setTesting(c.id!);
    try {
      const r = await api.post<Delivery>(`/settings/notifications/channels/${c.id}/test`);
      if (r.ok) toast({ title: `Test sent to ${c.name}`, tone: 'ok' });
      else toastError(new Error(r.error ?? 'failed'), `${c.name} rejected the test`);
    } catch (e) {
      toastError(e, 'Test failed');
    } finally {
      setTesting(null);
      void loadDeliveries();
    }
  };
  const remove = async (c: Channel) => {
    if (!(await confirmDialog({ title: `Remove ${c.name}?`, body: 'Servify stops sending notifications there.', confirm: 'Remove', danger: true }))) return;
    await api.del(`/settings/notifications/channels/${c.id}`).catch((e) => toastError(e));
    reload();
  };

  return (
    <>
      <Card
        title="Notification channels"
        desc="Get told when deploys fail, services go down, cron jobs or backups fail — wherever you already look."
        right={
          <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing({ name: 'Slack', type: 'slack', enabled: true, events: ['deploy.failed', 'service.crashed', 'job.failed', 'backup.failed', 'cert.failed', 'server.usage'] })}>
            Add channel
          </Button>
        }
      >
        {channels.length === 0 ? (
          <div className="channel-picker">
            {(Object.keys(CHANNEL_META) as ChannelType[]).map((t) => (
              <button key={t} className="channel-tile" onClick={() => setEditing({ name: CHANNEL_META[t].label, type: t, enabled: true, events: ['deploy.failed', 'service.crashed', 'job.failed', 'backup.failed', 'cert.failed', 'server.usage'] })}>
                <ChannelIcon type={t} size={22} />
                <span>{CHANNEL_META[t].label}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="channel-list">
            {channels.map((c) => (
              <div className="channel-row" key={c.id}>
                <div className="channel-icon">
                  <ChannelIcon type={c.type} />
                </div>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <b>{c.name}</b>
                    <span className="faint" style={{ fontSize: 12 }}>
                      {CHANNEL_META[c.type].label}
                    </span>
                  </div>
                  <div className="faint truncate" style={{ fontSize: 11.5, marginTop: 2 }}>
                    {c.events.map((e) => EVENTS.find((x) => x[0] === e)?.[1] ?? e).join(' · ')}
                  </div>
                </div>
                <Button size="sm" variant="ghost" icon="send" loading={testing === c.id} onClick={() => void test(c)}>
                  Test
                </Button>
                <Tooltip label="Edit">
                  <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setEditing(c)} aria-label="Edit channel">
                    <Icon name="edit" size={14} />
                  </button>
                </Tooltip>
                <Tooltip label="Remove">
                  <button className="btn btn-ghost btn-sm btn-icon" onClick={() => void remove(c)} aria-label="Remove channel">
                    <Icon name="trash" size={14} />
                  </button>
                </Tooltip>
                <Switch checked={c.enabled} onChange={(v) => void toggle(c, v)} label={`${c.name} enabled`} />
              </div>
            ))}
          </div>
        )}
      </Card>
      <UsageAlerts alerts={settings.alerts} reload={reload} />
      {deliveries.length > 0 && (
        <Card title="Recent deliveries">
          <div className="delivery-list">
            {deliveries.slice(0, 12).map((d, i) => (
              <div className="delivery-row" key={i}>
                <span className={`tls-dot`} data-tls={d.ok ? 'issued' : 'failed'} />
                <span className="mono faint" style={{ width: 72 }}>
                  {timeAgo(d.ts)}
                </span>
                <span style={{ width: 120 }} className="truncate">
                  {byId[d.channelId]?.name ?? 'removed'}
                </span>
                <span className="mono faint truncate grow">{d.ok ? d.event : `${d.event} — ${d.error}`}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
      {editing && (
        <ChannelModal
          channel={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function UsageAlerts({ alerts, reload }: { alerts: Alerts; reload: () => void }) {
  const [draft, setDraft] = useState(alerts);
  const dirty = JSON.stringify(draft) !== JSON.stringify(alerts);
  const save = async (next = draft) => {
    try {
      await api.patch('/settings/alerts', next);
      toast({ title: next.enabled ? 'Usage alerts saved' : 'Usage alerts off', tone: 'ok' });
      reload();
    } catch (e) {
      toastError(e, 'Could not save');
    }
  };
  const pct = (key: 'diskPct' | 'memPct' | 'cpuPct', label: string, hint: string, min: number, max: number) => (
    <Field label={label} hint={hint}>
      <div className="row" style={{ gap: 6 }}>
        <input className="input mono" type="number" min={min} max={max} style={{ width: 80 }} disabled={!draft.enabled} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })} />
        <span className="faint">%</span>
      </div>
    </Field>
  );
  return (
    <Card
      title="Usage alerts"
      desc="Sent to the channels above that have “Server disk, memory or CPU high” ticked — for this machine and every connected server. Once when a figure crosses the line, once when it's back."
      right={
        <Switch
          checked={draft.enabled}
          onChange={(v) => {
            const next = { ...draft, enabled: v };
            setDraft(next);
            void save(next);
          }}
          label="Usage alerts"
        />
      }
    >
      <div className="alert-thresholds">
        {pct('diskPct', 'Disk', 'Alerts as soon as it’s crossed.', 50, 99)}
        {pct('memPct', 'Memory', 'After 5 minutes above.', 50, 99)}
        {pct('cpuPct', 'CPU', 'After 10 minutes above.', 50, 100)}
      </div>
      {dirty && (
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <Button size="sm" variant="ghost" onClick={() => setDraft(alerts)}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={() => void save()}>
            Save
          </Button>
        </div>
      )}
    </Card>
  );
}

function ChannelModal({ channel, onClose, onSaved }: { channel: Channel; onClose: () => void; onSaved: () => void }) {
  const [c, setC] = useState<Channel>(channel);
  const [saving, setSaving] = useState(false);
  const isNew = !channel.id;
  const meta = CHANNEL_META[c.type];
  const smtp = c.smtp ?? { host: '', port: 587, secure: false, from: '', to: '' };
  const set = (patch: Partial<Channel>) => setC({ ...c, ...patch });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/settings/notifications/channels', { ...c, smtp: c.type === 'email' ? smtp : undefined });
      toast({ title: isNew ? `${c.name} added` : 'Channel saved', body: isNew ? 'Use “Test” to check it end to end.' : undefined, tone: 'ok' });
      onSaved();
    } catch (err) {
      toastError(err, 'Could not save');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open onClose={onClose} width={560}>
      <form onSubmit={save} className="modal-body col" style={{ gap: 16 }}>
        <div className="h2">{isNew ? 'Add a notification channel' : `Edit ${channel.name}`}</div>
        {isNew && (
          <div className="channel-picker compact">
            {(Object.keys(CHANNEL_META) as ChannelType[]).map((t) => (
              <button type="button" key={t} className={`channel-tile ${c.type === t ? 'on' : ''}`} onClick={() => set({ type: t, name: c.name && c.name !== CHANNEL_META[c.type].label ? c.name : CHANNEL_META[t].label })}>
                <ChannelIcon type={t} size={18} />
                <span>{CHANNEL_META[t].label}</span>
              </button>
            ))}
          </div>
        )}
        <div className="faint" style={{ fontSize: 12.5, marginTop: -4 }}>
          {meta.hint}
        </div>
        <Field label="Name">
          <input className="input" required value={c.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        {(c.type === 'slack' || c.type === 'discord' || c.type === 'webhook') && (
          <Field label={c.type === 'webhook' ? 'URL' : 'Webhook URL'}>
            <input className="input mono" required placeholder={c.type === 'slack' ? 'https://hooks.slack.com/services/…' : c.type === 'discord' ? 'https://discord.com/api/webhooks/…' : 'https://example.com/servify'} value={c.url ?? ''} onChange={(e) => set({ url: e.target.value })} />
          </Field>
        )}
        {c.type === 'webhook' && (
          <Field label="Signing secret" hint="Optional. Requests carry X-Servify-Signature: sha256=<hmac of the body>.">
            <input className="input mono" value={c.secret ?? ''} onChange={(e) => set({ secret: e.target.value })} />
          </Field>
        )}
        {c.type === 'telegram' && (
          <div className="ns-grid">
            <Field label="Bot token">
              <input className="input mono" required value={c.botToken ?? ''} onChange={(e) => set({ botToken: e.target.value })} />
            </Field>
            <Field label="Chat id">
              <input className="input mono" required placeholder="-1001234567890" value={c.chatId ?? ''} onChange={(e) => set({ chatId: e.target.value })} />
            </Field>
          </div>
        )}
        {c.type === 'ntfy' && (
          <div className="ns-grid">
            <Field label="Topic">
              <input className="input mono" required placeholder="my-servify-alerts" value={c.topic ?? ''} onChange={(e) => set({ topic: e.target.value })} />
            </Field>
            <Field label="Server">
              <input className="input mono" placeholder="https://ntfy.sh" value={c.url ?? ''} onChange={(e) => set({ url: e.target.value })} />
            </Field>
            <Field label="Access token" hint="Only for protected topics.">
              <input className="input mono" value={c.secret ?? ''} onChange={(e) => set({ secret: e.target.value })} />
            </Field>
          </div>
        )}
        {c.type === 'email' && (
          <>
            <div className="ns-grid">
              <Field label="SMTP host">
                <input className="input mono" required placeholder="smtp.example.com" value={smtp.host} onChange={(e) => set({ smtp: { ...smtp, host: e.target.value } })} />
              </Field>
              <Field label="Port">
                <input className="input mono" type="number" value={smtp.port} onChange={(e) => set({ smtp: { ...smtp, port: Number(e.target.value), secure: Number(e.target.value) === 465 } })} />
              </Field>
              <Field label="Username">
                <input className="input mono" autoComplete="off" value={smtp.user ?? ''} onChange={(e) => set({ smtp: { ...smtp, user: e.target.value } })} />
              </Field>
              <Field label="Password">
                <input className="input mono" type="password" autoComplete="new-password" value={smtp.pass ?? ''} onChange={(e) => set({ smtp: { ...smtp, pass: e.target.value } })} />
              </Field>
              <Field label="From">
                <input className="input" required placeholder="Servify <alerts@example.com>" value={smtp.from} onChange={(e) => set({ smtp: { ...smtp, from: e.target.value } })} />
              </Field>
              <Field label="To">
                <input className="input" required placeholder="you@example.com" value={smtp.to} onChange={(e) => set({ smtp: { ...smtp, to: e.target.value } })} />
              </Field>
            </div>
            <div className="setting-row">
              <div className="grow">
                <div className="title">TLS from the start (port 465)</div>
                <div className="desc">Off uses STARTTLS when the server offers it.</div>
              </div>
              <Switch checked={smtp.secure} onChange={(v) => set({ smtp: { ...smtp, secure: v } })} />
            </div>
          </>
        )}
        <Field label="Notify me about">
          <div className="event-grid">
            {EVENTS.map(([k, label]) => {
              const on = c.events.includes(k);
              return (
                <button type="button" key={k} className={`chip ${on ? 'chip-on' : ''}`} onClick={() => set({ events: on ? c.events.filter((x) => x !== k) : [...c.events, k] })}>
                  {on && <Icon name="check" size={12} />}
                  {label}
                </button>
              );
            })}
          </div>
        </Field>
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={saving} disabled={!c.events.length}>
            {isNew ? 'Add channel' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ───────────────────────────── backups ─────────────────────────────

function Backups({ settings, reload }: { settings: Settings; reload: () => void }) {
  const [editing, setEditing] = useState<Destination | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const test = async (d: Destination) => {
    setTesting(d.id!);
    try {
      const r = await api.post<{ ok: boolean; error?: string }>(`/settings/backups/destinations/${d.id}/test`);
      if (r.ok) toast({ title: `${d.name} works`, body: 'Wrote, read back and deleted a test file.', tone: 'ok' });
      else toastError(new Error(r.error), `${d.name} failed`);
    } finally {
      setTesting(null);
    }
  };
  const remove = async (d: Destination) => {
    if (!(await confirmDialog({ title: `Remove ${d.name}?`, body: 'Existing backups stay where they are, but Servify forgets this destination. Services using it fall back to this machine.', confirm: 'Remove', danger: true }))) return;
    await api.del(`/settings/backups/destinations/${d.id}`).catch((e) => toastError(e));
    reload();
  };
  return (
    <>
      <Card
        title="Backup destinations"
        desc="Where service backups are stored. Pick one per service in its Backups tab."
        right={
          <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing({ name: '', type: 's3', region: 'us-east-1', forcePathStyle: false })}>
            Add destination
          </Button>
        }
      >
        <div className="channel-list">
          {settings.backups.destinations.map((d) => (
            <div className="channel-row" key={d.id}>
              <div className="channel-icon">
                <Icon name={d.type === 's3' ? 'cloud' : 'database'} size={17} />
              </div>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 8 }}>
                  <b>{d.name}</b>
                  {d.id === 'local' && <span className="badge">built in</span>}
                </div>
                <div className="faint mono truncate" style={{ fontSize: 11.5, marginTop: 2 }}>
                  {d.type === 's3' ? `s3://${d.bucket}${d.prefix ? `/${d.prefix}` : ''} · ${d.endpoint ?? `AWS ${d.region ?? 'us-east-1'}`}` : d.path}
                </div>
              </div>
              <Button size="sm" variant="ghost" icon="check" loading={testing === d.id} onClick={() => void test(d)}>
                Test
              </Button>
              {d.id !== 'local' && (
                <>
                  <Tooltip label="Edit">
                    <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setEditing(d)} aria-label="Edit destination">
                      <Icon name="edit" size={14} />
                    </button>
                  </Tooltip>
                  <Tooltip label="Remove">
                    <button className="btn btn-ghost btn-sm btn-icon" onClick={() => void remove(d)} aria-label="Remove destination">
                      <Icon name="trash" size={14} />
                    </button>
                  </Tooltip>
                </>
              )}
            </div>
          ))}
        </div>
      </Card>
      <div className="callout callout-info rise-in">
        <Icon name="info" size={15} />
        <div className="grow">Works with AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO and any other S3-compatible storage. Credentials are encrypted at rest and never shown again after saving.</div>
      </div>
      {editing && (
        <DestinationModal
          dest={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function DestinationModal({ dest, onClose, onSaved }: { dest: Destination; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Destination>(dest);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<Destination>) => setD({ ...d, ...patch });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/settings/backups/destinations', { ...d, endpoint: d.endpoint || undefined, prefix: d.prefix || undefined });
      toast({ title: 'Destination saved', body: 'Use “Test” to check the credentials.', tone: 'ok' });
      onSaved();
    } catch (err) {
      toastError(err, 'Could not save');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open onClose={onClose} width={560}>
      <form onSubmit={save} className="modal-body col" style={{ gap: 16 }}>
        <div className="h2">{dest.id ? `Edit ${dest.name}` : 'Add a backup destination'}</div>
        <div className="channel-picker compact">
          {(['s3', 'local'] as const).map((t) => (
            <button type="button" key={t} className={`channel-tile ${d.type === t ? 'on' : ''}`} onClick={() => set({ type: t })}>
              <Icon name={t === 's3' ? 'cloud' : 'folder'} size={18} />
              <span>{t === 's3' ? 'S3-compatible' : 'Folder'}</span>
            </button>
          ))}
        </div>
        <Field label="Name">
          <input className="input" required placeholder={d.type === 's3' ? 'Offsite (R2)' : 'NAS'} value={d.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        {d.type === 'local' ? (
          <Field label="Folder" hint="An absolute path on this machine — e.g. a mounted NAS or external disk.">
            <input className="input mono" required placeholder="/Volumes/backup/servify" value={d.path ?? ''} onChange={(e) => set({ path: e.target.value })} />
          </Field>
        ) : (
          <>
            <div className="ns-grid">
              <Field label="Bucket">
                <input className="input mono" required value={d.bucket ?? ''} onChange={(e) => set({ bucket: e.target.value })} />
              </Field>
              <Field label="Region">
                <input className="input mono" placeholder="us-east-1 · auto for R2" value={d.region ?? ''} onChange={(e) => set({ region: e.target.value })} />
              </Field>
            </div>
            <Field label="Endpoint" hint="Leave empty for AWS. R2: https://<account>.r2.cloudflarestorage.com · MinIO: http://host:9000">
              <input className="input mono" placeholder="https://…" value={d.endpoint ?? ''} onChange={(e) => set({ endpoint: e.target.value })} />
            </Field>
            <div className="ns-grid">
              <Field label="Access key">
                <input className="input mono" required autoComplete="off" value={d.accessKeyId ?? ''} onChange={(e) => set({ accessKeyId: e.target.value })} />
              </Field>
              <Field label="Secret key">
                <input className="input mono" type="password" required autoComplete="new-password" value={d.secretAccessKey ?? ''} onChange={(e) => set({ secretAccessKey: e.target.value })} />
              </Field>
            </div>
            <Field label="Folder prefix" hint="Optional, e.g. servify/">
              <input className="input mono" value={d.prefix ?? ''} onChange={(e) => set({ prefix: e.target.value })} />
            </Field>
            <div className="setting-row">
              <div className="grow">
                <div className="title">Path-style URLs</div>
                <div className="desc">Needed for MinIO and most self-hosted stores.</div>
              </div>
              <Switch checked={d.forcePathStyle ?? !!d.endpoint} onChange={(v) => set({ forcePathStyle: v })} />
            </div>
          </>
        )}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={saving}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ───────────────────────────── git webhooks ─────────────────────────────

function Webhooks({ settings, reload }: { settings: Settings; reload: () => void }) {
  const system = useStore((s) => s.system);
  const [reveal, setReveal] = useState(false);
  const [deliveries, setDeliveries] = useState<HookDelivery[]>([]);
  const [provider, setProvider] = useState<'github' | 'gitlab' | 'gitea'>('github');
  const load = () => api.get<HookDelivery[]>('/settings/webhooks/deliveries').then(setDeliveries).catch(() => {});
  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const rotate = async () => {
    if (!(await confirmDialog({ title: 'Rotate the webhook secret?', body: 'Existing webhooks stop working until you paste the new secret into them. Deploy hook URLs change too.', confirm: 'Rotate', danger: true }))) return;
    await api.post('/settings/webhooks/rotate').catch((e) => toastError(e));
    reload();
  };
  const routerUrl = `https://<your-public-host>/_servify/hooks/git`;
  const localUrl = `http://localhost:${system?.proxy.port ?? 8080}/_servify/hooks/git`;
  const steps: Record<typeof provider, ReactNode[]> = {
    github: [
      <>Repository → Settings → Webhooks → <b>Add webhook</b></>,
      <>Payload URL: your public address + <span className="mono">/_servify/hooks/git</span></>,
      <>Content type <span className="mono">application/json</span>, and paste the secret below</>,
      <>Events: <b>Pushes</b> (and <b>Pull requests</b> for preview environments)</>,
    ],
    gitlab: [
      <>Project → Settings → Webhooks → <b>Add new webhook</b></>,
      <>URL: your public address + <span className="mono">/_servify/hooks/git</span></>,
      <>Secret token: paste the secret below</>,
      <>Triggers: <b>Push events</b> (and <b>Merge request events</b> for previews)</>,
    ],
    gitea: [
      <>Repository → Settings → Webhooks → <b>Add webhook → Gitea</b> (Forgejo works the same)</>,
      <>Target URL: your public address + <span className="mono">/_servify/hooks/git</span>, POST, application/json</>,
      <>Secret: paste the secret below</>,
      <>Trigger on <b>Push</b> (and <b>Pull request</b> for previews)</>,
    ],
  };
  return (
    <>
      <Card title="Deploy on push" icon={<BrandMark icon="github" size={18} />} desc="Git services with auto-deploy deploy the moment you push, instead of waiting for the once-a-minute check.">
        <div className="col" style={{ gap: 14 }}>
          <div className="seg-tabs">
            {(['github', 'gitlab', 'gitea'] as const).map((p) => (
              <button key={p} className={provider === p ? 'on' : ''} onClick={() => setProvider(p)}>
                <BrandMark icon={p} size={14} />
                {p === 'github' ? 'GitHub' : p === 'gitlab' ? 'GitLab' : 'Gitea / Forgejo'}
              </button>
            ))}
          </div>
          <ol className="steps">
            {steps[provider].map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          <Field label="Payload URL" hint="Served by the Servify router on any hostname, so it works wherever your apps are reachable — including through a tunnel.">
            <div className="row" style={{ gap: 6 }}>
              <input className="input mono" readOnly value={routerUrl} onFocus={(e) => e.currentTarget.select()} />
              <CopyButton text={routerUrl} label="Copy" />
            </div>
          </Field>
          <Field label="Secret">
            <div className="row" style={{ gap: 6 }}>
              <input className="input mono" readOnly type={reveal ? 'text' : 'password'} value={settings.webhooks.secret} />
              <Tooltip label={reveal ? 'Hide' : 'Show'}>
                <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setReveal(!reveal)} aria-label="Show secret">
                  <Icon name={reveal ? 'eyeOff' : 'eye'} size={14} />
                </button>
              </Tooltip>
              <CopyButton text={settings.webhooks.secret} label="Copy" />
              <Button size="sm" variant="ghost" icon="refresh" onClick={() => void rotate()}>
                Rotate
              </Button>
            </div>
          </Field>
          <div className="faint" style={{ fontSize: 12 }}>
            Test it locally: <span className="mono">{localUrl}</span>
          </div>
        </div>
      </Card>
      <Card title="Recent deliveries" desc="The last webhooks Servify received, and what it did with them.">
        {deliveries.length === 0 ? (
          <Empty icon="webhook" title="Nothing received yet" body="After you add the webhook, your git host sends a ping — it shows up here." />
        ) : (
          <div className="delivery-list">
            {deliveries.slice(0, 15).map((d, i) => (
              <div className="delivery-row" key={i}>
                <span className="tls-dot" data-tls={d.ok ? 'issued' : 'failed'} />
                <span className="mono faint" style={{ width: 72 }}>
                  {timeAgo(d.ts)}
                </span>
                <span style={{ width: 130 }} className="truncate">
                  {d.provider} · {d.event}
                </span>
                <span className="grow truncate">{d.result}</span>
                <span className="mono faint truncate" style={{ maxWidth: 200 }}>
                  {d.repo ?? ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

// ───────────────────────────── security ─────────────────────────────

type Device = { id: string; name: string; prefix: string; createdAt: number; lastUsedAt: number | null; current?: boolean };

/** Phones signed in with the Servify app. Each holds its own token; signing one out ends it at once. */
function Devices() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const load = () => api.get<Device[]>('/devices').then(setDevices).catch(() => setDevices([]));
  useEffect(() => {
    void load();
  }, []);
  const signOut = async (d: Device) => {
    if (!(await confirmDialog({ title: `Sign out ${d.name}?`, body: 'The app on that phone stops working until you sign in on it again.', confirm: 'Sign out', danger: true }))) return;
    try {
      await api.del(`/devices/${d.id}`);
      toast({ title: `Signed out ${d.name}` });
      void load();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Card title="Signed-in devices" icon={<Icon name="phone" size={17} />} desc="Phones signed in with the Servify app. They act as you, so sign out any you no longer use.">
      {devices === null ? null : devices.length === 0 ? (
        <div className="faint" style={{ fontSize: 13 }}>No phones yet. In the app, enter this Servify's address and your password.</div>
      ) : (
        <div className="token-list">
          {devices.map((d) => (
            <div className="token-row" key={d.id}>
              <div className="token-icon">
                <Icon name="phone" size={15} />
              </div>
              <div className="grow">
                <b>{d.name}</b>
                <div className="faint mono" style={{ fontSize: 11, marginTop: 2 }}>
                  signed in {timeAgo(d.createdAt)}  ·  {d.lastUsedAt ? `used ${timeAgo(d.lastUsedAt)}` : 'never used'}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => void signOut(d)}>
                Sign out
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Security() {
  const system = useStore((s) => s.system) as any;
  const mk = system?.masterKey as { source: 'env' | 'file' | 'created'; path: string | null } | undefined;
  return (
    <>
      <Card title="Secrets encryption" icon={<Icon name="lock" size={17} />} desc="Service variables, git tokens, notification credentials, storage keys and certificate keys are encrypted at rest with AES-256-GCM.">
        <dl className="kv-grid">
          <dt>Master key</dt>
          <dd className="mono">{mk?.source === 'env' ? 'from SERVIFY_MASTER_KEY' : mk?.path ?? '—'}</dd>
        </dl>
        <div className="callout callout-warn" style={{ marginTop: 14 }}>
          <Icon name="alert" size={15} />
          <div className="grow">
            Back this key up somewhere safe. Without it, stored secrets can't be decrypted — Servify refuses to start rather than lose them. Set <span className="mono">SERVIFY_MASTER_KEY</span> to keep the key out of the data folder.
          </div>
        </div>
      </Card>
      <Devices />
      <Card title="Access" icon={<Icon name="shield" size={17} />} desc="Who can reach this Servify.">
        <ul className="plain-list">
          <li>The dashboard and API listen on <span className="mono">{system?.api.host}</span> — {system?.api.host === '127.0.0.1' ? 'only this machine' : 'reachable from your network'}.</li>
          <li>{system?.authMode === 'none' ? 'Password login is turned off (SERVIFY_AUTH=none).' : 'An owner password protects the dashboard; sessions expire after 30 days.'}</li>
          <li>
            Agents use API tokens — manage them on the <button className="link" onClick={() => navigate('/agents')}>Agents page</button>. Only the owner can change these settings.
          </li>
        </ul>
      </Card>
    </>
  );
}
