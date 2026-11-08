import { useEffect, useId, useState, type FormEvent } from 'react';
import { formatLensText, parseLensText, type LensText } from '@d4/core';
import type { MetamodelRegistry } from '@d4/metamodel';
import type { LensDraft } from './LensEditor';

/**
 * The lens written as one line (D93), such as `2+Application+2 via dependency where lifecycle=LIVE`.
 * It shows the draft as text while the form can say it; Apply reads the line back into the draft,
 * checked against the metamodel, and replaces its contour, facets and traversal.
 */
export function LensTextForm({ registry, draft, onApply }: { registry: MetamodelRegistry; draft: LensDraft; onApply(patch: Partial<LensDraft>): void }) {
  const id = useId();
  const current = draft.contour ? formatLensText({ ...draft, contour: draft.contour }) : null;
  const [text, setText] = useState(current ?? '');
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Follows the editor below until the user types here.
  useEffect(() => {
    if (!dirty) setText(current ?? '');
  }, [current, dirty]);

  const apply = (e: FormEvent) => {
    e.preventDefault();
    const r = parseLensText(text);
    const problem = 'error' in r ? r.error : unknown(registry, r.lens);
    setError(problem);
    if (problem || 'error' in r) return;
    const { contour, steps, depth, shape } = r.lens;
    onApply({ contour, facets: [], query: undefined, steps, depth, shape, disclosure: { ...draft.disclosure, initialDepth: depth } });
    setDirty(false);
  };

  return (
    <form className="lens-editor-text" onSubmit={apply} noValidate>
      <label htmlFor={`${id}-text`}>Write it as text</label>
      <div className="lens-editor-text-row">
        <input
          id={`${id}-text`}
          value={text}
          spellCheck={false}
          placeholder="2+Application+2 via dependency where lifecycle=LIVE as flow"
          aria-describedby={`${id}-hint`}
          aria-invalid={!!error || undefined}
          onChange={(e) => {
            setText(e.target.value);
            setDirty(true);
            setError(null);
          }}
        />
        <button type="submit" className="button ghost small" disabled={!text.trim()}>
          Apply
        </button>
      </div>
      <p id={`${id}-hint`} className={error ? 'lens-editor-error' : 'lens-editor-hint'} role={error ? 'alert' : undefined}>
        {error ??
          (draft.contour && !current && !dirty
            ? 'This lens says more than the text form can; applying a line replaces its contour, facets and traversal.'
            : 'N+Type follows N levels up, Type+N down; then via a kind or relationships, to types, where filters, as a shape.')}
      </p>
    </form>
  );
}

/** What the line names that the metamodel does not have, or null. */
function unknown(registry: MetamodelRegistry, lens: LensText): string | null {
  const type = lens.contour.type;
  if (!registry.nodeType(type)) return `There is no node type ${type}`;
  const step = lens.steps?.[0];
  const rel = step?.relationships?.find((r) => !registry.relationshipType(r));
  if (rel) return `There is no relationship ${rel}`;
  const to = step?.types?.find((t) => !registry.nodeType(t));
  if (to) return `There is no node type ${to}`;
  const attrs = new Set(['name', ...registry.attributesFor(type).map((d) => d.name)]);
  const attr = lens.contour.attributes.find((f) => !attrs.has(f.attribute));
  return attr ? `${type} has no attribute ${attr.attribute}` : null;
}
