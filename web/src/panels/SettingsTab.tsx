import { useEffect, useState } from 'react';
import type { ServiceView, Protocol } from '../lib/types.ts';
import { api } from '../lib/api.ts';
import { Button, Segmented, Switch, Field, Stepper, toastError, toast, Tooltip, CopyButton } from '../components/ui.tsx';
import { navigate } from '../lib/router.ts';
import { openVolumeDialog, detachVolume, bytes } from '../lib/volumes.tsx';
import { Icon } from '../components/Icon.tsx';
import { remove, stop, start } from '../lib/actions.ts';
import { useStore } from '../lib/store.ts';
import { describeCron } from '../lib/format.ts';

async function patch(id: string, body: Record<string, unknown>, quiet = false) {
  try {
    await api.patch(`/services/${id}`, body);
    if (!quiet) toast({ title: 'Saved', tone: 'ok', duration: 1600 });
    return true;
  } catch (e) {
    toastError(e, 'Could not save');
    return false;
  }
}

/** Text input that commits on blur / Enter and resyncs from the server. */
function CommitInput({ value, onCommit, placeholder, mono, type = 'text', disabled }: { value: string; onCommit: (v: string) => void; placeholder?: string; mono?: boolean; type?: string; disabled?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    if (v !== value) onCommit(v);
  };
  return (
    <input
      className={`input ${mono ? 'mono' : ''}`}
      value={v}
      type={type}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setV(value);
      }}
      spellCheck={false}
    />
  );
}

function Section({ title, desc, children, icon }: { title: string; desc?: string; children: React.ReactNode; icon: any }) {
  return (
    <section className="section">
      <div className="section-head">
        <div className="section-icon">
          <Icon name={icon} size={15} />
        </div>
        <div className="grow">
          <div className="section-title">{title}</div>
          {desc && <div className="section-desc">{desc}</div>}
        </div>
      </div>
      <div className="section-body">{children}</div>
    </section>
  );
}

const PRESETS: [string, string][] = [
  ['*/5 * * * *', 'Every 5 min'],
  ['@hourly', 'Hourly'],
  ['0 3 * * *', 'Daily 03:00'],
  ['0 9 * * 1-5', 'Weekdays 09:00'],
  ['@weekly', 'Weekly'],
];

function ScheduleField({ service: s }: { service: ServiceView }) {
  return (
    <>
      <Field label="Cron expression" hint={s.schedule ? `${describeCron(s.schedule)}${(s.deployedSchedule ?? null) !== s.schedule ? ' · takes effect on the next deploy (replicas are replaced by scheduled runs)' : ''}` : s.deployedSchedule ? 'Cleared — deploy to switch back to always-on replicas' : 'Empty = a normal always-on service'}>
        <CommitInput mono value={s.schedule ?? ''} placeholder="e.g. */15 * * * *" onCommit={(v) => void patch(id(s), { schedule: v || null })} />
      </Field>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {PRESETS.map(([v, l]) => (
          <button key={v} type="button" className={`chip ${s.schedule === v ? 'chip-on' : ''}`} onClick={() => void patch(id(s), { schedule: v })}>
            {l}
          </button>
        ))}
        {s.schedule && (
          <button type="button" className="chip" onClick={() => void patch(id(s), { schedule: null })}>
            <Icon name="x" size={11} /> Clear
          </button>
        )}
      </div>
    </>
  );
}
const id = (s: ServiceView) => s.id;

