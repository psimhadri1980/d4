import cytoscape, { type Core, type ElementDefinition, type LayoutOptions } from 'cytoscape';
import { useEffect, useRef } from 'react';
import type { MetamodelRegistry } from '@d4/metamodel';
import type { Element, Relationship } from '../api';
import { elementName, layerOf } from '../model';
import { THEME_EVENT } from '../theme';

interface Props {
  registry: MetamodelRegistry;
  elements: Element[];
  relationships: Relationship[];
  selectedId?: string;
  onSelect(id: string): void;
  /** Double-click: load this element's neighbourhood into the view. */
  onExpand(id: string): void;
  /** Layout algorithm; `radial` puts `selectedId` in the centre with rings by hop distance. */
  layout?: GraphLayout;
  /** Bumped by the parent to re-fit the view (e.g. a "Fit" button). */
  fitSignal?: number;
  /** Date the graph is viewed at; relationships starting later are drawn dashed. Default: today. */
  asOf?: string;
}

export type GraphLayout = 'radial' | 'force' | 'hierarchy';

/**
 * Below this zoom, nodes and labels become too small to read; the view stays at this zoom
 * (centred on the selected element) and the user pans instead.
 */
export const MIN_READABLE_ZOOM = 0.7;

function keepReadable(cy: Core, focusId?: string) {
  if (cy.zoom() >= MIN_READABLE_ZOOM) return;
  const focus = focusId ? cy.getElementById(focusId) : cy.collection();
  cy.zoom(MIN_READABLE_ZOOM);
  cy.center(focus.nonempty() ? focus : undefined);
}

/** Hop distance from the root over the undirected relationship graph. */
export function hopDistances(rootId: string, relationships: { fromId: string; toId: string }[]): Map<string, number> {
  const next = new Map<string, string[]>();
  for (const r of relationships) {
    next.set(r.fromId, [...(next.get(r.fromId) ?? []), r.toId]);
    next.set(r.toId, [...(next.get(r.toId) ?? []), r.fromId]);
  }
  const dist = new Map([[rootId, 0]]);
  const queue = [rootId];
  for (let cur = queue.shift(); cur !== undefined; cur = queue.shift()) {
    for (const n of next.get(cur) ?? []) {
      if (!dist.has(n)) {
        dist.set(n, dist.get(cur)! + 1);
        queue.push(n);
      }
    }
  }
  return dist;
}

/**
 * Layout options tuned for readable, spread-out graphs. Radial needs a root that is in the
 * graph; otherwise force is used.
 */
function layoutOptions(kind: GraphLayout, rootId: string | undefined, hops: Map<string, number>, count: number): LayoutOptions {
  const base = { animate: false, fit: true, padding: 40 };
  if (kind === 'radial' && rootId) {
    const maxHop = Math.max(0, ...hops.values());
    return {
      ...base,
      name: 'concentric',
      // Higher value = closer to the centre; unreachable nodes go to the outermost ring.
      concentric: (n: cytoscape.NodeSingular) => maxHop + 1 - (hops.get(n.id()) ?? maxHop + 1),
      levelWidth: () => 1,
      minNodeSpacing: 70,
      avoidOverlap: true,
      spacingFactor: count > 30 ? 1.1 : 1.4,
      startAngle: (3 / 2) * Math.PI,
    } as LayoutOptions;
  }
  if (kind === 'hierarchy' && rootId) {
    return { ...base, name: 'breadthfirst', roots: [rootId], directed: false, spacingFactor: 3.6, avoidOverlap: true } as LayoutOptions;
  }
  return {
    ...base,
    name: 'cose',
    randomize: true,
    nodeRepulsion: () => 400_000,
    nodeOverlap: 40,
    idealEdgeLength: () => 140,
    edgeElasticity: () => 80,
    gravity: 0.25,
    numIter: 2500,
    componentSpacing: 120,
  } as LayoutOptions;
}

/** Reads a CSS custom property so the graph follows the light/dark theme tokens. */
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const layerColor = (layer: string) => token(`--layer-${layer.toLowerCase()}`) || token('--layer-other');

type GraphStyle = cytoscape.StylesheetJsonBlock[];

