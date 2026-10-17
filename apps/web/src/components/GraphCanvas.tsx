import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
import { useEffect, useRef } from 'react';
import type { MetamodelRegistry } from '@d4/metamodel';
import type { Element, Relationship } from '../api';
import { elementName, layerOf } from '../model';

interface Props {
  registry: MetamodelRegistry;
  elements: Element[];
  relationships: Relationship[];
  selectedId?: string;
  onSelect(id: string): void;
  /** Double-click: load this element's neighbourhood into the view. */
  onExpand(id: string): void;
}

/** Reads a CSS custom property so the graph follows the light/dark theme tokens. */
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Force-directed graph of the current view; nodes are coloured by metamodel layer. */
export function GraphCanvas({ registry, elements, relationships, selectedId, onSelect, onExpand }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
  const handlers = useRef({ onSelect, onExpand });
  handlers.current = { onSelect, onExpand };

  // Create once.
  useEffect(() => {
    const instance = cytoscape({
      container: host.current,
      wheelSensitivity: 0.2,
      minZoom: 0.2,
      maxZoom: 3,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            label: 'data(label)',
            color: token('--text'),
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
            color: token('--muted'),
            'text-rotation': 'autorotate',
            'text-background-color': token('--bg'),
            'text-background-opacity': 1,
            'text-background-padding': '2px',
          },
        },
        { selector: 'edge.future', style: { 'line-style': 'dashed' } },
      ],
    });
    instance.on('tap', 'node', (e) => handlers.current.onSelect(e.target.id()));
    instance.on('dbltap', 'node', (e) => handlers.current.onExpand(e.target.id()));
    cy.current = instance;
    return () => instance.destroy();
  }, []);

  // Sync data; re-layout only when the set of nodes changes.
  useEffect(() => {
    const instance = cy.current;
    if (!instance) return;
    const today = new Date().toISOString().slice(0, 10);
    const defs: ElementDefinition[] = [
      ...elements.map((e) => ({
        group: 'nodes' as const,
        data: {
          id: e.id,
          label: `${elementName(e)}\n‹${e.type}›`,
          color: token(`--layer-${layerOf(registry, e.type).toLowerCase()}`) || token('--layer-other'),
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
    if (changed) {
      instance
        .layout({ name: 'cose', animate: false, nodeRepulsion: () => 9000, idealEdgeLength: () => 110, padding: 30 })
        .run();
    }
  }, [elements, relationships, registry]);

  useEffect(() => {
    const instance = cy.current;
    if (!instance) return;
    instance.nodes().removeClass('focus');
    if (selectedId) instance.getElementById(selectedId).addClass('focus');
  }, [selectedId, elements]);

  return <div ref={host} className="graph" aria-label="Relationship graph" />;
}