function ServiceVolumes({ service: s }: { service: ServiceView }) {
  const vols = useStore((st) => st.current?.volumes);
  const attached = s.volumes.map((m) => ({ m, v: m.volumeId ? vols?.[m.volumeId] : undefined }));
  return (
    <>
      {attached.map(({ m, v }) => (
        <div key={m.volumeId ?? m.name} className="setting-row volume-row">
          <Icon name="database" size={14} />
          <span className="mono">{m.name}</span>
          <Icon name="arrowRight" size={12} className="faint" />
          <span className="mono grow truncate">{m.mountPath}</span>
          {v && <span className="faint mono" style={{ fontSize: 11 }}>{bytes(v.sizeBytes)}</span>}
          {s.activeDeploymentId && !s.stopped && (
            <a className="btn btn-ghost btn-sm" href={`/api/services/${s.id}/volumes/${encodeURIComponent(m.name)}/download`} download>
              <Icon name="download" size={14} />
              Download
            </a>
          )}
          {v && (
            <Button size="sm" variant="ghost" icon="link" onClick={() => void detachVolume(v)}>
              Detach
            </Button>
          )}
        </div>
      ))}
      <div className="row">
        <Button icon="plus" onClick={() => openVolumeDialog({ kind: 'attach', serviceId: s.id })}>
          Attach volume
        </Button>
        <span className="faint" style={{ fontSize: 12 }}>
          A new empty one, or a detached volume from this project.
        </span>
      </div>
    </>
  );
}

function tlsLabel(info?: ServiceView['domainInfo'][number]) {
  if (!info) return 'HTTP';
  if (info.tls === 'issued') return `HTTPS · certificate valid until ${info.expiresAt ? new Date(info.expiresAt).toLocaleDateString() : '?'}`;
  if (info.tls === 'pending') return 'HTTPS · requesting a certificate…';
  if (info.tls === 'failed') return `HTTPS · certificate failed: ${info.error ?? 'unknown error'}`;
  if (info.tls === 'local') return 'Local name — served with the Servify local CA on the HTTPS port';
  return 'HTTP only — turn on HTTPS in Settings';
}

function DeployHook({ serviceId }: { serviceId: string }) {
  const [path, setPath] = useState<string | null>(null);
  const system = useStore((st) => st.system);
  useEffect(() => {
    api.get<{ path: string }>(`/services/${serviceId}/deploy-hook`).then((r) => setPath(r.path)).catch(() => setPath(null));
  }, [serviceId]);
  if (!path) return null;
  const url = `http://<your-host>:${system?.proxy.port ?? 8080}${path}`;
  return (
    <Field label="Deploy hook" hint="POST to this URL from CI to deploy. Served by the router, so it works wherever your apps are reachable.">
      <div className="row" style={{ gap: 6 }}>
        <input className="input mono" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        <CopyButton text={url.replace('<your-host>', 'localhost')} label="Copy" />
      </div>
    </Field>
  );
}

