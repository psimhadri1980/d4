import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { api, connectorsApi, type Cadence, type Connector, type SyncResult } from '../api';
import { CadenceFields } from '../components/ScheduleForm';
import { ErrorBanner } from '../components/ErrorBanner';
import { syncSummary } from '../jobText';

/** A starting mapping: one element type, id and name fields, one relationship. Edit to fit the source. */
const EXAMPLE_MAPPING = JSON.stringify(
  {
    itemsPath: 'result',
    entities: [
      {
        type: { value: 'Application' },
        id: 'sys_id',
        name: 'name',
        attrs: {
          description: { path: 'short_description' },
          lifecycle: { path: 'install_status', map: { '1': 'LIVE', '7': 'RETIRED' } },
        },
        relationships: [{ type: 'RUNS_ON', to: 'platform_id' }],
      },
    ],
  },
  null,
  2,
);

/**
 * Connectors of this workspace: external systems whose records become elements. Every sync
 * reports what it changed; an element edited in D4 and in the source since the last sync is a
 * conflict and is left alone unless the connector says the source wins.
 */
export function Connectors({ ws }: { ws: string }) {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['admin', 'connectors', ws],
    queryFn: () => connectorsApi.list(ws),
  });
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useQuery({
    queryKey: ['job', ws, jobId],
    queryFn: () => api.job(ws, jobId!),
    enabled: !!jobId,
    refetchInterval: (q) =>
      q.state.data && (q.state.data.status === 'succeeded' || q.state.data.status === 'failed')
        ? false
        : 1000,
  });
  const running = !!job.data && (job.data.status === 'queued' || job.data.status === 'running');

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ['admin', 'connectors', ws] });
    } catch (e) {
      setError(e);
    }
  };
  const sync = (c: Connector, dryRun: boolean) =>
    act(async () => setJobId((await connectorsApi.sync(ws, c.id, dryRun)).id));

  return (
    <section className="card" aria-label="Connectors">
      <div className="card-head">
        <h3>Connectors</h3>
        {!adding && (
          <button className="button small" onClick={() => setAdding(true)}>
            Add connector
          </button>
        )}
      </div>
      <p className="muted small">
        External systems synced into this workspace. Elements a connector brings in carry its key in
        their external key. A dry run shows what a sync would change without writing.
      </p>
      {list.error && <ErrorBanner error={list.error} />}
      {error != null && <ErrorBanner error={error} />}
      {job.data && (
        <div
          role="status"
          aria-label="Sync result"
          className={job.data.status === 'failed' ? 'check error' : 'check ok'}
        >
          {job.data.status === 'failed'
            ? `Sync failed: ${job.data.error}`
            : running
              ? `Syncing… ${job.data.progress}%`
              : syncSummary(job.data.result as unknown as SyncResult)}
          {!running && job.data.status === 'succeeded' && (
            <SyncDetails result={job.data.result as unknown as SyncResult} />
          )}
        </div>
      )}
      {list.data?.length === 0 && !adding && <p className="muted small">No connectors yet.</p>}
      {list.data && list.data.length > 0 && (
        <table className="jobs" aria-label="All connectors">
          <thead>
            <tr>
              <th scope="col">Connector</th>
              <th scope="col">Source</th>
              <th scope="col">Schedule</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {list.data.map((c) => (
              <tr key={c.id} className={c.enabled ? '' : 'paused'}>
                <td>
                  {c.name} <span className="mono small muted">{c.key}</span>
                  {!c.enabled && <div className="badge muted">off</div>}
                </td>
                <td className="small">
                  <div className="truncate mono" title={String(c.config['url'] ?? '')}>
                    {String(c.config['url'] ?? c.kind)}
                  </div>
                  <span className="muted">
                    {c.hasSecret ? 'with credentials' : 'no credentials'} · conflicts:{' '}
                    {c.conflictPolicy === 'skip' ? 'keep D4 edits' : 'source wins'}
                  </span>
                </td>
                <td className="small">
                  {c.cadenceText ?? 'manual'}
                  {c.lastRunAt && (
                    <div className="muted">last {new Date(c.lastRunAt).toLocaleString()}</div>
                  )}
                </td>
                <td className="row-actions">
                  <button
                    className="button small ghost"
                    disabled={!c.enabled || running}
                    onClick={() => void sync(c, true)}
                  >
                    Dry run
                  </button>
                  <button
                    className="button small"
                    disabled={!c.enabled || running}
                    onClick={() => void sync(c, false)}
                  >
                    Sync now
                  </button>
                  <button
                    className="button small ghost"
                    onClick={() =>
                      void act(() => connectorsApi.update(ws, c.id, { enabled: !c.enabled }))
                    }
                  >
                    {c.enabled ? 'Turn off' : 'Turn on'}
                  </button>
                  <button
                    className="link danger"
                    aria-label={`Delete connector ${c.name}`}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete connector "${c.name}"? The elements it brought in stay.`,
                        )
                      )
                        void act(() => connectorsApi.remove(ws, c.id));
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
      {adding && <NewConnector ws={ws} onDone={() => setAdding(false)} act={act} />}
    </section>
  );
}

function SyncDetails({ result: r }: { result: SyncResult }) {
  const lines = [
    ...r.conflicts.items.map(
      (c) =>
        `Conflict: ${c.name} (${c.externalKey}) changed in D4 and in the source; ${c.applied ? 'source applied' : 'D4 version kept'}`,
    ),
    ...r.missingInSource.items.map((m) => `Gone from the source: ${m.externalKey} (kept in D4)`),
    ...r.deletedInD4.items.map((k) => `Deleted in D4, not recreated: ${k}`),
    ...r.unresolved.items.map((u) => `Unresolved ${u.type}: ${u.from} → ${u.to}`),
    ...r.mappingProblems.items.map((p) => `Record ${p.record + 1}: ${p.message}`),
    ...r.issues.map((i) => `Model rule: ${i.message}`),
  ];
  if (!lines.length) return null;
  return (
    <ul className="small plain sync-details" aria-label="Needs attention">
      {lines.map((l, i) => (
        <li key={i}>{l}</li>
      ))}
    </ul>
  );
}

function NewConnector({
  ws,
  onDone,
  act,
}: {
  ws: string;
  onDone(): void;
  act(fn: () => Promise<unknown>): Promise<void>;
}) {
  const [kind, setKind] = useState<'http-json' | 'git'>('http-json');
  const [branch, setBranch] = useState('main');
  const [path, setPath] = useState('');
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [auth, setAuth] = useState<'none' | 'bearer' | 'basic'>('none');
  const [secret, setSecret] = useState('');
  const [nextPath, setNextPath] = useState('');
  const [mapping, setMapping] = useState(EXAMPLE_MAPPING);
  const [policy, setPolicy] = useState<'skip' | 'source-wins'>('skip');
  const [scheduled, setScheduled] = useState(false);
  const [cadence, setCadence] = useState<Cadence>({ frequency: 'daily', hour: 3 });
  const [mappingError, setMappingError] = useState<string | null>(null);
  const ids = {
    kind: useId(),
    key: useId(),
    name: useId(),
    url: useId(),
    auth: useId(),
    secret: useId(),
    next: useId(),
    mapping: useId(),
    policy: useId(),
    branch: useId(),
    path: useId(),
  };
  const isGit = kind === 'git';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    let parsed: unknown = {};
    if (!isGit) {
      try {
        parsed = JSON.parse(mapping);
        setMappingError(null);
      } catch (err) {
        setMappingError(
          `The mapping is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
    }
    void act(async () => {
      await connectorsApi.create(ws, {
        key,
        name,
        kind,
        config: isGit
          ? { url, branch, path, auth: auth === 'none' ? 'none' : 'token' }
          : { url, auth, ...(nextPath && { nextPath }) },
        mapping: parsed,
        ...(secret && { secret }),
        conflictPolicy: policy,
        cadence: scheduled ? cadence : null,
      });
      onDone();
    });
  };

  return (
    <form className="connector-form" aria-label="New connector" onSubmit={submit}>
      <div className="admin-create">
        <div className="field">
          <label htmlFor={ids.kind}>Source type</label>
          <select
            id={ids.kind}
            value={kind}
            onChange={(e) => (setKind(e.target.value as typeof kind), setAuth('none'))}
          >
            <option value="http-json">JSON API</option>
            <option value="git">Git repository (model-as-code)</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.name}>Name</label>
          <input
            id={ids.name}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.key}>Key</label>
          <input
            id={ids.key}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            required
            pattern="[a-z][a-z0-9-]{1,30}"
            title="Lowercase letters, digits and dashes"
            placeholder="cmdb"
          />
        </div>
        <div className="field wide">
          <label htmlFor={ids.url}>{isGit ? 'Repository URL' : 'Source URL (JSON)'}</label>
          <input
            id={ids.url}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            placeholder={isGit ? 'https://github.com/org/model.git' : 'https://'}
          />
        </div>
        {isGit && (
          <>
            <div className="field">
              <label htmlFor={ids.branch}>Branch</label>
              <input
                id={ids.branch}
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor={ids.path}>Folder or file (optional)</label>
              <input
                id={ids.path}
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="model/"
              />
            </div>
          </>
        )}
        <div className="field">
          <label htmlFor={ids.auth}>Authentication</label>
          <select
            id={ids.auth}
            value={auth}
            onChange={(e) => setAuth(e.target.value as typeof auth)}
          >
            <option value="none">None</option>
            <option value="bearer">{isGit ? 'Access token' : 'Bearer token'}</option>
            {!isGit && <option value="basic">User and password</option>}
          </select>
        </div>
        {auth !== 'none' && (
          <div className="field">
            <label htmlFor={ids.secret}>{auth === 'bearer' ? 'Token' : 'user:password'}</label>
            <input
              id={ids.secret}
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              required
            />
          </div>
        )}
        {!isGit && (
          <div className="field">
            <label htmlFor={ids.next}>Next-page link at (optional)</label>
            <input
              id={ids.next}
              value={nextPath}
              onChange={(e) => setNextPath(e.target.value)}
              placeholder="links.next"
            />
          </div>
        )}
        <div className="field">
          <label htmlFor={ids.policy}>When D4 and the source both changed an item</label>
          <select
            id={ids.policy}
            value={policy}
            onChange={(e) => setPolicy(e.target.value as typeof policy)}
          >
            <option value="skip">Keep the D4 version and report it</option>
            <option value="source-wins">Take the source version</option>
          </select>
        </div>
      </div>
      {isGit ? (
        <p className="muted small">
          The branch holds D4 model documents (the format of model export and the d4 CLI); every
          sync records the commit it read.
        </p>
      ) : (
        <div className="field">
          <label htmlFor={ids.mapping}>Mapping (JSON)</label>
          <textarea
            id={ids.mapping}
            className="mono"
            rows={14}
            value={mapping}
            onChange={(e) => setMapping(e.target.value)}
            spellCheck={false}
          />
          <small className="muted">
            <code>itemsPath</code> is where the records are; each entity says which records become
            which element type (<code>when</code>), where the id and name are, which fields fill
            which attributes (<code>map</code> translates values) and which fields point at related
            records.
          </small>
          {mappingError && <div className="error-text small">{mappingError}</div>}
        </div>
      )}
      <label className="check-inline">
        <input
          type="checkbox"
          checked={scheduled}
          onChange={(e) => setScheduled(e.target.checked)}
        />{' '}
        Sync on a schedule
      </label>
      {scheduled && <CadenceFields value={cadence} onChange={setCadence} />}
      <div className="proposal-actions">
        <button className="button primary" type="submit">
          Create connector
        </button>
        <button className="button ghost" type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
