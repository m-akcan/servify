import { useEffect, useState } from 'react';
import type { ServiceView, ServiceMetricsPoint } from '../lib/types.ts';
import { api } from '../lib/api.ts';
import { Chart } from '../components/Chart.tsx';
import { Segmented } from '../components/ui.tsx';
import { num } from '../lib/format.ts';

function downsample(points: ServiceMetricsPoint[], max = 180): ServiceMetricsPoint[] {
  if (points.length <= max) return points;
  const bucket = Math.ceil(points.length / max);
  const out: ServiceMetricsPoint[] = [];
  for (let i = 0; i < points.length; i += bucket) {
    const b = points.slice(i, i + bucket);
    const avg = (k: keyof ServiceMetricsPoint) => b.reduce((a, p) => a + (p[k] as number), 0) / b.length;
    out.push({ t: b[b.length - 1].t, rps: avg('rps'), p50: avg('p50'), p95: Math.max(...b.map((p) => p.p95)), errors: avg('errors'), cpu: avg('cpu'), memMb: avg('memMb'), replicas: Math.round(avg('replicas')) });
  }
  return out;
}

export function MetricsTab({ service: s }: { service: ServiceView }) {
  const [range, setRange] = useState<'300' | '900' | '3600' | '21600' | '86400' | '604800'>('900');
  const [points, setPoints] = useState<ServiceMetricsPoint[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get<{ points: ServiceMetricsPoint[] }>(`/services/${s.id}/metrics?seconds=${range}`)
        .then((m) => alive && setPoints(downsample(m.points)))
        .catch(() => {});
    void load();
    const i = setInterval(load, Number(range) <= 900 ? 2000 : 15000);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, [s.id, range]);

  const times = points.map((p) => p.t);
  const css = (v: string) => `var(${v})`;
  const totalReq = points.reduce((a, p) => a + p.rps, 0) * (Number(range) / Math.max(1, points.length));

  return (
    <div className="tab-pad col" style={{ gap: 16 }}>
      <div className="row">
        <div className="grow faint" style={{ fontSize: 12 }}>
          {Number(range) <= 900 ? 'Sampled every second.' : 'Averaged from 10-second samples.'} Kept for 7 days on this machine.
        </div>
        <Segmented
          value={range}
          onChange={setRange}
          options={[
            { value: '300', label: '5m' },
            { value: '900', label: '15m' },
            { value: '3600', label: '1h' },
            { value: '21600', label: '6h' },
            { value: '86400', label: '24h' },
            { value: '604800', label: '7d' },
          ]}
        />
      </div>
      {s.protocol !== 'none' && (
        <>
          <section className="card chart-card">
            <div className="chart-head">
              <span className="h3">Requests</span>
              <span className="faint mono" style={{ fontSize: 11 }}>
                ~{num(totalReq, 0)} total
              </span>
            </div>
            <Chart
              times={times}
              series={[
                { key: 'rps', label: 'req/s', color: css('--signal'), values: points.map((p) => p.rps) },
                { key: 'err', label: 'errors/s', color: css('--err'), values: points.map((p) => p.errors), fill: false },
              ]}
              format={(v) => num(v)}
            />
          </section>
          <section className="card chart-card">
            <div className="chart-head">
              <span className="h3">Latency</span>
            </div>
            <Chart
              times={times}
              series={[
                { key: 'p95', label: 'p95', color: css('--warn'), values: points.map((p) => p.p95) },
                { key: 'p50', label: 'p50', color: css('--build'), values: points.map((p) => p.p50), fill: false },
              ]}
              format={(v) => (v < 10 ? v.toFixed(1) : v.toFixed(0))}
              unit="ms"
            />
          </section>
        </>
      )}
      <div className="chart-pair">
        <section className="card chart-card">
          <div className="chart-head">
            <span className="h3">CPU</span>
          </div>
          <Chart times={times} series={[{ key: 'cpu', label: 'CPU', color: css('--ok'), values: points.map((p) => p.cpu) }]} format={(v) => v.toFixed(v < 10 ? 1 : 0)} unit="%" height={120} />
        </section>
        <section className="card chart-card">
          <div className="chart-head">
            <span className="h3">Memory</span>
          </div>
          <Chart times={times} series={[{ key: 'mem', label: 'Memory', color: css('--build'), values: points.map((p) => p.memMb) }]} format={(v) => v.toFixed(0)} unit=" MB" height={120} />
        </section>
      </div>
      <section className="card chart-card">
        <div className="chart-head">
          <span className="h3">Replicas</span>
        </div>
        <Chart times={times} series={[{ key: 'rep', label: 'replicas', color: css('--text-2'), values: points.map((p) => p.replicas) }]} format={(v) => v.toFixed(0)} height={90} step />
      </section>
    </div>
  );
}
