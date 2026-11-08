import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { flowRank, flowStage, groupLabel, lensSearch, lensSpec, type LayerTypes, type Lens, type LensAttributeFilter, type LensGroup, type LensStep, type LensTime, timeMark } from '@d4/core';
import { D4ApiError, type Element, type QueryParamDef, type Relationship, useMe, useRegistry, useView, viewQuery } from '@d4/web-platform';
import {
  ErrorBanner,
  GraphCanvas,
  GraphInspector,
  GraphSearch,
  LensEditor,
  type CanvasAdjustments,
  type CanvasFilter,
  type CanvasLayout,
  type CanvasViewport,
  type GraphCanvasEdge,
  type GraphCanvasNode,
  type GraphCanvasView,
  type GraphSearchValue,
  type LensCatalogQuery,
  type LensDraft,
  type LensQueryDraft,
  type SubmitQueryResult,
} from '@d4/ui-kit';
import { exploreApi, type LensInput } from './api';
import { Connections } from './Connections';
import { ImpactTable } from './ImpactTable';
import { LensLandscape } from './LensLandscape';
import { LensMatrix } from './LensMatrix';
import { offeredOn, PREDEFINED_LENSES, type BuiltInLens } from './lenses';

/** One place on the focus path: the search the user began from, then one step per drill (DD-2). */
interface Step {
  label: string;
  /** Roots by id for a drill; absent for the search step. */
  focusId?: string;
  // What the user had here, restored when they go back (DD-3).
  selectedId: string | null;
  view: GraphCanvasView;
  /** The view was set, by the user or by opening a large result in the Overview; leave it be. */
  viewChosen?: boolean;
  expandedIds?: string[];
  /** Nodes, connectors and labels moved by hand, per layout (GV-5, GV-5b). */
  adjust?: Partial<Record<CanvasLayout, CanvasAdjustments>>;
  /** Zoom and scroll; absent, the graph fits the pane (DD-4). */
  viewport?: CanvasViewport;
  /** Group pages opened on this step, in order (D85). */
  pages?: GroupPage[];
  /** A connection step (D89): the paths between two nodes, and the one chosen (all when absent). */
  connect?: { from: string; to: string; chosen?: number };
}

type GroupPage = Awaited<ReturnType<typeof exploreApi.studioOpen>>;
const NO_PAGES: GroupPage[] = [];
/** Canvas ids of group nodes: a group opens where a node would drill. */
const GROUP = 'group:';

