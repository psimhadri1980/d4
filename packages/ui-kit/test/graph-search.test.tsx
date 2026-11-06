import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import { GraphSearch, type GraphSearchValue } from '../src';

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

const field = <T extends HTMLElement>(label: string) => {
  const l = [...host.querySelectorAll('label')].find((x) => x.textContent === label)!;
  return host.querySelector(`#${CSS.escape(l.htmlFor)}`) as T;
};
/** Sets a controlled field's value the way React notices. */
const set = (el: HTMLInputElement | HTMLSelectElement, value: string) =>
  act(() => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
const submit = () => act(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

describe('GraphSearch', () => {
  it('offers the metamodel layers and types; a layer narrows the types, a type sets its layer', () => {
    const root = render(<GraphSearch registry={registry} onSearch={() => {}} />);
    const layer = field<HTMLSelectElement>('Layer');
    const type = field<HTMLSelectElement>('Type');
    expect(layer.options[0]!.text).toBe('Any layer');
    expect([...layer.options].map((o) => o.value)).toContain('Data');
    set(layer, 'Data');
    const dataTypes = [...type.options].map((o) => o.value).filter(Boolean);
    expect(dataTypes.length).toBeGreaterThan(0);
    expect(dataTypes.every((t) => registry.nodeType(t)!.layer === 'Data')).toBe(true);
    set(layer, '');
    set(type, 'Application');
    expect(layer.value).toBe(registry.nodeType('Application')!.layer);
    // Another layer drops a type that does not belong to it.
    set(layer, 'Data');
    expect(type.value).toBe('');
    act(() => root.unmount());
  });

  it('searches only on Search or Enter, with at least one field, and clears', () => {
    const runs: GraphSearchValue[] = [];
    let cleared = 0;
    const root = render(<GraphSearch registry={registry} onSearch={(v) => runs.push(v)} onClear={() => cleared++} />);
    submit();
    expect(runs).toEqual([]);
    expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/Choose a layer or a type/);
    set(field<HTMLInputElement>('Name'), '  pay ');
    expect(runs).toEqual([]);
    submit();
    expect(runs).toEqual([{ layer: '', type: '', name: 'pay' }]);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Clear')!.click());
    expect(cleared).toBe(1);
    expect(field<HTMLInputElement>('Name').value).toBe('');
    act(() => root.unmount());
  });
});
