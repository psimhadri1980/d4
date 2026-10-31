import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { adminApi, type Webhook } from './api';
import { ErrorBanner } from '@d4/ui-kit';

const STATUS_CLASS = { pending: 'job-running', succeeded: 'job-succeeded', failed: 'job-failed' } as const;

/**
 * Webhooks: endpoints that receive model events. The signing secret is shown once, right after
 * creating the webhook or replacing its secret.
 */
export function Webhooks() {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ['admin', 'webhooks'], queryFn: adminApi.webhooks });
  const workspaces = useQuery({ queryKey: ['admin', 'workspaces'], queryFn: adminApi.workspaces });
  const eventTypes = useQuery({ queryKey: ['admin', 'event-types'], queryFn: adminApi.eventTypes });
  const [error, setError] = useState<unknown>(null);
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [types, setTypes] = useState<string[]>([]);
  const nameId = useId();
  const urlId = useId();
  const wsId = useId();

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ['admin', 'webhooks'] });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'deliveries'] });
    } catch (e) {
      setError(e);
    }
  };
  const showSecret = (w: Webhook) => w.secret && setSecret({ name: w.name, secret: w.secret });
  const create = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      showSecret(await adminApi.createWebhook({ name, url, workspace: workspace || null, eventTypes: types }));
      setName('');
      setUrl('');
      setWorkspace('');
      setTypes([]);
    });
  };
  const wsName = (id: string | null) => (id ? workspaces.data?.find((w) => w.id === id)?.name ?? id : 'All workspaces');

  return (
    <section className="card" aria-label="Webhooks">
      <div className="card-head">
        <h3>Webhooks</h3>
      </div>
      <p className="muted small">
        Each change to the model is sent as a signed JSON POST (header <code>D4-Signature</code>). Failed deliveries are retried for about 7.5 hours; a webhook
        is turned off after 5 failed deliveries in a row.
      </p>
      {list.error && <ErrorBanner error={list.error} />}
      {error != null && <ErrorBanner error={error} />}
      {secret && (
        <div className="notice" role="status" aria-label="Signing secret">
          <p>
            Signing secret for <strong>{secret.name}</strong>. Copy it now; it is not shown again.
          </p>
          <code className="secret mono">{secret.secret}</code>{' '}
          <button className="button small" onClick={() => void navigator.clipboard?.writeText(secret.secret)}>
            Copy
          </button>{' '}
          <button className="button small ghost" onClick={() => setSecret(null)}>
            Done
          </button>
        </div>
      )}
      {list.data && list.data.length === 0 && <p className="muted small">No webhooks yet.</p>}
      {list.data && list.data.length > 0 && (
        <table className="jobs" aria-label="All webhooks">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Sends</th>
              <th scope="col">Status</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {list.data.map((w) => (
              <WebhookRow
                key={w.id}
                webhook={w}
                scope={wsName(w.workspaceId)}
                open={open === w.id}
                onToggle={() => setOpen(open === w.id ? null : w.id)}
                act={act}
                onSecret={showSecret}
              />
            ))}
          </tbody>
        </table>
      )}
      <form className="admin-create webhook-create" aria-label="New webhook" onSubmit={create}>
        <div className="field">
          <label htmlFor={nameId}>Webhook name</label>
          <input id={nameId} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </div>
        <div className="field wide">
          <label htmlFor={urlId}>URL</label>
          <input id={urlId} type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://" />
        </div>
        <div className="field">
          <label htmlFor={wsId}>Workspace</label>
          <select id={wsId} value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
            <option value="">All workspaces</option>
            {workspaces.data
              ?.filter((w) => !w.archived)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
          </select>
        </div>
        <fieldset className="field event-types">
          <legend>Events (none ticked: all)</legend>
          {eventTypes.data?.map((t) => (
            <label key={t} className="check-inline">
              <input type="checkbox" checked={types.includes(t)} onChange={(e) => setTypes(e.target.checked ? [...types, t] : types.filter((x) => x !== t))} /> {t}
            </label>
          ))}
        </fieldset>
        <button className="button primary" type="submit">
          Add webhook
        </button>
      </form>
    </section>
  );
}

