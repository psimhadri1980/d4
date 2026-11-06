import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { GraphCanvas, type GraphCanvasEdge, type GraphCanvasNode } from '../src';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
const render = (ui: React.ReactNode) => {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(ui));
  return root;
};
afterEach(() => host?.remove());

const nodes: GraphCanvasNode[] = [
  { id: 'r1', name: 'Customer Onboarding', type: 'BusinessService', layer: 'Strategy', state: 'in-graph' },
  { id: 'iv', name: 'Identity Verification', type: 'Capability', layer: 'Business', state: 'in-graph' },
  { id: 'sv', name: 'app-eu-01', type: 'Server', layer: 'Technology', state: 'planned' },
];
const edges: GraphCanvasEdge[] = [
  { from: 'r1', to: 'iv', type: 'ENABLED_BY', planned: false },
  { from: 'iv', to: 'sv', type: 'RUNS_ON', planned: true },
];
const click = (el: Element, type = 'click') => act(() => el.dispatchEvent(new MouseEvent(type, { bubbles: true })));
const node = (id: string) => host.querySelector(`[data-node-id="${id}"]`)!;

describe('GraphCanvas', () => {
  it('draws a card per node with the root marked, and labelled connectors, dashed when planned', () => {
    const root = render(<GraphCanvas nodes={nodes} edges={edges} rootIds={['r1']} />);
    expect(host.querySelector('svg')!.getAttribute('aria-label')).toBe('Graph of 3 nodes and 2 relationships');
    expect(node('r1').getAttribute('aria-label')).toBe('Customer Onboarding, BusinessService, Strategy, root');
    expect(node('sv').getAttribute('aria-label')).toBe('app-eu-01, Server, Technology, planned');
    expect(node('r1').textContent).toContain('Root');
    expect([...host.querySelectorAll('.graph-canvas-label')].map((l) => l.textContent)).toEqual(['ENABLED BY', 'RUNS ON']);
    expect(host.querySelectorAll('.graph-canvas-edge.planned')).toHaveLength(1);
    expect(host.querySelector('.graph-canvas-edge path')!.getAttribute('marker-end')).toMatch(/^url\(#/);
    act(() => root.unmount());
  });

  it('reports selection, clearing on empty canvas, and drill on double-click; the host owns the selection', () => {
    const events: (string | null)[] = [];
    const drilled: string[] = [];
    const root = render(
      <GraphCanvas nodes={nodes} edges={edges} rootIds={['r1']} selectedId="iv" onSelect={(id) => events.push(id)} onDrill={(id) => drilled.push(id)} />,
    );
    expect(node('iv').getAttribute('aria-pressed')).toBe('true');
    expect(node('iv').classList.contains('selected')).toBe(true);
    click(node('sv'));
    click(host.querySelector('svg')!);
    click(node('r1'), 'dblclick');
    act(() => node('sv').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(events).toEqual(['sv', null, 'sv']);
    expect(drilled).toEqual(['r1']);
    // Nothing changes until the host passes a new selectedId.
    expect(node('sv').getAttribute('aria-pressed')).toBe('false');
    act(() => root.unmount());
  });

  it('shows the loading, too-large and empty states instead of a graph', () => {
    let root = render(<GraphCanvas nodes={nodes} edges={edges} rootIds={['r1']} loading />);
    expect(host.querySelector('[role="status"]')!.textContent).toBe('Loading the result…');
    act(() => root.unmount());
    root = render(<GraphCanvas nodes={nodes} edges={edges} rootIds={['r1']} maxNodes={2} />);
    expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/3 nodes, more than the 2 the canvas shows/);
    expect(host.querySelector('svg')).toBeNull();
    act(() => root.unmount());
    root = render(<GraphCanvas nodes={[]} edges={[]} rootIds={[]} />);
    expect(host.textContent).toBe('Nothing to show.');
    act(() => root.unmount());
  });

  it('shows the same result as a tree in the table view, expanded to level 1, with the same selection', () => {
    const events: (string | null)[] = [];
    const opened: string[][] = [];
    const root = render(
      <GraphCanvas nodes={nodes} edges={edges} rootIds={['r1']} view="table" selectedId="iv" onSelect={(id) => events.push(id)} onExpandedChange={(p) => opened.push(p)} />,
    );
    const rows = () => [...host.querySelectorAll('[role="treeitem"]')];
    expect(host.querySelector('svg.graph-canvas-svg')).toBeNull();
    expect(rows().map((r) => r.getAttribute('data-path'))).toEqual(['r1', 'r1/iv']);
    expect(rows()[0]!.textContent).toContain('Root');
    expect(rows()[0]!.textContent).toContain('1 dependent');
    expect(rows()[0]!.getAttribute('aria-expanded')).toBe('true');
    expect(rows()[1]!.getAttribute('aria-selected')).toBe('true');
    expect(rows()[1]!.getAttribute('aria-level')).toBe('2');

    click(rows()[0]!);
    click(rows()[1]!.querySelector('.graph-canvas-chevron')!);
    const press = (el: Element, key: string) => act(() => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
    press(rows()[0]!, 'ArrowLeft');
    press(rows()[0]!, 'Enter');
    click([...host.querySelectorAll('button')].find((b) => b.textContent!.startsWith('Expand all'))!);
    click([...host.querySelectorAll('button')].find((b) => b.textContent!.startsWith('Collapse all'))!);
    expect(events).toEqual(['r1', 'r1']);
    expect(opened).toEqual([['r1', 'r1/iv'], [], ['r1', 'r1/iv'], []]);
    act(() => root.unmount());
  });

  it('moves focus with the arrow keys and expands with Right', () => {
    const opened: string[][] = [];
    const root = render(<GraphCanvas nodes={nodes} edges={edges} rootIds={['r1']} view="table" expandedIds={[]} onExpandedChange={(p) => opened.push(p)} />);
    const first = host.querySelector('[role="treeitem"]') as HTMLElement;
    expect(first.tabIndex).toBe(0);
    act(() => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(opened).toEqual([['r1']]);
    act(() => root.unmount());
  });

  it('colours nodes by layer token with a fallback for unknown layers', () => {
    const root = render(<GraphCanvas nodes={[{ ...nodes[0]!, layer: 'Moon' }]} edges={[]} rootIds={['r1']} layout="radial" />);
    expect((host.querySelector('.graph-canvas-swatch') as SVGElement).style.fill).toContain('--layer-moon');
    expect((host.querySelector('.graph-canvas-swatch') as SVGElement).style.fill).toContain('--layer-system');
    act(() => root.unmount());
  });
});
