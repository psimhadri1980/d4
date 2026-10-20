import { IconArrowRight, IconDatabaseSearch, IconHierarchy3, IconSearch, type Icon } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, catalogApi } from '../api';
import { elementName } from '../model';
import type { NavGroup } from '../nav';

interface Result {
  id: string;
  group: 'Pages' | 'Elements' | 'Queries';
  label: string;
  detail?: string;
  to: string;
  icon: Icon;
}

/**
 * Search everything from one box (Ctrl K / ⌘ K): pages and their sub-pages, elements of this
 * workspace by name, and catalog queries you can run. Arrow keys move, Enter opens, Esc closes.
 */
export function CommandPalette({ ws, groups, open, onClose }: { ws: string; groups: NavGroup[]; open: boolean; onClose(): void }) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 200);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => {
    if (open) {
      setText('');
      setCursor(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  const elements = useQuery({ queryKey: ['palette', 'elements', ws, q], queryFn: () => api.listElements(ws, { q, first: 8 }), enabled: open && q.length > 1 });
  const queries = useQuery({ queryKey: ['palette', 'queries', q], queryFn: () => catalogApi.search({ q }), enabled: open && q.length > 1 });

  const results = useMemo<Result[]>(() => {
    const needle = text.trim().toLowerCase();
    const base = `/w/${ws}`;
    const pages: Result[] = groups.flatMap((g) =>
      g.items.flatMap((i) => [
        { id: `p:${i.id}`, group: 'Pages' as const, label: i.label, detail: g.label, to: i.to ? `${base}/${i.to}` : base, icon: i.icon },
        ...(i.sub ?? []).map((s) => ({ id: `p:${i.id}:${s.to}`, group: 'Pages' as const, label: `${i.label} › ${s.label}`, detail: g.label, to: `${base}/${s.to}`, icon: i.icon })),
      ]),
    );
    const pageHits = needle ? pages.filter((p) => p.label.toLowerCase().includes(needle) || p.detail?.toLowerCase().includes(needle)) : pages.filter((p) => !p.label.includes('›'));
    const elementHits: Result[] = (elements.data?.items ?? []).map((e) => ({
      id: `e:${e.id}`,
      group: 'Elements',
      label: elementName(e),
      detail: e.type,
      to: `${base}/e/${e.id}`,
      icon: IconHierarchy3,
    }));
    const queryHits: Result[] = (queries.data ?? [])
      .filter((c) => c.publishedVersion !== null)
      .slice(0, 5)
      .map((c) => ({ id: `q:${c.id}`, group: 'Queries', label: c.title, detail: 'Run query', to: `${base}/queries?tabs=run:${c.id}&active=run:${c.id}`, icon: IconDatabaseSearch }));
    return [...pageHits.slice(0, needle ? 8 : 20), ...elementHits, ...queryHits];
  }, [text, groups, ws, elements.data, queries.data]);

  useEffect(() => setCursor((c) => Math.min(c, Math.max(results.length - 1, 0))), [results.length]);

  if (!open) return null;
  const go = (r: Result | undefined) => {
    if (!r) return;
    onClose();
    navigate(r.to);
  };
  const loading = q.length > 1 && (elements.isFetching || queries.isFetching);

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <IconSearch size={18} stroke={1.6} aria-hidden />
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={results[cursor] ? `${listId}-${cursor}` : undefined}
            aria-label="Search pages, elements and queries"
            placeholder="Search pages, elements and queries"
            value={text}
            onChange={(e) => (setText(e.target.value), setCursor(0))}
            onKeyDown={(e) => {
              const moves: Record<string, () => void> = {
                ArrowDown: () => setCursor((c) => Math.min(c + 1, results.length - 1)),
                ArrowUp: () => setCursor((c) => Math.max(c - 1, 0)),
                Enter: () => go(results[cursor]),
                Escape: onClose,
              };
              const move = moves[e.key];
              if (move) {
                e.preventDefault();
                move();
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="palette-results" id={listId} role="listbox" aria-label="Results">
          {results.map((r, i) => {
            const ResultIcon = r.icon;
            const first = i === 0 || results[i - 1]!.group !== r.group;
            return (
              <li key={r.id} role="presentation">
                {first && <div className="palette-group">{r.group}</div>}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === cursor}
                  className={`palette-option ${i === cursor ? 'active' : ''}`}
                  onMouseMove={() => setCursor(i)}
                  onClick={() => go(r)}
                >
                  <ResultIcon size={18} stroke={1.6} aria-hidden />
                  <span className="palette-label">{r.label}</span>
                  {r.detail && <span className="palette-detail">{r.detail}</span>}
                  {i === cursor && <IconArrowRight size={16} aria-hidden />}
                </div>
              </li>
            );
          })}
          {!results.length && <li className="palette-empty">{loading ? 'Searching…' : `Nothing matches “${text}”.`}</li>}
        </ul>
      </div>
    </div>
  );
}