const DEFAULT_DEPTH = 2;
/** Results with more nodes than this open in the Overview (OV-1, LS-6). */
const OVERVIEW_ABOVE = 150;
/** The editor's preview waits this long after the last change. */
const PREVIEW_DELAY_MS = 400;
type NodeTypeRole = 'contour' | 'facet' | 'both';
/** What the editor is open on: a saved lens of the user's, a built-in one, or a new one. */
interface Editing {
  initial: LensDraft | null;
  /** The saved lens being changed; absent for new lenses and built-in ones (saved as a copy). */
  savedId?: string;
  builtIn: boolean;
}

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
  // A lens with layers keeps its steps to their types (D95).
  const inLayers: LayerTypes = (layers, types) => registry.data?.typesInLayers(layers, types) ?? [];
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

  const queryClient = useQueryClient();
  const me = useMe();
  // The API decides; this only decides whether to offer "Everyone in the workspace".
  const canShare = !!me.data?.roles.some((r) => r !== 'viewer');
  const saved = useQuery({ queryKey: ['studio-lenses', ws], enabled: !!ws, queryFn: () => exploreApi.lenses(ws!) });
  // Built-in lenses whose types this workspace's metamodel has, then the saved ones.
  const lenses = useMemo(() => {
    const reg = registry.data;
    if (!reg) return [];
    const fits = (l: BuiltInLens) => offeredOn(l, reg.metamodel.id) && [l.contour.type, ...l.facets.flatMap((f) => f.types)].every((t) => reg.nodeType(t));
    return [...PREDEFINED_LENSES.filter(fits), ...((saved.data ?? []) as Lens[])];
  }, [registry.data, saved.data]);
  // ── Query lenses (D84): the catalog list for the editor, and each used query's parameters ──
  const [editingOpen, setEditingOpen] = useState(false);
  const canAuthor = !!me.data?.roles.includes('query-author');
  const catalog = useQuery({ queryKey: ['catalog', 'lens-queries'], enabled: editingOpen, queryFn: () => exploreApi.catalog() });
  const [draftQueryId, setDraftQueryId] = useState<string | undefined>();
  const queryIds = useMemo(() => [...new Set([...lenses.flatMap((l) => (l.query?.id ? [l.query.id] : [])), ...(draftQueryId ? [draftQueryId] : [])])], [lenses, draftQueryId]);
  const queryDetails = useQueries({
    queries: queryIds.map((id) => ({ queryKey: ['catalog-detail', id], queryFn: () => exploreApi.catalogQuery(id), retry: false })),
  });
  const paramsOf = useMemo(() => {
    const m = new Map<string, QueryParamDef[]>();
    queryDetails.forEach((q, i) => {
      const d = q.data;
      if (!d) return;
      // The published version's parameters, else the one being written or reviewed.
      const v = d.versions.find((x) => x.version === d.publishedVersion) ?? d.versions.at(-1);
      m.set(queryIds[i]!, (v?.params ?? []) as QueryParamDef[]);
    });
    return m;
  }, [queryDetails, queryIds]);
  const catalogQueries = useMemo<LensCatalogQuery[] | undefined>(
    () =>
      catalog.data?.map((e) => ({
        id: e.id,
        title: e.title,
        state: e.publishedVersion ? 'published' : e.openStatus === 'in_review' ? 'review' : 'draft',
        params: paramsOf.get(e.id) ?? [],
      })),
    [catalog.data, paramsOf],
  );
  const submitQuery = async (d: LensQueryDraft): Promise<SubmitQueryResult> => {
    try {
      const slug = `${d.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'lens'}-${Date.now().toString(36)}`;
      const entry = await exploreApi.createQuery({ slug, title: d.title, tags: ['lens'] });
      const saved = await exploreApi.saveQueryDraft(entry.id, { cypher: d.cypher, params: d.params, resultShape: 'table' });
      if (saved.checks.errors.length) return { errors: saved.checks.errors };
      await exploreApi.submitQuery(entry.id);
      await queryClient.invalidateQueries({ queryKey: ['catalog'] });
      return { id: entry.id };
    } catch (e) {
      return { errors: e instanceof D4ApiError && e.issues.length ? e.issues : [(e as Error).message] };
    }
  };

  const lensOf = (v: { lensId: string } | null) => (v ? (lenses.find((l) => l.id === v.lensId) ?? null) : null);

  const focusId = step?.focusId;
  const started = !!step;
  const body = useMemo(
    () => (search && started ? searchBody(lensOf(search), search, focusId, depth, inLayers) : null),
    [search, lenses, started, focusId, depth],
  );
  const result = useQuery({
    queryKey: ['studio', ws, body, vq],
    enabled: !!ws && !!body,
    queryFn: () => exploreApi.studioSearch(ws!, body!, vq),
  });
  // A connection step shows the paths between two nodes instead of the search (D89).
  const connect = step?.connect;
  const paths = useQuery({
    queryKey: ['studio-paths', ws, connect?.from, connect?.to, vq],
    enabled: !!ws && !!connect,
    queryFn: () => exploreApi.studioPaths(ws!, { from: connect!.from, to: connect!.to }, vq),
  });
  const base = useMemo(() => (connect ? (paths.data ? pathResult(paths.data, connect) : undefined) : result.data), [connect, paths.data, result.data]);
  // The search's result with the groups opened on this step merged in (D85).
  const shownResult = useMemo(() => (base ? withPages(base, step?.pages ?? NO_PAGES) : undefined), [base, step?.pages]);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<unknown>(null);
  const openGroup = async (id: string) => {
    const g = shownResult?.groups?.find((x) => x.id === id);
    if (!g || !ws || !body || opening) return;
    setOpening(id);
    setOpenError(null);
    try {
      const shown = [...shownResult!.roots, ...shownResult!.elements].map((e) => e.id);
      const page = await exploreApi.studioOpen(ws, { group: g, steps: body.steps, disclosure: body.disclosure, shown }, vq);
      patch({ pages: [...(step?.pages ?? []), page] });
    } catch (e) {
      setOpenError(e);
    } finally {
      setOpening(null);
    }
  };

  // "Not sure yet": how many roots each lens finds for the text being typed (LS-5). Query lenses
  // are left out: counting them would run their query on every pause in typing.
  const countable = useMemo(() => lenses.filter((l) => !l.query), [lenses]);
  const [undecided, setUndecided] = useState('');
  const [countText, setCountText] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setCountText(undecided || null), COUNT_DELAY_MS);
    return () => clearTimeout(t);
  }, [undecided]);
  const counts = useQuery({
    queryKey: ['studio-counts', ws, countText, countable.map((l) => l.id), vq],
    enabled: !!ws && !!countText && countable.length > 0,
    queryFn: () => exploreApi.studioCounts(ws!, countable.map((l) => lensSearch(l, [], countText!)), vq),
  });
  const lensCounts = useMemo(
    () => (counts.data && countText ? new Map(countable.map((l, i) => [l.id, counts.data.counts[i]!])) : undefined),
    [counts.data, countText, countable],
  );

  // ── Lens editor ──
  const [editing, setEditing] = useState<Editing | null>(null);
  const [roles, setRoles] = useState<Record<string, NodeTypeRole>>({});
  const [draft, setDraft] = useState<LensDraft | null>(null);
  const [editorError, setEditorError] = useState<unknown>(null);
  const onDraftChange = useCallback((d: LensDraft) => {
    setDraft(d);
    setDraftQueryId(d.query?.id || undefined);
  }, []);
  useEffect(() => setEditingOpen(!!editing), [editing]);
  const contourType = editing ? draft?.contour?.type : undefined;
  const profileAttributes = useMemo(() => (contourType && registry.data ? registry.data.attributesFor(contourType).map((d) => d.name).slice(0, 20) : []), [contourType, registry.data]);
  const profile = useQuery({
    queryKey: ['studio-profile', ws, contourType, profileAttributes, vq],
    enabled: !!ws && !!contourType,
    queryFn: () => exploreApi.studioProfile(ws!, contourType!, profileAttributes, vq),
  });
  const [previewOf, setPreviewOf] = useState<LensDraft | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setPreviewOf(editing ? draft : null), PREVIEW_DELAY_MS);
    return () => clearTimeout(t);
  }, [draft, editing]);
  // The funnel: the contour alone, then one facet more at a time (LE-6).
  const preview = useQuery({
    queryKey: ['studio-preview', ws, previewOf?.contour, previewOf?.facets, previewOf?.match, vq],
    enabled: !!ws && !!previewOf?.contour && !previewOf.query,
    queryFn: async () => {
      const d = previewOf!;
      const lens = { ...d, id: '', contour: d.contour! } as Lens;
      const steps = [0, ...d.facets.map((_, i) => i + 1)].map((n) => lensSearch({ ...lens, facets: d.facets.slice(0, n) }, [], ''));
      const r = await exploreApi.studioCounts(ws!, steps, vq, 5);
      return { funnel: r.counts.map((c) => c.count), sample: r.counts.at(-1)?.sample ?? [] };
    },
  });

  // The first screen (D88): the draft drawn as it would open, counted per column.
  const firstScreen = useQuery({
    queryKey: ['studio-first-screen', ws, previewOf?.contour, previewOf?.facets, previewOf?.match, previewOf?.steps, previewOf?.layers, previewOf?.shape, previewOf?.depth, vq],
    enabled: !!ws && !!previewOf?.contour && !previewOf.query,
    retry: false,
    queryFn: async () => {
      const d = previewOf!;
      const lens = { ...d, id: '', contour: d.contour! } as Lens;
      const r = await exploreApi.studioSearch(ws!, searchBody(lens, { lensId: '', name: '', filters: [] }, undefined, d.depth, inLayers), vq);
      if (r.tooLarge) return null;
      const spec = lensSpec(lens, inLayers);
      const flow = lens.shape === 'flow' ? spec.steps : null;
      const shown = new Map<number, number>();
      for (const l of Object.values(r.levels ?? {})) shown.set(l, (shown.get(l) ?? 0) + 1);
      const folded = new Map<number, number>();
      for (const g of (r.groups ?? []) as LensGroup[]) folded.set(g.level, (folded.get(g.level) ?? 0) + g.count);
      const levels = [...new Set([...shown.keys(), ...folded.keys()])].sort((a, b) => (flow ? flowRank(flow, a) - flowRank(flow, b) : a - b));
      return {
        columns: levels.map((l) => ({ label: flow ? flowStage(flow, l) : l === 0 ? 'Roots' : `Level ${l}`, shown: shown.get(l) ?? 0, folded: folded.get(l) ?? 0 })),
        truncated: !!r.truncated,
      };
    },
  });

  const openEditor = (e: Editing) => {
    setEditorError(null);
    setDraft(e.initial);
    setEditing(e);
  };
  const saveLens = async (d: LensDraft & { contour: Lens['contour'] }) => {
    const body: LensInput = {
      name: d.name,
      description: d.description || undefined,
      visibility: d.visibility ?? 'private',
      contour: { type: d.contour.type, attributes: d.contour.attributes ?? [] },
      facets: d.query ? [] : d.facets,
      match: d.match,
      ...(d.query?.id && { query: { id: d.query.id, ...(d.query.version && { version: d.query.version }), params: d.query.params ?? {} } }),
      ...(d.quickFilters?.length && { quickFilters: d.quickFilters }),
      ...(d.phrases?.length && { phrases: d.phrases }),
      ...(d.layers?.length && { layers: d.layers }),
      ...(d.time && { time: d.time }),
      ...(d.steps?.length && { steps: d.steps }),
      ...(d.shape && { shape: d.shape }),
      ...(d.disclosure && { disclosure: d.disclosure }),
      depth: d.depth,
      layout: d.layout,
      view: d.view,
      follow: !!d.follow,
    };
    try {
      setEditorError(null);
      const lens = (editing?.savedId ? await exploreApi.updateLens(ws!, editing.savedId, body) : await exploreApi.createLens(ws!, body)) as Lens;
      // In the list at once, so the search below finds it.
      queryClient.setQueryData(['studio-lenses', ws], (old: Lens[] | undefined) => [...(old ?? []).filter((l) => l.id !== lens.id), lens]);
      void queryClient.invalidateQueries({ queryKey: ['studio-lenses', ws] });
      setEditing(null);
      // Back in the Studio with the lens selected, and its result.
      run({ lensId: lens.id, name: '', filters: [] }, lens);
    } catch (e) {
      setEditorError(e);
    }
  };
  const deleteLens = async (id: string) => {
    if (!window.confirm('Delete this lens? This cannot be undone.')) return;
    try {
      await exploreApi.deleteLens(ws!, id);
      queryClient.setQueryData(['studio-lenses', ws], (old: Lens[] | undefined) => (old ?? []).filter((l) => l.id !== id));
      setEditing(null);
      if (search?.lensId === id) clear();
    } catch (e) {
      setEditorError(e);
    }
  };

  // Pinned nodes stay on the canvas through drills and new searches, with the links they had (D85).
  const [pins, setPins] = useState<Pin[]>([]);
  const pinned = useMemo(() => (shownResult ? withPins(shownResult, pins) : undefined), [shownResult, pins]);
  const togglePin = (id: string) => {
    if (pins.some((p) => p.element.id === id)) return setPins(pins.filter((p) => p.element.id !== id));
    const element = pinned && [...pinned.roots, ...pinned.elements].find((e) => e.id === id);
    if (!element) return;
    setPins([...pins, { element, relationships: pinned.relationships.filter((x) => x.fromId === id || x.toId === id) }]);
  };
  // A Flow lens draws its levels as columns (D88), on its own steps also after a drill.
  const flowSteps = useMemo(() => {
    const lens = lensOf(search);
    return lens?.shape === 'flow' && !step?.connect ? lensSpec(lens, inLayers).steps : null;
  }, [search, lenses, step?.connect]);
  // A lens's time slice (D97) marks each node's validity against its range.
  const timeSlice = lensOf(search)?.time;
  const graph = useMemo(
    () => (pinned && registry.data ? toCanvas(registry.data, pinned, new Set(pins.map((p) => p.element.id)), modelView.asOf, flowSteps, timeSlice) : null),
    [pinned, pins, registry.data, modelView.asOf, flowSteps, timeSlice],
  );
  const [impactOpen, setImpactOpen] = useState(false);
  // A Matrix lens opens its matrix (D90): the roots by what its first step reaches.
  const matrixStep = useMemo(() => {
    const lens = lensOf(search);
    return lens?.shape === 'matrix' && !step?.connect ? (lensSpec(lens, inLayers).steps[0] ?? null) : null;
  }, [search, lenses, step?.connect]);
  // A Landscape lens opens its boxes (D91): each root holding what its first step reaches.
  const landscapeStep = useMemo(() => {
    const lens = lensOf(search);
    return lens?.shape === 'landscape' && !step?.connect ? (lensSpec(lens, inLayers).steps[0] ?? null) : null;
  }, [search, lenses, step?.connect]);
  const [matrixOpen, setMatrixOpen] = useState(true);

  // A large result opens in the Overview, once per step; after that the view is the user's.
  useEffect(() => {
    if (graph && step && !step.viewChosen && graph.nodes.length > OVERVIEW_ABOVE) patch({ view: 'overview', viewChosen: true });
  }, [graph]);

  if (registry.error) return <ErrorBanner error={registry.error} />;
  if (!registry.data) return <div className="splash">Loading metamodel…</div>;
  const reg = registry.data;

  /** With `focus`, the lens runs from that one node, as "Open as" does (D92). */
  const run = (v: GraphSearchValue, known?: Lens, focus?: { id: string; name: string }) => {
    const lens = known ?? lensOf(v);
    setSearch(v);
    // A lens opens with its own depth, layout and view (LS-6).
    if (lens) {
      setDepth(lens.depth);
      // A Hierarchy lens is a tree from its roots (D85), a Flow lens columns (D88).
      setLayout(lens.shape === 'tree' ? 'hier' : lens.shape === 'flow' ? 'flow' : lens.layout);
      setFollow(!!lens.follow);
    }
    // A new Search starts a new focus path (DD-3).
    const view = lens?.view ?? carried(step?.view);
    setSteps([focus ? { label: `${lens?.name ?? ''} · ${focus.name}`, focusId: focus.id, selectedId: focus.id, view } : { label: describe(lens, v), selectedId: null, view }]);
    if (lens?.shape !== 'flow') setImpactOpen(false);
    setMatrixOpen(true);
  };
  const clear = () => {
    setSearch(null);
    setSteps([]);
    setPins([]);
    setImpactOpen(false);
    setFilter({ nodeTypes: [], relationshipTypes: [] });
  };
  /** "Save as lens" (LS-7): the editor, filled in from the search that ran. */
  const saveAsLens = () => {
    if (!search) return;
    const lens = lensOf(search);
    const extra: LensAttributeFilter[] = [
      ...search.filters.map(({ attribute, op, value }) => ({ attribute, op, value })),
      ...(search.name ? [{ attribute: 'name', op: 'contains' as const, value: search.name }] : []),
    ];
    // With no lens, the contour is the roots' type when they all share one.
    const rootTypes = new Set(graph?.rootIds.map((r) => graph.byId.get(r)?.type));
    const type = lens?.contour.type ?? (rootTypes.size === 1 ? [...rootTypes][0] : undefined);
    openEditor({
      builtIn: false,
      initial: {
        name: search.name || (lens ? `${lens.name} (copy)` : ''),
        contour: type ? { type, attributes: [...(lens?.contour.attributes ?? []), ...extra] } : null,
        facets: lens?.facets ?? [],
        match: lens?.match ?? 'all',
        depth,
        layout,
        view: carried(step?.view),
        follow,
        visibility: 'private',
      },
    });
  };
  const editLens = (id: string) => {
    const lens = lenses.find((l) => l.id === id);
    if (!lens) return;
    const mine = !!lens.owner && lens.owner === me.data?.userId;
    openEditor({
      initial: mine ? lens : { ...lens, id: undefined, name: lens.owner ? `${lens.name} (copy)` : lens.name, visibility: 'private' },
      savedId: mine ? lens.id : undefined,
      builtIn: !lens.owner,
    });
  };

  /** A step showing how two nodes are connected (D89), on the focus path like a drill. */
  const connectNodes = (from: string, to: string) => {
    const n = (id: string) => graph?.byId.get(id)?.name ?? id;
    setSteps((s) => [...s, { label: `${n(from)} ↔ ${n(to)}`, connect: { from, to }, selectedId: null, view: carried(s.at(-1)?.view) }]);
  };

  const drill = (id: string) => {
    if (id.startsWith(GROUP)) return void openGroup(id.slice(GROUP.length));
    const name = graph?.byId.get(id)?.name ?? id;
    setSteps((s) => [...s, { label: name, focusId: id, selectedId: id, view: carried(s.at(-1)?.view) }]);
  };

  const selected = step?.selectedId ? (graph?.byId.get(step.selectedId) ?? null) : null;
  // "Open as" (D92): every other lens whose contour the selected node is, a catalog query's aside.
  const openAs = selected
    ? lenses.filter((l) => !l.query && l.id !== search?.lensId && reg.lineage(selected.type).includes(l.contour.type)).map((l) => ({ id: l.id, name: l.name }))
    : [];
  const openAsLens = (id: string, lensId: string) => run({ lensId, name: '', filters: [] }, undefined, { id, name: graph?.byId.get(id)?.name ?? id });
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

  if (editing) {
    return (
      <>
        {editorError ? (
          <div className="graph-studio-editor-error">
            <ErrorBanner error={editorError} />
          </div>
        ) : null}
        <LensEditor
          registry={reg}
          initial={editing.initial}
          lenses={lenses}
          profile={profile.data}
          preview={preview.data}
          firstScreen={firstScreen.data}
          roles={roles}
          onRolesChange={setRoles}
          onDraftChange={onDraftChange}
          canShare={canShare}
          builtIn={editing.builtIn}
          onSave={saveLens}
          onCancel={() => setEditing(null)}
          onDelete={editing.savedId ? () => void deleteLens(editing.savedId!) : undefined}
          workspaceId={ws}
          catalogQueries={catalogQueries ?? []}
          onSubmitQuery={canAuthor ? submitQuery : undefined}
        />
      </>
    );
  }

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
          onEditLens={editLens}
          onNewLens={() => openEditor({ initial: null, builtIn: false })}
          onSaveAsLens={search ? saveAsLens : undefined}
          queryParams={(id) => {
            const q = lenses.find((l) => l.id === id)?.query;
            return q ? paramsOf.get(q.id) : undefined;
          }}
          workspaceId={ws}
        />
      </div>
      {result.error && <ErrorBanner error={result.error} />}
      {openError ? <ErrorBanner error={openError} /> : null}
      <div className="graph-studio-main">
        <div className="graph-studio-result">
          <GraphCanvas
            fill
            nodes={graph?.nodes ?? []}
            edges={graph?.edges ?? []}
            rootIds={graph?.rootIds ?? []}
            loading={connect ? paths.isLoading : !!body && result.isLoading}
            emptyMessage={emptyMessage}
            layers={reg.metamodel.layers}
            selectedId={step?.selectedId ?? null}
            view={step?.view ?? 'graph'}
            expandedIds={step?.expandedIds}
            layout={layout}
            columns={graph?.columns}
            caption={
              flowSteps && graph?.rootIds.length ? (
                <button type="button" className="button ghost small" aria-pressed={impactOpen} onClick={() => setImpactOpen(!impactOpen)}>
                  Impact table
                </button>
              ) : (matrixStep || landscapeStep) && graph?.rootIds.length ? (
                <button type="button" className="button ghost small" aria-pressed={matrixOpen} onClick={() => setMatrixOpen(!matrixOpen)}>
                  {matrixStep ? 'Matrix' : 'Landscape'}
                </button>
              ) : undefined
            }
            depth={depth}
            crumbs={steps.map((s) => ({ label: s.label }))}
            // A group opens on a click: it has nothing to inspect (D85).
            onSelect={(id) => (id?.startsWith(GROUP) ? void openGroup(id.slice(GROUP.length)) : step && patch({ selectedId: id }))}
            onViewChange={(v) => (step ? patch({ view: v, viewChosen: true }) : undefined)}
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
          onPin={togglePin}
          connectTo={pins.map((p) => ({ id: p.element.id, name: String(p.element.attrs['name'] ?? p.element.id) }))}
          onConnect={connectNodes}
          openAs={openAs}
          onOpenAs={openAsLens}
          editTo={selected ? `/w/${ws}/e/${selected.id}/edit` : undefined}
        />
        {connect && (
          <Connections
            paths={paths.data}
            loading={paths.isLoading}
            error={paths.error}
            chosen={connect.chosen ?? null}
            onChoose={(i) => patch({ connect: { ...connect, ...{ chosen: i ?? undefined } }, viewport: undefined })}
            onClose={() => setSteps((s) => s.slice(0, -1))}
          />
        )}
        {matrixOpen && matrixStep && graph && (
          <LensMatrix ws={ws!} rootIds={graph.rootIds} rowLabel={lensOf(search)?.contour.type ?? ''} step={matrixStep} view={vq} selectedId={step?.selectedId ?? null} onSelect={(id) => patch({ selectedId: id })} onClose={() => setMatrixOpen(false)} />
        )}
        {matrixOpen && landscapeStep && graph && (
          <LensLandscape ws={ws!} registry={reg} rootIds={graph.rootIds} step={landscapeStep} view={vq} selectedId={step?.selectedId ?? null} onSelect={(id) => patch({ selectedId: id })} onClose={() => setMatrixOpen(false)} />
        )}
        {impactOpen && flowSteps && graph && !connect && (
          <ImpactTable ws={ws!} rootIds={graph.rootIds} steps={flowSteps} view={vq} onSelect={(id) => patch({ selectedId: id })} onClose={() => setImpactOpen(false)} />
        )}
      </div>
    </div>
  );
}

