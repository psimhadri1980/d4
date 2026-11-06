import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { type Element, type Relationship, useRegistry, useView, viewQuery } from '@d4/web-platform';
import {
  ErrorBanner,
  GraphCanvas,
  GraphInspector,
  GraphSearch,
  typesByLayer,
  type CanvasFilter,
  type CanvasLayout,
  type GraphCanvasEdge,
  type GraphCanvasNode,
  type GraphCanvasView,
  type GraphSearchValue,
} from '@d4/ui-kit';
import { exploreApi } from './api';

/** One place on the focus path: the search the user began from, then one step per drill (DD-2). */
interface Step {
  label: string;
  /** Roots by id for a drill; absent for the search step. */
  focusId?: string;
  // What the user had here, restored when they go back (DD-3).
  selectedId: string | null;
  view: GraphCanvasView;
  expandedIds?: string[];
}

const DEFAULT_DEPTH = 2;

type MetamodelRegistry = NonNullable<ReturnType<typeof useRegistry>['data']>;

/**
 * Graph Studio, first slice: find nodes by Layer, Type and Name, see every match as a root with
 * its neighbourhood as a graph or a tree, inspect a node, and drill down along a focus path.
 * The page owns all state; GraphCanvas, GraphSearch and GraphInspector only draw it.
 */
export function GraphStudio() {
  const { ws } = useParams();
  const registry = useRegistry(ws);
  const { view: modelView } = useView();
  const vq = viewQuery(modelView);

  const [search, setSearch] = useState<GraphSearchValue | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [depth, setDepth] = useState(DEFAULT_DEPTH);
  const [layout, setLayout] = useState<CanvasLayout>('hier');
  // Filters stay as they are across focus steps (DD-3).
  const [filter, setFilter] = useState<CanvasFilter>({ nodeTypes: [], relationshipTypes: [] });
  const step = steps.at(-1);
  const patch = (p: Partial<Step>) => setSteps((s) => [...s.slice(0, -1), { ...s.at(-1)!, ...p }]);

  const focusId = step?.focusId;
  const started = !!step;
  const body = useMemo(
    () => (search && registry.data && started ? searchBody(registry.data, search, focusId, depth) : null),
    [search, registry.data, started, focusId, depth],
  );
  const result = useQuery({
    queryKey: ['studio', ws, body, vq],
    enabled: !!ws && !!body,
    queryFn: () => exploreApi.studioSearch(ws!, body!, vq),
  });

  const graph = useMemo(() => (result.data && registry.data ? toCanvas(registry.data, result.data, modelView.asOf) : null), [result.data, registry.data, modelView.asOf]);

  if (registry.error) return <ErrorBanner error={registry.error} />;
  if (!registry.data) return <div className="splash">Loading metamodel…</div>;
  const reg = registry.data;

  const run = (v: GraphSearchValue) => {
    setSearch(v);
    // A new Search starts a new focus path (DD-3).
    setSteps([{ label: describe(v), selectedId: null, view: step?.view ?? 'graph' }]);
  };
  const clear = () => {
    setSearch(null);
    setSteps([]);
    setFilter({ nodeTypes: [], relationshipTypes: [] });
  };
  const drill = (id: string) => {
    const name = graph?.byId.get(id)?.name ?? id;
    setSteps((s) => [...s, { label: name, focusId: id, selectedId: id, view: s.at(-1)?.view ?? 'graph' }]);
  };

  const selected = step?.selectedId ? (graph?.byId.get(step.selectedId) ?? null) : null;
  const tooLarge = result.data?.tooLarge === true;
  const emptyMessage = !search ? (
    <p>Find a node to start.</p>
  ) : tooLarge ? (
    <p role="alert">
      This result has more than 1,000 nodes ({result.data!.nodeCount.toLocaleString()} found before stopping). Lower Depth or narrow the search.
    </p>
  ) : (
    <div>
      <p>No nodes match {describe(search)}.</p>
      <button type="button" className="button ghost small" onClick={clear}>
        Clear the search
      </button>
    </div>
  );

  return (
    <div className="graph-studio">
      <div className="graph-studio-search">
        <GraphSearch registry={reg} value={search ?? undefined} onSearch={run} onClear={clear} busy={result.isFetching} />
      </div>
      {result.error && <ErrorBanner error={result.error} />}
      <div className="graph-studio-main">
        <div className="graph-studio-result">
          <GraphCanvas
            fill
            nodes={graph?.nodes ?? []}
            edges={graph?.edges ?? []}
            rootIds={graph?.rootIds ?? []}
            loading={!!body && result.isLoading}
            emptyMessage={emptyMessage}
            layers={reg.metamodel.layers}
            selectedId={step?.selectedId ?? null}
            view={step?.view ?? 'graph'}
            expandedIds={step?.expandedIds}
            layout={layout}
            depth={depth}
            crumbs={steps.map((s) => ({ label: s.label }))}
            onSelect={(id) => step && patch({ selectedId: id })}
            onViewChange={(v) => (step ? patch({ view: v }) : undefined)}
            onExpandedChange={(paths) => patch({ expandedIds: paths })}
            onLayoutChange={setLayout}
            onDepthChange={setDepth}
            onDrill={drill}
            onCrumb={(i) => setSteps((s) => s.slice(0, i + 1))}
            filter={filter}
            onFilterChange={setFilter}
          />
        </div>
        <GraphInspector
          registry={reg}
          node={selected}
          attrs={selected ? graph!.attrs.get(selected.id) : undefined}
          nodes={graph?.nodes ?? []}
          edges={graph?.edges ?? []}
          onSelect={(id) => patch({ selectedId: id })}
          onFocus={drill}
          editTo={selected ? `/w/${ws}/e/${selected.id}/edit` : undefined}
        />
      </div>
    </div>
  );
}

