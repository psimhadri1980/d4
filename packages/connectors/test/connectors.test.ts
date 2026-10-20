import { describe, expect, it } from 'vitest';
import type { Element, ModelSnapshot } from '@d4/core';
import { fetchJsonRecords, get, HttpJsonConfig, Mapping, mapRecords, planSync, type SyncedItem } from '../src';

const mapping = Mapping.parse({
  itemsPath: 'result',
  entities: [
    {
      when: { path: 'class', equals: 'app' },
      type: { value: 'Application' },
      id: 'sys_id',
      name: 'name',
      attrs: { lifecycle: { path: 'state', map: { live: 'LIVE', retired: 'RETIRED' } }, description: { path: 'desc' } },
      relationships: [{ type: 'RUNS_ON', to: 'hosts' }],
    },
    { when: { path: 'class', equals: 'platform' }, type: { value: 'Platform' }, id: 'sys_id', name: 'name' },
  ],
});
const records = [
  { sys_id: 'a1', class: 'app', name: 'CRM', state: 'live', desc: 'Sales', hosts: ['p1'] },
  { sys_id: 'p1', class: 'platform', name: 'Kubernetes' },
  { sys_id: 'a2', class: 'app', name: 'Ledger', state: 'unknown', hosts: 'p9' },
  { class: 'app', name: 'No id' },
  { sys_id: 'x', class: 'other', name: 'Ignored' },
];

