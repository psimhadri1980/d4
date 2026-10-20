import type { MetamodelRegistry } from '@d4/metamodel';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, canReview, proposalsApi, type Proposal, type ProposalOperation, type ProposalStatus } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { ElementPicker } from '../components/ParamForm';
import { useRegistry } from '../model';

const FILTERS: { label: string; statuses?: ProposalStatus[] }[] = [
  { label: 'Open', statuses: ['draft', 'submitted'] },
  { label: 'Waiting for review', statuses: ['submitted'] },
  { label: 'Closed', statuses: ['applied', 'rejected', 'withdrawn'] },
  { label: 'All' },
];
const STATUS_CLASS: Record<ProposalStatus, string> = { draft: 'muted', submitted: 'job-running', applied: 'job-succeeded', rejected: 'job-failed', withdrawn: 'muted' };

/**
 * Change proposals: draft a set of model changes, check them against the live model, submit them
 * for review, and have an architect or admin apply them as one change.
 */
export function Proposals() {
  const { ws, pid } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState(0);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<unknown>(null);
  const filterId = useId();
  const titleId = useId();
  const list = useQuery({ queryKey: ['proposals', ws, filter], queryFn: () => proposalsApi.list(ws!, FILTERS[filter]!.statuses) });

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const p = await proposalsApi.create(ws!, { title });
      setTitle('');
      await queryClient.invalidateQueries({ queryKey: ['proposals', ws] });
      navigate(`/w/${ws}/proposals/${p.id}`);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div className="proposals-page">
      <aside className="proposal-list">
        <h2>Change proposals</h2>
        <form className="inline-form" aria-label="New proposal" onSubmit={(e) => void create(e)}>
          <label htmlFor={titleId} className="sr-only">
            New proposal title
          </label>
          <input id={titleId} placeholder="New proposal title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
          <button className="button primary small" type="submit">
            Create
          </button>
        </form>
        {error != null && <ErrorBanner error={error} />}
        <div className="field narrow">
          <label htmlFor={filterId}>Show</label>
          <select id={filterId} value={filter} onChange={(e) => setFilter(Number(e.target.value))}>
            {FILTERS.map((f, i) => (
              <option key={f.label} value={i}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        {list.error && <ErrorBanner error={list.error} />}
        {list.data?.length === 0 && <p className="muted small">No proposals here.</p>}
        <ul className="plain proposal-items" aria-label="Proposals">
          {list.data?.map((p) => (
            <li key={p.id} className={p.id === pid ? 'selected' : ''}>
              <Link to={`/w/${ws}/proposals/${p.id}`}>{p.title}</Link>
              <div className="small muted">
                <span className={`badge ${STATUS_CLASS[p.status]}`}>{p.status}</span> {p.stepCount} {p.stepCount === 1 ? 'change' : 'changes'} · {new Date(p.updatedAt).toLocaleDateString()}
              </div>
            </li>
          ))}
        </ul>
      </aside>
      <section className="proposal-detail">{pid ? <ProposalView key={pid} ws={ws!} id={pid} /> : <p className="muted">Choose a proposal, or create one.</p>}</section>
    </div>
  );
}

function ProposalView({ ws, id }: { ws: string; id: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const registry = useRegistry(ws);
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const q = useQuery({ queryKey: ['proposal', ws, id], queryFn: () => proposalsApi.get(ws, id) });
  const [error, setError] = useState<unknown>(null);
  const [comment, setComment] = useState('');
  const commentId = useId();

  const run = async (fn: () => Promise<Proposal | void>) => {
    setError(null);
    try {
      const next = await fn();
      if (next) queryClient.setQueryData(['proposal', ws, id], next);
      await queryClient.invalidateQueries({ queryKey: ['proposals', ws] });
      return true;
    } catch (e) {
      setError(e);
      await queryClient.invalidateQueries({ queryKey: ['proposal', ws, id] });
      return false;
    }
  };

  if (q.error) return <ErrorBanner error={q.error} />;
  if (!q.data || !registry.data || !me.data) return <p className="muted">Loading…</p>;
  const p = q.data;
  const mine = p.createdBy === me.data.userId;
  const draft = p.status === 'draft';
  const setOps = (operations: ProposalOperation[]) => run(() => proposalsApi.edit(ws, id, { operations }));
  const act = (action: 'submit' | 'reopen' | 'withdraw' | 'approve' | 'reject') =>
    run(() => proposalsApi.act(ws, id, action, comment || undefined)).then((ok) => ok && setComment(''));

  return (
    <article className="card" aria-label={`Proposal ${p.title}`}>
      <div className="card-head">
        <h3>{p.title}</h3>
        <span className={`badge ${STATUS_CLASS[p.status]}`} aria-label="Status">
          {p.status}
        </span>
      </div>
      {p.description && <p>{p.description}</p>}
      <p className="small muted">
        {mine ? 'Your proposal' : 'Proposed by another user'} · created {new Date(p.createdAt).toLocaleString()}
        {p.decidedAt && ` · decided ${new Date(p.decidedAt).toLocaleString()}`}
      </p>
      {p.reviewComment && (
        <blockquote className="review-comment" aria-label="Review comment">
          {p.reviewComment}
        </blockquote>
      )}
      {error != null && <ErrorBanner error={error} />}

      {p.check && (
        <p role="status" className={p.check.ok ? 'check ok' : 'check error'}>
          {p.check.ok ? '✓ Every change applies to the model as it is now.' : '✗ A change no longer applies; see the marked step.'}
        </p>
      )}
      {p.steps.length === 0 ? (
        <p className="muted">No changes yet.</p>
      ) : (
        <ol className="proposal-steps" aria-label="Changes">
          {p.steps.map((s) => (
            <li key={s.index} className={`step-${s.state}`}>
              <span>
                {s.text}
                {p.status === 'applied' && s.subjectId && s.op.endsWith('Element') && s.op !== 'deleteElement' && (
                  <>
                    {' '}
                    <Link to={`/w/${ws}/e/${s.subjectId}`} className="small">
                      open
                    </Link>
                  </>
                )}
              </span>
              {s.error && <div className="small error-text">{s.error.message}</div>}
              {draft && mine && (
                <button className="link danger small" aria-label={`Remove change ${s.index + 1}`} onClick={() => void setOps(p.operations.filter((_, i) => i !== s.index))}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ol>
      )}

      {draft && mine && <StepBuilder ws={ws} registry={registry.data} operations={p.operations} onAdd={(o) => setOps([...p.operations, o])} />}

      <div className="proposal-actions">
        {mine && draft && (
          <>
            <button className="button primary" disabled={!p.steps.length || p.check?.ok === false} onClick={() => void act('submit')}>
              Submit for review
            </button>
            <button
              className="button ghost"
              onClick={() => {
                if (window.confirm('Delete this draft?')) void run(() => proposalsApi.remove(ws, id)).then((ok) => ok && navigate(`/w/${ws}/proposals`));
              }}
            >
              Delete draft
            </button>
          </>
        )}
        {mine && p.status === 'submitted' && (
          <button className="button ghost" onClick={() => void act('reopen')}>
            Back to draft
          </button>
        )}
        {mine && (draft || p.status === 'submitted') && (
          <button className="button ghost" onClick={() => void act('withdraw')}>
            Withdraw
          </button>
        )}
      </div>

      {!mine && p.status === 'submitted' && canReview(me.data.roles) && (
        <div className="review-box" role="group" aria-label="Review">
          <div className="field">
            <label htmlFor={commentId}>Review comment</label>
            <textarea id={commentId} rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Required when rejecting" />
          </div>
          <button className="button primary" disabled={p.check?.ok === false} onClick={() => void act('approve')}>
            Approve and apply
          </button>
          <button className="button ghost" disabled={!comment.trim()} onClick={() => void act('reject')}>
            Reject
          </button>
        </div>
      )}
      {mine && p.status === 'submitted' && <p className="small muted">Waiting for an architect or admin other than you to review.</p>}
    </article>
  );
}

type Kind = 'add' | 'change' | 'connect' | 'delete';

/** Builds one step at a time; new elements get a ref that later steps can connect to. */
function StepBuilder({ ws, registry, operations, onAdd }: { ws: string; registry: MetamodelRegistry; operations: ProposalOperation[]; onAdd(o: ProposalOperation): void }) {
  const [kind, setKind] = useState<Kind>('add');
  const kindId = useId();
  const created = operations.flatMap((o) => (o.op === 'createElement' ? [{ ref: o.ref, type: o.type, name: String(o.attrs['name'] ?? o.ref) }] : []));
  return (
    <section className="step-builder" aria-label="Add a change">
      <div className="field narrow">
        <label htmlFor={kindId}>Add a change</label>
        <select id={kindId} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          <option value="add">New element</option>
          <option value="change">Change an element's attribute</option>
          <option value="connect">Connect two elements</option>
          <option value="delete">Delete an element</option>
        </select>
      </div>
      {kind === 'add' && <AddElement registry={registry} taken={created.map((c) => c.ref)} onAdd={onAdd} />}
      {kind === 'change' && <ChangeElement ws={ws} registry={registry} onAdd={onAdd} />}
      {kind === 'connect' && <Connect ws={ws} registry={registry} created={created} onAdd={onAdd} />}
      {kind === 'delete' && <DeleteElement ws={ws} onAdd={onAdd} />}
    </section>
  );
}

function AddElement({ registry, taken, onAdd }: { registry: MetamodelRegistry; taken: string[]; onAdd(o: ProposalOperation): void }) {
  const [type, setType] = useState('');
  const [name, setName] = useState('');
  const typeId = useId();
  const nameId = useId();
  const types = registry
    .nodeTypes()
    .filter((n) => !n.internal)
    .map((n) => n.name)
    .sort();
  return (
    <form
      className="admin-create"
      aria-label="New element"
      onSubmit={(e) => {
        e.preventDefault();
        let n = taken.length + 1;
        while (taken.includes(`new-${n}`)) n++;
        onAdd({ op: 'createElement', ref: `new-${n}`, type, attrs: { name } });
        setName('');
      }}
    >
      <div className="field">
        <label htmlFor={typeId}>Type</label>
        <select id={typeId} value={type} onChange={(e) => setType(e.target.value)} required>
          <option value="">— choose a type —</option>
          {types.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={nameId}>Name</label>
        <input id={nameId} value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <button className="button" type="submit">
        Add to proposal
      </button>
    </form>
  );
}

function ChangeElement({ ws, registry, onAdd }: { ws: string; registry: MetamodelRegistry; onAdd(o: ProposalOperation): void }) {
  const [id, setId] = useState('');
  const [attr, setAttr] = useState('');
  const [value, setValue] = useState('');
  const pickId = useId();
  const attrId = useId();
  const valueId = useId();
  const el = useQuery({ queryKey: ['element', ws, id], queryFn: () => api.element(ws, id), enabled: !!id });
  const defs = el.data ? registry.attributesFor(el.data.type).filter((a) => a.name !== 'externalKey') : [];
  const def = defs.find((a) => a.name === attr);
  const options = def?.enum ? (registry.metamodel.enums[def.enum] ?? []) : null;
  return (
    <form
      className="admin-create"
      aria-label="Change an element"
      onSubmit={(e) => {
        e.preventDefault();
        if (!el.data || !def) return;
        const v = def.type === 'number' || def.type === 'integer' ? Number(value) : def.type === 'boolean' ? value === 'true' : value;
        onAdd(value === '' ? { op: 'updateElement', id, expectedVersion: el.data.version, unset: [attr] } : { op: 'updateElement', id, expectedVersion: el.data.version, set: { [attr]: v } });
        setAttr('');
        setValue('');
      }}
    >
      <div className="field">
        <label htmlFor={pickId}>Element</label>
        <ElementPicker id={pickId} workspaceId={ws} value={id} onChange={setId} />
      </div>
      <div className="field">
        <label htmlFor={attrId}>Attribute</label>
        <select id={attrId} value={attr} onChange={(e) => (setAttr(e.target.value), setValue(''))} disabled={!el.data} required>
          <option value="">— choose an attribute —</option>
          {defs.map((a) => (
            <option key={a.name}>{a.name}</option>
          ))}
        </select>
        {el.data && attr && <small className="muted">Now: {String(el.data.attrs[attr] ?? '—')}</small>}
      </div>
      <div className="field">
        <label htmlFor={valueId}>New value</label>
        {options ? (
          <select id={valueId} value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">— clear —</option>
            {options.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        ) : (
          <input id={valueId} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Empty clears it" />
        )}
      </div>
      <button className="button" type="submit" disabled={!el.data || !attr}>
        Add to proposal
      </button>
    </form>
  );
}

type Created = { ref: string; type: string; name: string };

function Connect({ ws, registry, created, onAdd }: { ws: string; registry: MetamodelRegistry; created: Created[]; onAdd(o: ProposalOperation): void }) {
  const [from, setFrom] = useState<End>({ ref: '', existing: '' });
  const [to, setTo] = useState<End>({ ref: '', existing: '' });
  const [rel, setRel] = useState('');
  const [attrs, setAttrs] = useState<Record<string, string>>({});
  const relId = useId();
  const fromType = useEndType(ws, from, created);
  const toType = useEndType(ws, to, created);
  const rels = registry
    .relationshipTypes()
    .filter((r) => !fromType || !toType || registry.canConnect(r.name, fromType, toType))
    .map((r) => r.name)
    .sort();
  const relDef = rel ? registry.relationshipTypes().find((r) => r.name === rel) : undefined;
  const fromId = from.ref || from.existing;
  const toId = to.ref || to.existing;
  return (
    <form
      className="admin-create connect-form"
      aria-label="Connect two elements"
      onSubmit={(e) => {
        e.preventDefault();
        const set = Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== ''));
        onAdd({ op: 'createRelationship', type: rel, from: fromId, to: toId, ...(Object.keys(set).length && { attrs: set }) });
        setRel('');
        setAttrs({});
      }}
    >
      <EndPicker label="From" ws={ws} created={created} value={from} onChange={setFrom} />
      <div className="field">
        <label htmlFor={relId}>Relationship</label>
        <select id={relId} value={rel} onChange={(e) => (setRel(e.target.value), setAttrs({}))} required>
          <option value="">— choose a relationship —</option>
          {rels.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
        {relDef?.attributes.map((a) => {
          const options = a.enum ? (registry.metamodel.enums[a.enum] ?? []) : null;
          return (
            <label key={a.name} className="small">
              {a.name}
              {a.required && ' *'}
              {options ? (
                <select value={attrs[a.name] ?? ''} onChange={(e) => setAttrs({ ...attrs, [a.name]: e.target.value })} required={a.required}>
                  <option value="">—</option>
                  {options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <input value={attrs[a.name] ?? ''} onChange={(e) => setAttrs({ ...attrs, [a.name]: e.target.value })} required={a.required} />
              )}
            </label>
          );
        })}
      </div>
      <EndPicker label="To" ws={ws} created={created} value={to} onChange={setTo} />
      <button className="button" type="submit" disabled={!fromId || !toId || !rel}>
        Add to proposal
      </button>
    </form>
  );
}

type End = { ref: string; existing: string };

function useEndType(ws: string, end: End, created: Created[]) {
  const el = useQuery({ queryKey: ['element', ws, end.existing], queryFn: () => api.element(ws, end.existing), enabled: !end.ref && !!end.existing });
  return end.ref ? created.find((c) => c.ref === end.ref)?.type : el.data?.type;
}

/** One end of a new relationship: an element added earlier in this proposal, or an existing one. */
function EndPicker({ label, ws, created, value, onChange }: { label: string; ws: string; created: Created[]; value: End; onChange(v: End): void }) {
  const newId = useId();
  const pickId = useId();
  return (
    <div className="field end-picker">
      {created.length > 0 && (
        <>
          <label htmlFor={newId}>{label}: new in this proposal</label>
          <select id={newId} value={value.ref} onChange={(e) => onChange({ ref: e.target.value, existing: '' })}>
            <option value="">— an existing element —</option>
            {created.map((c) => (
              <option key={c.ref} value={c.ref}>
                {c.name} — {c.type}
              </option>
            ))}
          </select>
        </>
      )}
      {!value.ref && (
        <>
          <label htmlFor={pickId}>{label}</label>
          <ElementPicker id={pickId} workspaceId={ws} value={value.existing} onChange={(existing) => onChange({ ref: '', existing })} />
        </>
      )}
    </div>
  );
}

function DeleteElement({ ws, onAdd }: { ws: string; onAdd(o: ProposalOperation): void }) {
  const [id, setId] = useState('');
  const pickId = useId();
  const el = useQuery({ queryKey: ['element', ws, id], queryFn: () => api.element(ws, id), enabled: !!id });
  return (
    <form
      className="admin-create"
      aria-label="Delete an element"
      onSubmit={(e) => {
        e.preventDefault();
        if (el.data) onAdd({ op: 'deleteElement', id, expectedVersion: el.data.version });
        setId('');
      }}
    >
      <div className="field">
        <label htmlFor={pickId}>Element to delete (with its relationships)</label>
        <ElementPicker id={pickId} workspaceId={ws} value={id} onChange={setId} />
      </div>
      <button className="button" type="submit" disabled={!el.data}>
        Add to proposal
      </button>
    </form>
  );
}
