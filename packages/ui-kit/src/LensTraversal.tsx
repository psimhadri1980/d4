import { useId } from 'react';
import type { Lens, LensRelationshipKind, LensStep } from '@d4/core';
import type { MetamodelRegistry } from '@d4/metamodel';

/** The lens patterns the editor offers (D85 section 4, D88, D90): each a preset of steps and a shape. */
export type LensPattern = 'ego' | 'tree' | 'lineage' | 'chain' | 'matrix';

type Draft = Pick<Lens, 'steps' | 'shape' | 'layout' | 'depth'> & { contour: { type: string } | null };

/** The most steps a viewpoint chain has: every step opens at first, and Depth stops at 6. */
export const CHAIN_MAX_STEPS = 6;

const KINDS: [LensRelationshipKind, string][] = [
  ['flow', 'Data flow'],
  ['dependency', 'Dependency'],
  ['containment', 'Containment'],
  ['ownership', 'Ownership'],
];

/** Which pattern a lens is, from its shape and steps. */
export function patternOf(d: Pick<Lens, 'steps' | 'shape'>): LensPattern {
  if (d.shape === 'tree') return 'tree';
  if (d.shape === 'matrix') return 'matrix';
  if (d.shape !== 'flow') return 'ego';
  const s = d.steps ?? [];
  return s.length === 1 && s[0]!.repeat && !s[0]!.types?.length ? 'lineage' : 'chain';
}

/** The draft fields a pattern sets when the user picks it. */
export function patternPreset(p: LensPattern, d: Draft, reg: MetamodelRegistry): Partial<Draft> {
  switch (p) {
    case 'ego':
      return { shape: 'ego', steps: undefined };
    case 'tree':
      return { shape: 'tree', steps: [{ kind: 'containment', direction: 'down', repeat: true }], layout: 'hier' };
    case 'lineage': {
      const kind = KINDS.find(([k]) => reg.relationshipsOfKind(k).length)?.[0] ?? 'flow';
      return { shape: 'flow', steps: [{ kind, direction: 'up', repeat: true }], layout: 'flow', depth: Math.max(d.depth, 3) };
    }
    case 'chain': {
      const next = d.contour ? nextTypes(reg, d.contour.type)[0] : undefined;
      return { shape: 'flow', steps: [{ direction: 'both', ...(next && { types: [next], stage: next }) }], layout: 'flow', depth: 1 };
    }
    case 'matrix': {
      const next = d.contour ? nextTypes(reg, d.contour.type)[0] : undefined;
      return { shape: 'matrix', steps: [{ direction: 'both', ...(next && { types: [next], stage: next }) }], depth: 1 };
    }
  }
}

/**
 * Types one relationship away from `type`, either way, most specific first. A relationship open to
 * any type (`*`) is left out, or every type would be offered.
 */
export function nextTypes(reg: MetamodelRegistry, type: string): string[] {
  const mine = new Set(reg.lineage(type));
  const out = new Set<string>();
  for (const r of reg.relationshipTypes()) {
    if (r.from.some((t) => mine.has(t))) for (const t of r.to) if (t !== '*') out.add(t);
    if (r.to.some((t) => mine.has(t))) for (const t of r.from) if (t !== '*') out.add(t);
  }
  return [...out].filter((t) => reg.nodeType(t)).sort();
}

/** Relationships between two types, either way, by name. */
function relationshipsBetween(reg: MetamodelRegistry, a: string, b: string): string[] {
  return reg
    .relationshipTypes()
    .filter((r) => reg.canConnect(r.name, a, b) || reg.canConnect(r.name, b, a))
    .map((r) => r.name)
    .sort();
}

/**
 * The editor's Traversal section (D88): the pattern, then what it follows. Lineage and impact follow
 * one relationship kind up or down as far as it goes; a viewpoint chain is typed steps, one column
 * each. Kinds the metamodel does not declare are offered greyed out, with the reason.
 */
