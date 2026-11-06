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
    expect(host.querySelector('svg.graph-canvas-svg')!.getAttribute('aria-label')).toBe('Graph of 3 nodes and 2 relationships');
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
    click(host.querySelector('svg.graph-canvas-svg')!);
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
    expect(host.querySelector('svg.graph-canvas-svg')).toBeNull();
    act(() => root.unmount());
    root = render(<GraphCanvas nodes={[]} edges={[]} rootIds={[]} emptyMessage="Find a node to start." />);
    expect(host.querySelector('.graph-canvas-state')!.textContent).toBe('Find a node to start.');
    expect(host.querySelector('.graph-canvas-summary')).toBeNull();
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

  it('has a top bar with the focus path, an option bar for the view, and a status bar', () => {
    const calls: string[] = [];
    const root = render(
      <GraphCanvas
        nodes={nodes}
        edges={edges}
        rootIds={['r1']}
        depth={2}
        layout="hier"
        crumbs={[{ label: 'Onboarding' }, { label: 'Identity Verification' }]}
        onCrumb={(i) => calls.push(`crumb ${i}`)}
        onDepthChange={(d) => calls.push(`depth ${d}`)}
        onLayoutChange={(l) => calls.push(`layout ${l}`)}
        onViewChange={(v) => calls.push(`view ${v}`)}
      />,
    );
    expect(host.querySelector('h2')!.textContent).toBe('Result');
    const crumbs = host.querySelector('nav[aria-label="Focus path"]')!;
    expect(crumbs.textContent).toBe('OnboardingIdentity Verification');
    expect(crumbs.querySelector('[aria-current="location"]')!.textContent).toBe('Identity Verification');
    const button = (name: string) => [...host.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent!.trim()) === name)!;
    expect(button('Depth 2').getAttribute('aria-pressed')).toBe('true');
    expect(button('Hierarchical').getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe('Graph');
    click(crumbs.querySelector('button')!);
    click(button('‹ Back'));
    click(button('Depth 5'));
    click(button('Radial'));
    click([...host.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Table')!);
    expect(calls).toEqual(['crumb 0', 'crumb 0', 'depth 5', 'layout radial', 'view table']);
    expect([...host.querySelectorAll('.graph-canvas-summary li')].map((l) => l.textContent)).toEqual(['1 root', '3 nodes', '1 planned edge']);
    expect(host.querySelector('.graph-canvas-legend')!.textContent).toBe('currentplanned');
    act(() => root.unmount());
  });

  it('filters by inclusion from the Show only panel, with a badge, chips and "x of y" in the summary', () => {
    const changes: unknown[] = [];
    const draw = (filter: { nodeTypes: string[]; relationshipTypes: string[] }) => (
      <GraphCanvas nodes={nodes} edges={edges} rootIds={['r1']} filter={filter} onFilterChange={(f) => changes.push(f)} />
    );
    let root = render(draw({ nodeTypes: [], relationshipTypes: [] }));
    const filterButton = () => host.querySelector('button[title="Filter"]') as HTMLButtonElement;
    expect(filterButton().getAttribute('aria-label')).toBe('Filter');
    click(filterButton());
    const panel = host.querySelector('[role="dialog"][aria-label="Show only"]')!;
    const box = (text: string) => [...panel.querySelectorAll('label')].find((l) => l.textContent!.startsWith(text))!.querySelector('input')!;
    expect(box('All node types').checked).toBe(true);
    expect(panel.textContent).toContain('Capability1');
    expect(panel.textContent).toContain('RUNS ON1');
    click(box('Capability'));
    expect(changes).toEqual([{ nodeTypes: ['Capability'], relationshipTypes: [] }]);
    act(() => root.unmount());

    // Show only Capability: the Server goes, the root stays.
    root = render(draw({ nodeTypes: ['Capability'], relationshipTypes: [] }));
    expect(filterButton().getAttribute('aria-label')).toBe('Filter, 1 ticked');
    expect([...host.querySelectorAll('[data-node-id]')].map((n) => n.getAttribute('data-node-id'))).toEqual(['r1', 'iv']);
    expect([...host.querySelectorAll('.graph-canvas-summary li')].map((l) => l.textContent)).toEqual(['1 root', '2 of 3 nodes', '0 planned edges']);
    expect(host.querySelector('.graph-canvas-chips')!.textContent).toContain('Showing only:Capability');
    click(host.querySelector('button[aria-label="Remove Capability"]')!);
    expect(changes.at(-1)).toEqual({ nodeTypes: [], relationshipTypes: [] });
    act(() => root.unmount());
  });

  it('drags nodes, connectors and labels, reporting the adjustments once, on release', () => {
    const changes: { nodes: Record<string, { x: number; y: number }>; bends: Record<string, number>; labels: Record<string, { x: number; y: number }> }[] = [];
    const selected: (string | null)[] = [];
    const root = render(<GraphCanvas nodes={nodes} edges={edges} rootIds={['r1']} onAdjustmentsChange={(a) => changes.push(a as never)} onSelect={(id) => selected.push(id)} />);
    const pointer = (el: Element, type: string, x: number, y: number) => act(() => el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })));
    const transform = () => node('iv').getAttribute('transform');
    const before = transform();

    pointer(node('iv'), 'pointerdown', 100, 100);
    pointer(node('iv'), 'pointermove', 140, 130);
    expect(transform()).not.toBe(before);
    expect(changes).toEqual([]);
    pointer(node('iv'), 'pointerup', 140, 130);
    click(node('iv'));
    expect(changes).toHaveLength(1);
    expect(Object.keys(changes[0]!.nodes)).toEqual(['iv']);
    // The click that ends a drag does not select.
    expect(selected).toEqual([]);

    const hit = host.querySelector('[data-edge-id] .graph-canvas-hit')!;
    pointer(hit, 'pointerdown', 0, 0);
    pointer(hit, 'pointermove', 0, 25);
    pointer(hit, 'pointerup', 0, 25);
    expect(Object.keys(changes[1]!.bends)).toHaveLength(1);

    const label = host.querySelector('[data-edge-id] .graph-canvas-label-box')!;
    pointer(label, 'pointerdown', 0, 0);
    pointer(label, 'pointermove', 50, 0);
    pointer(label, 'pointerup', 50, 0);
    expect(Object.keys(changes[2]!.labels)).toHaveLength(1);
    act(() => root.unmount());
  });

  it('moves a selected node with the arrow keys, resets a label on double-click, and Reset layout clears all', () => {
    const changes: unknown[] = [];
    const adjustments = { nodes: { iv: { x: 300, y: 300 } }, bends: { 'r1|ENABLED_BY|iv|0': 140 }, labels: { 'r1|ENABLED_BY|iv|0': { x: 10, y: 10 } } };
    const root = render(<GraphCanvas nodes={nodes} edges={edges} rootIds={['r1']} adjustments={adjustments} onAdjustmentsChange={(a) => changes.push(a)} onLayoutChange={() => {}} />);
    expect(node('iv').getAttribute('transform')).toBe('translate(210,272)');
    act(() => node('iv').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(changes.at(-1)).toMatchObject({ nodes: { iv: { x: 310, y: 300 } } });

    // Selecting a label highlights its connector and ties the label to it.
    const label = host.querySelector('[data-edge-id="r1|ENABLED_BY|iv|0"] .graph-canvas-label-box')!;
    click(label);
    expect(host.querySelector('.graph-canvas-edge.lit')).not.toBeNull();
    expect(host.querySelector('.graph-canvas-tie')).not.toBeNull();
    click(label, 'dblclick');
    expect(changes.at(-1)).toEqual({ nodes: adjustments.nodes, bends: {}, labels: {} });

    click(host.querySelector('button[aria-label="Reset layout"]')!);
    expect(changes.at(-1)).toEqual({ nodes: {}, bends: {}, labels: {} });
    act(() => root.unmount());
  });

  it('colours nodes by layer token with a fallback for unknown layers', () => {
    const root = render(<GraphCanvas nodes={[{ ...nodes[0]!, layer: 'Moon' }]} edges={[]} rootIds={['r1']} layout="radial" />);
    expect((host.querySelector('.graph-canvas-swatch') as SVGElement).style.fill).toContain('--layer-moon');
    expect((host.querySelector('.graph-canvas-swatch') as SVGElement).style.fill).toContain('--layer-system');
    act(() => root.unmount());
  });
});
