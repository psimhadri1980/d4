import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { Lens } from '@d4/core';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import { LensEditor, type LensDraft } from '../src';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const registry = new MetamodelRegistry(loadStarterMetamodel());
let host: HTMLDivElement;
const render = (ui: React.ReactNode) => {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(ui));
  return root;
};
afterEach(() => host?.remove());

const click = (el: Element) => act(() => (el as HTMLElement).click());
const button = (text: string | RegExp) =>
  [...host.querySelectorAll('button')].find((b) => (typeof text === 'string' ? (b.getAttribute('aria-label') ?? b.textContent!.trim()) === text : text.test(b.textContent!)))!;
const field = <T extends HTMLElement>(label: string) => host.querySelector(`#${CSS.escape([...host.querySelectorAll('label')].find((l) => l.textContent === label)!.htmlFor)}`) as T;
const set = (el: HTMLInputElement | HTMLSelectElement, value: string) =>
  act(() => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });

const profile = {
  count: 7,
  links: [
    { relationship: 'HOLDS', direction: 'IN' as const, type: 'DataStore', count: 6 },
    { relationship: 'OWNS', direction: 'IN' as const, type: 'Division', count: 5 },
  ],
  values: { classification: [{ value: 'RESTRICTED', count: 4 }, { value: 'INTERNAL', count: 3 }], lifecycle: [{ value: 'LIVE', count: 7 }] },
};

