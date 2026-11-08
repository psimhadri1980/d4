import { useId, useState } from 'react';
import type { LensQuery } from '@d4/core';
import type { QueryParamDef } from '@d4/web-platform';
import { ParamForm, paramsFromForm, type ParamValues } from './ParamForm';

/** A catalog query a lens can take its roots from (D84), as the host lists them. */
export interface LensCatalogQuery {
  id: string;
  title: string;
  /** Only a published query runs; the others show as waiting. */
  state: 'published' | 'review' | 'draft';
  /** The parameters of the version the lens would run. */
  params: QueryParamDef[];
}

/** A new query an author writes in the lens editor; it goes to the catalog as a draft for review. */
export interface LensQueryDraft {
  title: string;
  cypher: string;
  params: unknown[];
}

export type SubmitQueryResult = { id: string } | { errors: string[] };

interface Props {
  workspaceId: string;
  queries: readonly LensCatalogQuery[];
  value: LensQuery | undefined;
  onChange(q: LensQuery | undefined): void;
  /** Query Authors may write a new query here (D7: nobody else types Cypher). */
  onSubmitQuery?(draft: LensQueryDraft): Promise<SubmitQueryResult>;
}

const STATE_NOTE = { published: '', review: ' (in review)', draft: ' (draft)' };

const toForm = (params: Record<string, unknown> = {}): ParamValues =>
  Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'boolean' ? v : Array.isArray(v) ? v.join(', ') : String(v ?? '')]));

/**
 * A lens's roots from a catalog query (D84): pick a query the user may run, fill in its
 * parameters, or, for authors, write a new one that is submitted for review. The query returns
 * element ids in an `id` column, or element nodes.
 */
export function LensQuerySource({ workspaceId, queries, value, onChange, onSubmitQuery }: Props) {
  const id = useId();
  const [writing, setWriting] = useState(false);
  const chosen = queries.find((q) => q.id === value?.id);
  const [form, setForm] = useState<ParamValues>(() => toForm(value?.params));
  const setParams = (v: ParamValues) => {
    setForm(v);
    if (value && chosen) onChange({ ...value, params: paramsFromForm(chosen.params, v) });
  };

  return (
    <div className="lens-query">
      <div className="lens-editor-field">
        <label htmlFor={`${id}-query`}>Catalog query</label>
        <select
          id={`${id}-query`}
          value={value?.id ?? ''}
          onChange={(e) => {
            setForm({});
            onChange(e.target.value ? { id: e.target.value, params: {} } : undefined);
          }}
        >
          <option value="">Choose a query…</option>
          {queries.map((q) => (
            <option key={q.id} value={q.id}>
              {q.title}
              {STATE_NOTE[q.state]}
            </option>
          ))}
        </select>
      </div>
      {value && !chosen && <p className="lens-editor-hint">This query is not in the catalog, or you cannot run it.</p>}
      {chosen && chosen.state !== 'published' && (
        <p className="lens-editor-hint" role="status">
          Waiting for review: the lens finds nothing until a steward publishes the query.
        </p>
      )}
      {chosen && (
        <div className="lens-query-params" role="group" aria-label="Query parameters">
          <ParamForm workspaceId={workspaceId} defs={chosen.params} values={form} onChange={setParams} />
        </div>
      )}
      <p className="lens-editor-hint">The query returns element ids in a column named id, or element nodes: they become the roots. A projection returns a node column, with parent (or from), rel, anchor and level if it likes: the lens draws those nodes and links.</p>
      {onSubmitQuery &&
        (writing ? (
          <QueryWriter
            onCancel={() => setWriting(false)}
            onSubmit={async (d) => {
              const r = await onSubmitQuery(d);
              if ('id' in r) {
                setWriting(false);
                setForm({});
                onChange({ id: r.id, params: {} });
              }
              return r;
            }}
          />
        ) : (
          <button type="button" className="button ghost" onClick={() => setWriting(true)}>
            Write a new query…
          </button>
        ))}
    </div>
  );
}

