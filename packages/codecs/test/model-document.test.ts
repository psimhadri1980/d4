import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryModelRepository, planImport, type CommandContext } from '@d4/core';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import {
  CodecError,
  fromSnapshot,
  parseModelDocument,
  stringifyModelDocument,
  toImportInput,
} from '../src';

const reg = new MetamodelRegistry(loadStarterMetamodel());
const ctx: CommandContext = { workspaceId: 'ws1', actor: 'tester' };
const SAMPLE = join(__dirname, '..', '..', '..', 'samples', 'ubs-banking.yaml');

describe('parseModelDocument', () => {
  it('accepts YAML and JSON with shorthands', () => {
    const yaml = `
apiVersion: d4/v1
kind: Model
metadata: { name: t }
elements:
  - { key: a, type: Platform, name: Kafka, lifecycle: LIVE, validFrom: 2026-01-01 }
`;
    const doc = parseModelDocument(yaml);
    expect(toImportInput(doc).elements[0]).toEqual({
      key: 'a',
      type: 'Platform',
      attrs: { name: 'Kafka', lifecycle: 'LIVE' },
      validFrom: '2026-01-01',
    });
    expect(parseModelDocument(JSON.stringify(doc))).toEqual(doc);
  });

  it('reports structural problems with paths', () => {
    expect(() => parseModelDocument('apiVersion: d4/v2\nkind: Model\nmetadata: { name: t }')).toThrow(CodecError);
    try {
      parseModelDocument('apiVersion: d4/v1\nkind: Model\nmetadata: { name: t }\nelements: [{ key: a, type: X, colour: red }]');
    } catch (e) {
      expect((e as CodecError).issues.join()).toMatch(/elements\.0.*colour/);
    }
  });
});

describe('UBS sample', () => {
  const doc = parseModelDocument(readFileSync(SAMPLE, 'utf8'));

  it('is a valid model for the starter metamodel', () => {
    const plan = planImport(reg, ctx, toImportInput(doc), { elements: [], relationships: [] });
    expect(plan.issues).toEqual([]);
    expect(plan.elements.created).toBe(doc.elements.length);
    expect(plan.relationships.created).toBe(doc.relationships.length);
    expect(doc.metadata.disclaimer).toMatch(/Illustrative only/);
  });

  it('round-trips: export → parse → re-import changes nothing', async () => {
    const repo = new InMemoryModelRepository();
    const first = planImport(reg, ctx, toImportInput(doc), { elements: [], relationships: [] });
    await repo.apply(ctx.workspaceId, first.change!);
    const snapshot = { elements: [...repo.elements.values()], relationships: [...repo.relationships.values()] };

    const exported = fromSnapshot(reg, snapshot, { name: 'export' });
    const text = stringifyModelDocument(exported);
    const reparsed = parseModelDocument(text);
    expect(reparsed).toEqual(exported);

    const again = planImport(reg, ctx, toImportInput(reparsed), snapshot);
    expect(again.ok).toBe(true);
    expect(again.elements).toEqual({ created: 0, updated: 0, unchanged: doc.elements.length });
    expect(again.relationships).toEqual({ created: 0, updated: 0, unchanged: doc.relationships.length });
  });

  it('exports deterministic, readable keys ordered by layer', () => {
    const repoless = planImport(reg, ctx, toImportInput(doc), { elements: [], relationships: [] });
    const exported = fromSnapshot(reg, { elements: repoless.change!.elements, relationships: repoless.change!.relationships }, {
      name: 'export',
    });
    expect(exported.elements[0]?.type).toBe('Driver');
    expect(exported.elements.map((e) => e.key)).toContain('data-product-client-master');
    expect(stringifyModelDocument(exported, 'json')).toContain('"apiVersion": "d4/v1"');
  });
});
