import { useQuery } from '@tanstack/react-query';
import { adminApi } from '../modules/admin/api';
import { ErrorBanner } from '@d4/ui-kit';

const LABELS: Record<string, string> = {
  elements: 'Elements',
  relationships: 'Relationships',
  workspaces: 'Active workspaces',
  queryRunsPerDay: 'Query runs today',
  jobsPerDay: 'Background jobs today',
  storageBytes: 'Stored files',
};

const bytes = (n: number) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toLocaleString(undefined, { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
};
const fmt = (metric: string, n: number) => (metric === 'storageBytes' ? bytes(n) : n.toLocaleString());

/** Usage against the plan's limits, with the last 30 days as a small trend line. */
export function Usage() {
  const q = useQuery({ queryKey: ['admin', 'usage'], queryFn: adminApi.usage });
  return (
    <section className="card" aria-label="Usage and limits">
      <div className="card-head">
        <h3>Usage and limits</h3>
      </div>
      <p className="muted small">Daily counts reset at midnight UTC. Limits are set by the platform operator; ask them to raise one.</p>
      {q.error && <ErrorBanner error={q.error} />}
      {q.data && (
        <table className="jobs usage" aria-label="Usage">
          <thead>
            <tr>
              <th scope="col">What</th>
              <th scope="col">Used</th>
              <th scope="col">Limit</th>
              <th scope="col">Last 30 days</th>
            </tr>
          </thead>
          <tbody>
            {q.data.metrics.map((m) => {
              const share = m.limit ? Math.min(1, m.used / m.limit) : 0;
              const level = share >= 1 ? 'full' : share >= 0.8 ? 'high' : '';
              const points = q.data!.history.filter((h) => h.metric === m.metric).map((h) => h.value);
              return (
                <tr key={m.metric}>
                  <th scope="row">{LABELS[m.metric] ?? m.metric}</th>
                  <td>
                    {fmt(m.metric, m.used)}
                    {m.limit !== null && (
                      <div className={`meter ${level}`} role="meter" aria-label={`${LABELS[m.metric]} used`} aria-valuemin={0} aria-valuemax={m.limit} aria-valuenow={m.used}>
                        <span style={{ width: `${share * 100}%` }} />
                      </div>
                    )}
                  </td>
                  <td>{m.limit === null ? 'unlimited' : fmt(m.metric, m.limit)}</td>
                  <td>{points.length > 1 ? <Spark values={points} /> : <span className="muted small">not enough data yet</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Spark({ values }: { values: number[] }) {
  const w = 120;
  const h = 24;
  const max = Math.max(...values, 1);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * w).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`).join(' ');
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <path d={d} />
    </svg>
  );
}