export function LensTraversal({ registry: reg, draft, onChange }: { registry: MetamodelRegistry; draft: Draft; onChange(patch: Partial<Draft>): void }) {
  const id = useId();
  const pattern = patternOf(draft);
  const steps = draft.steps ?? [];
  const PATTERNS: [LensPattern, string, string][] = [
    ['ego', 'Around the roots', 'Each root and what is linked to it, any relationship, either way.'],
    ['tree', 'Hierarchy', 'Down through what the roots contain, as a tree.'],
    ['lineage', 'Lineage or impact', 'Where the roots come from, or what depends on them, as far as it goes.'],
    ['chain', 'Viewpoint chain', 'Typed steps from the roots, one column each: Capability → Application → Data.'],
    ['matrix', 'Matrix', 'The roots as rows, one linked type as columns: which X relate to which Y, and which relate to none.'],
  ];
  const noContainment = !reg.relationshipsOfKind('containment').length;
  return (
    <div className="lens-traversal">
      <div className="lens-editor-patterns" role="radiogroup" aria-label="Pattern">
        {PATTERNS.map(([p, label, note]) => {
          const off = p === 'tree' && noContainment;
          return (
            <label key={p} className={`lens-pattern${pattern === p ? ' current' : ''}${off ? ' off' : ''}`}>
              <input type="radio" name={`${id}-pattern`} checked={pattern === p} disabled={off} onChange={() => onChange(patternPreset(p, draft, reg))} />
              <span className="lens-pattern-name">{label}</span>
              <span className="lens-pattern-note">{off ? 'This metamodel declares no containment relationships.' : note}</span>
            </label>
          );
        })}
      </div>

      {pattern === 'lineage' && steps[0] && <LineageFields registry={reg} step={steps[0]} onChange={(s) => onChange({ steps: [s] })} />}
      {pattern === 'matrix' &&
        (draft.contour ? (
          <ol className="lens-chain-steps" aria-label="Columns">
            <ChainStep n={1} registry={reg} from={draft.contour.type} step={steps[0] ?? { direction: 'both' }} onChange={(s) => onChange({ steps: [s], depth: 1 })} />
          </ol>
        ) : (
          <p className="lens-editor-hint">Choose a contour first: its nodes are the rows.</p>
        ))}
      {pattern === 'matrix' && draft.contour && !steps[0]?.types?.length && <p className="lens-editor-hint">Choose the type of the columns.</p>}
      {pattern === 'chain' && <ChainSteps registry={reg} contour={draft.contour?.type ?? null} steps={steps} onChange={(s) => onChange({ steps: s, depth: Math.max(1, s.length) })} />}
    </div>
  );
}

function LineageFields({ registry: reg, step, onChange }: { registry: MetamodelRegistry; step: LensStep; onChange(s: LensStep): void }) {
  const kindId = useId();
  const dirId = useId();
  const names = step.kind ? reg.relationshipsOfKind(step.kind) : [];
  return (
    <div className="lens-editor-grid">
      <div className="lens-editor-field">
        <label htmlFor={kindId}>
          Follow
        </label>
        <select id={kindId} value={step.kind ?? ''} onChange={(e) => onChange({ ...step, kind: e.target.value as LensRelationshipKind })}>
          {KINDS.map(([k, label]) => {
            const n = reg.relationshipsOfKind(k).length;
            return (
              <option key={k} value={k} disabled={!n}>
                {label}
                {n ? '' : ' (none in this metamodel)'}
              </option>
            );
          })}
        </select>
      </div>
      <div className="lens-editor-field">
        <label htmlFor={dirId}>
          Direction
        </label>
        <select id={dirId} value={step.direction} onChange={(e) => onChange({ ...step, direction: e.target.value as LensStep['direction'] })}>
          <option value="up">Upstream: where it comes from</option>
          <option value="down">Downstream: where it goes, what it affects</option>
        </select>
      </div>
      <p className="lens-editor-hint lens-editor-field wide">{names.length ? `Follows ${names.map((n) => n.replace(/_/g, ' ').toLowerCase()).join(', ')}.` : 'This metamodel has no relationship of this kind.'}</p>
    </div>
  );
}

