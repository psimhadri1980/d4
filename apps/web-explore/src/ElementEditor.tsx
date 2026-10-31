import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { allowedTransitions, isLifecycleState, LIFECYCLE } from '@d4/core';
import { api, keys, useRegistry } from '@d4/web-platform';
import { AttributeField, attrsFromForm, diffAttrs, elementName, ErrorBanner, type FormValues, toFormValue, typesByLayer } from '@d4/ui-kit';

/** Metamodel-driven form: fields, enums, required flags and lifecycle moves come from the rules. */
export function ElementEditor({ mode }: { mode: 'create' | 'edit' }) {
  const { ws, id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const registry = useRegistry(ws);
  const existing = useQuery({
    queryKey: keys.element(ws, id),
    enabled: mode === 'edit' && !!id,
    queryFn: () => api.element(ws!, id!),
  });

  // `?type=Decision` preselects the type (e.g. "New decision" on the Decisions page).
  const [search] = useSearchParams();
  const [type, setType] = useState(mode === 'create' ? (search.get('type') ?? '') : '');
  const [values, setValues] = useState<FormValues>({});
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [issues, setIssues] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const reg = registry.data;
  // An unknown `?type=` must not look selected.
  useEffect(() => {
    if (reg && type && !reg.nodeType(type)) setType('');
  }, [reg, type]);
  const defs = useMemo(() => (reg && type ? reg.attributesFor(type) : []), [reg, type]);

  // Load the element being edited into the form.
  useEffect(() => {
    const e = existing.data;
    if (!e || !reg) return;
    setType(e.type);
    setValues(Object.fromEntries(reg.attributesFor(e.type).map((d) => [d.name, toFormValue(d, e.attrs[d.name])])));
    setValidFrom(e.validFrom ?? '');
    setValidTo(e.validTo ?? '');
  }, [existing.data, reg]);

  if (registry.error) return <ErrorBanner error={registry.error} />;
  if (!reg || (mode === 'edit' && !existing.data)) {
    return existing.error ? <ErrorBanner error={existing.error} /> : <div className="splash">Loading…</div>;
  }

  const current = existing.data?.attrs['lifecycle'];
  const lifecycleOptions =
    mode === 'edit' && isLifecycleState(current) ? [current, ...allowedTransitions(current)] : [...LIFECYCLE];
  const optionsFor = (name: string, enumName?: string) =>
    name === 'lifecycle' ? lifecycleOptions : enumName ? reg.metamodel.enums[enumName] : undefined;

  // Required and common fields first, then the type's own attributes.
  const commonNames = new Set(reg.metamodel.commonAttributes.map((a) => a.name));
  const ordered = [...defs.filter((d) => commonNames.has(d.name)), ...defs.filter((d) => !commonNames.has(d.name))];

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    const attrs = attrsFromForm(defs, values);
    if (mode === 'create' && !attrs['lifecycle']) attrs['lifecycle'] = 'IDEA';
    const found = reg.validateNodeAttributes(type, attrs);
    setIssues(found);
    if (found.length) return;

    setBusy(true);
    try {
      if (mode === 'create') {
        const created = await api.createElement(ws!, {
          type,
          attrs,
          validFrom: validFrom || null,
          validTo: validTo || null,
        });
        await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[1] === ws });
        navigate(`/w/${ws}/e/${created.id}`);
      } else {
        const e = existing.data!;
        const { set, unset } = diffAttrs(e.attrs, attrs);
        await api.updateElement(ws!, e.id, e.version, {
          set,
          unset,
          validFrom: validFrom || null,
          validTo: validTo || null,
        });
        await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[1] === ws });
        navigate(`/w/${ws}/e/${e.id}`);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="editor">
      <form className="card form" onSubmit={(e) => void submit(e)}>
        <h2>{mode === 'create' ? 'New element' : `Edit ${elementName(existing.data!)}`}</h2>

        <div className="field">
          <label htmlFor="type">Type</label>
          {mode === 'create' ? (
            <select id="type" value={type} onChange={(e) => setType(e.target.value)} required>
              <option value="">Choose a type…</option>
              {typesByLayer(reg).map(([layer, types]) => (
                <optgroup key={layer} label={layer}>
                  {types.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          ) : (
            <input id="type" value={type} disabled />
          )}
          {type && reg.nodeType(type)?.description && <small className="muted">{reg.nodeType(type)!.description}</small>}
        </div>

        {ordered.map((d) => (
          <AttributeField
            key={d.name}
            def={d}
            value={values[d.name] ?? (d.type === 'boolean' ? false : '')}
            options={optionsFor(d.name, d.enum)}
            onChange={(v) => setValues((x) => ({ ...x, [d.name]: v }))}
          />
        ))}

        {type && (
          <div className="row">
            <div className="field">
              <label htmlFor="validFrom">Valid from</label>
              <input id="validFrom" type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="validTo">Valid to</label>
              <input id="validTo" type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
            </div>
          </div>
        )}

        {issues.length > 0 && (
          <div className="error-banner" role="alert">
            <strong>Please fix:</strong>
            <ul>
              {issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </div>
        )}
        <ErrorBanner error={error} />

        <div className="actions">
          <button className="button primary" type="submit" disabled={!type || busy}>
            {busy ? 'Saving…' : mode === 'create' ? 'Create' : 'Save'}
          </button>
          <Link className="button ghost" to={mode === 'edit' ? `/w/${ws}/e/${id}` : `/w/${ws}`}>
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