/**
 * The view a new step starts in: graph or table as before, but not the Overview, which a step
 * opens in only when its own result is large.
 */
const carried = (v: GraphCanvasView | undefined): 'graph' | 'table' => (v === 'table' ? 'table' : 'graph');

/** "Data products · "client" · Lifecycle LIVE", for the breadcrumb and the empty state. */
function describe(lens: Lens | null, v: GraphSearchValue): string {
  const parts = [lens?.name, v.name && `"${v.name}"`, ...v.filters.map((f) => f.label)].filter(Boolean);
  return parts.join(' · ') || 'everything';
}

/**
 * The search request: the lens's roots (or the drilled node), drawn by disclosure along its steps
 * (D85). Depth on the canvas sets how many levels open at first.
 */
function searchBody(lens: Lens | null, v: GraphSearchValue, focusId: string | undefined, depth: number, inLayers: LayerTypes) {
  const spec = lensSpec(lens, inLayers);
  const base = { depth, match: 'all' as const, maxNodes: 1000, steps: spec.steps, disclosure: { ...spec.disclosure, initialDepth: depth } };
  if (focusId) return { ...base, ids: [focusId] };
  return { ...base, ...lensSearch(lens, v.filters, v.name, v.params) };
}

type StudioResult = Awaited<ReturnType<typeof exploreApi.studioSearch>>;

