import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { RunPanel } from './Catalog';
import { Editor, NewQueryForm, StatusBadges } from './QueryStudio';
import { StewardPanel } from './Stewardship';
import { accessOf, api } from '@d4/web-platform';
import { type CatalogEntry } from '../modules/queries/api';
import { ErrorBanner } from '@d4/ui-kit';

/** What a tab does with its query. */
export type TabMode = 'run' | 'edit' | 'review';
interface QueryTab {
  mode: TabMode;
  id: string;
}

const MODE_LABEL: Record<TabMode, string> = { run: '▶ Run', edit: '✎ Edit', review: '✓ Review' };
const tabKey = (t: QueryTab) => `${t.mode}:${t.id}`;

/** Tabs live in the URL (`?tabs=run:ID,edit:ID&active=run:ID`) so reloads and links restore them. */
export function parseTabs(raw: string | null): QueryTab[] {
  const seen = new Set<string>();
  return (raw ?? '')
    .split(',')
    .map((s) => s.split(':'))
    .filter(([m, id]) => (m === 'run' || m === 'edit' || m === 'review') && !!id)
    .map(([m, id]) => ({ mode: m as TabMode, id: id! }))
    .filter((t) => !seen.has(tabKey(t)) && !!seen.add(tabKey(t)));
}

/**
 * One workspace for queries: an accordion (Catalog, Studio, Stewardship, each with a count) and
 * closable tabs, so users can run, edit and review several queries side by side. Tabs stay mounted
 * while hidden, keeping parameter values, results and unsaved edits.
 */