export function SettingsTab({ service: s }: { service: ServiceView }) {
  const proxyPort = useStore((st) => st.current?.proxyPort ?? 8080);
  const project = useStore((st) => st.current?.project);
  const [domainDraft, setDomainDraft] = useState('');
  const id = s.id;
  const src = s.source;

  return (
    <div className="settings">
      <Section title="General" icon="edit">
        <Field label="Name">
          <CommitInput value={s.name} onCommit={(v) => void patch(id, { name: v })} />
        </Field>
      </Section>

      <Section title="Source" icon={src.type === 'git' ? 'github' : src.type === 'local' ? 'folder' : 'box'} desc="Changes apply on the next deploy.">
        <Segmented
          value={src.type}
          onChange={(t) => {
            if (t === src.type) return;
            if (t === 'image') void patch(id, { image: 'nginx:alpine' });
            if (t === 'git') void patch(id, { repo: 'https://github.com/owner/repo' });
            if (t === 'local') void patch(id, { path: '/path/to/project' });
          }}
          options={[
            { value: 'image', label: 'Image' },
            { value: 'git', label: 'Git' },
            { value: 'local', label: 'Local folder' },
          ]}
        />
        {src.type === 'image' && (
          <Field label="Image">
            <CommitInput mono value={src.image} onCommit={(v) => void patch(id, { image: v })} />
          </Field>
        )}
        {src.type === 'git' && (
          <>
            <Field label="Repository">
              <CommitInput mono value={src.repo} onCommit={(v) => void patch(id, { repo: v })} />
            </Field>
            <div className="ns-grid">
              <Field label="Branch">
                <CommitInput mono value={src.branch ?? ''} placeholder="default" onCommit={(v) => void patch(id, { branch: v })} />
              </Field>
              <Field label="Root directory">
                <CommitInput mono value={src.rootDir ?? ''} placeholder="/" onCommit={(v) => void patch(id, { rootDir: v })} />
              </Field>
              <Field label="Dockerfile">
                <CommitInput mono value={src.dockerfile ?? ''} placeholder="auto" onCommit={(v) => void patch(id, { dockerfile: v })} />
              </Field>
              <Field label="Access token">
                <CommitInput mono type="password" value={src.token ?? ''} placeholder="for private repos" onCommit={(v) => void patch(id, { token: v })} />
              </Field>
            </div>
            <div className="setting-row">
              <div className="grow">
                <div className="title">Auto-deploy on push</div>
                <div className="desc">
                  Instant with a git webhook (<button className="link" onClick={() => navigate('/settings/webhooks')}>set one up</button>); otherwise checked every minute.
                </div>
              </div>
              <Switch checked={s.autoDeploy} onChange={(v) => void patch(id, { autoDeploy: v })} />
            </div>
          </>
        )}
        <DeployHook serviceId={s.id} />
        {src.type === 'local' && (
          <div className="ns-grid">
            <Field label="Path">
              <CommitInput mono value={src.path} onCommit={(v) => void patch(id, { path: v })} />
            </Field>
            <Field label="Dockerfile">
              <CommitInput mono value={src.dockerfile ?? ''} placeholder="auto" onCommit={(v) => void patch(id, { path: src.path, dockerfile: v })} />
            </Field>
          </div>
        )}
        {src.type !== 'image' && (
          <Field label="Build command" hint="Overrides the detected build step (zero-config builds only)">
            <CommitInput mono value={s.buildCommand ?? ''} placeholder="auto" onCommit={(v) => void patch(id, { buildCommand: v || null })} />
          </Field>
        )}
        <Field label="Start command" hint="Runs via /bin/sh -c, replacing the image's default command">
          <CommitInput mono value={s.startCommand ?? ''} placeholder="image default" onCommit={(v) => void patch(id, { startCommand: v || null })} />
        </Field>
        {(s.cmd?.length || s.entrypoint?.length) && (
          <div className="setting-row">
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="title">Container arguments</div>
              <div className="desc mono truncate">
                {s.entrypoint?.length ? `entrypoint ${JSON.stringify(s.entrypoint)} · ` : ''}
                {s.cmd?.length ? `command ${JSON.stringify(s.cmd)}` : 'image command'}
              </div>
              <div className="desc">{s.startCommand ? 'Ignored while a start command is set.' : 'Overrides only what is listed, like Docker Compose (from an import).'}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => void patch(id, { cmd: null, entrypoint: null })}>
              Clear
            </Button>
          </div>
        )}
      </Section>

      <Section title="Schedule" icon="clock" desc="Run this service as a cron job: a one-off container on a schedule instead of always-on replicas.">
        <ScheduleField service={s} />
      </Section>

      <Section title="Networking" icon="globe">
        <Segmented<Protocol>
          value={s.protocol}
          onChange={(v) => void patch(id, { protocol: v })}
          options={[
            { value: 'http', label: 'HTTP' },
            { value: 'tcp', label: 'TCP' },
            { value: 'none', label: 'Worker' },
          ]}
        />
        {s.protocol !== 'none' && (
          <Field label="Container port" hint="Auto-detected from EXPOSE when empty. PORT is injected into the container.">
            <CommitInput mono value={s.port ? String(s.port) : ''} placeholder="auto" onCommit={(v) => void patch(id, { port: v ? Number(v) : null })} />
          </Field>
        )}
        {s.protocol === 'http' && (
          <>
            <div className="setting-row">
              <div className="grow">
                <div className="title">Public domain</div>
                <div className="desc mono">
                  {s.slug}.{project?.slug}.localhost:{proxyPort}
                </div>
              </div>
              <Switch checked={s.publicHttp} onChange={(v) => void patch(id, { publicHttp: v })} />
            </div>
            <Field
              label="Custom domains"
              hint={
                <>
                  Point the domain's DNS at this machine. With HTTPS on (<button className="link" onClick={() => navigate('/settings/https')}>Settings → HTTPS</button>) Servify gets a certificate automatically.
                </>
              }
            >
              <div className="domain-list">
                {s.domains.map((d) => {
                  const info = s.domainInfo?.find((x) => x.domain === d);
                  return (
                  <span key={d} className="chip mono domain-chip" data-tls={info?.tls ?? 'off'}>
                    <Tooltip label={tlsLabel(info)}>
                      <span className="tls-dot" />
                    </Tooltip>
                    <a href={info?.url ?? `http://${d}`} target="_blank" rel="noreferrer">
                      {d}
                    </a>
                    <button onClick={() => void patch(id, { domains: s.domains.filter((x) => x !== d) })} aria-label={`Remove ${d}`}>
                      <Icon name="x" size={12} />
                    </button>
                  </span>
                  );
                })}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!domainDraft.trim()) return;
                    void patch(id, { domains: [...s.domains, domainDraft.trim()] }).then((ok) => ok && setDomainDraft(''));
                  }}
                  className="row"
                  style={{ flex: 1, minWidth: 200 }}
                >
                  <input className="input mono" placeholder="app.example.com" value={domainDraft} onChange={(e) => setDomainDraft(e.target.value)} />
                  <Button type="submit" size="sm" icon="plus" disabled={!domainDraft.trim()}>
                    Add
                  </Button>
                </form>
              </div>
            </Field>
          </>
        )}
        {s.protocol !== 'none' && (
          <div className="setting-row">
            <div className="grow">
              <div className="title">TCP proxy</div>
              <div className="desc">{s.publicTcpPort ? `Reachable at localhost:${s.publicTcpPort} — load balanced across replicas` : 'Expose a raw TCP port on this machine (databases, gRPC, …)'}</div>
            </div>
            {s.publicTcpPort && (
              <div style={{ width: 96 }}>
                <CommitInput mono value={String(s.publicTcpPort)} onCommit={(v) => void patch(id, { publicTcpPort: Number(v) || null })} />
              </div>
            )}
            <Switch checked={!!s.publicTcpPort} onChange={(v) => void patch(id, { publicTcpPort: v ? 0 : null })} />
          </div>
        )}
      </Section>

      {s.protocol !== 'none' && (
        <Section title="Health checks" icon="pulse" desc="Replicas only receive traffic once healthy. Failing replicas are taken out of rotation.">
          <div className="ns-grid">
            <Field label="HTTP path" hint={s.protocol === 'http' ? 'Empty = TCP connect check' : 'TCP connect check'}>
              <CommitInput mono value={s.healthcheck.path ?? ''} placeholder="/healthz" disabled={s.protocol !== 'http'} onCommit={(v) => void patch(id, { healthcheck: { path: v || null } })} />
            </Field>
            <Field label="Interval (s)">
              <CommitInput mono value={String(s.healthcheck.intervalSec)} onCommit={(v) => void patch(id, { healthcheck: { intervalSec: Number(v) || 5 } })} />
            </Field>
            <Field label="Timeout (s)">
              <CommitInput mono value={String(s.healthcheck.timeoutSec)} onCommit={(v) => void patch(id, { healthcheck: { timeoutSec: Number(v) || 3 } })} />
            </Field>
            <Field label="Startup grace (s)">
              <CommitInput mono value={String(s.healthcheck.graceSec)} onCommit={(v) => void patch(id, { healthcheck: { graceSec: Number(v) || 60 } })} />
            </Field>
          </div>
        </Section>
      )}

      {!s.volumes.length && (
        <Section title="Autoscaling" icon="layers" desc="Adds replicas under load, removes them when it calms down.">
          <div className="setting-row">
            <div className="grow">
              <div className="title">Enable autoscaling</div>
              <div className="desc">
                Target {s.autoscale.metric === 'cpu' ? `${s.autoscale.target}% CPU` : `${s.autoscale.target} req/s`} per replica, between {s.autoscale.min} and {s.autoscale.max} replicas
              </div>
            </div>
            <Switch checked={s.autoscale.enabled} onChange={(v) => void patch(id, { autoscale: { enabled: v } })} />
          </div>
          {s.autoscale.enabled && (
            <div className="autoscale-grid fade-in">
              <Field label="Metric">
                <Segmented
                  value={s.autoscale.metric}
                  onChange={(v) => void patch(id, { autoscale: { metric: v, target: v === 'cpu' ? 70 : 50 } }, true)}
                  options={[
                    { value: 'rps', label: 'Requests' },
                    { value: 'cpu', label: 'CPU' },
                  ]}
                />
              </Field>
              <Field label={s.autoscale.metric === 'cpu' ? 'Target CPU %' : 'Target req/s'}>
                <CommitInput mono value={String(s.autoscale.target)} onCommit={(v) => void patch(id, { autoscale: { target: Number(v) || 50 } })} />
              </Field>
              <Field label="Min">
                <Stepper value={s.autoscale.min} min={1} max={s.autoscale.max} onChange={(v) => void patch(id, { autoscale: { min: v } }, true)} />
              </Field>
              <Field label="Max">
                <Stepper value={s.autoscale.max} min={s.autoscale.min} max={32} onChange={(v) => void patch(id, { autoscale: { max: v } }, true)} />
              </Field>
            </div>
          )}
        </Section>
      )}

      <Section title="Resources" icon="cpu" desc="Per-replica limits. Empty = unlimited.">
        <div className="ns-grid">
          <Field label="CPU cores">
            <CommitInput mono value={s.resources.cpus ? String(s.resources.cpus) : ''} placeholder="unlimited" onCommit={(v) => void patch(id, { resources: { cpus: v ? Number(v) : null } })} />
          </Field>
          <Field label="Memory (MB)">
            <CommitInput mono value={s.resources.memoryMb ? String(s.resources.memoryMb) : ''} placeholder="unlimited" onCommit={(v) => void patch(id, { resources: { memoryMb: v ? Number(v) : null } })} />
          </Field>
        </div>
      </Section>

      <Section title="Volumes" icon="database" desc="Persistent storage that survives deploys and can move between services. A service with a volume runs as one replica.">
        <ServiceVolumes service={s} />
      </Section>

      <Section title="Danger zone" icon="alert">
        <div className="setting-row">
          <div className="grow">
            <div className="title">{s.stopped ? 'Start service' : 'Stop service'}</div>
            <div className="desc">{s.stopped ? 'Bring replicas back online with the last deployment.' : 'Remove all replicas but keep configuration, images and volumes.'}</div>
          </div>
          {s.stopped ? (
            <Button icon="play" onClick={() => void start(s)}>
              Start
            </Button>
          ) : (
            <Button icon="stop" onClick={() => void stop(s)}>
              Stop
            </Button>
          )}
        </div>
        <div className="setting-row">
          <div className="grow">
            <div className="title">Delete service</div>
            <div className="desc">Permanently remove the service, its images{s.volumes.length ? ' and volume data' : ''}.</div>
          </div>
          <Button variant="danger" icon="trash" onClick={() => void remove(s)}>
            Delete
          </Button>
        </div>
      </Section>
    </div>
  );
}