/** The result with opened group pages added: their members, links and groups; each group as it was left. */
interface Pin {
  element: Element;
  relationships: Relationship[];
}

/** The result with pinned nodes added, and their links to nodes on the canvas. */
function withPins(r: StudioResult, pins: readonly Pin[]): StudioResult {
  if (!pins.length) return r;
  const shown = new Set([...r.roots, ...r.elements].map((e) => e.id));
  const extra = pins.map((p) => p.element).filter((e) => !shown.has(e.id));
  for (const e of extra) shown.add(e.id);
  const rels = new Map(r.relationships.map((x) => [x.id, x]));
  for (const x of pins.flatMap((p) => p.relationships)) if (shown.has(x.fromId) && shown.has(x.toId)) rels.set(x.id, x);
  return { ...r, elements: [...r.elements, ...extra], relationships: [...rels.values()] };
}

/** The paths between two nodes as a result (D89): both ends as roots; one path when chosen, else all. */
function pathResult(p: Awaited<ReturnType<typeof exploreApi.studioPaths>>, c: NonNullable<Step['connect']>): StudioResult {
  const chosen = c.chosen !== undefined ? p.paths[c.chosen] : undefined;
  const nodeIds = new Set(chosen ? chosen.nodeIds : p.paths.flatMap((x) => x.nodeIds));
  const relIds = new Set(chosen ? chosen.relationshipIds : p.paths.flatMap((x) => x.relationshipIds));
  const ends = new Set([c.from, c.to]);
  const elements = p.elements.filter((e) => nodeIds.has(e.id));
  return {
    roots: elements.filter((e) => ends.has(e.id)),
    elements: elements.filter((e) => !ends.has(e.id)),
    relationships: p.relationships.filter((r) => relIds.has(r.id)),
    tooLarge: false,
    nodeCount: elements.length,
  };
}

