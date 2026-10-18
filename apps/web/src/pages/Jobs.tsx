import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type Job } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function describe(j: Job): string {
  if (j.kind === 'render') return `Picture (${String(j.params['format']).toUpperCase()}) of ${j.params['target'] === 'roadmap' ? 'a roadmap' : 'a graph'}`;
  if (j.kind === 'export') {
    const p = j.params;
    const bits = [String(p['format'] ?? 'yaml'), p['scope'] ? 'of a graph' : 'of the workspace', p['asOf'] ? `as of ${String(p['asOf'])}` : '', p['scenario'] ? 'in a scenario' : ''];
    return `Export ${bits.filter(Boolean).join(' ')}`;
  }
  const files = (j.params['files'] as string[] | undefined) ?? [];
  return `${j.params['dryRun'] ? 'Check' : 'Import'} ${files.join(', ')}`;
}

function outcome(j: Job): string {
  if (j.status === 'failed') return j.error ?? 'Failed';
  if (j.status !== 'succeeded' || !j.result) return '';
  interface Counts {
    created?: number;
    updated?: number;
  }
  const r = j.result as { elements?: Counts | number; relationships?: Counts | number; rowIssues?: unknown[]; issues?: unknown[]; applied?: boolean; ok?: boolean };
  if (j.kind === 'render') return String((j.result as { title?: string }).title ?? '');
  if (j.kind === 'export') return `${String(r.elements)} elements, ${String(r.relationships)} relationships`;
  const issues = (r.rowIssues?.length ?? 0) + (r.issues?.length ?? 0);
  const el = (r.elements ?? {}) as Counts;
  const rel = (r.relationships ?? {}) as Counts;
  const counts = `${el.created ?? 0} new, ${el.updated ?? 0} changed elements; ${rel.created ?? 0} new relationships`;
  return r.applied ? `Imported: ${counts}` : r.ok ? `Ready: ${counts}` : `Not imported: ${issues} problem${issues === 1 ? '' : 's'} (run a check in Import to see them)`;
}

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
                <td>{describe(j)}</td>
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
                  {j.artifact && (
                    <button className="button small" onClick={() => void download(j)}>
                      Download ({size(j.artifact.bytes)})
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
