/**
 * Inbound git webhooks (GitHub, GitLab, Gitea/Forgejo) and per-service deploy hooks.
 *
 * Reachable two ways: on the dashboard port (`POST /api/hooks/git`) and on the public router under
 * `/_servify/hooks/…` for any host, so a git host can reach it wherever your apps are reachable
 * (including through a tunnel). Every request is authenticated by HMAC/token, never by session.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { changedFiles, touchesWatchPaths } from './watchpaths.ts';
import { services as servicesTable } from './db.ts';
import { getSettings } from './settings.ts';
import { recordActivity, type Actor } from './events.ts';
import { deployService } from './ops.ts';
import { isDeploying } from './deployer.ts';

export const MAX_HOOK_BODY = 2 * 1024 * 1024;
const GIT: Actor = { type: 'system', name: 'git-webhook' };

export type HookResult = { status: number; body: Record<string, unknown> };
export type HookDelivery = { ts: number; provider: string; event: string; repo: string | null; ok: boolean; result: string };
const deliveries: HookDelivery[] = [];
export const recentHookDeliveries = () => deliveries.slice(-30).reverse();
function record(d: Omit<HookDelivery, 'ts'>) {
  deliveries.push({ ts: Date.now(), ...d });
  if (deliveries.length > 200) deliveries.splice(0, deliveries.length - 200);
}

/** Canonical "host/owner/repo" for any https/ssh/shorthand form. */
export function repoKey(url: string | undefined | null): string | null {
  if (!url) return null;
  let u = url.trim().toLowerCase();
  const ssh = u.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/);
  if (ssh) u = `${ssh[1]}/${ssh[2]}`;
  else if (/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(u)) u = `github.com/${u}`;
  u = u.replace(/^[a-z]+:\/\//, '').replace(/^[^@/]+@/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  return u;
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type PullRequestEvent = {
  provider: 'github' | 'gitlab' | 'gitea';
  action: 'opened' | 'updated' | 'closed';
  repo: string; // normalized base repo key
  cloneUrl: string;
  number: number;
  branch: string;
  sameRepo: boolean;
  title: string;
  url?: string;
};
type PrHandler = (pr: PullRequestEvent) => Promise<string>;
let prHandler: PrHandler | null = null;
/** Registered by the environments module (keeps the import graph acyclic). */
export function onPullRequest(fn: PrHandler) {
  prHandler = fn;
}

type Push = { repo: string | null; branch: string | null; defaultBranch: string | null; sha: string | null; deleted: boolean; message: string | null; files: string[] | null };

export async function handleGitWebhook(headers: Record<string, string | string[] | undefined>, raw: Buffer): Promise<HookResult> {
  const h = (k: string) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const secret = getSettings().webhooks.secret;
  if (!secret) return { status: 503, body: { error: 'webhook secret not configured' } };
  if (raw.length > MAX_HOOK_BODY) return { status: 413, body: { error: 'payload too large' } };

  let provider: 'github' | 'gitlab' | 'gitea';
  let event: string;
  if (h('x-gitea-event') || h('x-forgejo-event')) {
    provider = 'gitea';
    event = (h('x-gitea-event') ?? h('x-forgejo-event'))!;
    const sig = h('x-gitea-signature') ?? h('x-forgejo-signature') ?? '';
    const want = createHmac('sha256', secret).update(raw).digest('hex');
    if (!sig || !safeEqual(sig, want)) return deny(provider, event);
  } else if (h('x-github-event')) {
    provider = 'github';
    event = h('x-github-event')!;
    const sig = h('x-hub-signature-256') ?? '';
    const want = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    if (!sig || !safeEqual(sig, want)) return deny(provider, event);
  } else if (h('x-gitlab-event')) {
    provider = 'gitlab';
    event = h('x-gitlab-event')!;
    if (!safeEqual(h('x-gitlab-token') ?? '', secret)) return deny(provider, event);
  } else {
    return { status: 400, body: { error: 'unrecognized webhook (expected GitHub, GitLab or Gitea headers)' } };
  }

  let payload: any;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return { status: 400, body: { error: 'payload must be JSON (set the webhook content type to application/json)' } };
  }

  if (event === 'ping' || event === 'System Hook') {
    record({ provider, event, repo: null, ok: true, result: 'pong' });
    return { status: 200, body: { ok: true, pong: true } };
  }

  const isPush = event === 'push' || event === 'Push Hook';
  const isPr = event === 'pull_request' || event === 'Merge Request Hook';
  if (isPush) return handlePush(provider, event, parsePush(provider, payload));
  if (isPr) {
    const pr = parsePr(provider, payload);
    if (!pr) {
      record({ provider, event, repo: null, ok: true, result: 'ignored action' });
      return { status: 202, body: { ok: true, ignored: true } };
    }
    const result = prHandler ? await prHandler(pr) : 'previews are not available';
    record({ provider, event, repo: pr.repo, ok: true, result });
    return { status: 202, body: { ok: true, result } };
  }
  record({ provider, event, repo: null, ok: true, result: 'event ignored' });
  return { status: 202, body: { ok: true, ignored: event } };
}

function deny(provider: string, event: string): HookResult {
  record({ provider, event, repo: null, ok: false, result: 'invalid signature' });
  return { status: 401, body: { error: 'invalid signature' } };
}