function withPages(r: StudioResult, pages: readonly GroupPage[]): StudioResult {
  if (!pages.length) return r;
  const elements = new Map(r.elements.map((e) => [e.id, e]));
  const rels = new Map(r.relationships.map((x) => [x.id, x]));
  const groups = new Map((r.groups ?? []).map((g) => [g.id, g]));
  const levels = { ...r.levels };
  for (const p of pages) {
    Object.assign(levels, p.levels);
    for (const e of p.elements) elements.set(e.id, e);
    for (const x of p.relationships) rels.set(x.id, x);
    for (const g of p.groups) groups.set(g.id, g);
    groups.set(p.group.id, p.group);
  }
  // A member shown since may still be counted in a group fetched earlier; counts are as the server gave them.
  return { ...r, levels, elements: [...elements.values()], relationships: [...rels.values()], groups: [...groups.values()].filter((g) => g.count > 0) };
}

const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/**
 * API result → GraphCanvas input. A node or relationship counts as planned when it only starts
 * after the date being viewed (today by default), as in the Explorer.
 */
const markOf = (m: ReturnType<typeof timeMark>) => (m ? { mark: m } : {});

function toCanvas(reg: MetamodelRegistry, r: StudioResult, pinnedIds: ReadonlySet<string>, asOf?: string, flow?: readonly LensStep[] | null, time?: LensTime) {
  const column = (level: number | undefined) => (flow && level !== undefined ? { column: flowRank(flow, level) } : {});
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
      ...(pinnedIds.has(e.id) && { pinned: true }),
      ...column(r.levels?.[e.id]),
      ...markOf(timeMark(e, time)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const edges: GraphCanvasEdge[] = r.relationships.map((x) => ({ id: x.id, from: x.fromId, to: x.toId, type: x.type, planned: planned(x) }));
  // Folded links (D85): one node per group, joined to its parent by the group's relationship.
  const ids = new Set(nodes.map((n) => n.id));
  for (const g of (r.groups ?? []) as LensGroup[]) {
    if (!ids.has(g.parent)) continue;
    const id = `${GROUP}${g.id}`;
    nodes.push({ id, name: groupLabel(g), type: g.type, layer: reg.nodeType(g.type)?.layer ?? 'System', state: 'in-graph', group: g.count, ...column(g.level) });
    edges.push({ id: `${id}:edge`, from: g.direction === 'OUT' ? g.parent : id, to: g.direction === 'OUT' ? id : g.parent, type: g.relationship, planned: false });
  }
  // Flow column headings: each level's stage (D88).
  const levels = new Set([...Object.values(r.levels ?? {}), ...((r.groups ?? []) as LensGroup[]).map((g) => g.level)]);
  const columns = flow ? Object.fromEntries([...levels].map((l) => [flowRank(flow, l), flowStage(flow, l)])) : undefined;
  return {
    nodes,
    edges,
    columns,
    rootIds: r.roots.map((e) => e.id),
    byId: new Map(nodes.map((n) => [n.id, n])),
    attrs: new Map(all.map((e) => [e.id, e.attrs])),
  };
}
