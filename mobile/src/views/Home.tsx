import { useCallback, useEffect, useState } from 'react';
import { useSession, useNav, useServerEvents, useDebounced } from '../session.tsx';
import { Icon, ProjectMark, StatusDot, Live, TopBar, Spinner, ServiceGlyph, useTick } from '../ui/kit.tsx';
import { PullScroll } from '../ui/pull.tsx';
import { timeAgo, num } from '../../../web/src/lib/format.ts';
import type { ProjectListItem } from '../../../web/src/lib/types.ts';
import type { Overview } from '../../../server/src/types.ts';

const PROBLEM = new Set(['crashed', 'failed', 'degraded']);

export function Home() {
  const { api, server, live } = useSession();
  const nav = useNav();
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useTick();

  const load = useCallback(async () => {
    try {
      const [p, o] = await Promise.all([api.get<ProjectListItem[]>('/projects'), api.get<Overview>('/overview').catch(() => null)]);
      setProjects(p);
      if (o) setOverview(o);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);

  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), 20_000);
    return () => clearInterval(t);
  }, [load]);

  const refetch = useDebounced(() => void load());
  useServerEvents((ev) => {
    if (ev.type === 'service.updated' || ev.type === 'service.deleted' || ev.type === 'project.updated' || ev.type === 'project.deleted' || ev.type === 'deployment.updated') refetch();
  });

  const top = projects?.filter((p) => !p.parentId) ?? [];
  const all = top.flatMap((p) => p.services.map((s) => ({ ...s, project: p })));
  const problems = all.filter((s) => PROBLEM.has(s.status));
  const running = all.filter((s) => s.status === 'running').length;
  const deployed = all.filter((s) => s.status !== 'idle' && s.kind !== 'redirect' && s.kind !== 'external').length;
  const online = overview?.servers.filter((s) => s.status === 'online').length;

  return (
    <>
      <TopBar
        title={server.label}
        sub={
          <span className="row" style={{ gap: 10 }}>
            <Live on={live} />
            <span>Servify {server.version}</span>
          </span>
        }
        right={
          <button className="icon-btn" onClick={() => nav.push({ name: 'settings' })} aria-label="Settings">
            <Icon name="gear" size={20} />
          </button>
        }
      />
      <PullScroll onRefresh={load}>
        {error && (
          <div className="error" role="alert" style={{ marginTop: 0, marginBottom: 16 }}>
            <Icon name="alert" size={16} />
            <div>{error}</div>
          </div>
        )}
        {!projects && !error ? (
          <div className="empty">
            <Spinner />
          </div>
        ) : projects ? (
          <>
            <div className="stats">
              <div className="card stat">
                <div className="label">Running</div>
                <div className="v">
                  {running}
                  <small>/{deployed}</small>
                </div>
              </div>
              <div className="card stat">
                <div className="label">Requests</div>
                <div className="v">
                  {overview ? num(overview.servify.rps) : '–'}
                  <small>/s</small>
                </div>
              </div>
              <div className="card stat">
                <div className="label">Servers</div>
                <div className="v">
                  {online ?? '–'}
                  <small>/{overview?.servers.length ?? '–'}</small>
                </div>
              </div>
            </div>

            {problems.length > 0 && (
              <>
                <div className="section-title">
                  <span className="label" style={{ color: 'var(--err)' }}>
                    Needs attention
                  </span>
                </div>
                <div className="card list">
                  {problems.map((s) => (
                    <button key={s.id} className="item" onClick={() => nav.push({ name: 'service', id: s.id, title: s.name })}>
                      <ServiceGlyph icon={s.icon} name={s.name} size={34} />
                      <div className="grow">
                        <div className="title ellipsis">{s.name}</div>
                        <div className="meta ellipsis">
                          {s.project.name} · {s.status}
                        </div>
                      </div>
                      <StatusDot status={s.status} />
                    </button>
                  ))}
                </div>
              </>
            )}

            <div className="section-title">
              <span className="label">Projects</span>
              <span className="label">{top.length}</span>
            </div>
            {top.length === 0 ? (
              <div className="card empty">
                <div className="ic">
                  <Icon name="layers" size={28} />
                </div>
                No projects yet. Create one in the dashboard.
              </div>
            ) : (
              top.map((p) => <ProjectCard key={p.id} p={p} onOpen={() => nav.push({ name: 'project', id: p.id, title: p.name })} />)
            )}
          </>
        ) : null}
      </PullScroll>
    </>
  );
}

function ProjectCard({ p, onOpen }: { p: ProjectListItem; onOpen: () => void }) {
  const shown = p.services.slice(0, 8);
  const rest = p.services.length - shown.length;
  const bad = p.services.filter((s) => PROBLEM.has(s.status)).length;
  return (
    <button className="card project" onClick={onOpen}>
      <div className="row" style={{ gap: 12 }}>
        <ProjectMark name={p.name} color={p.color} icon={p.icon} />
        <div className="grow">
          <div className="row" style={{ gap: 8 }}>
            <b className="ellipsis" style={{ fontSize: 15 }}>
              {p.name}
            </b>
            {bad > 0 && (
              <span className="pill" style={{ ['--tone' as any]: 'var(--err)' }}>
                {bad} down
              </span>
            )}
          </div>
          <div className="faint mono" style={{ fontSize: 11 }}>
            {p.serviceCount} service{p.serviceCount === 1 ? '' : 's'} · {p.running} running
            {p.lastDeployAt ? ` · deployed ${timeAgo(p.lastDeployAt)}` : ''}
          </div>
        </div>
        <Icon name="chevronRight" size={18} className="chev" />
      </div>
      {shown.length > 0 && (
        <div className="svc-strip">
          {shown.map((s) => (
            <span className="svc-chip" key={s.id}>
              <StatusDot status={s.status} />
              <span className="ellipsis">{s.name}</span>
            </span>
          ))}
          {rest > 0 && <span className="svc-chip">+{rest}</span>}
        </div>
      )}
    </button>
  );
}
