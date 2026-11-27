import { useEffect, useRef, useState } from 'react';
import type { Deployment, ServiceView } from '../lib/types.ts';
import { useStore, deploymentsFor } from '../lib/store.ts';
import { Badge, Button, Tooltip, toastError, Empty } from '../components/ui.tsx';
import { Icon } from '../components/Icon.tsx';
import { deployTone, timeAgo, duration, isBusy } from '../lib/format.ts';
import { rollback, deploy, deployWithoutSafetyBackup } from '../lib/actions.ts';
import { sse, api } from '../lib/api.ts';
import { LogView, type ViewLine } from '../components/LogView.tsx';
import { useAutoHeight } from '../motion/hooks.ts';

const triggerIcon: Record<string, any> = { agent: 'bot', git: 'git', rollback: 'history', restart: 'refresh', create: 'sparkle', manual: 'user', config: 'sliders' };

function DeployLog({ dep }: { dep: Deployment }) {
  const [lines, setLines] = useState<ViewLine[]>([]);
  const k = useRef(0);
  const live = isBusy(dep.status);
  useEffect(() => {
    setLines([]);
    k.current = 0;
    const stop = sse(`/deployments/${dep.id}/logs/stream`, {
      backlog: (arr: { ts: number; text: string }[]) => setLines(arr.map((l) => ({ key: k.current++, ts: l.ts, text: l.text }))),
      line: (l: { ts: number; text: string }) => setLines((prev) => [...prev.slice(-3000), { key: k.current++, ts: l.ts, text: l.text }]),
    }, undefined, { pauseWhenHidden: true });
    return stop;
  }, [dep.id]);
  return <LogView lines={lines} live={live} className="deploy-log" emptyText={live ? 'Starting…' : 'No log output.'} />;
}

/** What changed between two deployments' configs. */
function diffConfigs(prev: Deployment | undefined, d: Deployment): string[] {
  if (!prev) return [];
  const out: string[] = [];
  const a = prev.config;
  const b = d.config;
  const src = (x: Deployment['config']['source']) => (x.type === 'image' ? x.image : x.type === 'git' ? `${x.repo}${x.branch ? '@' + x.branch : ''}` : x.type === 'external' ? x.url : x.type === 'redirect' ? x.to : x.type === 'upload' ? `upload ${x.label ?? ''}`.trim() : x.path);
  if (src(a.source) !== src(b.source)) out.push(`source → ${src(b.source)}`);
  if (prev.commitSha && d.commitSha && prev.commitSha !== d.commitSha) out.push(`commit ${prev.commitSha.slice(0, 7)} → ${d.commitSha.slice(0, 7)}`);
  if ((a.port ?? null) !== (b.port ?? null)) out.push(`port ${a.port ?? 'auto'} → ${b.port ?? 'auto'}`);
  if ((a.startCommand ?? '') !== (b.startCommand ?? '')) out.push('start command changed');
  const ka = new Set(Object.keys(a.env));
  const kb = new Set(Object.keys(b.env));
  const added = [...kb].filter((k) => !ka.has(k));
  const removed = [...ka].filter((k) => !kb.has(k));
  const changed = [...kb].filter((k) => ka.has(k) && a.env[k] !== b.env[k]);
  if (added.length) out.push(`+ ${added.join(', ')}`);
  if (removed.length) out.push(`− ${removed.join(', ')}`);
  if (changed.length) out.push(`~ ${changed.join(', ')}`);
  if (JSON.stringify(a.volumes) !== JSON.stringify(b.volumes)) out.push('volumes changed');
  if (JSON.stringify(a.resources) !== JSON.stringify(b.resources)) out.push('resources changed');
  return out;
}

/** Turn common failure modes into a concrete next step. */
function FailureHint({ d, s }: { d: Deployment; s: ServiceView }) {
  const e = d.error ?? '';
  let text: string | null = null;
  if (d.safetyRefused)
    text = `${s.name} keeps data, and a new image may change it in place — so Servify wants a recent backup first, and could neither find one nor take one. Nothing changed. Back it up in the Backups tab and deploy again, change the safety backup setting in Settings, or deploy without a safety backup if you accept the risk.`;
  else if (/health check timed out/.test(e) && s.protocol !== 'none')
    text = `Replicas never accepted connections on port ${d.port ?? '?'}. If your app listens elsewhere, set the container port in Settings → Networking (Servify injects PORT=${d.port ?? '…'}), or switch to Worker if it serves no traffic.`;
  else if (/exited during startup/.test(e)) text = 'The process exited right after starting. Check the output below — a missing variable or a wrong start command are the usual causes.';
  else if (/^pull failed: (unauthorized|not found or private)/.test(e)) {
    const stays = s.activeDeploymentId ? 'nothing changed and the running version stays' : 'nothing was started';
    const m = /credentials for (\S+)|(\S+) refused the saved login/.exec(e);
    const host = m?.[1] ?? m?.[2] ?? 'the registry';
    text = `The registry refused the pull, so ${stays}. Log in on the server as the user Servify runs as (docker login ${host}), then retry.${d.cachedImageAvailable ? ' Deploy cached image uses the copy already on the server instead — it may be older.' : ''}`;
  } else if (/^pull failed: registry unreachable/.test(e)) text = `The registry could not be reached, so ${s.activeDeploymentId ? 'nothing changed and the running version stays' : 'nothing was started'}. Retry once it is back.${d.cachedImageAvailable ? ' Deploy cached image uses the copy already on the server instead — it may be older.' : ''}`;
  else if (/^pull failed|pull access denied|manifest unknown|not found: manifest|error from registry|denied/i.test(e)) text = `The image could not be pulled, so ${s.activeDeploymentId ? 'nothing changed and the running version stays' : 'nothing was started'}. Check the name and tag; for private registries run docker login on the server (Servify pulls with your CLI credentials).`;
  else if (/git clone failed/.test(e)) text = 'The repository could not be cloned. Check the URL and branch; private repositories need an access token in Settings → Source.';
  else if (/could not detect how to build/.test(e)) text = 'No Dockerfile and no recognised project files. Add a Dockerfile, or point Root directory at the app folder.';

  if (!text) return null;
  return (
    <div className="failure-hint">
      <Icon name="info" size={14} />
      <span>{text}</span>
    </div>
  );
}