describe('LensEditor', () => {
  it('starts with "Choose a node type…", picks a contour from the layer groups, and asks the host for its profile', () => {
    const drafts: LensDraft[] = [];
    const root = render(<LensEditor registry={registry} initial={null} lenses={[]} onDraftChange={(d) => drafts.push(d)} onSave={() => {}} onCancel={() => {}} />);
    expect(host.querySelector('[role="dialog"] h2')!.textContent).toBe('New lens');
    expect(button(/Choose a node type/)).toBeDefined();
    expect(button('Save').disabled).toBe(true);
    click(button(/Choose a node type/));
    const pop = host.querySelector('[role="dialog"][aria-label="Contour type"]')!;
    expect([...pop.querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-label'))).toContain('Data');
    // Facet-only types are not offered as a contour.
    expect([...pop.querySelectorAll('.lens-type-name')].map((b) => b.textContent)).not.toContain('KPI');
    set(pop.querySelector('input')!, 'dataprod');
    click([...pop.querySelectorAll('.lens-type-name')].find((b) => b.textContent === 'DataProduct')!);
    expect(drafts.at(-1)!.contour).toEqual({ type: 'DataProduct', attributes: [] });
    act(() => root.unmount());
  });

  it('suggests facets linked in the data, ranks filters by how well they split, and saves the whole lens', () => {
    const saved: unknown[] = [];
    const initial: LensDraft = { name: '', contour: { type: 'DataProduct', attributes: [] }, facets: [], match: 'all', depth: 2, layout: 'hier', view: 'graph' };
    const root = render(<LensEditor registry={registry} initial={initial} lenses={[]} profile={profile} onSave={(d) => saved.push(d)} onCancel={() => {}} />);
    expect(host.textContent).toContain('7 nodes of this type in the data.');
    // Classification splits the data, lifecycle (all LIVE) does not: classification is offered first.
    const offered = [...host.querySelectorAll('.lens-filter-suggest')[0]!.querySelectorAll('button')].map((b) => b.textContent);
    expect(offered[0]).toBe('Classification');
    click(button('Classification'));
    const restricted = [...host.querySelectorAll('.lens-filter-pick label')].find((l) => l.textContent!.startsWith('RESTRICTED'))!;
    expect(restricted.textContent).toBe('RESTRICTED4');
    click(restricted.querySelector('input')!);

    click(button(/HOLDS DataStore/));
    expect(host.querySelector('.lens-facet summary')!.textContent).toBe('Linked to DataStore by HOLDS');
    set(field<HTMLSelectElement>('Link'), 'none');
    expect(host.querySelector('.lens-facet summary')!.textContent).toBe('Not linked to DataStore by HOLDS');

    set(field<HTMLInputElement>('Name'), ' Unheld restricted products ');
    set(field<HTMLSelectElement>('Layout'), 'flow');
    click(button('Save'));
    expect(saved).toEqual([
      expect.objectContaining({
        name: 'Unheld restricted products',
        contour: { type: 'DataProduct', attributes: [{ attribute: 'classification', op: 'in', value: ['RESTRICTED'] }] },
        facets: [{ types: ['DataStore'], relationship: 'HOLDS', direction: 'IN', link: 'none' }],
        layout: 'flow',
      }),
    ]);
    act(() => root.unmount());
  });

  it('shows the preview funnel, sample and load meter; copies a lens with Start from; sets roles', () => {
    const roles: Record<string, string>[] = [];
    const other: Lens = { id: 'x', name: 'Critical applications', contour: { type: 'Application' }, facets: [], match: 'all', depth: 2, layout: 'radial', view: 'graph' };
    const initial: LensDraft = { name: 'Held', contour: { type: 'DataProduct' }, facets: [{ types: ['DataStore'], direction: 'IN', link: 'has' }], match: 'all', depth: 2, layout: 'hier', view: 'graph' };
    const root = render(
      <LensEditor registry={registry} initial={initial} lenses={[other]} preview={{ funnel: [7, 6], sample: ['Account', 'Client Master'] }} onRolesChange={(r) => roles.push(r as never)} onSave={() => {}} onCancel={() => {}} />,
    );
    const preview = host.querySelector('[aria-label="Preview"]')!;
    expect(preview.textContent).toContain('6 roots');
    expect(preview.querySelector('.lens-funnel')!.textContent).toContain('linked to DataStore6 (−1)');
    expect(preview.textContent).toContain('Client Master');
    expect((preview.querySelector('meter') as HTMLMeterElement).value).toBe(6);

    set(field<HTMLSelectElement>('Start from…'), 'x');
    expect(button(/^Application/)).toBeDefined();
    expect(field<HTMLSelectElement>('Layout').value).toBe('radial');
    // The name typed so far stays.
    expect(field<HTMLInputElement>('Name').value).toBe('Held');

    const kpi = host.querySelector('[role="radiogroup"][aria-label="Role of KPI"]')!;
    expect(kpi.querySelector('[aria-checked="true"]')!.textContent).toBe('Facet');
    click([...kpi.querySelectorAll('button')].find((b) => b.textContent === 'Both')!);
    expect(roles).toEqual([{ KPI: 'both' }]);
    act(() => root.unmount());
  });

  it("offers sharing only with write access, and saves a built-in lens as the user's own", () => {
    const root = render(<LensEditor registry={registry} initial={null} lenses={[]} builtIn onSave={() => {}} onCancel={() => {}} />);
    expect([...field<HTMLSelectElement>('Visible to').options].find((o) => o.value === 'workspace')!.disabled).toBe(true);
    expect(button('Save as my lens')).toBeDefined();
    act(() => root.unmount());
  });

  it('shows the lens as text, and applies a line checked against the metamodel (D93)', () => {
    const drafts: LensDraft[] = [];
    const initial: LensDraft = { name: 'Deps', contour: { type: 'Application', attributes: [] }, facets: [], match: 'all', depth: 2, layout: 'hier', view: 'graph' };
    const root = render(<LensEditor registry={registry} initial={initial} lenses={[]} onDraftChange={(d) => drafts.push(d)} onSave={() => {}} onCancel={() => {}} />);
    const text = field<HTMLInputElement>('Write it as text');
    expect(text.value).toBe('Application');
    set(text, 'Application+2 via NOT_A_RELATIONSHIP');
    click(button('Apply'));
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('There is no relationship NOT_A_RELATIONSHIP');
    set(text, '2+Application+2 via dependency where lifecycle=LIVE as flow');
    click(button('Apply'));
    expect(drafts.at(-1)).toMatchObject({
      contour: { type: 'Application', attributes: [{ attribute: 'lifecycle', op: 'eq', value: 'LIVE' }] },
      steps: [{ direction: 'both', kind: 'dependency', repeat: true }],
      depth: 2,
      shape: 'flow',
      disclosure: { initialDepth: 2 },
    });
    expect(text.value).toBe('2+Application+2 via dependency where lifecycle=LIVE as flow');
    act(() => root.unmount());
  });

  it('keeps the steps to the layers ticked, and says where a step reaches none (D95)', () => {
    const drafts: LensDraft[] = [];
    const initial: LensDraft = { name: 'Biz', contour: { type: 'Capability', attributes: [] }, facets: [], match: 'all', depth: 2, layout: 'hier', view: 'graph', steps: [{ direction: 'both', types: ['DataStore'] }] };
    const root = render(<LensEditor registry={registry} initial={initial} lenses={[]} onDraftChange={(d) => drafts.push(d)} onSave={() => {}} onCancel={() => {}} />);
    const layers = [...host.querySelectorAll('fieldset')].find((f) => f.querySelector('legend')!.textContent === 'Keep to layers')!;
    expect(layers.textContent).toContain('None ticked');
    click([...layers.querySelectorAll('label')].find((l) => l.textContent === 'Business')!.querySelector('input')!);
    expect(drafts.at(-1)!.layers).toEqual(['Business']);
    expect(layers.textContent).toContain('Step 1 reaches nothing in these layers');
    act(() => root.unmount());
  });

  it('takes search phrases one per line, and will not save one without a slot at the end (D92)', () => {
    const saved: LensDraft[] = [];
    const initial: LensDraft = { name: 'Impact', contour: { type: 'Application', attributes: [] }, facets: [], match: 'all', depth: 2, layout: 'hier', view: 'graph' };
    const root = render(<LensEditor registry={registry} initial={initial} lenses={[]} onSave={(d) => saved.push(d)} onCancel={() => {}} />);
    const phrases = field<HTMLTextAreaElement>('Search phrases');
    const type = (v: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(phrases, v);
        phrases.dispatchEvent(new Event('input', { bubbles: true }));
      });
    type('impact of $application\nimpact of');
    expect(button('Save').disabled).toBe(true);
    expect(host.textContent).toContain('End each phrase in one slot, such as $name: impact of');
    type('impact of $application\n\nwhat uses $application');
    click(button('Save'));
    expect(saved[0]!.phrases).toEqual(['impact of $application', 'what uses $application']);
    act(() => root.unmount());
  });

  it('takes the roots from a catalog query: pick one, fill its parameters, choose quick filters, save', () => {
    const saved: LensDraft[] = [];
    const queries = [
      { id: 'cq1', title: 'Apps by owner', state: 'published' as const, params: [{ name: 'owner', type: 'string' as const, label: 'Owner' }] },
      { id: 'cq2', title: 'Waiting one', state: 'review' as const, params: [] },
    ];
    const initial: LensDraft = { name: 'By owner', contour: { type: 'Application', attributes: [] }, facets: [], match: 'all', depth: 2, layout: 'hier', view: 'graph' };
    const root = render(<LensEditor registry={registry} initial={initial} lenses={[]} catalogQueries={queries} onSave={(d) => saved.push(d)} onCancel={() => {}} />);
    click([...host.querySelectorAll('input[type="radio"]')].find((r) => r.parentElement!.textContent === 'A catalog query')!);
    // No query chosen yet: nothing to save.
    expect(button('Save').disabled).toBe(true);
    expect(host.textContent).not.toContain('Write a new query');
    set(field<HTMLSelectElement>('Catalog query'), 'cq2');
    expect(host.querySelector('[role="status"]')!.textContent).toContain('Waiting for review');
    set(field<HTMLSelectElement>('Catalog query'), 'cq1');
    set(field<HTMLInputElement>('Owner'), 'cdo');
    click([...host.querySelectorAll('.lens-editor-quick label')].find((l) => l.textContent === 'Hosting')!.querySelector('input')!);
    click(button('Save'));
    expect(saved[0]).toMatchObject({ query: { id: 'cq1', params: { owner: 'cdo' } }, quickFilters: ['hosting'], facets: [] });
    act(() => root.unmount());
  });

  it('lets a Query Author write a new query, which is submitted for review and then chosen', async () => {
    const submitted: unknown[] = [];
    const initial: LensDraft = { name: 'Mine', contour: { type: 'Application', attributes: [] }, facets: [], match: 'all', depth: 2, layout: 'hier', view: 'graph', query: { id: '' } };
    const drafts: LensDraft[] = [];
    const root = render(
      <LensEditor
        registry={registry}
        initial={initial}
        lenses={[]}
        catalogQueries={[]}
        onDraftChange={(d) => drafts.push(d)}
        onSubmitQuery={async (d) => {
          submitted.push(d);
          return submitted.length === 1 ? { errors: ['the query must not write'] } : { id: 'new1' };
        }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    click(button('Write a new query…'));
    set(field<HTMLInputElement>('Query title'), 'Owned apps');
    await act(async () => button('Submit for review').click());
    expect(host.querySelector('.lens-query-errors')!.textContent).toBe('the query must not write');
    await act(async () => button('Submit for review').click());
    expect(submitted.at(-1)).toMatchObject({ title: 'Owned apps', params: [{ name: 'text', type: 'string', default: '' }] });
    expect(drafts.at(-1)!.query).toEqual({ id: 'new1', params: {} });
    // A projection starter (D94) replaces an untouched starter, never the author's own Cypher.
    click(button('Write a new query…'));
    const cypher = field<HTMLTextAreaElement>('Cypher');
    click([...host.querySelectorAll('.lens-query-role label')].find((l) => l.textContent!.startsWith('Projection'))!.querySelector('input')!);
    expect(cypher.value).toContain('RETURN row.node AS node, row.parent AS parent, row.rel AS rel');
    act(() => root.unmount());
  });

  it('picks a pattern: lineage follows one kind up or down; a viewpoint chain is typed steps with column headings (D88)', () => {
    const drafts: LensDraft[] = [];
    const saved: LensDraft[] = [];
    const initial: LensDraft = { name: 'Chain', contour: { type: 'Application' }, facets: [], match: 'all', depth: 2, layout: 'hier', view: 'graph' };
    const firstScreen = { columns: [{ label: 'Start', shown: 3, folded: 0 }, { label: 'Capability', shown: 4, folded: 9 }], truncated: false };
    const root = render(<LensEditor registry={registry} initial={initial} lenses={[]} firstScreen={firstScreen} onDraftChange={(d) => drafts.push(d)} onSave={(d) => saved.push(d)} onCancel={() => {}} />);
    const radio = (name: string) => [...host.querySelectorAll('.lens-pattern')].find((l) => l.querySelector('.lens-pattern-name')!.textContent === name)!.querySelector('input')!;
    expect(radio('Around the roots').checked).toBe(true);

    click(radio('Lineage or impact'));
    expect(drafts.at(-1)).toMatchObject({ shape: 'flow', layout: 'flow', steps: [{ kind: 'flow', direction: 'up', repeat: true }] });
    expect(host.textContent).toContain('Follows ');
    set(field<HTMLSelectElement>('Direction'), 'down');
    expect(drafts.at(-1)!.steps).toEqual([{ kind: 'flow', direction: 'down', repeat: true }]);

    click(radio('Viewpoint chain'));
    const first = drafts.at(-1)!.steps![0]!;
    expect(first.types).toHaveLength(1);
    expect(first.stage).toBe(first.types![0]);
    set(field<HTMLSelectElement>('To'), 'Capability');
    expect(drafts.at(-1)!.steps).toEqual([{ direction: 'both', types: ['Capability'], stage: 'Capability' }]);
    set(field<HTMLSelectElement>('By'), 'REALIZES');
    click(button('Add a step'));
    expect(drafts.at(-1)!.steps).toHaveLength(2);
    expect(drafts.at(-1)!.depth).toBe(2);
    click(button('Remove step 2'));
    expect(drafts.at(-1)!.steps).toEqual([{ direction: 'both', types: ['Capability'], stage: 'Capability', relationships: ['REALIZES'] }]);

    // The live preview counts the first screen per column.
    expect([...host.querySelectorAll('.lens-first-screen li')].map((l) => l.textContent)).toEqual(['Start3', 'Capability4 + 9 folded']);
    click(button('Save'));
    expect(saved[0]).toMatchObject({ shape: 'flow', depth: 1, steps: [{ types: ['Capability'], relationships: ['REALIZES'] }] });

    // A matrix (D90): one step, whose type is the columns.
    click(radio('Matrix'));
    expect(drafts.at(-1)).toMatchObject({ shape: 'matrix', depth: 1 });
    expect(drafts.at(-1)!.steps).toHaveLength(1);
    set(field<HTMLSelectElement>('To'), 'Capability');
    expect(drafts.at(-1)!.steps).toEqual([{ direction: 'both', types: ['Capability'], stage: 'Capability' }]);
    expect(button('Add a step')).toBeUndefined();

    // A landscape (D91): one step down through containment.
    click(radio('Landscape'));
    expect(drafts.at(-1)).toMatchObject({ shape: 'landscape', depth: 1, steps: [{ kind: 'containment', direction: 'down' }] });
    act(() => root.unmount());
  });
});
