import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ErrorBanner } from '../components/ErrorBanner';
import { CadenceFields } from '../components/ScheduleForm';
import { api, type Cadence, type Schedule } from '@d4/web-platform';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

function what(s: Schedule): string {
  const p = s.params;
  if (s.kind === 'render') return `${String(p['format']).toUpperCase()} picture of ${p['target'] === 'roadmap' ? 'a roadmap' : 'a graph'}`;
  return `${String(p['format'] ?? 'yaml')} export of ${p['scope'] ? 'a graph' : 'the workspace'}`;
}

/**
 * Your scheduled reports: what they produce, when they run next, the last run and its file.
 * Create schedules from the Roadmap page or the Explorer's Export control.
 */
export function Reports() {
  const { ws } = useParams();
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [cadence, setCadence] = useState<Cadence | null>(null);
  const list = useQuery({
    queryKey: ['schedules', ws],
    queryFn: () => api.schedules(ws!),
    refetchInterval: (q) => (q.state.data?.some((s) => s.lastJob && ['queued', 'running'].includes(s.lastJob.status)) ? 1500 : false),
  });
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ['schedules', ws] });
    } catch (e) {
      setError(e);
    }
  };
  const download = (s: Schedule) =>
    act(async () => {
      const { blob, filename } = await api.jobFile(ws!, s.lastJob!.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

  return (
    <div className="reports-page">
      <header className="jobs-head">
        <h2>Scheduled reports</h2>
      </header>
      <p className="muted">
        Reports run in the background on their schedule and appear on the <Link to={`/w/${ws}/jobs`}>Jobs</Link> page. Create one with “Schedule…” on the{' '}
        <Link to={`/w/${ws}/roadmap`}>Roadmap</Link> page or in the Explorer’s Export control.
      </p>
      {list.error && <ErrorBanner error={list.error} />}
      {error != null && <ErrorBanner error={error} />}
      {list.data?.length === 0 && (
        <div className="empty">
          <p>No scheduled reports yet.</p>
        </div>
      )}
      {list.data && list.data.length > 0 && (
        <table className="jobs" aria-label="Scheduled reports">
          <thead>
            <tr>
              <th scope="col">Report</th>
              <th scope="col">When</th>
              <th scope="col">Next run</th>
              <th scope="col">Last run</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {list.data.map((s) => (
              <tr key={s.id} className={s.enabled ? '' : 'paused'}>
                <td>
                  <strong>{s.name}</strong>
                  <div className="muted small">{what(s)}</div>
                  <div className="muted small">{s.recipients.length ? `Emailed to ${s.recipients.join(', ')}` : 'Not emailed'}</div>
                </td>
                <td className="small">
                  {editing === s.id && cadence ? (
                    <div className="cadence-edit">
                      <CadenceFields value={cadence} onChange={setCadence} />
                      <button className="button small primary" onClick={() => void act(() => api.updateSchedule(ws!, s.id, { cadence })).then(() => setEditing(null))}>
                        Save
                      </button>
                      <button className="button small ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      {s.cadenceText}{' '}
                      <button
                        className="link"
                        onClick={() => {
                          setEditing(s.id);
                          setCadence(s.cadence);
                        }}
                      >
                        Change
                      </button>
                    </>
                  )}
                </td>
                <td className="small">
                  {s.enabled ? when(s.nextRunAt) : <span className="badge muted">paused</span>}
                  {s.pausedReason && <div className="error-text">{s.pausedReason}</div>}
                </td>
                <td className="small">
                  {s.lastJob ? (
                    <>
                      <span className={`badge job-${s.lastJob.status}`}>{s.lastJob.status}</span> {when(s.lastRunAt)}
                      {s.lastJob.error && <div className="error-text">{s.lastJob.error}</div>}
                      <Delivery job={s.lastJob} />
                    </>
                  ) : (
                    'Not run yet'
                  )}
                </td>
                <td className="row-actions">
                  {s.lastJob?.artifact && (
                    <button className="button small" onClick={() => void download(s)}>
                      Download
                    </button>
                  )}
                  <button className="button small ghost" onClick={() => void act(() => api.runSchedule(ws!, s.id))}>
                    Run now
                  </button>
                  <button className="button small ghost" onClick={() => void act(() => api.updateSchedule(ws!, s.id, { enabled: !s.enabled }))}>
                    {s.enabled ? 'Pause' : 'Resume'}
                  </button>
                  <button
                    className="link danger"
                    aria-label={`Delete ${s.name}`}
                    onClick={() => {
                      if (window.confirm(`Delete the scheduled report "${s.name}"? Files already produced stay on the Jobs page.`)) void act(() => api.deleteSchedule(ws!, s.id));
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Delivery({ job }: { job: Schedule['lastJob'] }) {
  const d = (job?.result as { delivery?: { status: string; recipients?: number; reason?: string; error?: string } } | null)?.delivery;
  if (!d) return null;
  if (d.status === 'sent') return <div className="muted small">✉ Emailed to {d.recipients}</div>;
  if (d.status === 'skipped') return <div className="muted small">✉ Not emailed: {d.reason}</div>;
  return <div className="error-text small">✉ Email failed: {d.error}</div>;
}
