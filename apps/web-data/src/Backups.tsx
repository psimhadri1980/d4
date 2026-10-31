import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, keys, type Job } from '@d4/web-platform';
import { type Backup, backupsApi } from './api';
import { AdminGate, describeJob, ErrorBanner, outcome } from '@d4/ui-kit';

const REASONS: Record<Backup['reason'], string> = { manual: 'manual', scheduled: 'daily', safety: 'before a restore' };
const size = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/**
 * Backups of the current workspace's graph: snapshot now, check the graph against the event log,
 * restore a snapshot (plus every change after it) or rebuild from the event log alone.
 */
export function Backups({ ws, slug }: { ws: string; slug: string }) {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ['admin', 'backups', ws], queryFn: () => backupsApi.list(ws) });
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const job = useQuery({
    queryKey: ['job', ws, jobId],
    queryFn: () => api.job(ws, jobId!),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data && (q.state.data.status === 'succeeded' || q.state.data.status === 'failed') ? false : 1000),
  });
  const running = job.data && (job.data.status === 'queued' || job.data.status === 'running');
  const finished = job.data && !running ? job.data.id : null;
  useEffect(() => {
    if (finished) void queryClient.invalidateQueries({ queryKey: ['admin', 'backups', ws] });
  }, [finished, queryClient, ws]);

  const start = async (fn: () => Promise<Job>) => {
    setError(null);
    try {
      setJobId((await fn()).id);
    } catch (e) {
      setError(e);
    }
  };
  const confirmSlug = (what: string) => {
    const typed = window.prompt(`${what}\n\nThe current graph is saved as a backup first. Type the workspace slug "${slug}" to continue.`);
    return typed === slug ? typed : null;
  };

  return (
    <section className="card" aria-label="Backups">
      <div className="card-head">
        <h3>Backups of this workspace</h3>
      </div>
      <p className="muted small">
        Every workspace is backed up daily. A restore loads a backup and then replays every change recorded after it, so the result always matches the
        event log; nothing done since the backup is lost. Writes are paused while a restore runs.
      </p>
      <div className="proposal-actions">
        <button className="button primary" disabled={!!running} onClick={() => void start(() => backupsApi.backup(ws))}>
          Back up now
        </button>
        <button className="button" disabled={!!running} onClick={() => void start(() => backupsApi.verify(ws))}>
          Check against the event log
        </button>
        <button
          className="button ghost danger"
          disabled={!!running}
          onClick={() => {
            const c = confirmSlug('Rebuild the whole graph of this workspace from the event log?');
            if (c) void start(() => backupsApi.rebuild(ws, c));
          }}
        >
          Rebuild from the event log…
        </button>
      </div>
      {error != null && <ErrorBanner error={error} />}
      {job.data && (
        <p role="status" className={job.data.status === 'failed' || (job.data.kind === 'verify' && job.data.result?.['matches'] === false) ? 'check error' : 'check ok'}>
          {describeJob(job.data)}: {running ? `${job.data.status}… ${job.data.progress}%` : outcome(job.data)}
        </p>
      )}
      {job.data?.kind === 'verify' && Array.isArray(job.data.result?.['examples']) && (job.data.result['examples'] as string[]).length > 0 && (
        <ul className="small plain" aria-label="Differences">
          {(job.data.result['examples'] as string[]).map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
      {list.error && <ErrorBanner error={list.error} />}
      {list.data?.length === 0 && <p className="muted small">No backups yet.</p>}
      {list.data && list.data.length > 0 && (
        <table className="jobs" aria-label="Backup list">
          <thead>
            <tr>
              <th scope="col">Taken</th>
              <th scope="col">Kind</th>
              <th scope="col">Contents</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {list.data.map((b) => (
              <tr key={b.id}>
                <td className="small">{new Date(b.createdAt).toLocaleString()}</td>
                <td className="small">{REASONS[b.reason]}</td>
                <td className="small">
                  {b.elements} elements, {b.relationships} relationships (deleted ones included) · {size(b.bytes)}
                  <div className="mono muted" title={b.checksum}>
                    {b.checksum.slice(0, 12)}
                  </div>
                </td>
                <td className="row-actions">
                  <button
                    className="button small ghost"
                    disabled={!!running}
                    aria-label={`Restore the backup of ${new Date(b.createdAt).toLocaleString()}`}
                    onClick={() => {
                      const c = confirmSlug(`Restore the backup of ${new Date(b.createdAt).toLocaleString()}, then replay every change made since?`);
                      if (c) void start(() => backupsApi.restore(ws, b.id, c));
                    }}
                  >
                    Restore…
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function BackupsPage() {
  const { ws } = useParams();
  return (
    <AdminGate title="Backups">
      <CurrentBackups ws={ws!} />
    </AdminGate>
  );
}

function CurrentBackups({ ws }: { ws: string }) {
  const list = useQuery({ queryKey: keys.adminWorkspaces, queryFn: api.adminWorkspaces });
  const slug = list.data?.find((w) => w.id === ws)?.slug;
  return slug ? <Backups ws={ws} slug={slug} /> : null;
}