export function Queries() {
  const { ws } = useParams();
  const [params, setParams] = useSearchParams();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const roles = accessOf(me.data?.roles);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  const list = useQuery({ queryKey: ['catalog', 'queries', q], queryFn: () => api.searchCatalog({ q: q || undefined }) });
  const entries = list.data ?? [];
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);

  const runnable = entries.filter((e) => e.publishedVersion !== null);
  const editable = entries.filter((e) => !e.system);
  const inReview = entries.filter((e) => e.openStatus === 'in_review');

  const tabs = parseTabs(params.get('tabs'));
  const active = params.get('active') ?? (tabs[0] ? tabKey(tabs[0]) : null);

  const update = (next: QueryTab[], nextActive: string | null) => {
    const p = new URLSearchParams(params);
    if (next.length) p.set('tabs', next.map(tabKey).join(','));
    else p.delete('tabs');
    if (nextActive) p.set('active', nextActive);
    else p.delete('active');
    setParams(p, { replace: true });
  };
  const open = (t: QueryTab) => {
    const exists = tabs.some((x) => tabKey(x) === tabKey(t));
    update(exists ? tabs : [...tabs, t], tabKey(t));
  };
  const close = (key: string) => {
    const i = tabs.findIndex((t) => tabKey(t) === key);
    const next = tabs.filter((t) => tabKey(t) !== key);
    const neighbour = next[Math.min(i, next.length - 1)];
    update(next, key === active ? (neighbour ? tabKey(neighbour) : null) : active);
  };
  const closeAllFor = (id: string) => {
    const next = tabs.filter((t) => t.id !== id);
    update(next, next.some((t) => tabKey(t) === active) ? active : next[0] ? tabKey(next[0]) : null);
  };

  // `?section=` (from the navigation) opens just that section; otherwise all are open.
  const section = params.get('section');
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({ catalog: true, studio: true, stewardship: true });
  useEffect(() => {
    if (section) setOpenSections({ catalog: section === 'catalog', studio: section === 'studio', stewardship: section === 'stewardship' });
  }, [section]);
  const toggle = (k: string) => setOpenSections((s) => ({ ...s, [k]: !s[k] }));

  return (
    <div className="queries">
      <aside className="pane left">
        <input type="search" placeholder="Search queries…" aria-label="Search queries" value={text} onChange={(e) => setText(e.target.value)} />
        {list.error && <ErrorBanner error={list.error} />}

        <Section id="catalog" title="Catalog" count={runnable.length} open={openSections['catalog']!} onToggle={toggle}>
          <EntryList entries={runnable} activeIds={tabs.filter((t) => t.mode === 'run').map((t) => t.id)} onPick={(e) => open({ mode: 'run', id: e.id })} empty="No queries you can run match." />
        </Section>

        {roles.author && (
          <Section id="studio" title="Studio" count={editable.length} open={openSections['studio']!} onToggle={toggle}>
            <NewQueryForm onCreated={(id) => open({ mode: 'edit', id })} />
            <EntryList entries={editable} activeIds={tabs.filter((t) => t.mode === 'edit').map((t) => t.id)} onPick={(e) => open({ mode: 'edit', id: e.id })} badges empty="No tenant queries yet." />
          </Section>
        )}

        {roles.steward && (
          <Section id="stewardship" title="Stewardship" count={inReview.length} open={openSections['stewardship']!} onToggle={toggle} countLabel="waiting for review">
            <EntryList entries={inReview} activeIds={tabs.filter((t) => t.mode === 'review').map((t) => t.id)} onPick={(e) => open({ mode: 'review', id: e.id })} badges empty="Nothing waiting for review." />
            <details className="all-queries">
              <summary>Manage any query ({entries.length})</summary>
              <EntryList entries={entries} activeIds={[]} onPick={(e) => open({ mode: 'review', id: e.id })} badges empty="No queries." />
            </details>
          </Section>
        )}
      </aside>

      <section className="pane main tabs-area">
        {tabs.length > 0 && (
          <div className="tab-strip" role="tablist" aria-label="Open queries">
            {tabs.map((t) => {
              const key = tabKey(t);
              const title = byId.get(t.id)?.title ?? 'Query';
              return (
                <div key={key} className={`tab ${key === active ? 'active' : ''}`}>
                  <button role="tab" aria-selected={key === active} className="tab-title" onClick={() => update(tabs, key)} title={`${MODE_LABEL[t.mode]} · ${title}`}>
                    <span className="tab-mode">{MODE_LABEL[t.mode]}</span> {title}
                  </button>
                  <button className="tab-close" aria-label={`Close ${MODE_LABEL[t.mode]} ${title}`} onClick={() => close(key)}>
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {tabs.length === 0 && (
          <div className="empty">
            <p>Pick a query on the left. Each opens in its own tab, so you can run, edit and review several at once.</p>
          </div>
        )}
        {tabs.map((t) => {
          const key = tabKey(t);
          return (
            <div key={key} role="tabpanel" className="tab-panel" hidden={key !== active}>
              {t.mode === 'run' && <RunPanel workspaceId={ws!} queryId={t.id} />}
              {t.mode === 'edit' && <Editor queryId={t.id} onRemoved={() => closeAllFor(t.id)} />}
              {t.mode === 'review' && <StewardPanel queryId={t.id} onRemoved={() => closeAllFor(t.id)} />}
            </div>
          );
        })}
      </section>
    </div>
  );
}

function Section({
  id,
  title,
  count,
  countLabel,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  count: number;
  countLabel?: string;
  open: boolean;
  onToggle(id: string): void;
  children: ReactNode;
}) {
  return (
    <section className={`accordion ${open ? 'open' : ''}`}>
      <h3>
        <button aria-expanded={open} aria-controls={`acc-${id}`} onClick={() => onToggle(id)}>
          <span className="chevron" aria-hidden>
            {open ? '▾' : '▸'}
          </span>
          {title}
          <span className="count" aria-label={`${count} ${countLabel ?? 'queries'}`}>
            {count}
          </span>
        </button>
      </h3>
      <div id={`acc-${id}`} hidden={!open}>
        {children}
      </div>
    </section>
  );
}

function EntryList({
  entries,
  activeIds,
  onPick,
  badges,
  empty,
}: {
  entries: CatalogEntry[];
  activeIds: string[];
  onPick(e: CatalogEntry): void;
  badges?: boolean;
  empty: string;
}) {
  if (!entries.length) return <p className="muted small">{empty}</p>;
  return (
    <ul className="items">
      {entries.map((e) => (
        <li key={e.id} className={activeIds.includes(e.id) ? 'selected' : ''}>
          <button className="item" onClick={() => onPick(e)}>
            <span className="name">{e.title}</span>
            {badges ? <StatusBadges entry={e} /> : e.certified && <span className="badge certified" title="Certified by a steward">✓</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
