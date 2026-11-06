import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import type { MetamodelRegistry } from '@d4/metamodel';
import { typesByLayer } from './model';

export interface GraphSearchValue {
  layer: string;
  type: string;
  name: string;
}

export const EMPTY_GRAPH_SEARCH: GraphSearchValue = { layer: '', type: '', name: '' };

export interface GraphSearchProps {
  registry: MetamodelRegistry;
  /** The search last run; the fields start from it and follow it when it changes. */
  value?: GraphSearchValue;
  onSearch(value: GraphSearchValue): void;
  /** Clear resets the whole search and the canvas (LS-8); the host decides what that means. */
  onClear?(): void;
  busy?: boolean;
}

/**
 * Graph Studio's search panel (FN-2…FN-4, FB-1, FB-4): Layer, Type and Name. Layer and Type come
 * from the metamodel; a Layer narrows the Types, and picking a Type sets its Layer. Nothing runs
 * until Search (or Enter); at least one field is needed. The lens smart bar replaces Layer and Type
 * in a later phase.
 */
export function GraphSearch({ registry, value = EMPTY_GRAPH_SEARCH, onSearch, onClear, busy = false }: GraphSearchProps) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [missing, setMissing] = useState(false);
  useEffect(() => setDraft(value), [value]);

  const groups = useMemo(() => typesByLayer(registry), [registry]);
  const types = draft.layer ? (groups.find(([l]) => l === draft.layer)?.[1] ?? []) : groups.flatMap(([, ts]) => ts).sort();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = { ...draft, name: draft.name.trim() };
    if (!v.layer && !v.type && !v.name) {
      setMissing(true);
      return;
    }
    setMissing(false);
    onSearch(v);
  };

  return (
    <form className="graph-search" role="search" aria-label="Find nodes" onSubmit={submit} noValidate>
      <div className="graph-search-field">
        <label htmlFor={`${id}-layer`}>Layer</label>
        <select
          id={`${id}-layer`}
          value={draft.layer}
          onChange={(e) => {
            const layer = e.target.value;
            // A Type from another layer no longer fits.
            const keep = !layer || registry.nodeType(draft.type)?.layer === layer;
            setDraft({ ...draft, layer, type: keep ? draft.type : '' });
          }}
        >
          <option value="">Any layer</option>
          {groups.map(([l]) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div className="graph-search-field">
        <label htmlFor={`${id}-type`}>Type</label>
        <select
          id={`${id}-type`}
          value={draft.type}
          onChange={(e) => {
            const type = e.target.value;
            setDraft({ ...draft, type, layer: type ? (registry.nodeType(type)?.layer ?? draft.layer) : draft.layer });
          }}
        >
          <option value="">Any type</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <div className="graph-search-field grow">
        <label htmlFor={`${id}-name`}>Name</label>
        <input
          id={`${id}-name`}
          type="search"
          value={draft.name}
          placeholder="Part of a name"
          aria-describedby={missing ? `${id}-missing` : undefined}
          aria-invalid={missing || undefined}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </div>
      <div className="graph-search-actions">
        <button type="submit" className="button" disabled={busy}>
          Search
        </button>
        {onClear && (
          <button
            type="button"
            className="button ghost"
            onClick={() => {
              setDraft(EMPTY_GRAPH_SEARCH);
              setMissing(false);
              onClear();
            }}
          >
            Clear
          </button>
        )}
      </div>
      {missing && (
        <p id={`${id}-missing`} className="graph-search-error" role="alert">
          Choose a layer or a type, or type part of a name.
        </p>
      )}
    </form>
  );
}