/** Cytoscape stylesheet built from the current theme tokens (rebuilt when the theme changes). */
function graphStyle(): GraphStyle {
  return [
    {
      selector: 'node',
      style: {
        'background-color': 'data(color)',
        label: 'data(label)',
        color: token('--text'),
        'font-family': token('--font-sans'),
        'font-size': 11,
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'text-wrap': 'wrap',
        'text-max-width': '110px',
        width: 26,
        height: 26,
        'border-width': 2,
        'border-color': token('--surface'),
      },
    },
    {
      selector: 'node:selected, node.focus',
      style: { 'border-color': token('--accent'), 'border-width': 4, width: 34, height: 34 },
    },
    {
      selector: 'edge',
      style: {
        width: 1.5,
        'line-color': token('--edge'),
        'target-arrow-color': token('--edge'),
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        label: 'data(label)',
        'font-size': 9,
        'font-family': token('--font-sans'),
        color: token('--muted'),
        'text-rotation': 'autorotate',
        'text-background-color': token('--bg'),
        'text-background-opacity': 1,
        'text-background-padding': '2px',
      },
    },
    { selector: 'edge.future', style: { 'line-style': 'dashed' } },
  ] as GraphStyle;
}

/** Graph of the current view; nodes are coloured by metamodel layer. */
export function GraphCanvas({
  registry,
  elements,
  relationships,
  selectedId,
  onSelect,
  onExpand,
  layout = 'radial',
  fitSignal = 0,
  asOf,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
  const lastLayout = useRef<GraphLayout | null>(null);
  const handlers = useRef({ onSelect, onExpand });
  handlers.current = { onSelect, onExpand };

  // Create once.
  useEffect(() => {
    const instance = cytoscape({
      container: host.current,
      wheelSensitivity: 0.2,
      minZoom: 0.2,
      maxZoom: 3,
      style: graphStyle(),
    });
    instance.on('tap', 'node', (e) => handlers.current.onSelect(e.target.id()));
    instance.on('dbltap', 'node', (e) => handlers.current.onExpand(e.target.id()));
    cy.current = instance;
    const onTheme = () => {
      instance.style(graphStyle());
      instance.nodes().forEach((n) => {
        n.data('color', layerColor(String(n.data('layer'))));
      });
    };
    window.addEventListener(THEME_EVENT, onTheme);
    // Test hook: lets browser tests measure node placement.
    (host.current as unknown as { __cy?: Core }).__cy = instance;
    return () => {
      window.removeEventListener(THEME_EVENT, onTheme);
      instance.destroy();
    };
  }, []);

  // Sync data; re-layout only when the set of nodes changes.
  useEffect(() => {
    const instance = cy.current;
    if (!instance) return;
    const today = asOf || new Date().toISOString().slice(0, 10);
    const defs: ElementDefinition[] = [
      ...elements.map((e) => ({
        group: 'nodes' as const,
        data: {
          id: e.id,
          label: `${elementName(e)}\n‹${e.type}›`,
          layer: layerOf(registry, e.type),
          color: layerColor(layerOf(registry, e.type)),
        },
      })),
      ...relationships
        .filter((r) => elements.some((e) => e.id === r.fromId) && elements.some((e) => e.id === r.toId))
        .map((r) => ({
          group: 'edges' as const,
          data: {
            id: r.id,
            source: r.fromId,
            target: r.toId,
            label: typeof r.attrs['role'] === 'string' ? `${r.type} (${String(r.attrs['role'])})` : r.type,
          },
          // Not yet valid: drawn dashed (e.g. a planned hand-over).
          classes: r.validFrom && r.validFrom > today ? 'future' : '',
        })),
    ];
    const before = new Set(instance.nodes().map((n) => n.id()));
    instance.json({ elements: defs });
    const after = new Set(elements.map((e) => e.id));
    const changed = before.size !== after.size || [...after].some((id) => !before.has(id));
    if (changed || lastLayout.current !== layout) {
      lastLayout.current = layout;
      const root = selectedId && after.has(selectedId) ? selectedId : undefined;
      instance.layout(layoutOptions(layout, root, root ? hopDistances(root, relationships) : new Map(), elements.length)).run();
      keepReadable(instance, root);
    }
  }, [elements, relationships, registry, layout, selectedId, asOf]);

  useEffect(() => {
    const instance = cy.current;
    if (!fitSignal || !instance) return;
    instance.fit(undefined, 40);
    keepReadable(instance, selectedId);
  }, [fitSignal]); // selectedId is read at click time

  useEffect(() => {
    const instance = cy.current;
    if (!instance) return;
    instance.nodes().removeClass('focus');
    if (selectedId) instance.getElementById(selectedId).addClass('focus');
  }, [selectedId, elements]);

  return <div ref={host} className="graph" aria-label="Relationship graph" />;
}
