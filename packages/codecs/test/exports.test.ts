import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { InMemoryModelRepository } from '@d4/core/testing';
import { planImport, type ModelSnapshot } from '@d4/core';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import { elementsToCsv, parseModelDocument, relationshipsToCsv, toArchiMate, toCypherScript, toImportInput, toMermaid } from '../src';

const reg = new MetamodelRegistry(loadStarterMetamodel());
const SAMPLE = join(__dirname, '..', '..', '..', 'samples', 'ubs-banking.yaml');
let snapshot: ModelSnapshot;
let id: (key: string) => string;

beforeAll(async () => {
  const repo = new InMemoryModelRepository();
  const plan = planImport(reg, { workspaceId: 'ws1', actor: 'tester' }, toImportInput(parseModelDocument(readFileSync(SAMPLE, 'utf8'))), {
    elements: [],
    relationships: [],
  });
  await repo.apply('ws1', plan.change!);
  snapshot = { elements: [...repo.elements.values()], relationships: [...repo.relationships.values()] };
  id = (key) => plan.keyToId[key]!;
});

/** A tiny CSV reader for checking output (quoted cells, doubled quotes). */
function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted && c === '"' && text[i + 1] === '"') {
      cell += '"';
      i++;
    } else if (c === '"') {
      quoted = !quoted;
    } else if (!quoted && c === ',') {
      row.push(cell);
      cell = '';
    } else if (!quoted && c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += c;
    }
  }
  return rows;
}

describe('CSV', () => {
  it('writes every element with its layer and attributes', () => {
    const rows = readCsv(elementsToCsv(snapshot, reg));
    const header = rows[0]!;
    expect(header.slice(0, 9)).toEqual(['id', 'type', 'layer', 'name', 'lifecycle', 'description', 'validFrom', 'validTo', 'scenarioId']);
    expect(rows).toHaveLength(snapshot.elements.length + 1);
    const adr = rows.find((r) => r[0] === id('adr-mdm'))!;
    expect(adr[header.indexOf('status')]).toBe('ACCEPTED');
    expect(adr[header.indexOf('layer')]).toBe('Governance');
  });

  it('writes relationships with end names and validity', () => {
    const rows = readCsv(relationshipsToCsv(snapshot));
    const h = rows[0]!;
    const master = rows.find((r) => r[h.indexOf('fromName')] === 'Legacy Client Database' && r[h.indexOf('role')] === 'MASTER')!;
    expect(master[h.indexOf('toName')]).toBe('Client Master');
    expect(master[h.indexOf('validTo')]).toBe('2027-07-01');
  });
});

describe('Mermaid', () => {
  it('groups by layer and dashes time-bound edges', () => {
    const m = toMermaid(snapshot, reg, 'UBS: "sample"');
    expect(m.split('\n').slice(0, 4)).toEqual(['---', "title: UBS: 'sample'", '---', 'flowchart LR']);
    expect(m).toContain('subgraph Data["Data"]');
    expect(m).toMatch(/-\.->\|"HOLDS MASTER"\|/);
    expect(m).toMatch(/-->\|"ACTS_ON CREATE"\|/);
    expect(m).not.toMatch(/\["[^"]*"[^\]<]*"\]/); // no stray quotes inside labels
  });
});

describe('ArchiMate', () => {
  const ax = () => toArchiMate(snapshot, reg, { name: 'UBS & co <sample>' });

  it('maps types and escapes XML', () => {
    const { xml } = ax();
    expect(xml).toContain('<name xml:lang="en">UBS &amp; co &lt;sample&gt;</name>');
    expect(xml).toContain(`<element identifier="id-${id('app-onboarding')}" xsi:type="ApplicationComponent">`);
    expect(xml).toContain(`<element identifier="id-${id('cap-onboarding')}" xsi:type="Capability">`);
    expect(xml).toContain(`<element identifier="id-${id('div-gf')}" xsi:type="BusinessActor">`);
    expect(xml).toContain(`<element identifier="id-${id('del-migrate')}" xsi:type="Deliverable">`);
  });

  it('uses specific relationships where meaning is clear and reverses assignment', () => {
    const { xml } = ax();
    const rel = (from: string, to: string) => new RegExp(`source="id-${id(from)}" target="id-${id(to)}" xsi:type="(\\w+)"`).exec(xml)?.[1];
    expect(rel('bp-onboarding', 'step-capture')).toBe('Composition');
    expect(rel('step-capture', 'step-kyc')).toBe('Triggering');
    expect(rel('actor-advisor', 'step-capture')).toBe('Assignment');
    expect(rel('ds-legacy-client', 'dp-client')).toBe('Association');
    expect(xml).toMatch(/xsi:type="Access" accessType="Write">\s*<name xml:lang="en">ACTS_ON \(CREATE\)/);
  });

  it('only references exported elements and reports skipped types', () => {
    const { xml, skippedTypes } = ax();
    const defined = new Set([...xml.matchAll(/<element identifier="([^"]+)"/g)].map((m) => m[1]));
    for (const m of xml.matchAll(/source="([^"]+)" target="([^"]+)"/g)) {
      expect(defined.has(m[1])).toBe(true);
      expect(defined.has(m[2])).toBe(true);
    }
    expect(skippedTypes).not.toContain('Application');
    for (const t of skippedTypes) expect(xml).toContain(t);
  });
});

describe('Cypher script', () => {
  it('merges every element and relationship with D4 labels and escaped values', () => {
    const script = toCypherScript(
      {
        elements: [{ ...snapshot.elements[0]!, attrs: { name: "O'Brien \\ data", tags: ['a', 'b'] } }],
        relationships: [],
      },
      reg,
    );
    expect(script).toContain(":begin\nMERGE (n:Element {id: '");
    expect(script).toContain("`name`: 'O\\'Brien \\\\ data'");
    expect(script).toContain("`tags`: ['a', 'b']");
    const full = toCypherScript(snapshot, reg);
    expect(full.match(/^MERGE \(n:Element/gm)).toHaveLength(snapshot.elements.length);
    expect(full.match(/^MATCH \(a:Element/gm)).toHaveLength(snapshot.relationships.length);
    expect(full).toContain('SET n:`Element`:`DataLayer`:`DataProduct`');
  });
});
