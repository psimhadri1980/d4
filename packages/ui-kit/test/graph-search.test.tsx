import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { Lens } from '@d4/core';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import { GraphSearch, type GraphSearchValue } from '../src';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const registry = new MetamodelRegistry(loadStarterMetamodel());
const lenses: Lens[] = [
  { id: 'apps', name: 'Critical applications', contour: { type: 'Application', attributes: [{ attribute: 'criticality', op: 'in', value: ['HIGH'] }] }, facets: [], match: 'all', depth: 2, layout: 'radial', view: 'graph' },
  { id: 'held', name: 'Data products with a store', contour: { type: 'DataProduct' }, facets: [{ types: ['DataStore'], relationship: 'HOLDS', direction: 'IN', link: 'has' }], match: 'all', depth: 1, layout: 'flow', view: 'graph' },
];
let host: HTMLDivElement;
const render = (ui: React.ReactNode) => {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(ui));
  return root;
};
afterEach(() => host?.remove());

const lensPicker = () => host.querySelector('select') as HTMLSelectElement;
const input = () => host.querySelector('input[role="combobox"]') as HTMLInputElement;
const options = () => [...host.querySelectorAll('[role="option"]')].map((o) => o.textContent);
/** Sets a controlled field's value the way React notices. */
const set = (el: HTMLInputElement | HTMLSelectElement, value: string) =>
  act(() => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
const submit = () => act(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
const pick = (text: string) => act(() => (host.querySelector(`[role="option"]`) && [...host.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent!.startsWith(text))!.click()));

describe('GraphSearch (lens smart bar)', () => {
  it('with a lens chosen: the bar names it, shows what it fixes as locked chips, and offers its filters', () => {
    const runs: GraphSearchValue[] = [];
    const root = render(<GraphSearch registry={registry} lenses={lenses} onSearch={(v) => runs.push(v)} />);
    expect(lensPicker().options[0]!.text).toBe('Not sure yet');
    expect([...lensPicker().options].map((o) => o.text)).toContain('Critical applications (Application)');
    set(lensPicker(), 'apps');
    expect(host.querySelector('label[for="' + input().id + '"]')!.textContent).toBe('Name or filter in Critical applications');
    expect([...host.querySelectorAll('.graph-search-chips li.locked')].map((c) => c.textContent)).toEqual(['Application from lens', 'Criticality HIGH from lens']);

    act(() => input().dispatchEvent(new FocusEvent('focus')));
    act(() => input().focus());
    // Criticality is fixed by the lens, so it is not offered again; Hosting is.
    expect(options().some((o) => o!.startsWith('Criticality'))).toBe(false);
    expect(options().slice(0, 3)).toEqual(['Lifecycle IDEA', 'Hosting ON_PREM', 'Time class TOLERATE']);
    set(input(), 'saas');
    expect(options()).toEqual(['Hosting SAAS', 'Use "saas" as a name']);
    pick('Hosting SAAS');
    expect(host.querySelector('button[aria-label="Remove Hosting SAAS"]')).not.toBeNull();
    set(input(), 'core');
    submit();
    expect(runs).toEqual([{ lensId: 'apps', name: 'core', filters: [{ attribute: 'hosting', op: 'eq', value: 'SAAS', label: 'Hosting SAAS' }] }]);
    act(() => root.unmount());
  });

  it('not sure yet: lists the lenses that fit the text, with counts, and picking one moves into it', () => {
    const typed: string[] = [];
    const counts = new Map([
      ['apps', { count: 0, more: false }],
      ['held', { count: 3, more: false }],
    ]);
    const root = render(<GraphSearch registry={registry} lenses={lenses} lensCounts={counts} onUndecidedText={(t) => typed.push(t)} onSearch={() => {}} />);
    act(() => input().focus());
    set(input(), 'client');
    expect(typed.at(-1)).toBe('client');
    // Only the lens with matching roots fits "client"; its count shows.
    expect(options()[0]).toBe('Data products with a store3');
    expect(options()).toContain('Use "client" as a name');
    pick('Data products with a store');
    expect(lensPicker().value).toBe('held');
    expect(host.querySelector('.graph-search-chips')!.textContent).toContain('Linked to DataStore by HOLDS');
    act(() => root.unmount());
  });

  it('Enter after typing searches; the arrow keys pick a suggestion first; Escape only closes the list', () => {
    const runs: GraphSearchValue[] = [];
    const root = render(<GraphSearch registry={registry} lenses={lenses} onSearch={(v) => runs.push(v)} />);
    const key = (k: string) => act(() => input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));
    act(() => input().focus());
    set(input(), 'pay');
    key('Escape');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(input().value).toBe('pay');
    set(input(), 'payments');
    key('Enter');
    // Enter with nothing highlighted submits the form, as a plain search box would.
    submit();
    expect(runs).toEqual([{ lensId: '', name: 'payments', filters: [] }]);
    // The list closed on Search: the first arrow opens it, the next highlights.
    key('ArrowDown');
    expect(host.querySelector('[aria-selected="true"]')).toBeNull();
    key('ArrowDown');
    expect(host.querySelector('[aria-selected="true"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it('needs a lens, a filter or a name, and Clear empties everything', () => {
    const runs: GraphSearchValue[] = [];
    let cleared = 0;
    const root = render(<GraphSearch registry={registry} lenses={lenses} onSearch={(v) => runs.push(v)} onClear={() => cleared++} />);
    submit();
    expect(runs).toEqual([]);
    expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/Choose a lens, add a filter/);
    set(input(), '  pay ');
    submit();
    expect(runs).toEqual([{ lensId: '', name: 'pay', filters: [] }]);
    act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Clear')!.click());
    expect(cleared).toBe(1);
    expect(input().value).toBe('');
    act(() => root.unmount());
  });

  it('a query lens offers only its chosen quick filters, and its parameters as a form sent with the search', () => {
    const byQuery: Lens = {
      id: 'q',
      name: 'Apps by owner',
      contour: { type: 'Application' },
      facets: [],
      match: 'all',
      depth: 1,
      layout: 'hier',
      view: 'graph',
      query: { id: 'cq1', params: { days: 30 } },
      quickFilters: ['hosting', 'appId'],
    };
    const runs: GraphSearchValue[] = [];
    const defs = [
      { name: 'owner', type: 'string' as const, label: 'Owner' },
      { name: 'days', type: 'integer' as const },
    ];
    const root = render(<GraphSearch registry={registry} lenses={[byQuery]} onSearch={(v) => runs.push(v)} queryParams={(id) => (id === 'q' ? defs : undefined)} />);
    set(lensPicker(), 'q');
    expect([...host.querySelectorAll('.graph-search-chips li.locked')].map((c) => c.textContent)).toEqual(['Application from a catalog query from lens']);
    const form = host.querySelector('[role="group"][aria-label="Query parameters"]')!;
    const days = form.querySelectorAll('input')[1] as HTMLInputElement;
    expect(days.value).toBe('30');
    set(form.querySelectorAll('input')[0] as HTMLInputElement, 'cdo');

    act(() => input().focus());
    // Hosting is a pick-list: its values. Criticality is not chosen, so it is not offered.
    expect(options().some((o) => o!.startsWith('Hosting'))).toBe(true);
    expect(options().some((o) => o!.startsWith('Criticality'))).toBe(false);
    // App id is text: the typed text, as "contains".
    set(input(), 'PAY');
    pick('App id contains PAY');
    submit();
    expect(runs.at(-1)).toEqual({
      lensId: 'q',
      name: '',
      filters: [{ attribute: 'appId', op: 'contains', value: 'PAY', label: 'App id contains PAY' }],
      params: { owner: 'cdo', days: 30 },
    });
    act(() => root.unmount());
  });
});
