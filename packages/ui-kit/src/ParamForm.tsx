import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { api, type QueryParamDef } from '@d4/web-platform';
import { elementName } from './model';

export type ParamValues = Record<string, string | boolean>;

const label = (d: QueryParamDef) =>
  d.label ?? d.name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

/** Form values → request params (empty fields left out so defaults apply). */
export function paramsFromForm(defs: QueryParamDef[], values: ParamValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    const v = values[d.name];
    if (d.type === 'boolean') {
      if (v === true) out[d.name] = true;
      continue;
    }
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s) continue;
    out[d.name] =
      d.type === 'number' || d.type === 'integer'
        ? Number(s)
        : d.type === 'string[]'
          ? s.split(',').map((x) => x.trim()).filter(Boolean)
          : s;
  }
  return out;
}

/** Inputs for a catalog query, generated from its parameter definitions. */
export function ParamForm({
  workspaceId,
  defs,
  values,
  onChange,
}: {
  workspaceId: string;
  defs: QueryParamDef[];
  values: ParamValues;
  onChange(v: ParamValues): void;
}) {
  // Unique per form: several query tabs can be open at once.
  const uid = useId();
  if (!defs.length) return <p className="muted small">This query has no parameters.</p>;
  const set = (name: string, v: string | boolean) => onChange({ ...values, [name]: v });
  return (
    <div className="param-form">
      {defs.map((d) => {
        const id = `${uid}param-${d.name}`;
        const v = values[d.name];
        const text = typeof v === 'string' ? v : '';
        return (
          <div key={d.name} className={`field ${d.type === 'boolean' ? 'checkbox' : ''}`}>
            <label htmlFor={id}>
              {label(d)}
              {d.required && <span className="req"> *</span>}
            </label>
            {d.type === 'element' ? (
              <ElementPicker id={id} workspaceId={workspaceId} types={d.elementTypes} value={text} onChange={(x) => set(d.name, x)} />
            ) : d.type === 'enum' ? (
              <select id={id} value={text} onChange={(e) => set(d.name, e.target.value)}>
                <option value="">{d.required ? 'Choose…' : 'Any'}</option>
                {d.values?.map((o) => <option key={o}>{o}</option>)}
              </select>
            ) : d.type === 'boolean' ? (
              <input id={id} type="checkbox" checked={v === true} onChange={(e) => set(d.name, e.target.checked)} />
            ) : (
              <input
                id={id}
                type={d.type === 'date' ? 'date' : d.type === 'number' || d.type === 'integer' ? 'number' : 'text'}
                placeholder={d.type === 'string[]' ? 'comma, separated' : d.default !== undefined ? `default: ${String(d.default)}` : ''}
                value={text}
                onChange={(e) => set(d.name, e.target.value)}
              />
            )}
            {d.description && <small className="muted">{d.description}</small>}
          </div>
        );
      })}
    </div>
  );
}

/** Required parameters that have no value yet (checked before running). */
export function missingRequired(defs: QueryParamDef[], values: ParamValues): QueryParamDef[] {
  const filled = paramsFromForm(defs, values);
  return defs.filter((d) => d.required && d.default === undefined && filled[d.name] === undefined);
}

export const paramLabel = label;

/**
 * Search-as-you-type element picker limited to the parameter's element types. The list always
 * has an explicit "nothing selected" entry so what is highlighted is what will be sent, and the
 * chosen element stays listed even when a later search no longer matches it.
 */
export function ElementPicker({
  id,
  workspaceId,
  types,
  value,
  onChange,
}: {
  id: string;
  workspaceId: string;
  types?: string[];
  value: string;
  onChange(id: string): void;
}) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<{ id: string; label: string } | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const list = useQuery({
    queryKey: ['picker', workspaceId, types, q],
    queryFn: () => api.listElements(workspaceId, { type: types, q: q || undefined, first: 30 }),
  });

  const options = (list.data?.items ?? []).map((e) => ({ id: e.id, label: `${elementName(e)} — ${e.type}` }));
  if (chosen && value === chosen.id && !options.some((o) => o.id === chosen.id)) options.unshift(chosen);
  const what = types?.join(', ') ?? 'elements';

  return (
    <div className="picker">
      <input type="search" aria-label={`Search ${what}`} placeholder={`Search ${what}…`} value={text} onChange={(e) => setText(e.target.value)} />
      <select
        id={id}
        size={6}
        value={value}
        onChange={(e) => {
          const picked = options.find((o) => o.id === e.target.value) ?? null;
          setChosen(picked);
          onChange(e.target.value);
        }}
      >
        <option value="">— none selected —</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <small className={value ? '' : 'muted'}>{value && chosen ? `Selected: ${chosen.label}` : 'Click an element in the list to select it.'}</small>
    </div>
  );
}
