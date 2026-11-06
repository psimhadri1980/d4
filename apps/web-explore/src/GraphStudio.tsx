import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { lensSearch, type Lens } from '@d4/core';
import { type Element, type Relationship, useRegistry, useView, viewQuery } from '@d4/web-platform';
import {
  ErrorBanner,
  GraphCanvas,
  GraphInspector,
  GraphSearch,
  type CanvasAdjustments,
  type CanvasFilter,
  type CanvasLayout,
  type CanvasViewport,
  type GraphCanvasEdge,
  type GraphCanvasNode,
  type GraphCanvasView,
  type GraphSearchValue,
} from '@d4/ui-kit';
import { exploreApi } from './api';
import { PREDEFINED_LENSES } from './lenses';

/** One place on the focus path: the search the user began from, then one step per drill (DD-2). */
interface Step {
  label: string;
  /** Roots by id for a drill; absent for the search step. */
  focusId?: string;
  // What the user had here, restored when they go back (DD-3).
  selectedId: string | null;
  view: GraphCanvasView;
  expandedIds?: string[];
  /** Nodes, connectors and labels moved by hand, per layout (GV-5, GV-5b). */
  adjust?: Partial<Record<CanvasLayout, CanvasAdjustments>>;
  /** Zoom and scroll; absent, the graph fits the pane (DD-4). */
  viewport?: CanvasViewport;
}

const DEFAULT_DEPTH = 2;

type MetamodelRegistry = NonNullable<ReturnType<typeof useRegistry>['data']>;

/** Typing pauses this long before the lens list's counts are fetched. */
const COUNT_DELAY_MS = 300;

/**
 * Graph Studio: pick a lens (or none) and search inside it, see every match as a root with its
 * neighbourhood as a graph or a tree, inspect a node, and drill down along a focus path.
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
  const [follow, setFollow] = useState(false);
  const step = steps.at(-1);
  const patch = (p: Partial<Step>) => setSteps((s) => [...s.slice(0, -1), { ...s.at(-1)!, ...p }]);
  // For reports that arrive later (the viewport settles after a delay): they belong to the step
  // that was showing when they were made, even if the user has drilled on since.
  const patchAt = (i: number, p: Partial<Step>) => setSteps((s) => (s[i] ? s.map((x, j) => (j === i ? { ...x, ...p } : x)) : s));
  const stepIndex = steps.length - 1;

  // Lenses whose types this workspace's metamodel has.
  const lenses = useMemo(() => {
    const reg = registry.data;
    if (!reg) return [];
    return PREDEFINED_LENSES.filter((l) => [l.contour.type, ...l.facets.flatMap((f) => f.types)].every((t) => reg.nodeType(t)));
  }, [registry.data]);
  const lensOf = (v: { lensId: string } | null) => (v ? (lenses.find((l) => l.id === v.lensId) ?? null) : null);

  const focusId = step?.focusId;
  const started = !!step;
  const body = useMemo(
    () => (search && started ? searchBody(lensOf(search), search, focusId, depth) : null),
    [search, lenses, started, focusId, depth],
  );
  const result = useQuery({
    queryKey: ['studio', ws, body, vq],
    enabled: !!ws && !!body,
    queryFn: () => exploreApi.studioSearch(ws!, body!, vq),
  });

  // "Not sure yet": how many roots each lens finds for the text being typed (LS-5).
  const [undecided, setUndecided] = useState('');
  const [countText, setCountText] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setCountText(undecided || null), COUNT_DELAY_MS);
    return () => clearTimeout(t);
  }, [undecided]);
  const counts = useQuery({
    queryKey: ['studio-counts', ws, countText, lenses.map((l) => l.id), vq],
    enabled: !!ws && !!countText && lenses.length > 0,
    queryFn: () => exploreApi.studioCounts(ws!, lenses.map((l) => lensSearch(l, [], countText!)), vq),
  });
  const lensCounts = useMemo(
    () => (counts.data && countText ? new Map(lenses.map((l, i) => [l.id, counts.data.counts[i]!])) : undefined),
    [counts.data, countText, lenses],
  );

  const graph = useMemo(() => (result.data && registry.data ? toCanvas(registry.data, result.data, modelView.asOf) : null), [result.data, registry.data, modelView.asOf]);

  if (registry.error) return <ErrorBanner error={registry.error} />;
  if (!registry.data) return <div className="splash">Loading metamodel…</div>;
  const reg = registry.data;

  const run = (v: GraphSearchValue) => {
    const lens = lensOf(v);
    setSearch(v);
    // A lens opens with its own depth, layout and view (LS-6).
    if (lens) {
      setDepth(lens.depth);
      setLayout(lens.layout);
    }
    // A new Search starts a new focus path (DD-3).
    setSteps([{ label: describe(lens, v), selectedId: null, view: lens?.view ?? step?.view ?? 'graph' }]);
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
      <p>No nodes match {describe(lensOf(search), search)}.</p>
      <button type="button" className="button ghost small" onClick={clear}>
        Clear the search
      </button>
    </div>
  );

  return (
    <div className="graph-studio">
      <div className="graph-studio-search">
        <GraphSearch
          registry={reg}
          lenses={lenses}
          value={search ?? undefined}
          onSearch={run}
          onClear={clear}
          onUndecidedText={setUndecided}
          lensCounts={lensCounts}
          busy={result.isFetching}
        />
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
            // A new layout or depth opens fitted again.
            onLayoutChange={(l) => {
              setLayout(l);
              if (step) patch({ viewport: undefined });
            }}
            onDepthChange={(d) => {
              setDepth(d);
              if (step) patch({ viewport: undefined });
            }}
            onDrill={drill}
            onCrumb={(i) => setSteps((s) => s.slice(0, i + 1))}
            filter={filter}
            onFilterChange={setFilter}
            adjustments={step?.adjust?.[layout]}
            onAdjustmentsChange={(a) => step && patch({ adjust: { ...step.adjust, [layout]: a } })}
            viewport={step?.viewport}
            onViewportChange={(v) => patchAt(stepIndex, { viewport: v })}
            followSelection={follow}
            onFollowSelectionChange={setFollow}
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

/** "Data products · "client" · Lifecycle LIVE", for the breadcrumb and the empty state. */
function describe(lens: Lens | null, v: GraphSearchValue): string {
  const parts = [lens?.name, v.name && `"${v.name}"`, ...v.filters.map((f) => f.label)].filter(Boolean);
  return parts.join(' · ') || 'everything';
}

function searchBody(lens: Lens | null, v: GraphSearchValue, focusId: string | undefined, depth: number) {
  const base = { depth, match: 'all' as const, maxNodes: 1000 };
  if (focusId) return { ...base, ids: [focusId] };
  return { ...base, ...lensSearch(lens, v.filters, v.name) };
}

type StudioResult = Awaited<ReturnType<typeof exploreApi.studioSearch>>;

const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

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
    .map((e) => ({
      id: e.id,
      name: nameOf(e),
      type: e.type,
      layer: reg.nodeType(e.type)?.layer ?? 'System',
      state: planned(e) ? ('planned' as const) : ('in-graph' as const),
      owner: text(e.attrs['owner'] ?? e.attrs['ownerId']),
      changedAt: e.updatedAt ?? undefined,
    }))
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