/** "Name contains "pay" · Application", for the breadcrumb and the empty state. */
function describe(v: GraphSearchValue): string {
  const parts = [v.name && `"${v.name}"`, v.type || (v.layer && `${v.layer} layer`)].filter(Boolean);
  return parts.join(' · ') || 'everything';
}

function searchBody(reg: MetamodelRegistry, v: GraphSearchValue, focusId: string | undefined, depth: number) {
  const base = { depth, match: 'all' as const, maxNodes: 1000 };
  if (focusId) return { ...base, ids: [focusId] };
  // A Layer without a Type means every type in that layer.
  const types = v.type ? [v.type] : v.layer ? (typesByLayer(reg).find(([l]) => l === v.layer)?.[1] ?? []) : undefined;
  return { ...base, types, name: v.name || undefined };
}

type StudioResult = Awaited<ReturnType<typeof exploreApi.studioSearch>>;

/**
 * API result → GraphCanvas input. A node or relationship counts as planned when it only starts
 * after the date being viewed (today by default), as in the Explorer.
 */
function toCanvas(reg: MetamodelRegistry, r: StudioResult, asOf?: string) {
  const today = asOf || new Date().toISOString().slice(0, 10);
  const planned = (x: Element | Relationship) => !!x.validFrom && x.validFrom > today;
  const nameOf = (e: Element) => (typeof e.attrs['name'] === 'string' ? e.attrs['name'] : e.id);
  const all = [...r.roots, ...r.elements];
  const nodes: GraphCanvasNode[] = all
    .map((e) => ({ id: e.id, name: nameOf(e), type: e.type, layer: reg.nodeType(e.type)?.layer ?? 'System', state: planned(e) ? ('planned' as const) : ('in-graph' as const) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const edges: GraphCanvasEdge[] = r.relationships.map((x) => ({ id: x.id, from: x.fromId, to: x.toId, type: x.type, planned: planned(x) }));
  return {
    nodes,
    edges,
    rootIds: r.roots.map((e) => e.id),
    byId: new Map(nodes.map((n) => [n.id, n])),
    attrs: new Map(all.map((e) => [e.id, e.attrs])),
  };
}
