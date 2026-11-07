import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { describeFilter, lensChips, type Lens, type LensAttributeFilter, type LensFacet } from '@d4/core';
import type { AttributeDef, MetamodelRegistry, NodeTypeRole } from '@d4/metamodel';
import { attributeLabel } from './GraphInspector';
import { LensQuerySource, type LensCatalogQuery, type LensQueryDraft, type SubmitQueryResult } from './LensQuerySource';
import { typesByLayer } from './model';

/** What the lens editor knows about the data for its contour (LE-1): from the host's profile call. */
export interface LensProfile {
  count: number;
  links: { relationship: string; direction: 'OUT' | 'IN'; type: string; count: number }[];
  values: Record<string, { value?: unknown; count: number }[]>;
}

/** The sticky preview (LE-6): what the lens finds, step by step. */
export interface LensPreview {
  /** Roots after the contour and its own filters, then after each facet in turn. */
  funnel: number[];
  /** Some of the roots the whole lens finds. */
  sample: string[];
}

/** A lens being edited: no contour yet means "Choose a node type…" (LE-9). */
/** A Hierarchy lens follows containment down from its roots, level after level (D85). */
const HIERARCHY_STEPS: Lens['steps'] = [{ kind: 'containment', direction: 'down', repeat: true }];

export type LensDraft = Omit<Lens, 'id' | 'contour'> & { id?: string; contour: Lens['contour'] | null };

export interface LensEditorProps {
  registry: MetamodelRegistry;
  /** The lens to edit, or a starting point for a new one; null starts empty. */
  initial: LensDraft | null;
  /** Lenses to copy from ("Start from…", LE-7). */
  lenses: readonly Lens[];
  profile?: LensProfile | null;
  preview?: LensPreview | null;
  /** Node type roles for this session, over the metamodel's (LE-5). */
  roles?: Readonly<Record<string, NodeTypeRole>>;
  onRolesChange?(roles: Record<string, NodeTypeRole>): void;
  /** Called whenever the draft changes, so the host can fetch the profile and the preview. */
  onDraftChange?(draft: LensDraft): void;
  /** Whether the user may share lenses with the workspace. */
  canShare?: boolean;
  /** Built-in lenses are saved as the user's own copy. */
  builtIn?: boolean;
  onSave(draft: LensDraft & { contour: Lens['contour'] }): void;
  onCancel(): void;
  onDelete?(): void;
  /** The load limit the preview's meter shows against (GV-6). */
  limit?: number;
  /** For query lenses (D84): the workspace (element parameters), the queries the user may pick, and for Query Authors a way to submit a new one. */
  workspaceId?: string;
  catalogQueries?: readonly LensCatalogQuery[];
  onSubmitQuery?(draft: LensQueryDraft): Promise<SubmitQueryResult>;
}

const EMPTY: LensDraft = { name: '', contour: null, facets: [], match: 'all', depth: 2, layout: 'hier', view: 'graph', follow: false, visibility: 'private' };
const LAYOUTS: [Lens['layout'], string][] = [
  ['hier', 'Hierarchical'],
  ['flow', 'Flow'],
  ['layers', 'By layer'],
  ['radial', 'Radial'],
  ['force', 'Force-directed'],
];

/**
 * The lens editor (LE-1…LE-10), full screen over the Studio: 1 Contour, 2 Facets, 3 About, 4 When
 * it is opened, 5 Node type roles, with a sticky preview. It fetches nothing: the host passes the
 * contour's profile and the preview, and saves.
 */