function parsePush(provider: string, p: any): Push {
  const ref: string = p.ref ?? '';
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
  if (provider === 'gitlab') {
    return {
      repo: repoKey(p.project?.git_http_url ?? p.project?.web_url ?? p.repository?.git_http_url),
      branch,
      defaultBranch: p.project?.default_branch ?? null,
      sha: p.checkout_sha ?? p.after ?? null,
      deleted: !p.checkout_sha && /^0+$/.test(p.after ?? ''),
      message: p.commits?.at(-1)?.message ?? null,
      files: changedFiles(provider, p),
    };
  }
  return {
    repo: repoKey(p.repository?.clone_url ?? p.repository?.html_url),
    branch,
    defaultBranch: p.repository?.default_branch ?? null,
    sha: p.after ?? null,
    deleted: !!p.deleted || /^0+$/.test(p.after ?? ''),
    message: p.head_commit?.message ?? null,
    files: changedFiles(provider, p),
  };
}

function parsePr(provider: 'github' | 'gitlab' | 'gitea', p: any): PullRequestEvent | null {
  if (provider === 'gitlab') {
    const a = p.object_attributes ?? {};
    const action = a.action === 'open' || a.action === 'reopen' ? 'opened' : a.action === 'update' ? 'updated' : a.action === 'close' || a.action === 'merge' ? 'closed' : null;
    if (!action) return null;
    const repo = repoKey(p.project?.git_http_url ?? p.project?.web_url);
    if (!repo) return null;
    return {
      provider,
      action,
      repo,
      cloneUrl: p.project?.git_http_url ?? `https://${repo}.git`,
      number: Number(a.iid),
      branch: a.source_branch,
      sameRepo: a.source_project_id === a.target_project_id,
      title: a.title ?? '',
      url: a.url,
    };
  }
  const pr = p.pull_request ?? {};
  const map: Record<string, PullRequestEvent['action']> = { opened: 'opened', reopened: 'opened', synchronize: 'updated', synchronized: 'updated', closed: 'closed' };
  const action = map[p.action];
  if (!action) return null;
  const base = pr.base?.repo ?? p.repository;
  const repo = repoKey(base?.clone_url ?? base?.html_url);
  if (!repo) return null;
  const headRepo = repoKey(pr.head?.repo?.clone_url ?? pr.head?.repo?.html_url);
  return {
    provider,
    action,
    repo,
    cloneUrl: base?.clone_url ?? `https://${repo}.git`,
    number: Number(p.number ?? pr.number),
    branch: pr.head?.ref,
    sameRepo: !headRepo || headRepo === repo,
    title: pr.title ?? '',
    url: pr.html_url,
  };
}

function handlePush(provider: string, event: string, push: Push): HookResult {
  if (!push.repo || !push.branch) {
    record({ provider, event, repo: push.repo, ok: true, result: 'not a branch push' });
    return { status: 202, body: { ok: true, ignored: 'not a branch push' } };
  }
  if (push.deleted) {
    record({ provider, event, repo: push.repo, ok: true, result: `branch ${push.branch} deleted` });
    return { status: 202, body: { ok: true, ignored: 'branch deleted' } };
  }
  const deployed: string[] = [];
  const skipped: string[] = [];
  for (const svc of servicesTable.all()) {
    if (svc.source.type !== 'git' || repoKey(svc.source.repo) !== push.repo) continue;
    const want = svc.source.branch || push.defaultBranch;
    if (want && want !== push.branch) continue;
    if (!svc.autoDeploy || svc.stopped) {
      skipped.push(`${svc.name} (auto-deploy off)`);
      continue;
    }
    if (!touchesWatchPaths(push.files, svc.watchPaths)) {
      skipped.push(`${svc.name} (nothing changed under its watch paths)`);
      continue;
    }
    recordActivity(GIT, 'git.push', `Push to ${push.branch}${push.sha ? ` (${push.sha.slice(0, 7)})` : ''}${push.message ? `: ${push.message.split('\n')[0].slice(0, 60)}` : ''} — deploying ${svc.name}`, svc.projectId, svc.id);
    deployService(GIT, svc.id, 'git');
    deployed.push(svc.name);
    void isDeploying;
  }
  const result = deployed.length ? `deploying ${deployed.join(', ')}` : skipped.length ? `matched but skipped: ${skipped.join(', ')}` : 'no service uses this repo and branch';
  record({ provider, event, repo: `${push.repo}@${push.branch}`, ok: true, result });
  return { status: 202, body: { ok: true, deployed, skipped } };
}

// ───────────────────────────── per-service deploy hooks (CI) ─────────────────────────────

export function deployHookToken(serviceId: string): string {
  return createHmac('sha256', getSettings().webhooks.secret).update(`deploy:${serviceId}`).digest('base64url').slice(0, 32);
}

export function handleDeployHook(serviceId: string, token: string): HookResult {
  const svc = servicesTable.get(serviceId);
  if (!svc || !safeEqual(token, deployHookToken(serviceId))) return { status: 404, body: { error: 'not found' } };
  const dep = deployService({ type: 'system', name: 'deploy-hook' }, svc.id, 'manual');
  // Image services pull a `:latest` tag on every deploy, and any tag with "pull before every deploy" on.
  const pulls = svc.source.type === 'image' && (!!svc.pullOnDeploy || /:latest$/.test(svc.source.image) || !/:[^/]+$/.test(svc.source.image.replace(/@.*$/, '')));
  record({ provider: 'deploy-hook', event: 'deploy', repo: null, ok: true, result: `deploying ${svc.name}${pulls ? ' (pulling the image)' : ''}` });
  return { status: 202, body: { ok: true, deploymentId: dep.id, ...(svc.source.type === 'image' ? { pull: pulls } : {}) } };
}
