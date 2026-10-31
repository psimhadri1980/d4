import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ErrorBanner, GraphCanvas, ResultTable } from '@d4/ui-kit';
import { type Element, type Relationship, useRegistry } from '@d4/web-platform';
import { type RunResult } from '../modules/queries/api';

/** Node, relationship and path shapes produced by the catalog runner. */
interface RunnerNode {
  elementId: string;
  labels: string[];
  properties: Record<string, unknown>;
}
interface RunnerRel {
  elementId: string;
  type: string;
  startNodeId: string;
  endNodeId: string;
  properties: Record<string, unknown>;
}
interface RunnerPath {
  start: RunnerNode;
  end: RunnerNode;
  segments: { start: RunnerNode; relationship: RunnerRel; end: RunnerNode }[];
}

const isNode = (v: unknown): v is RunnerNode =>
  !!v && typeof v === 'object' && 'elementId' in v && 'labels' in v && 'properties' in v;
const isRel = (v: unknown): v is RunnerRel =>
  !!v && typeof v === 'object' && 'elementId' in v && 'startNodeId' in v && 'endNodeId' in v;
const isPath = (v: unknown): v is RunnerPath => !!v && typeof v === 'object' && 'segments' in v && 'start' in v;

const SYSTEM = new Set(['id', 'type', 'workspaceId', 'version', 'validFrom', 'validTo', 'scenarioId', 'deleted', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy']);
const attrsOf = (p: Record<string, unknown>) => Object.fromEntries(Object.entries(p).filter(([k]) => !SYSTEM.has(k)));

/**
 * Collects every node, relationship and path anywhere in the rows (including inside lists) and
 * maps them to the explorer's element/relationship shape. D4 nodes keep their own ids so links
 * work; relationships whose endpoints aren't in the result are dropped.
 */
export function graphFromRows(rows: Record<string, unknown>[]): { elements: Element[]; relationships: Relationship[] } {
  const nodes = new Map<string, RunnerNode>();
  const rels = new Map<string, RunnerRel>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (isPath(v)) {
      visit(v.start);
      visit(v.end);
      for (const s of v.segments) {
        visit(s.start);
        visit(s.relationship);
        visit(s.end);
      }
      return;
    }
    if (isRel(v)) {
      rels.set(v.elementId, v);
      return;
    }
    if (isNode(v)) {
      nodes.set(v.elementId, v);
      return;
    }
    if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  rows.forEach((r) => Object.values(r).forEach(visit));

  const idOf = new Map<string, string>();
  const elements: Element[] = [...nodes.values()].map((n) => {
    const p = n.properties;
    const id = typeof p['id'] === 'string' ? (p['id'] as string) : n.elementId;
    idOf.set(n.elementId, id);
    return {
      id,
      type: typeof p['type'] === 'string' ? (p['type'] as string) : (n.labels.find((l) => l !== 'Element') ?? 'Element'),
      attrs: attrsOf(p),
      workspaceId: String(p['workspaceId'] ?? ''),
      version: Number(p['version'] ?? 1),
      validFrom: (p['validFrom'] as string | undefined) ?? null,
      validTo: (p['validTo'] as string | undefined) ?? null,
      scenarioId: null,
      deleted: false,
      createdAt: '',
      createdBy: '',
      updatedAt: '',
      updatedBy: '',
    };
  });
  const relationships: Relationship[] = [...rels.values()]
    .filter((r) => idOf.has(r.startNodeId) && idOf.has(r.endNodeId))
    .map((r) => ({
      id: typeof r.properties['id'] === 'string' ? (r.properties['id'] as string) : r.elementId,
      type: r.type,
      fromId: idOf.get(r.startNodeId)!,
      toId: idOf.get(r.endNodeId)!,
      attrs: attrsOf(r.properties),
      workspaceId: String(r.properties['workspaceId'] ?? ''),
      version: Number(r.properties['version'] ?? 1),
      validFrom: (r.properties['validFrom'] as string | undefined) ?? null,
      validTo: (r.properties['validTo'] as string | undefined) ?? null,
      scenarioId: null,
      deleted: false,
      createdAt: '',
      createdBy: '',
      updatedAt: '',
      updatedBy: '',
    }));
  return { elements, relationships };
}

/** Table or graph view of a run result, following the query's declared result shape. */
export function QueryResultView({
  result,
  workspaceId,
  title,
  shape,
}: {
  result: RunResult;
  workspaceId: string;
  title: string;
  shape: 'table' | 'graph';
}) {
  const [view, setView] = useState<'table' | 'graph'>(shape);
  const registry = useRegistry(workspaceId);
  const navigate = useNavigate();
  const graph = view === 'graph' ? graphFromRows(result.rows) : null;

  return (
    <div className="result-view">
      {shape === 'graph' && (
        <div className="segmented" role="group" aria-label="Result view">
          <button className={view === 'graph' ? 'active' : ''} onClick={() => setView('graph')}>
            Graph
          </button>
          <button className={view === 'table' ? 'active' : ''} onClick={() => setView('table')}>
            Table
          </button>
        </div>
      )}
      {view === 'graph' && graph ? (
        <>
          <p className="muted small">
            {graph.elements.length} elements · {graph.relationships.length} relationships · v{result.version} · {result.durationMs} ms
            {result.truncated && ' · truncated at the row limit'}
          </p>
          {registry.error && <ErrorBanner error={registry.error} />}
          {registry.data && graph.elements.length > 0 ? (
            <div className="result-graph">
              <GraphCanvas
                registry={registry.data}
                elements={graph.elements}
                relationships={graph.relationships}
                onSelect={() => undefined}
                onExpand={(id) => navigate(`/w/${workspaceId}/e/${id}`)}
                layout="force"
              />
            </div>
          ) : (
            <p className="muted">No graph elements in this result.</p>
          )}
          <p className="muted small">Double-click a node to open it in the explorer.</p>
        </>
      ) : (
        <ResultTable result={result} title={title} renderElementLink={(id) => <Link to={`/w/${workspaceId}/e/${id}`}>open</Link>} />
      )}
    </div>
  );
}