export function LensEditor(props: LensEditorProps) {
  const { registry, initial, lenses, profile, preview, roles = {}, onRolesChange, onDraftChange, canShare = false, builtIn = false, onSave, onCancel, onDelete, limit = 1000, workspaceId = '', catalogQueries, onSubmitQuery } = props;
  const id = useId();
  const [draft, setDraft] = useState<LensDraft>(() => ({ ...EMPTY, ...initial }));
  const set = (patch: Partial<LensDraft>) => setDraft((d) => ({ ...d, ...patch }));
  useEffect(() => {
    onDraftChange?.(draft);
  }, [draft, onDraftChange]);
  const roleOf = (t: string) => roles[t] ?? registry.roleOf(t);
  const contourType = draft.contour?.type ?? null;
  const byQuery = draft.query !== undefined;
  const ready = !!contourType && !!draft.name.trim() && (!byQuery || !!draft.query?.id);

  // Escape leaves the editor without saving.
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && onCancel();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onCancel]);

  const title = draft.id ? `Edit lens: ${initial?.name ?? draft.name}` : 'New lens';
  return (
    <div className="lens-editor" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
      <header className="lens-editor-head">
        <h2 id={`${id}-title`}>{title}</h2>
        <StartFrom lenses={lenses} onPick={(l) => setDraft({ ...EMPTY, ...l, id: draft.id, name: draft.name || `Copy of ${l.name}`, visibility: draft.visibility })} />
        <div className="lens-editor-actions">
          {onDelete && (
            <button type="button" className="button ghost danger" onClick={onDelete}>
              Delete lens
            </button>
          )}
          <button type="button" className="button ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="button" disabled={!ready} onClick={() => ready && onSave({ ...draft, name: draft.name.trim(), contour: draft.contour! })}>
            {builtIn ? 'Save as my lens' : 'Save'}
          </button>
        </div>
      </header>

      <div className="lens-editor-body">
        <div className="lens-editor-sections">
          <Section n={1} title="Contour" note="The node type every result is.">
            <TypePicker
              label="Contour type"
              registry={registry}
              value={contourType}
              allow={(t) => roleOf(t) !== 'facet'}
              placeholder="Choose a node type…"
              onPick={(type) => set({ contour: { type, attributes: [] }, facets: [] })}
            />
            {draft.contour && profile && <p className="lens-editor-hint">{profile.count.toLocaleString()} nodes of this type in the data.</p>}
            {draft.contour && (
              <AttributeFilters
                registry={registry}
                type={draft.contour.type}
                filters={draft.contour.attributes ?? []}
                values={profile?.values}
                total={profile?.count}
                onChange={(attributes) => set({ contour: { ...draft.contour!, attributes } })}
              />
            )}
          </Section>

          <Section n={2} title={byQuery ? 'Roots' : 'Facets'} note={byQuery ? 'The roots come from a catalog query; the contour filters narrow them.' : 'Node types linked to the contour that qualify it.'}>
            {catalogQueries && (
              <div className="lens-editor-roots" role="radiogroup" aria-label="Roots from">
                <label className="lens-editor-check">
                  <input type="radio" name={`${id}-roots`} checked={!byQuery} onChange={() => set({ query: undefined })} />
                  Facets
                </label>
                <label className="lens-editor-check">
                  <input type="radio" name={`${id}-roots`} checked={byQuery} onChange={() => set({ query: { id: '' }, facets: [] })} />
                  A catalog query
                </label>
              </div>
            )}
            {byQuery && catalogQueries ? (
              <LensQuerySource
                workspaceId={workspaceId}
                queries={catalogQueries}
                value={draft.query?.id ? draft.query : undefined}
                onChange={(query) => set({ query: query ?? { id: '' } })}
                onSubmitQuery={onSubmitQuery}
              />
            ) : !draft.contour ? (
              <p className="lens-editor-hint">Choose a contour first.</p>
            ) : (
              <Facets registry={registry} contour={draft.contour.type} facets={draft.facets} match={draft.match} profile={profile} allow={(t) => roleOf(t) !== 'contour'} onChange={(facets) => set({ facets })} onMatch={(match) => set({ match })} />
            )}
          </Section>

          <Section n={3} title="Quick filters" note="Attributes the smart bar offers to narrow this lens. None ticked: the contour's pick-list attributes.">
            {!draft.contour ? (
              <p className="lens-editor-hint">Choose a contour first.</p>
            ) : (
              <QuickFilterPicker registry={registry} type={draft.contour.type} value={draft.quickFilters ?? []} onChange={(quickFilters) => set({ quickFilters: quickFilters.length ? quickFilters : undefined })} />
            )}
          </Section>

          <Section n={4} title="About">
            <div className="lens-editor-grid">
              <Field label="Name">{(fid) => <input id={fid} value={draft.name} onChange={(e) => set({ name: e.target.value })} required />}</Field>
              <Field label="Visible to">
                {(fid) => (
                  <select id={fid} value={draft.visibility ?? 'private'} onChange={(e) => set({ visibility: e.target.value as 'private' | 'workspace' })}>
                    <option value="private">Only me</option>
                    <option value="workspace" disabled={!canShare}>
                      Everyone in the workspace{canShare ? '' : ' (needs write access)'}
                    </option>
                  </select>
                )}
              </Field>
              <Field label="Description" wide>
                {(fid) => <textarea id={fid} rows={2} value={draft.description ?? ''} onChange={(e) => set({ description: e.target.value })} />}
              </Field>
            </div>
          </Section>

          <Section n={5} title="When it is opened">
            <div className="lens-editor-grid">
              <Field label="Shape">
                {(fid) => (
                  <select
                    id={fid}
                    value={draft.shape ?? 'ego'}
                    onChange={(e) => set(e.target.value === 'tree' ? { shape: 'tree', steps: HIERARCHY_STEPS, layout: 'hier' } : { shape: 'ego', steps: undefined })}
                  >
                    <option value="ego">Around the roots</option>
                    <option value="tree">Hierarchy: down through what they contain</option>
                  </select>
                )}
              </Field>
              <Field label="Depth">
                {(fid) => (
                  <select id={fid} value={draft.depth} onChange={(e) => set({ depth: Number(e.target.value) })}>
                    {[1, 2, 3, 4, 5, 6].map((d) => (
                      <option key={d}>{d}</option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Layout">
                {(fid) => (
                  <select id={fid} value={draft.layout} onChange={(e) => set({ layout: e.target.value as Lens['layout'] })}>
                    {LAYOUTS.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="View">
                {(fid) => (
                  <select id={fid} value={draft.view} onChange={(e) => set({ view: e.target.value as Lens['view'] })}>
                    <option value="graph">Graph</option>
                    <option value="table">Table</option>
                  </select>
                )}
              </Field>
              <label className="lens-editor-check">
                <input type="checkbox" checked={!!draft.follow} onChange={(e) => set({ follow: e.target.checked })} />
                Follow selection
              </label>
            </div>
          </Section>

          <Section n={6} title="Node type roles" note="Which types can be a contour, a facet or both, for this session. The metamodel sets the starting role.">
            <RolesTable registry={registry} roles={roles} onChange={onRolesChange} />
          </Section>
        </div>

        <PreviewPanel draft={draft} preview={preview} limit={limit} />
      </div>
    </div>
  );
}

function QuickFilterPicker({ registry, type, value, onChange }: { registry: MetamodelRegistry; type: string; value: readonly string[]; onChange(v: string[]): void }) {
  // The name is what the smart bar's text searches already; a description is too long to filter by.
  const defs = registry.attributesFor(type).filter((d) => d.name !== 'name' && d.name !== 'description');
  return (
    <fieldset className="lens-editor-quick">
      <legend className="sr-only">Quick filter attributes</legend>
      {defs.map((d) => (
        <label key={d.name} className="lens-editor-check">
          <input
            type="checkbox"
            checked={value.includes(d.name)}
            onChange={(e) => onChange(e.target.checked ? [...value, d.name] : value.filter((n) => n !== d.name))}
          />
          {attributeLabel(d.name)}
        </label>
      ))}
    </fieldset>
  );
}

function Section({ n, title, note, children }: { n: number; title: string; note?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="lens-editor-section" aria-labelledby={id}>
      <h3 id={id}>
        <span className="lens-editor-step" aria-hidden="true">
          {n}
        </span>
        {title}
      </h3>
      {note && <p className="lens-editor-hint">{note}</p>}
      {children}
    </section>
  );
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className={`lens-editor-field${wide ? ' wide' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
}

function StartFrom({ lenses, onPick }: { lenses: readonly Lens[]; onPick(l: Lens): void }) {
  const id = useId();
  if (!lenses.length) return null;
  return (
    <div className="lens-editor-start">
      <label htmlFor={id}>Start from…</label>
      <select
        id={id}
        value=""
        onChange={(e) => {
          const l = lenses.find((x) => x.id === e.target.value);
          if (l) onPick(l);
        }}
      >
        <option value="">Copy a lens</option>
        {lenses.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
    </div>
  );
}

// ── 1 Contour (and the facet type finder) ─────────────────────────────────

const PIN_KEY = 'd4:lens-editor:pinned';
const readPins = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(PIN_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
};
const writePins = (pins: string[]) => {
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify(pins));
  } catch {
    // Pins are a convenience; without storage they last until the page closes.
  }
};
/** Types picked this session, newest first. */
const recent: string[] = [];

/**
 * A type-ahead popover over node types (LE-2): Pinned, Recent, then the layers. Built for 30 to 40
 * types and more; nothing shows as one long flat list.
 */
function TypePicker({ label, registry, value, allow, placeholder, onPick }: { label: string; registry: MetamodelRegistry; value: string | null; allow(t: string): boolean; placeholder: string; onPick(t: string): void }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [pins, setPins] = useState(readPins);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const groups = useMemo(() => {
    const text = q.trim().toLowerCase();
    const fits = (t: string) => allow(t) && (!text || t.toLowerCase().includes(text));
    const out: [string, string[]][] = [
      ['Pinned', pins.filter((t) => registry.nodeType(t) && fits(t))],
      ['Recent', recent.filter((t) => !pins.includes(t) && fits(t)).slice(0, 5)],
      ...typesByLayer(registry).map(([layer, ts]) => [layer, ts.filter(fits)] as [string, string[]]),
    ];
    return out.filter(([, ts]) => ts.length);
  }, [q, pins, registry, allow]);

  const pick = (t: string) => {
    recent.splice(0, recent.length, t, ...recent.filter((x) => x !== t));
    onPick(t);
    setOpen(false);
    setQ('');
  };
  const togglePin = (t: string) => {
    const next = pins.includes(t) ? pins.filter((x) => x !== t) : [...pins, t];
    setPins(next);
    writePins(next);
  };

  return (
    <div className="lens-type-picker" ref={box}>
      <span className="lens-editor-label" id={`${id}-label`}>
        {label}
      </span>
      <button type="button" className="lens-type-button" aria-labelledby={`${id}-label ${id}-value`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span id={`${id}-value`}>{value ?? placeholder}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="lens-type-pop" role="dialog" aria-label={label}>
          <input type="search" aria-label="Find a node type" placeholder="Find a node type" value={q} autoFocus onChange={(e) => setQ(e.target.value)} />
          <div className="lens-type-groups">
            {groups.length ? (
              groups.map(([g, ts]) => (
                <div key={g} role="group" aria-label={g}>
                  <div className="lens-type-group">{g}</div>
                  {ts.map((t) => (
                    <div key={`${g}-${t}`} className={`lens-type-row${t === value ? ' current' : ''}`}>
                      <button type="button" className="lens-type-name" onClick={() => pick(t)}>
                        {t}
                      </button>
                      <button type="button" className="lens-type-pin" aria-pressed={pins.includes(t)} aria-label={`${pins.includes(t) ? 'Unpin' : 'Pin'} ${t}`} onClick={() => togglePin(t)}>
                        {pins.includes(t) ? '★' : '☆'}
                      </button>
                    </div>
                  ))}
                </div>
              ))
            ) : (
              <p className="lens-editor-hint">No node type matches.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Attribute filters (LE-8) ─────────────────────────────────────────────

type Kind = 'pick' | 'amount' | 'date' | 'text';
/** Strings with at most this many distinct values are offered as a pick-list. */
const PICK_MAX = 12;

function kindOf(d: AttributeDef, values?: { value?: unknown }[]): Kind {
  if (d.type === 'enum' || d.type === 'boolean') return 'pick';
  if (d.type === 'number' || d.type === 'integer') return 'amount';
  if (d.type === 'date' || d.type === 'datetime') return 'date';
  if ((d.type === 'string' || d.type === 'string[]') && values && values.length > 0 && values.length <= PICK_MAX) return 'pick';
  return 'text';
}

const DATE_PRESETS: { id: string; label: string; make(today: Date): Pick<LensAttributeFilter, 'op' | 'value'> }[] = [
  { id: 'last30', label: 'Last 30 days', make: (t) => ({ op: 'gte', value: iso(addDays(t, -30)) }) },
  { id: 'lastYear', label: 'Last year', make: (t) => ({ op: 'gte', value: iso(addDays(t, -365)) }) },
  { id: 'past', label: 'Before today', make: (t) => ({ op: 'lte', value: iso(addDays(t, -1)) }) },
  { id: 'next90', label: 'Next 90 days', make: (t) => ({ op: 'lte', value: iso(addDays(t, 90)) }) },
  { id: 'nextYear', label: 'Next year', make: (t) => ({ op: 'lte', value: iso(addDays(t, 365)) }) },
  { id: 'later', label: 'More than a year ahead', make: (t) => ({ op: 'gte', value: iso(addDays(t, 366)) }) },
];
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * How well an attribute splits the data, for ranking Add filter's suggestions (LE-3): 0 when one
 * value covers everything, towards 1 when values are spread evenly.
 */
function splitScore(values: { count: number }[] | undefined, total: number | undefined): number {
  if (!values?.length || !total) return 0;
  return 1 - Math.max(...values.map((v) => v.count)) / total;
}

function AttributeFilters({
  registry,
  type,
  filters,
  values,
  total,
  onChange,
}: {
  registry: MetamodelRegistry;
  type: string;
  filters: LensAttributeFilter[];
  values?: LensProfile['values'];
  total?: number;
  onChange(f: LensAttributeFilter[]): void;
}) {
  const id = useId();
  const defs = registry.attributesFor(type);
  const used = new Set(filters.map((f) => f.attribute));
  const offered = defs.filter((d) => !used.has(d.name)).sort((a, b) => splitScore(values?.[b.name], total) - splitScore(values?.[a.name], total) || a.name.localeCompare(b.name));
  const [q, setQ] = useState('');
  const shown = offered.filter((d) => !q || attributeLabel(d.name).toLowerCase().includes(q.toLowerCase()));

  const replace = (i: number, f: LensAttributeFilter | null) => onChange(f ? filters.map((x, j) => (j === i ? f : x)) : filters.filter((_, j) => j !== i));
  const add = (name: string) => {
    const d = defs.find((x) => x.name === name)!;
    const vs = values?.[name];
    const kind = kindOf(d, vs);
    const first = vs?.[0]?.value;
    const start: LensAttributeFilter =
      kind === 'pick'
        ? { attribute: name, op: 'in', value: [] }
        : kind === 'amount'
          ? { attribute: name, op: 'gte', value: typeof first === 'number' ? first : 0 }
          : kind === 'date'
            ? { attribute: name, ...DATE_PRESETS[1]!.make(new Date()) }
            : { attribute: name, op: 'contains', value: '' };
    onChange([...filters, start]);
    setQ('');
  };

  return (
    <div className="lens-filters">
      {filters.map((f, i) => {
        const d = defs.find((x) => x.name === f.attribute);
        return (
          <FilterRow
            key={`${f.attribute}-${i}`}
            def={d}
            filter={f}
            values={values?.[f.attribute]}
            enumValues={d?.enum ? registry.metamodel.enums[d.enum] : d?.type === 'boolean' ? ['true', 'false'] : undefined}
            onChange={(nf) => replace(i, nf)}
            onRemove={() => replace(i, null)}
          />
        );
      })}
      <div className="lens-filter-add">
        <label htmlFor={`${id}-q`}>Add filter</label>
        <input id={`${id}-q`} type="search" placeholder="Find an attribute" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul aria-label="Attributes to filter on" className="lens-filter-suggest">
          {shown.slice(0, 8).map((d) => (
            <li key={d.name}>
              <button type="button" className="button ghost small" onClick={() => add(d.name)}>
                {attributeLabel(d.name)}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function FilterRow({
  def,
  filter,
  values,
  enumValues,
  onChange,
  onRemove,
}: {
  def?: AttributeDef;
  filter: LensAttributeFilter;
  values?: { value?: unknown; count: number }[];
  enumValues?: string[];
  onChange(f: LensAttributeFilter): void;
  onRemove(): void;
}) {
  const id = useId();
  const kind = def ? kindOf(def, values) : 'text';
  const label = attributeLabel(filter.attribute);
  const counts = new Map((values ?? []).map((v) => [String(v.value), v.count]));
  let control: ReactNode;
  if (kind === 'pick') {
    const options = enumValues ?? (values ?? []).map((v) => String(v.value));
    const chosen = new Set((Array.isArray(filter.value) ? filter.value : [filter.value]).map(String));
    control = (
      <fieldset className="lens-filter-pick">
        <legend className="sr-only">{label}</legend>
        {options.map((o) => (
          <label key={o}>
            <input
              type="checkbox"
              checked={chosen.has(o)}
              onChange={(e) => {
                const next = e.target.checked ? [...chosen, o] : [...chosen].filter((x) => x !== o);
                const typed = next.map((x) => (def?.type === 'boolean' ? x === 'true' : x));
                onChange({ ...filter, op: 'in', value: typed });
              }}
            />
            {o}
            {counts.has(o) && <span className="lens-count">{counts.get(o)}</span>}
          </label>
        ))}
      </fieldset>
    );
  } else if (kind === 'amount') {
    control = (
      <>
        <select aria-label={`${label}: how`} value={filter.op} onChange={(e) => onChange({ ...filter, op: e.target.value as LensAttributeFilter['op'] })}>
          <option value="gte">at least</option>
          <option value="lte">at most</option>
          <option value="eq">exactly</option>
        </select>
        <input id={id} aria-label={`${label}: amount`} type="number" value={String(filter.value)} onChange={(e) => onChange({ ...filter, value: Number(e.target.value) })} />
      </>
    );
  } else if (kind === 'date') {
    const today = new Date();
    const current = DATE_PRESETS.find((p) => {
      const m = p.make(today);
      return m.op === filter.op && m.value === filter.value;
    });
    control = (
      <select aria-label={`${label}: when`} value={current?.id ?? ''} onChange={(e) => onChange({ ...filter, ...DATE_PRESETS.find((p) => p.id === e.target.value)!.make(today) })}>
        {!current && <option value="">{describeFilter(filter)}</option>}
        {DATE_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
    );
  } else {
    control = (
      <>
        <select aria-label={`${label}: how`} value={filter.op} onChange={(e) => onChange({ ...filter, op: e.target.value as LensAttributeFilter['op'] })}>
          <option value="contains">contains</option>
          <option value="starts">starts with</option>
        </select>
        <input aria-label={`${label}: text`} value={String(filter.value)} onChange={(e) => onChange({ ...filter, value: e.target.value })} />
      </>
    );
  }
  return (
    <div className="lens-filter" role="group" aria-label={`Filter on ${label}`}>
      <span className="lens-filter-name">{label}</span>
      {control}
      <button type="button" className="lens-remove" aria-label={`Remove the ${label} filter`} onClick={onRemove}>
        ×
      </button>
    </div>
  );
}

// ── 2 Facets (LE-3) ──────────────────────────────────────────────────────

function Facets({
  registry,
  contour,
  facets,
  match,
  profile,
  allow,
  onChange,
  onMatch,
}: {
  registry: MetamodelRegistry;
  contour: string;
  facets: LensFacet[];
  match: Lens['match'];
  profile?: LensProfile | null;
  allow(t: string): boolean;
  onChange(f: LensFacet[]): void;
  onMatch(m: Lens['match']): void;
}) {
  const id = useId();
  const taken = new Set(facets.map((f) => `${f.types[0]}|${f.relationship ?? ''}|${f.direction}`));
  const suggestions = (profile?.links ?? []).filter((l) => allow(l.type) && !taken.has(`${l.type}|${l.relationship}|${l.direction}`)).slice(0, 8);
  const add = (f: LensFacet) => onChange([...facets, f]);
  const replace = (i: number, f: LensFacet | null) => onChange(f ? facets.map((x, j) => (j === i ? f : x)) : facets.filter((_, j) => j !== i));
  return (
    <div className="lens-facets">
      {suggestions.length > 0 && (
        <div>
          <span className="lens-editor-label">Linked in the data</span>
          <ul className="lens-facet-suggest" aria-label="Facet suggestions">
            {suggestions.map((l) => (
              <li key={`${l.type}|${l.relationship}|${l.direction}`}>
                <button type="button" className="button ghost small" onClick={() => add({ types: [l.type], relationship: l.relationship, direction: l.direction, link: 'has' })}>
                  {l.direction === 'OUT' ? '→' : '←'} {l.relationship.replace(/_/g, ' ')} {l.type} <span className="lens-count">{l.count}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <TypePicker label="Find another facet type…" registry={registry} value={null} allow={allow} placeholder="Choose a type" onPick={(t) => add({ types: [t], direction: 'BOTH', link: 'has' })} />
      {facets.length > 1 && (
        <div className="lens-editor-field">
          <label htmlFor={`${id}-match`}>Facets must</label>
          <select id={`${id}-match`} value={match} onChange={(e) => onMatch(e.target.value as Lens['match'])}>
            <option value="all">all hold</option>
            <option value="any">any one hold</option>
          </select>
        </div>
      )}
      {facets.map((f, i) => (
        <FacetCard key={i} registry={registry} contour={contour} facet={f} onChange={(nf) => replace(i, nf)} onRemove={() => replace(i, null)} />
      ))}
    </div>
  );
}

function FacetCard({ registry, contour, facet, onChange, onRemove }: { registry: MetamodelRegistry; contour: string; facet: LensFacet; onChange(f: LensFacet): void; onRemove(): void }) {
  const id = useId();
  const type = facet.types[0]!;
  // Relationship types the metamodel allows between the contour and the facet type, either way.
  const rels = registry
    .relationshipTypes()
    .filter((r) => registry.canConnect(r.name, contour, type) || registry.canConnect(r.name, type, contour))
    .map((r) => r.name);
  const summary = `${facet.link === 'none' ? 'Not linked to' : 'Linked to'} ${type}${facet.relationship ? ` by ${facet.relationship.replace(/_/g, ' ')}` : ''}`;
  return (
    <details className="lens-facet" open>
      <summary>{summary}</summary>
      <div className="lens-editor-grid">
        <div className="lens-editor-field">
          <label htmlFor={`${id}-link`}>Link</label>
          <select id={`${id}-link`} value={facet.link} onChange={(e) => onChange({ ...facet, link: e.target.value as LensFacet['link'] })}>
            <option value="has">has a link</option>
            <option value="none">has no link</option>
          </select>
        </div>
        <div className="lens-editor-field">
          <label htmlFor={`${id}-rel`}>Relationship</label>
          <select id={`${id}-rel`} value={facet.relationship ?? ''} onChange={(e) => onChange({ ...facet, relationship: e.target.value || undefined })}>
            <option value="">Any relationship</option>
            {[...new Set([...rels, ...(facet.relationship ? [facet.relationship] : [])])].map((r) => (
              <option key={r} value={r}>
                {r.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </div>
        <div className="lens-editor-field">
          <label htmlFor={`${id}-dir`}>Direction</label>
          <select id={`${id}-dir`} value={facet.direction} onChange={(e) => onChange({ ...facet, direction: e.target.value as LensFacet['direction'] })}>
            <option value="OUT">{contour} → {type}</option>
            <option value="IN">{type} → {contour}</option>
            <option value="BOTH">either way</option>
          </select>
        </div>
      </div>
      <AttributeFilters registry={registry} type={type} filters={facet.attributes ?? []} onChange={(attributes) => onChange({ ...facet, attributes })} />
      <button type="button" className="button ghost small" onClick={onRemove}>
        Remove this facet
      </button>
    </details>
  );
}

// ── 5 Node type roles (LE-5) ─────────────────────────────────────────────

function RolesTable({ registry, roles, onChange }: { registry: MetamodelRegistry; roles: Readonly<Record<string, NodeTypeRole>>; onChange?(r: Record<string, NodeTypeRole>): void }) {
  const [q, setQ] = useState('');
  const types = registry
    .nodeTypes()
    .filter((t) => !t.internal && (!q || t.name.toLowerCase().includes(q.toLowerCase()) || t.layer.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="lens-roles">
      <input type="search" aria-label="Find a node type or layer" placeholder="Find a node type or layer" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="lens-roles-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Node type</th>
              <th scope="col">Layer</th>
              <th scope="col">Role</th>
            </tr>
          </thead>
          <tbody>
            {types.map((t) => {
              const role = roles[t.name] ?? registry.roleOf(t.name);
              return (
                <tr key={t.name}>
                  <th scope="row">{t.name}</th>
                  <td>{t.layer}</td>
                  <td>
                    <div role="radiogroup" aria-label={`Role of ${t.name}`} className="lens-role-pills">
                      {(['contour', 'facet', 'both'] as const).map((r) => (
                        <button key={r} type="button" role="radio" aria-checked={role === r} disabled={!onChange} onClick={() => onChange?.({ ...roles, [t.name]: r })}>
                          {r.charAt(0).toUpperCase() + r.slice(1)}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Preview (LE-6) ───────────────────────────────────────────────────────

function PreviewPanel({ draft, preview, limit }: { draft: LensDraft; preview?: LensPreview | null; limit: number }) {
  const contour = draft.contour;
  const total = preview?.funnel.at(-1);
  const sentence = contour ? lensChips({ ...draft, id: '', contour } as Lens).join(' · ') : 'Choose a node type to start.';
  return (
    <aside className="lens-preview" aria-label="Preview" aria-live="polite">
      <h3>Preview</h3>
      <p className="lens-preview-sentence">{sentence}</p>
      {contour && preview && (
        <>
          <p className="lens-preview-total">
            <strong>{total?.toLocaleString()}</strong> {total === 1 ? 'root' : 'roots'}
          </p>
          <ol className="lens-funnel" aria-label="Step by step">
            <li>
              {contour.type}
              {contour.attributes?.length ? ` with ${contour.attributes.map(describeFilter).join(', ')}` : ''}
              <span className="lens-count">{preview.funnel[0]?.toLocaleString()}</span>
            </li>
            {draft.facets.map((f, i) => {
              const before = preview.funnel[i] ?? 0;
              const after = preview.funnel[i + 1] ?? 0;
              return (
                <li key={i}>
                  {f.link === 'none' ? 'not linked to' : 'linked to'} {f.types.join(' or ')}
                  <span className="lens-count">
                    {after.toLocaleString()}
                    {before > after ? ` (−${(before - after).toLocaleString()})` : ''}
                  </span>
                </li>
              );
            })}
          </ol>
          <div className="lens-meter">
            <span>
              Load limit: {Math.min(total ?? 0, limit).toLocaleString()} of {limit.toLocaleString()} roots
            </span>
            <meter min={0} max={limit} high={limit * 0.8} value={Math.min(total ?? 0, limit)} aria-label="Roots against the load limit" />
          </div>
          {preview.sample.length > 0 && (
            <>
              <h4>Sample</h4>
              <ul className="lens-sample">
                {preview.sample.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </aside>
  );
}