const STARTER = 'MATCH (n:Element {workspaceId: $workspace, deleted: false})\nWHERE n.name CONTAINS $text\nRETURN n.id AS id';
/** A projection (D94): the query returns the nodes and the links to draw, a `node` row each. */
const PROJECTION_STARTER = [
  'MATCH (n:Element {workspaceId: $workspace, deleted: false})',
  'WHERE n.name CONTAINS $text',
  'OPTIONAL MATCH (n)-[r]->(m:Element {deleted: false})',
  'WITH n, collect({m: m.id, rel: type(r)}) AS out',
  'UNWIND [{node: n.id, parent: null, rel: null}] + [x IN out WHERE x.m IS NOT NULL | {node: x.m, parent: n.id, rel: x.rel}] AS row',
  'RETURN row.node AS node, row.parent AS parent, row.rel AS rel',
].join('\n');
const ROLES = { anchors: STARTER, projection: PROJECTION_STARTER };
const STARTER_PARAMS = '[\n  { "name": "text", "type": "string", "default": "" }\n]';

/** Title, Cypher and parameter definitions (JSON, as in Query Studio), submitted for review. */
function QueryWriter({ onSubmit, onCancel }: { onSubmit(d: LensQueryDraft): Promise<SubmitQueryResult>; onCancel(): void }) {
  const id = useId();
  const [title, setTitle] = useState('');
  const [role, setRole] = useState<keyof typeof ROLES>('anchors');
  const [cypher, setCypher] = useState(STARTER);
  const [paramsText, setParamsText] = useState(STARTER_PARAMS);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    let params: unknown;
    try {
      params = JSON.parse(paramsText);
      if (!Array.isArray(params)) throw new Error('Parameters must be a JSON array');
    } catch (e) {
      setErrors([(e as Error).message]);
      return;
    }
    setBusy(true);
    try {
      const r = await onSubmit({ title: title.trim(), cypher, params: params as unknown[] });
      setErrors('errors' in r ? r.errors : []);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lens-query-writer" role="group" aria-label="New catalog query">
      <div className="lens-editor-field">
        <label htmlFor={`${id}-title`}>Query title</label>
        <input id={`${id}-title`} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <fieldset className="lens-editor-field wide lens-query-role">
        <legend>The query gives</legend>
        {(['anchors', 'projection'] as const).map((r) => (
          <label key={r}>
            <input
              type="radio"
              name={`${id}-role`}
              checked={role === r}
              onChange={() => {
                // An untouched starter follows the role; the author's own Cypher stays.
                if (cypher === ROLES[role]) setCypher(ROLES[r]);
                setRole(r);
              }}
            />
            {r === 'anchors' ? 'Anchors: the roots, in an id column' : 'Projection: the nodes and links to draw'}
          </label>
        ))}
      </fieldset>
      <div className="lens-editor-field wide">
        <label htmlFor={`${id}-cypher`}>Cypher</label>
        <textarea id={`${id}-cypher`} className="code" rows={8} spellCheck={false} value={cypher} onChange={(e) => setCypher(e.target.value)} />
      </div>
      <div className="lens-editor-field wide">
        <label htmlFor={`${id}-params`}>Parameters (JSON)</label>
        <textarea id={`${id}-params`} className="code" rows={5} spellCheck={false} value={paramsText} onChange={(e) => setParamsText(e.target.value)} />
      </div>
      <p className="lens-editor-hint">$workspace is supplied for you. The query is checked, then a steward reviews it before it runs.</p>
      {errors.length > 0 && (
        <ul className="lens-query-errors" role="alert">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="lens-query-actions">
        <button type="button" className="button ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button" disabled={busy || !title.trim() || !cypher.trim()} onClick={() => void submit()}>
          Submit for review
        </button>
      </div>
    </div>
  );
}
