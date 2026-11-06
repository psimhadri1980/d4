import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { describeFilter, lensChips, lensNote, type Lens, type QuickFilter } from '@d4/core';
import type { MetamodelRegistry } from '@d4/metamodel';

export interface GraphSearchValue {
  /** '' is "Not sure yet". */
  lensId: string;
  name: string;
  filters: QuickFilter[];
}

export const EMPTY_GRAPH_SEARCH: GraphSearchValue = { lensId: '', name: '', filters: [] };

export interface GraphSearchProps {
  registry: MetamodelRegistry;
  lenses: readonly Lens[];
  /** The search last run; the fields start from it and follow it when it changes. */
  value?: GraphSearchValue;
  onSearch(value: GraphSearchValue): void;
  /** Clear resets the whole search and the canvas (LS-8); the host decides what that means. */
  onClear?(): void;
  /** The text being typed with no lens chosen, so the host can count each lens's roots (LS-5). */
  onUndecidedText?(text: string): void;
  /** Root counts per lens id, shown only while no lens is chosen. */
  lensCounts?: ReadonlyMap<string, { count: number; more: boolean }>;
  busy?: boolean;
}

type Option = { id: string; group: 'lens' | 'filter' | 'name'; text: string; note?: string; pick(): void };

/** Suggestions offered per attribute at most, and in all. */
const PER_ATTRIBUTE = 6;
const MAX_FILTERS = 8;

/**
 * Graph Studio's smart bar (LS-3…LS-5): pick a lens, then type part of a name or add quick filters
 * that narrow it. With "Not sure yet", the list shows the lenses that fit the text, with their
 * counts, and choosing one moves into that lens. Nothing runs until Search (or Enter).
 */
