import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MetamodelRegistry } from '@d4/metamodel';
import { ErrorBanner } from './ErrorBanner';
import { api, useView, viewQuery } from '@d4/web-platform';
import { elementName, layerOf, layerVar, typesByLayer } from './model';

interface Props {
  registry: MetamodelRegistry;
  workspaceId: string;
  selectedId?: string;
}

/** Search and filter elements; cursor-paged ("Load more"), search results ranked. */
export function ElementList({ registry, workspaceId, selectedId }: Props) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [layer, setLayer] = useState('');
  const [type, setType] = useState('');

  // Debounce typing.
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  const vq = viewQuery(useView().view);
  const list = useInfiniteQuery({
    queryKey: ['elements', workspaceId, q, layer, type, vq],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listElements(workspaceId, {
        q: q || undefined,
        layer: layer || undefined,
        type: type ? [type] : undefined,
        first: 50,
        after: pageParam,
      }, vq),
    // Search results are ranked and not cursor-paged.
    getNextPageParam: (last) => (!q && last.hasMore ? (last.endCursor ?? undefined) : undefined),
  });

  const groups = typesByLayer(registry);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="element-list">
      <input
        type="search"
        placeholder="Search names and descriptions…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Search elements"
      />
      <div className="filters">
        <select value={layer} onChange={(e) => {
            setLayer(e.target.value);
            setType('');
          }} aria-label="Layer">
          <option value="">All layers</option>
          {groups.map(([l]) => (
            <option key={l}>{l}</option>
          ))}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
          <option value="">All types</option>
          {groups
            .filter(([l]) => !layer || l === layer)
            .map(([l, types]) => (
              <optgroup key={l} label={l}>
                {types.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </optgroup>
            ))}
        </select>
      </div>

      {list.error && <ErrorBanner error={list.error} />}
      <ul className="items">
        {items.map((e) => (
          <li key={e.id} className={e.id === selectedId ? 'selected' : ''}>
            <Link to={`/w/${workspaceId}/e/${e.id}`}>
              <span className="dot" style={{ background: layerVar(layerOf(registry, e.type)) }} />
              <span className="name">{elementName(e)}</span>
              <span className="type">{e.type}</span>
            </Link>
          </li>
        ))}
      </ul>
      {list.isLoading && <div className="muted small">Loading…</div>}
      {!list.isLoading && !items.length && <div className="muted small">No elements match.</div>}
      {list.hasNextPage && (
        <button className="button ghost" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
          Load more
        </button>
      )}
    </div>
  );
}