function DeploymentRow({ d, s, expanded, onToggle, prev }: { d: Deployment; s: ServiceView; expanded: boolean; onToggle: () => void; prev?: Deployment }) {
  const changes = diffConfigs(prev, d);
  const wrap = useRef<HTMLDivElement>(null);
  useAutoHeight(wrap, [expanded]);
  const isActive = s.activeDeploymentId === d.id;
  const busy = isBusy(d.status);
  const elapsed = d.startedAt ? (d.finishedAt ?? Date.now()) - d.startedAt : null;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, [busy]);

  return (
    <div className={`deploy-row ${expanded ? 'open' : ''} ${isActive ? 'is-active' : ''}`} data-status={d.status}>
      <div
        className="deploy-summary"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span className="deploy-rail" data-tone={deployTone[d.status]} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <Badge tone={deployTone[d.status]} live={busy}>
              {d.status}
            </Badge>
            {isActive && <span className="active-chip">LIVE</span>}
            <span className="deploy-msg truncate">{d.commitMessage ?? d.sourceLabel}</span>
          </div>
          <div className="deploy-meta">
            <span className="actor-pill">
              <Icon name={triggerIcon[d.trigger] ?? 'user'} size={11} />
              {d.actor}
            </span>
            <span>{d.trigger}</span>
            <span>·</span>
            <span>{timeAgo(d.createdAt)}</span>
            {elapsed != null && (
              <>
                <span>·</span>
                <span className="tnum">{duration(elapsed)}</span>
              </>
            )}
            {d.commitSha && (
              <>
                <span>·</span>
                <span className="mono">{d.commitSha.slice(0, 7)}</span>
              </>
            )}
            {d.builder && (
              <>
                <span>·</span>
                <span>{d.builder}</span>
              </>
            )}
          </div>
          {changes.length > 0 && (
            <div className="deploy-diff">
              {changes.slice(0, 4).map((c) => (
                <span key={c} className="diff-chip mono">
                  {c}
                </span>
              ))}
            </div>
          )}
          {d.error && !expanded && <div className="deploy-error truncate">{d.error}</div>}
        </div>
        <div className="row" style={{ gap: 2 }} onClick={(e) => e.stopPropagation()}>
          {d.status === 'queued' && (
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                try {
                  await api.post(`/deployments/${d.id}/cancel`);
                } catch (e) {
                  toastError(e);
                }
              }}
            >
              Cancel
            </Button>
          )}
          {!isActive && d.image && (d.status === 'superseded' || d.status === 'active') && (
            <Tooltip label="Redeploy this version">
              <Button size="sm" variant="ghost" icon="history" onClick={() => void rollback(s, d)}>
                Rollback
              </Button>
            </Tooltip>
          )}
          {d.status === 'failed' && d.cachedImageAvailable && /^pull failed/.test(d.error ?? '') && (
            <Tooltip label="Deploy the copy of the image already on the server, without pulling (it may be older than the registry's)">
              <Button size="sm" variant="ghost" icon="history" onClick={() => void deploy(s, { useCachedImage: true })}>
                Deploy cached image
              </Button>
            </Tooltip>
          )}
          {d.status === 'failed' && d.safetyRefused && (
            <Tooltip label="Start the new version on the current data without a safety backup">
              <Button size="sm" variant="ghost" icon="alert" onClick={() => void deployWithoutSafetyBackup(s, d)}>
                Deploy without backup
              </Button>
            </Tooltip>
          )}
          {d.status === 'failed' && (
            <Button size="sm" variant="ghost" icon="refresh" onClick={() => void deploy(s)}>
              Retry
            </Button>
          )}
        </div>
        <Icon name="chevronDown" size={15} className="deploy-chev" />
      </div>
      <div className="deploy-expand" ref={wrap}>
        <div>
          {expanded && d.status === 'failed' && d.error && <FailureHint d={d} s={s} />}
          {expanded && <DeployLog dep={d} />}
        </div>
      </div>
    </div>
  );
}

export function DeploymentsTab({ service: s }: { service: ServiceView }) {
  const current = useStore((st) => st.current);
  const deps = deploymentsFor(current, s.id);
  const [open, setOpen] = useState<string | null>(() => {
    const first = deps[0];
    return first && (isBusy(first.status) || first.status === 'failed') ? first.id : null;
  });
  // Auto-expand a deploy that just started.
  const newest = deps[0]?.id;
  const prevNewest = useRef(newest);
  useEffect(() => {
    if (newest && newest !== prevNewest.current) setOpen(newest);
    prevNewest.current = newest;
  }, [newest]);

  if (!deps.length) return <Empty icon="rocket" title="No deployments yet" body="Deploy this service to see builds and history here." />;
  return (
    <div className="tab-pad">
      <div className="deploy-list">
        {deps.map((d, i) => (
          <DeploymentRow key={d.id} d={d} s={s} prev={deps[i + 1]} expanded={open === d.id} onToggle={() => setOpen(open === d.id ? null : d.id)} />
        ))}
      </div>
    </div>
  );
}