export function GraphSearch({ registry, lenses, value = EMPTY_GRAPH_SEARCH, onSearch, onClear, onUndecidedText, lensCounts, busy = false }: GraphSearchProps) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  // No option is active until the arrow keys pick one, so Enter after typing searches.
  const [active, setActive] = useState(-1);
  const [missing, setMissing] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => setDraft(value), [value]);

  const lens = lenses.find((l) => l.id === draft.lensId) ?? null;
  const text = draft.name.trim().toLowerCase();
  useEffect(() => {
    if (!lens) onUndecidedText?.(draft.name.trim());
  }, [lens, draft.name, onUndecidedText]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  // Quick filters: the contour's pick-list attributes (every type's lifecycle without a lens).
  const suggestions = useMemo(() => {
    const defs = lens ? registry.attributesFor(lens.contour.type) : registry.metamodel.commonAttributes;
    const enums = defs.filter((d) => d.type === 'enum' && d.enum);
    const fixed = new Set([...(lens?.contour.attributes ?? []), ...draft.filters].map((f) => f.attribute));
    const perAttribute = enums
      .filter((d) => !fixed.has(d.name))
      .map((d) =>
        (registry.metamodel.enums[d.enum!] ?? [])
          .map((v) => ({ attribute: d.name, op: 'eq' as const, value: v, label: describeFilter({ attribute: d.name, op: 'eq', value: v }) }))
          .filter((f) => !text || f.label.toLowerCase().includes(text))
          .slice(0, PER_ATTRIBUTE),
      );
    // Taken in turn from each attribute, so one long list does not crowd out the others.
    const out: QuickFilter[] = [];
    for (let i = 0; out.length < MAX_FILTERS && perAttribute.some((l) => l[i]); i++) for (const l of perAttribute) if (l[i] && out.length < MAX_FILTERS) out.push(l[i]!);
    return out;
  }, [registry, lens, draft.filters, text]);

  const options: Option[] = [
    ...(lens
      ? []
      : lenses
          .filter((l) => !text || l.name.toLowerCase().includes(text) || lensNote(l).toLowerCase().includes(text) || lensCounts?.get(l.id)?.count)
          .map((l): Option => {
            const c = lensCounts?.get(l.id);
            return { id: `lens-${l.id}`, group: 'lens', text: l.name, note: c ? `${c.count}${c.more ? '+' : ''}` : lensNote(l), pick: () => pickLens(l.id) };
          })),
    ...suggestions.map((f, i): Option => ({ id: `filter-${i}`, group: 'filter', text: f.label, pick: () => addFilter(f) })),
    ...(text ? [{ id: 'name', group: 'name' as const, text: `Use "${draft.name.trim()}" as a name`, pick: () => setOpen(false) }] : []),
  ];

  const pickLens = (lensId: string) => {
    setDraft({ lensId, name: lens ? draft.name : '', filters: [] });
    setOpen(false);
    setActive(-1);
  };
  const addFilter = (f: QuickFilter) => {
    setDraft({ ...draft, name: '', filters: [...draft.filters, f] });
    setOpen(false);
    setActive(-1);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = { ...draft, name: draft.name.trim() };
    if (!v.lensId && !v.name && !v.filters.length) {
      setMissing(true);
      return;
    }
    setMissing(false);
    setOpen(false);
    onSearch(v);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return setOpen(true);
      setActive((a) => (options.length ? (a < 0 ? (e.key === 'ArrowDown' ? 0 : options.length - 1) : (a + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length) : -1));
    } else if (e.key === 'Escape') {
      // Only close the list: a search box would otherwise clear its text.
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'Enter' && open && options[active]) {
      e.preventDefault();
      options[active].pick();
    }
  };

  const listId = `${id}-list`;
  const groupHead = { lens: 'Lenses that match', filter: lens ? `Filters in ${lens.name}` : 'Filters', name: '' };
  return (
    <form className="graph-search" role="search" aria-label="Find nodes" onSubmit={submit} noValidate>
      <div className="graph-search-row">
        <div className="graph-search-field">
          <label htmlFor={`${id}-lens`}>Lens</label>
          <select id={`${id}-lens`} value={draft.lensId} onChange={(e) => pickLens(e.target.value)}>
            <option value="">Not sure yet</option>
            {lenses.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({lensNote(l)})
              </option>
            ))}
          </select>
        </div>
        <div className="graph-search-field grow" ref={box}>
          <label htmlFor={`${id}-q`}>{lens ? `Name or filter in ${lens.name}` : 'Lens, filter or name'}</label>
          <input
            id={`${id}-q`}
            type="search"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && options[active] ? `${id}-${options[active].id}` : undefined}
            aria-describedby={missing ? `${id}-missing` : undefined}
            aria-invalid={missing || undefined}
            value={draft.name}
            placeholder={lens ? 'Part of a name, or add a filter' : 'Type a name, a lens or a filter'}
            onChange={(e) => {
              setDraft({ ...draft, name: e.target.value });
              setOpen(true);
              setActive(-1);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKey}
          />
          {open && options.length > 0 && (
            <ul id={listId} role="listbox" className="graph-search-list" aria-label="Suggestions">
              {options.map((o, i) => (
                <li key={o.id} role="presentation">
                  {(i === 0 || options[i - 1]!.group !== o.group) && groupHead[o.group] && (
                    <div className="graph-search-group" aria-hidden="true">
                      {groupHead[o.group]}
                    </div>
                  )}
                  <div
                    id={`${id}-${o.id}`}
                    role="option"
                    aria-selected={i === active}
                    className={`graph-search-option${i === active ? ' active' : ''}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={o.pick}
                  >
                    <span>{o.text}</span>
                    {o.note && <span className="graph-search-note">{o.note}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
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
      </div>
      {(lens || draft.filters.length > 0) && (
        <ul className="graph-search-chips" aria-label="Search criteria">
          {lens &&
            lensChips(lens).map((c) => (
              <li key={`lens-${c}`} className="locked">
                {c} <span className="graph-search-note">from lens</span>
              </li>
            ))}
          {draft.filters.map((f, i) => (
            <li key={`${f.attribute}-${i}`}>
              {f.label}
              <button type="button" aria-label={`Remove ${f.label}`} onClick={() => setDraft({ ...draft, filters: draft.filters.filter((_, j) => j !== i) })}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {missing && (
        <p id={`${id}-missing`} className="graph-search-error" role="alert">
          Choose a lens, add a filter or type part of a name.
        </p>
      )}
    </form>
  );
}
