import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ErrorBanner } from '../components/ErrorBanner';
import { describe, outcome } from '../jobText';
import { api, type Job } from '@d4/web-platform';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Your background jobs in this workspace; refreshes while any is still running. */
export function Jobs() {
  const { ws } = useParams();
  const [error, setError] = useState<unknown>(null);
  const jobs = useQuery({
    queryKey: ['jobs', ws],
    queryFn: () => api.jobs(ws!),
    refetchInterval: (q) => (q.state.data?.some((j) => j.status === 'queued' || j.status === 'running') ? 1500 : false),
  });

  const download = async (j: Job) => {
    setError(null);
    try {
      const { blob, filename } = await api.jobFile(ws!, j.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="jobs-page">
      <header className="jobs-head">
        <h2>Background jobs</h2>
        <button className="button small" onClick={() => void jobs.refetch()}>
          Refresh
        </button>
      </header>
      <p className="muted">Large exports and imports run here so you can keep working. Files are kept for download once a job finishes.</p>
      {jobs.error && <ErrorBanner error={jobs.error} />}
      {error != null && <ErrorBanner error={error} />}
      {jobs.data && jobs.data.length === 0 && (
        <div className="empty">
          <p>No jobs yet. Choose “In background” when exporting or importing.</p>
        </div>
      )}
      {jobs.data && jobs.data.length > 0 && (
        <table className="jobs" aria-label="Jobs">
          <thead>
            <tr>
              <th scope="col">Job</th>
              <th scope="col">Status</th>
              <th scope="col">Started</th>
              <th scope="col">Outcome</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {jobs.data.map((j) => (
              <tr key={j.id} className={`job ${j.status}`}>
                <td>
                  {describe(j)}
                  {j.scheduleId && <span className="badge muted"> scheduled</span>}
                </td>
                <td>
                  <span className={`badge job-${j.status}`}>{j.status}</span>
                  {(j.status === 'running' || j.status === 'queued') && (
                    <span className="job-progress" role="progressbar" aria-label="Progress" aria-valuenow={j.progress} aria-valuemin={0} aria-valuemax={100}>
                      <span style={{ width: `${j.progress}%` }} />
                    </span>
                  )}
                  {j.attempts > 1 && <span className="muted small"> · attempt {j.attempts}</span>}
                </td>
                <td className="small">{when(j.startedAt ?? j.createdAt)}</td>
                <td className="small">{outcome(j)}</td>
                <td>
                  {!j.artifact && (j.result as { artifactExpired?: boolean } | null)?.artifactExpired && <span className="muted small">File expired</span>}
                  {j.artifact && (
                    <button className="button small" onClick={() => void download(j)}>
                      Download{j.artifact.bytes !== null && ` (${size(j.artifact.bytes)})`}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
