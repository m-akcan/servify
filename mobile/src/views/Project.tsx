import { useCallback, useEffect, useState } from 'react';
import { useSession, useNav, useServerEvents, useDebounced } from '../session.tsx';
import { Icon, StatusPill, TopBar, Spinner, ServiceGlyph, Live } from '../ui/kit.tsx';
import { PullScroll } from '../ui/pull.tsx';
import { sourceLine, publicUrls, hostOf } from '../lib/describe.ts';
import type { Snapshot, ServiceView } from '../../../web/src/lib/types.ts';

export function ProjectView({ id, title }: { id: string; title: string }) {
  const { api, live } = useSession();
  const nav = useNav();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSnap(await api.get<Snapshot>(`/projects/${id}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, id]);
  useEffect(() => {
    void load();
  }, [load]);

  const refetch = useDebounced(() => void load());
  useServerEvents((ev) => {
    if (ev.type === 'service.updated' && ev.service.projectId === id) {
      // Events carry the full serialized service: patch it in place.
      setSnap((s) => (s ? { ...s, services: s.services.some((x) => x.id === ev.service.id) ? s.services.map((x) => (x.id === ev.service.id ? { ...x, ...(ev.service as ServiceView) } : x)) : s.services } : s));
      if (!snap?.services.some((x) => x.id === ev.service.id)) refetch();
    } else if ((ev.type === 'service.deleted' && ev.projectId === id) || (ev.type === 'replicas' && ev.projectId === id)) refetch();
    else if (ev.type === 'project.deleted' && ev.projectId === id) nav.back();
  });

  const services = snap ? [...snap.services].sort((a, b) => a.name.localeCompare(b.name)) : [];
  return (
    <>
      <TopBar title={snap?.project.name ?? title} sub={<Live on={live} />} onBack={nav.back} />
      <PullScroll onRefresh={load}>
        {error && (
          <div className="error" role="alert" style={{ marginTop: 0, marginBottom: 16 }}>
            <Icon name="alert" size={16} />
            <div>{error}</div>
          </div>
        )}
        {!snap && !error && (
          <div className="empty">
            <Spinner />
          </div>
        )}
        {snap && (
          <>
            <div className="section-title">
              <span className="label">Services</span>
              <span className="label">{services.length}</span>
            </div>
            {services.length === 0 ? (
              <div className="card empty">No services in this project yet.</div>
            ) : (
              <div className="card list">
                {services.map((s) => {
                  const reps = snap.replicas[s.id] ?? [];
                  const healthy = reps.filter((r) => r.state === 'healthy').length;
                  const urls = publicUrls(s);
                  return (
                    <button key={s.id} className="item" onClick={() => nav.push({ name: 'service', id: s.id, title: s.name })}>
                      <ServiceGlyph icon={s.icon} name={s.name} size={38} />
                      <div className="grow">
                        <div className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
                          <span className="title ellipsis">{s.name}</span>
                          <StatusPill status={s.status} />
                        </div>
                        <div className="meta ellipsis">{urls[0] ? hostOf(urls[0]) : sourceLine(s)}</div>
                        {reps.length > 1 && (
                          <div className="meta">
                            {healthy}/{reps.length} replicas
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </PullScroll>
    </>
  );
}
