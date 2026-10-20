import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRoadmap, type RoadmapView } from '@d4/core';
import { Gantt, ResultTable, toCsv, type QueryResult } from '../src';

// React's act() wants to know it runs in a test environment.
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

const dependencies = [{ from: 'b', to: 'a', type: 'FINISH_START' as const, lagDays: 0 }];
const roadmap: RoadmapView = {
  ...buildRoadmap({
    items: [
      { id: 'a', name: 'Build hub', kind: 'deliverable', start: '2027-01-01', end: '2027-01-31', lane: 'Data' },
      { id: 'b', name: 'Migrate clients', kind: 'deliverable', start: '2027-02-01', end: '2027-02-28', lane: 'Data' },
      { id: 'm', name: 'Go live', kind: 'milestone', start: '2027-03-01', end: null, lane: 'Milestones' },
    ],
    dependencies,
  }),
  lanesBy: 'initiative',
  changes: [],
  dependencies,
};

describe('Gantt', () => {
  it('draws an accessible bar per item and a milestone, and reports selection', () => {
    const picked: string[] = [];
    const root = render(<Gantt roadmap={roadmap} zoom="month" selected="a" highlight={[]} onSelect={(id) => picked.push(id)} today="2027-01-15" />);
    const items = [...host.querySelectorAll('[role="button"]')];
    expect(items.map((i) => i.getAttribute('aria-label'))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Build hub, 2027-01-01 to 2027-01-31/), expect.stringMatching(/^Go live, 2027-03-01/)]),
    );
    expect(host.querySelector('svg')!.getAttribute('aria-label')).toBe('Gantt chart with 3 items');
    expect(host.querySelectorAll('.gantt-milestone')).toHaveLength(1);
    expect(host.querySelectorAll('.gantt-dep')).toHaveLength(1);
    act(() => (items.find((i) => i.getAttribute('aria-label')!.startsWith('Migrate')) as SVGElement).dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(picked).toEqual(['b']);
    act(() => root.unmount());
  });
});

describe('ResultTable', () => {
  const result: QueryResult = {
    columns: ['id', 'name', 'tags'],
    rows: [{ id: '01J0000000000000000000000A', name: 'Client, "master"', tags: ['a', 'b'] }],
    truncated: false,
    durationMs: 12,
    version: 3,
    status: 'published',
  };

  it('renders rows, and element ids through the caller’s link', () => {
    const root = render(<ResultTable result={result} title="Golden copies" renderElementLink={(id) => <a href={`/e/${id}`}>open</a>} />);
    expect(host.textContent).toContain('1 row · v3 · 12 ms');
    expect(host.querySelector('a')!.getAttribute('href')).toBe('/e/01J0000000000000000000000A');
    expect(host.querySelectorAll('td')[2]!.textContent).toBe('a, b');
    act(() => root.unmount());
  });

  it('shows ids as text without a link renderer, and writes CSV', () => {
    const root = render(<ResultTable result={result} title="x" />);
    expect(host.querySelector('a')).toBeNull();
    expect(toCsv(result)).toBe('id,name,tags\n01J0000000000000000000000A,"Client, ""master""","a, b"');
    act(() => root.unmount());
  });
});