describe('mapping', () => {
  it('reads dotted paths with indexes', () => {
    expect(get({ a: { b: [{ c: 1 }] } }, 'a.b[0].c')).toBe(1);
    expect(get({ a: null }, 'a.b')).toBeUndefined();
    expect(get([1, 2], '')).toEqual([1, 2]);
    expect(() => Mapping.parse({ entities: [{ type: { value: 'X' }, id: 'a..b', name: 'n' }] })).toThrow(/dotted path/);
  });

  it('turns records into elements with external keys, mapped values and relationships', () => {
    const r = mapRecords('cmdb', mapping, records);
    expect(r.items.map((i) => [i.externalKey, i.element.type, i.element.attrs['name']])).toEqual([
      ['cmdb:a1', 'Application', 'CRM'],
      ['cmdb:p1', 'Platform', 'Kubernetes'],
      ['cmdb:a2', 'Application', 'Ledger'],
    ]);
    expect(r.items[0]!.element.attrs).toMatchObject({ externalKey: 'cmdb:a1', lifecycle: 'LIVE', description: 'Sales' });
    // An unmapped value is left out rather than guessed.
    expect(r.items[2]!.element.attrs['lifecycle']).toBeUndefined();
    expect(r.relationships).toEqual([
      { type: 'RUNS_ON', from: 'cmdb:a1', to: 'cmdb:p1' },
      { type: 'RUNS_ON', from: 'cmdb:a2', to: 'cmdb:p9' },
    ]);
    expect(r.problems).toEqual([{ record: 3, message: "no id at 'sys_id'" }]);
  });

  it('hashes mapped values, so unrelated source fields do not count as changes', () => {
    const a = mapRecords('cmdb', mapping, [records[1]]).items[0]!.hash;
    const b = mapRecords('cmdb', mapping, [{ ...records[1], updated_on: 'today' }]).items[0]!.hash;
    const c = mapRecords('cmdb', mapping, [{ ...records[1], name: 'K8s' }]).items[0]!.hash;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('fetchJsonRecords', () => {
  const pages: Record<string, unknown> = {
    'https://src.test/api/items': { result: [{ id: 1 }, { id: 2 }], links: { next: '/api/items?page=2' } },
    'https://src.test/api/items?page=2': { result: [{ id: 3 }], links: {} },
  };
  const fake = (seen: { url: string; headers: Record<string, string> }[]) =>
    (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      const body = pages[url];
      return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;

  it('follows next links, sends auth and collects every record', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const config = HttpJsonConfig.parse({ url: 'https://src.test/api/items', auth: 'basic', nextPath: 'links.next' });
    const r = await fetchJsonRecords(config, 'svc:pw', 'result', { fetch: fake(seen), checkUrl: async () => null });
    expect(r).toEqual({ records: [{ id: 1 }, { id: 2 }, { id: 3 }], pages: 2 });
    expect(seen.map((s) => s.url)).toEqual(['https://src.test/api/items', 'https://src.test/api/items?page=2']);
    expect(seen[0]!.headers['authorization']).toBe(`Basic ${Buffer.from('svc:pw').toString('base64')}`);
  });

  it('refuses blocked URLs, HTTP errors, missing secrets and bodies without a record list', async () => {
    const deps = { fetch: fake([]), checkUrl: async (u: string) => (u.includes('10.0.0.1') ? 'must not point to a private or local address' : null) };
    await expect(fetchJsonRecords(HttpJsonConfig.parse({ url: 'https://10.0.0.1/x' }), null, '', deps)).rejects.toThrow('Source URL must not point to a private or local address');
    await expect(fetchJsonRecords(HttpJsonConfig.parse({ url: 'https://src.test/missing' }), null, '', deps)).rejects.toThrow('answered HTTP 404');
    await expect(fetchJsonRecords(HttpJsonConfig.parse({ url: 'https://src.test/api/items', auth: 'bearer' }), null, '', deps)).rejects.toThrow(/needs a token/);
    await expect(fetchJsonRecords(HttpJsonConfig.parse({ url: 'https://src.test/api/items' }), null, 'rows', deps)).rejects.toThrow("No list of records at 'rows'");
  });
});

describe('planSync', () => {
  const el = (id: string, externalKey: string, version = 1, extra: Partial<Element> = {}): Element =>
    ({ id, type: 'Application', attrs: { name: id, externalKey }, version, deleted: false, workspaceId: 'w', validFrom: null, validTo: null, scenarioId: null, createdAt: '', createdBy: '', updatedAt: '', updatedBy: '', ...extra }) as Element;
  const snapshot = (...elements: Element[]): ModelSnapshot => ({ elements, relationships: [] });
  const mapped = mapRecords('cmdb', mapping, records.slice(0, 3));
  const hashOf = (key: string) => mapped.items.find((i) => i.externalKey === key)!.hash;

  it('first sync: everything is new; ends missing everywhere are reported', () => {
    const plan = planSync(mapped, snapshot(), [], 'skip');
    expect(plan.input.elements.map((e) => e.key)).toEqual(['cmdb:a1', 'cmdb:p1', 'cmdb:a2']);
    expect(plan.input.relationships).toEqual([{ type: 'RUNS_ON', from: 'cmdb:a1', to: 'cmdb:p1' }]);
    expect(plan.unresolved).toEqual([{ type: 'RUNS_ON', from: 'cmdb:a2', to: 'cmdb:p9' }]);
  });

  it('later syncs: unchanged items stay out, D4 edits are protected, deletions respected, gaps reported', () => {
    const previous: SyncedItem[] = [
      { externalKey: 'cmdb:a1', elementId: 'E1', syncedVersion: 1, sourceHash: 'old' }, // source changed; D4 edited → conflict
      { externalKey: 'cmdb:p1', elementId: 'E2', syncedVersion: 1, sourceHash: hashOf('cmdb:p1') }, // unchanged
      { externalKey: 'cmdb:a2', elementId: 'E3', syncedVersion: 2, sourceHash: 'old' }, // source changed only → update
      { externalKey: 'cmdb:gone', elementId: 'E4', syncedVersion: 1, sourceHash: 'x' }, // not in source any more
    ];
    const snap = snapshot(el('E1', 'cmdb:a1', 3), el('E2', 'cmdb:p1', 1), el('E3', 'cmdb:a2', 2), el('E4', 'cmdb:gone', 1));
    const plan = planSync(mapped, snap, previous, 'skip');
    expect(plan.input.elements.map((e) => e.key)).toEqual(['cmdb:a2']);
    expect(plan.unchanged).toEqual(['cmdb:p1']);
    expect(plan.conflicts).toEqual([{ externalKey: 'cmdb:a1', elementId: 'E1', name: 'E1', applied: false }]);
    // Relationship ends outside the import resolve to the existing elements.
    expect(plan.input.relationships).toEqual([{ type: 'RUNS_ON', from: 'E1', to: 'E2' }]);
    expect(plan.missingInSource).toEqual([{ externalKey: 'cmdb:gone', elementId: 'E4' }]);

    const wins = planSync(mapped, snap, previous, 'source-wins');
    expect(wins.conflicts[0]!.applied).toBe(true);
    expect(wins.input.elements.map((e) => e.key)).toEqual(['cmdb:a1', 'cmdb:a2']);

    const afterDelete = planSync(mapped, snapshot(el('E1', 'cmdb:a1', 2, { deleted: true }), el('E2', 'cmdb:p1')), previous, 'skip');
    expect(afterDelete.deletedInD4).toEqual(['cmdb:a1']);
    expect(afterDelete.input.elements.map((e) => e.key)).not.toContain('cmdb:a1');
    expect(afterDelete.unresolved.find((u) => u.from === 'cmdb:a1')).toBeUndefined();
  });
});
