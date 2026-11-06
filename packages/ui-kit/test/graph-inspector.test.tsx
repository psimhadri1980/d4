import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import { attributeLabel, GraphInspector, type GraphCanvasEdge, type GraphCanvasNode } from '../src';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const registry = new MetamodelRegistry(loadStarterMetamodel());
let host: HTMLDivElement;
const render = (ui: React.ReactNode) => {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<MemoryRouter>{ui}</MemoryRouter>));
  return root;
};
afterEach(() => host?.remove());

const nodes: GraphCanvasNode[] = [
  { id: 'g', name: 'Grow lending', type: 'Goal', layer: 'Strategy', state: 'in-graph' },
  { id: 'v', name: 'Best private bank', type: 'Vision', layer: 'Strategy', state: 'in-graph' },
  { id: 'o', name: 'Double mortgages', type: 'Objective', layer: 'Strategy', state: 'planned' },
];
const edges: GraphCanvasEdge[] = [
  { from: 'v', to: 'g', type: 'PARENT_OF', planned: false },
  { from: 'g', to: 'o', type: 'PARENT_OF', planned: true },
];

describe('GraphInspector', () => {
  it('asks for a selection when nothing is selected', () => {
    const root = render(<GraphInspector registry={registry} node={null} nodes={nodes} edges={edges} />);
    expect(host.textContent).toBe('Select a node to see its attributes');
    act(() => root.unmount());
  });

  it('shows every attribute the type defines, dashes for empty ones, then extra attributes', () => {
    const root = render(
      <GraphInspector registry={registry} node={nodes[0]!} attrs={{ name: 'Grow lending', targetDate: '2027-12-31', costCentre: 'CC-1', reviewers: [] }} nodes={nodes} edges={edges} editTo="/w/default/e/g/edit" />,
    );
    expect(host.querySelector('h2')!.textContent).toBe('Grow lending');
    expect(host.textContent).toContain('Goal · Strategy');
    const pairs = [...host.querySelectorAll('dl > div')].map((d) => [d.querySelector('dt')!.textContent, d.querySelector('dd')!.textContent]);
    expect(pairs).toEqual(expect.arrayContaining([['Target date', '2027-12-31'], ['Cost centre (not in the metamodel)', 'CC-1'], ['Tags', '–'], ['Reviewers (not in the metamodel)', '–']]));
    const defined = registry.attributesFor('Goal').filter((d) => d.name !== 'name');
    expect(pairs.filter(([k]) => !k!.includes('not in'))).toHaveLength(defined.length);
    expect(host.querySelector('a')!.getAttribute('href')).toBe('/w/default/e/g/edit');
    act(() => root.unmount());
  });

  it('lists direct relationships, each selecting the node at the other end', () => {
    const picked: string[] = [];
    const root = render(<GraphInspector registry={registry} node={nodes[0]!} nodes={nodes} edges={edges} onSelect={(id) => picked.push(id)} />);
    const items = [...host.querySelectorAll('li')];
    expect(items.map((li) => li.textContent)).toEqual(['← PARENT OF Best private bank', '→ PARENT OF Double mortgages planned']);
    act(() => items[0]!.querySelector('button')!.click());
    expect(picked).toEqual(['v']);
    act(() => root.unmount());
  });

  it('labels camelCase attribute names', () => {
    expect(attributeLabel('targetDate')).toBe('Target date');
    expect(attributeLabel('piiType')).toBe('Pii type');
  });
});