function WebhookRow({
  webhook: w,
  scope,
  open,
  onToggle,
  act,
  onSecret,
}: {
  webhook: Webhook;
  scope: string;
  open: boolean;
  onToggle(): void;
  act(fn: () => Promise<unknown>): Promise<void>;
  onSecret(w: Webhook): void;
}) {
  return (
    <>
      <tr className={w.enabled ? '' : 'paused'}>
        <td>
          {w.name}
          <div className="small mono muted truncate" title={w.url}>
            {w.url}
          </div>
        </td>
        <td className="small">
          {scope}
          <div className="muted">{w.eventTypes.length ? w.eventTypes.join(', ') : 'every event'}</div>
        </td>
        <td>
          {w.enabled ? <span className="badge job-succeeded">on</span> : <span className="badge muted">off</span>}
          {w.disabledReason && <div className="small muted">{w.disabledReason}</div>}
        </td>
        <td className="row-actions">
          <button className="button small ghost" aria-expanded={open} onClick={onToggle}>
            Deliveries
          </button>
          <button className="button small ghost" disabled={!w.enabled} onClick={() => void act(() => adminApi.ping(w.id)).then(() => !open && onToggle())}>
            Send test
          </button>
          <button className="button small ghost" onClick={() => void act(() => adminApi.updateWebhook(w.id, { enabled: !w.enabled }))}>
            {w.enabled ? 'Turn off' : 'Turn on'}
          </button>
          <button
            className="button small ghost"
            onClick={() => {
              if (window.confirm(`Replace the signing secret of "${w.name}"? The receiver must switch to the new one.`)) void act(async () => onSecret(await adminApi.rotateSecret(w.id)));
            }}
          >
            New secret
          </button>
          <button
            className="link danger"
            aria-label={`Delete webhook ${w.name}`}
            onClick={() => {
              if (window.confirm(`Delete webhook "${w.name}" and its delivery log?`)) void act(() => adminApi.deleteWebhook(w.id));
            }}
          >
            Delete
          </button>
        </td>
      </tr>
      {open && (
        <tr className="webhook-deliveries">
          <td colSpan={4}>
            <Deliveries webhookId={w.id} act={act} />
          </td>
        </tr>
      )}
    </>
  );
}

function Deliveries({ webhookId, act }: { webhookId: string; act(fn: () => Promise<unknown>): Promise<void> }) {
  const q = useQuery({
    queryKey: ['admin', 'deliveries', webhookId],
    queryFn: () => adminApi.deliveries(webhookId),
    // Poll while something is still on its way.
    refetchInterval: (query) => (query.state.data?.some((d) => d.status === 'pending') ? 2000 : false),
  });
  if (q.error) return <ErrorBanner error={q.error} />;
  if (!q.data) return <p className="muted small">Loading…</p>;
  if (!q.data.length) return <p className="muted small">Nothing sent yet.</p>;
  return (
    <table className="jobs" aria-label="Deliveries">
      <thead>
        <tr>
          <th scope="col">When</th>
          <th scope="col">Event</th>
          <th scope="col">Result</th>
          <th scope="col">Attempts</th>
          <th scope="col" />
        </tr>
      </thead>
      <tbody>
        {q.data.map((d) => (
          <tr key={d.id}>
            <td className="small">{new Date(d.createdAt).toLocaleString()}</td>
            <td className="small">{d.eventType}</td>
            <td className="small">
              <span className={`badge ${STATUS_CLASS[d.status]}`}>{d.status}</span>{' '}
              {d.responseStatus != null && <span className="mono">HTTP {d.responseStatus}</span>}
              {d.lastError && d.lastError !== `HTTP ${d.responseStatus}` && <span className="muted"> {d.lastError}</span>}
              {d.nextAttemptAt && d.attempts > 0 && <div className="muted">next try {new Date(d.nextAttemptAt).toLocaleTimeString()}</div>}
            </td>
            <td className="small">{d.attempts}</td>
            <td className="row-actions">
              {d.status !== 'pending' && (
                <button className="button small ghost" onClick={() => void act(() => adminApi.redeliver(webhookId, d.id))}>
                  Send again
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