function ChainSteps({ registry: reg, contour, steps, onChange }: { registry: MetamodelRegistry; contour: string | null; steps: LensStep[]; onChange(s: LensStep[]): void }) {
  if (!contour) return <p className="lens-editor-hint">Choose a contour first: the chain starts there.</p>;
  const set = (i: number, s: LensStep) => onChange(steps.map((x, j) => (j === i ? s : x)));
  const from = (i: number) => (i === 0 ? contour : (steps[i - 1]?.types?.[0] ?? null));
  return (
    <div className="lens-chain">
      <ol className="lens-chain-steps" aria-label="Steps">
        <li className="lens-chain-start">
          <span className="lens-chain-stage">Start</span> {contour}
        </li>
        {steps.map((s, i) => (
          <ChainStep
            key={i}
            n={i + 1}
            registry={reg}
            from={from(i)}
            step={s}
            onChange={(x) => set(i, x)}
            onRemove={steps.length > 1 ? () => onChange(steps.filter((_, j) => j !== i)) : undefined}
          />
        ))}
      </ol>
      <button
        type="button"
        className="button ghost small"
        disabled={steps.length >= CHAIN_MAX_STEPS || !steps.at(-1)?.types?.length}
        onClick={() => {
          const last = steps.at(-1)?.types?.[0];
          const next = last ? nextTypes(reg, last).find((t) => t !== last && !steps.some((s) => s.types?.includes(t))) : undefined;
          onChange([...steps, { direction: 'both', ...(next && { types: [next], stage: next }) }]);
        }}
      >
        Add a step
      </button>
      {steps.length >= CHAIN_MAX_STEPS && <p className="lens-editor-hint">A chain has at most {CHAIN_MAX_STEPS} steps.</p>}
    </div>
  );
}

function ChainStep({ n, registry: reg, from, step, onChange, onRemove }: { n: number; registry: MetamodelRegistry; from: string | null; step: LensStep; onChange(s: LensStep): void; onRemove?(): void }) {
  const toId = useId();
  const viaId = useId();
  const dirId = useId();
  const stageId = useId();
  const to = step.types?.[0] ?? '';
  const offered = from ? nextTypes(reg, from) : reg.nodeTypes().map((t) => t.name).sort();
  const rels = from && to ? relationshipsBetween(reg, from, to) : [];
  const via = step.relationships?.[0] ?? '';
  return (
    <li className="lens-chain-step">
      <span className="lens-chain-n" aria-hidden="true">
        {n}
      </span>
      <div className="lens-editor-grid">
        <div className="lens-editor-field">
          <label htmlFor={toId}>
            To
          </label>
          <select
            id={toId}
            value={to}
            onChange={(e) => {
              const t = e.target.value;
              // The stage follows the type unless the user named it.
              const named = step.stage && step.stage !== to;
              onChange({ ...step, types: t ? [t] : undefined, relationships: undefined, stage: named ? step.stage : t || undefined });
            }}
          >
            <option value="">Any type</option>
            {(offered.includes(to) || !to ? offered : [to, ...offered]).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="lens-editor-field">
          <label htmlFor={viaId}>
            By
          </label>
          <select id={viaId} value={via} onChange={(e) => onChange({ ...step, relationships: e.target.value ? [e.target.value] : undefined })}>
            <option value="">Any relationship</option>
            {(rels.includes(via) || !via ? rels : [via, ...rels]).map((r) => (
              <option key={r} value={r}>
                {r.replace(/_/g, ' ').toLowerCase()}
              </option>
            ))}
          </select>
        </div>
        <div className="lens-editor-field">
          <label htmlFor={dirId}>
            Direction
          </label>
          <select id={dirId} value={step.direction} onChange={(e) => onChange({ ...step, direction: e.target.value as LensStep['direction'] })}>
            <option value="both">Either way</option>
            <option value="down">Down or downstream</option>
            <option value="up">Up or upstream</option>
          </select>
        </div>
        <div className="lens-editor-field">
          <label htmlFor={stageId}>
            Column heading
          </label>
          <input id={stageId} value={step.stage ?? ''} maxLength={60} placeholder={to || `Level ${n}`} onChange={(e) => onChange({ ...step, stage: e.target.value || undefined })} />
        </div>
      </div>
      {onRemove && (
        <button type="button" className="button ghost small" aria-label={`Remove step ${n}`} onClick={onRemove}>
          Remove
        </button>
      )}
    </li>
  );
}
