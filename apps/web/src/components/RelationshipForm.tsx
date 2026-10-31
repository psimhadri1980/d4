import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { MetamodelRegistry } from '@d4/metamodel';
import { AttributeField } from './AttributeField';
import { ErrorBanner } from './ErrorBanner';
import { api, type Element, useView } from '@d4/web-platform';
import { attrsFromForm, elementName, type FormValues, relationshipOptions } from '../model';

interface Props {
  registry: MetamodelRegistry;
  workspaceId: string;
  element: Element;
  onDone(): void | Promise<void>;
}

/** Connects the element to another one; only relationship types the metamodel allows are offered. */
export function RelationshipForm({ registry, workspaceId: ws, element, onDone }: Props) {
  const options = useMemo(() => relationshipOptions(registry, element.type), [registry, element.type]);
  const [choice, setChoice] = useState(0);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [targetId, setTargetId] = useState('');
  const [values, setValues] = useState<FormValues>({});
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const { view } = useView();

  const option = options[choice];
  const relDef = option ? registry.relationshipType(option.type) : undefined;

  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => {
    setTargetId('');
    setValues({});
  }, [choice]);

  const candidates = useQuery({
    queryKey: ['candidates', ws, option?.type, option?.direction, q, view.scenario],
    enabled: !!option,
    // Scenario elements can be connected while that scenario is selected; dates are not filtered.
    queryFn: () => api.listElements(ws, { type: option!.partnerTypes, q: q || undefined, first: 30 }, { scenario: view.scenario || undefined }),
  });

  if (!options.length) return <div className="muted small">The metamodel allows no relationships for {element.type}.</div>;

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!option || !targetId) return;
    setBusy(true);
    setError(null);
    try {
      await api.createRelationship(ws, {
        type: option.type,
        fromId: option.direction === 'OUT' ? element.id : targetId,
        toId: option.direction === 'OUT' ? targetId : element.id,
        attrs: attrsFromForm(relDef?.attributes ?? [], values),
        validFrom: validFrom || null,
        // With a scenario selected in the Explorer, new relationships belong to that scenario.
        scenarioId: view.scenario || null,
        validTo: validTo || null,
      });
      await onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="rel-form" onSubmit={(e) => void submit(e)}>
      {view.scenario && <p className="view-notice small">This relationship will be added to the selected scenario, not the baseline.</p>}
      <div className="field">
        <label htmlFor="rel-type">Relationship</label>
        <select id="rel-type" value={choice} onChange={(e) => setChoice(Number(e.target.value))}>
          {options.map((o, i) => (
            <option key={`${o.type}-${o.direction}`} value={i}>
              {o.direction === 'OUT' ? `${o.type} →` : `← ${o.type}`}
            </option>
          ))}
        </select>
        {relDef?.description && <small className="muted">{relDef.description}</small>}
      </div>

      <div className="field">
        <label htmlFor="rel-target">{option?.direction === 'OUT' ? 'To' : 'From'}</label>
        <input
          type="search"
          placeholder={`Search ${option?.partnerTypes.slice(0, 3).join(', ')}${(option?.partnerTypes.length ?? 0) > 3 ? '…' : ''}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <select id="rel-target" value={targetId} onChange={(e) => setTargetId(e.target.value)} required size={6}>
          <option value="">— none selected —</option>
          {(candidates.data?.items ?? [])
            .filter((c) => c.id !== element.id)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {elementName(c)} — {c.type}
              </option>
            ))}
        </select>
      </div>

      {relDef?.attributes.map((d) => (
        <AttributeField
          key={d.name}
          def={d}
          value={values[d.name] ?? ''}
          options={d.enum ? registry.metamodel.enums[d.enum] : undefined}
          onChange={(v) => setValues((x) => ({ ...x, [d.name]: v }))}
        />
      ))}

      <div className="row">
        <div className="field">
          <label htmlFor="rel-from">Valid from</label>
          <input id="rel-from" type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="rel-to">Valid to</label>
          <input id="rel-to" type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
        </div>
      </div>

      <ErrorBanner error={error} />
      <button className="button primary" type="submit" disabled={busy || !targetId}>
        {busy ? 'Saving…' : 'Add relationship'}
      </button>
    </form>
  );
}
