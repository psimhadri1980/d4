import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Workbook } from 'exceljs';
import { beforeAll, describe, expect, it } from 'vitest';
import { InMemoryModelRepository } from '@d4/core/testing';
import { planImport, type ModelSnapshot } from '@d4/core';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import {
  elementsToCsv,
  parseCsv,
  parseModelDocument,
  readWorkbook,
  relationshipsToCsv,
  suggestMapping,
  tablesToImport,
  toImportInput,
  toWorkbook,
  type Table,
} from '../src';

const reg = new MetamodelRegistry(loadStarterMetamodel());
const ctx = { workspaceId: 'ws1', actor: 'tester' };
const SAMPLE = join(__dirname, '..', '..', '..', 'samples', 'ubs-banking.yaml');
let snapshot: ModelSnapshot;

beforeAll(async () => {
  const repo = new InMemoryModelRepository();
  const plan = planImport(reg, ctx, toImportInput(parseModelDocument(readFileSync(SAMPLE, 'utf8'))), { elements: [], relationships: [] });
  await repo.apply('ws1', plan.change!);
  snapshot = { elements: [...repo.elements.values()], relationships: [...repo.relationships.values()] };
});

const mapped = (tables: Table[]) => tables.map((table) => ({ table, mapping: suggestMapping(table, reg) }));

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, CRLF, a BOM and blank lines', () => {
    const t = parseCsv('x.csv', '﻿name,notes\r\n"Core, Banking","said ""hi"""\r\n\r\nLedger,\n');
    expect(t).toEqual({ name: 'x.csv', headers: ['name', 'notes'], rows: [['Core, Banking', 'said "hi"'], ['Ledger', '']] });
  });
});

describe('round trip', () => {
  it('re-importing exported CSVs changes nothing', () => {
    const tables = [parseCsv('elements.csv', elementsToCsv(snapshot, reg)), parseCsv('relationships.csv', relationshipsToCsv(snapshot))];
    const m = mapped(tables);
    expect(m.map((x) => x.mapping.kind)).toEqual(['elements', 'relationships']);
    const r = tablesToImport(m, reg, snapshot);
    expect(r.issues).toEqual([]);
    const plan = planImport(reg, ctx, r.input, snapshot);
    expect(plan.issues).toEqual([]);
    expect(plan.elements).toEqual({ created: 0, updated: 0, unchanged: snapshot.elements.length });
    expect(plan.relationships).toEqual({ created: 0, updated: 0, unchanged: snapshot.relationships.length });
  });

  it('re-importing an exported workbook changes nothing', async () => {
    const xlsx = await toWorkbook({ elements: elementsToCsv(snapshot, reg), relationships: relationshipsToCsv(snapshot) });
    const tables = await readWorkbook('model.xlsx', xlsx);
    expect(tables.map((t) => t.name)).toEqual(['model.xlsx › Elements', 'model.xlsx › Relationships']);
    const plan = planImport(reg, ctx, tablesToImport(mapped(tables), reg, snapshot).input, snapshot);
    expect(plan.elements.unchanged).toBe(snapshot.elements.length);
    expect(plan.relationships.unchanged).toBe(snapshot.relationships.length);
  });
});

describe('a hand-made sheet', () => {
  const apps = parseCsv(
    'Applications.csv',
    ['Name,Criticality,Hosting,timeClass,Description', 'Payments Gateway,mission critical,saas,invest,Card and SEPA payments', 'Broken App,very high,saas,,'].join('\n'),
  );

  it('takes the type from the sheet name and matches enum values loosely', () => {
    const m = suggestMapping(apps, reg);
    expect(m).toMatchObject({ kind: 'elements', type: 'Application', columns: { Name: 'name', Criticality: 'attr:criticality', timeClass: 'attr:timeClass', Description: 'description' } });
    const r = tablesToImport([{ table: apps, mapping: m }], reg, snapshot);
    expect(r.input.elements).toEqual([
      expect.objectContaining({ type: 'Application', attrs: { name: 'Payments Gateway', criticality: 'MISSION_CRITICAL', hosting: 'SAAS', timeClass: 'INVEST', description: 'Card and SEPA payments' } }),
    ]);
    expect(r.issues).toEqual([{ table: 'Applications.csv', row: 3, column: 'Criticality', message: expect.stringMatching(/^"very high" is not one of LOW, MEDIUM/) }]);
  });

  it('links by name, asks for "Type: Name" when a name is ambiguous, and reports unknown ones', () => {
    const rels = parseCsv(
      'links.csv',
      [
        'type,from,to',
        'REALIZES,Payments Gateway,Client Onboarding',
        'REALIZES,Payments Gateway,Capability: Client Onboarding',
        'REALIZES,Payments Gateway,Nowhere',
        'HOLDS,Risk Data Mart,Client Master',
      ].join('\n'),
    );
    const r = tablesToImport(mapped([apps, rels]), reg, snapshot);
    expect(r.issues.filter((i) => i.table === 'links.csv')).toEqual([
      { table: 'links.csv', row: 2, column: 'to', message: '"Client Onboarding" matches several elements; write it as "Type: Name"' },
      { table: 'links.csv', row: 4, column: 'to', message: 'no element "Nowhere" in this import or the workspace' },
    ]);
    expect(r.input.relationships).toHaveLength(2);
    const realizes = r.input.relationships.find((x) => x.type === 'REALIZES')!;
    expect(realizes.from).toBe(r.input.elements[0]!.key);
    // A new HOLDS needs a role: the planner reports it rather than writing an invalid relationship.
    // (MDM → Client Master would match the existing HOLDS, which the import leaves unchanged.)
    const plan = planImport(reg, ctx, r.input, snapshot);
    expect(plan.ok).toBe(false);
    expect(plan.issues.map((i) => i.message).join(' ')).toMatch(/role/);
  });

  it('reports unknown types, bad values, missing names and duplicate keys', () => {
    const t = parseCsv('mixed.csv', ['key,type,name,level', 'a,Capability,Lending,two', 'b,Spaceship,Enterprise,', 'c,Capability,,', 'a,Capability,Deposits,1'].join('\n'));
    const r = tablesToImport(mapped([t]), reg, snapshot);
    expect(r.issues.map((i) => `${i.row}:${i.column ?? ''}:${i.message}`)).toEqual([
      '2:level:"two" is not a whole number',
      '3:type:unknown element type "Spaceship"',
      '4::no name',
    ]);
    // Row 5 reuses key "a", but row 2 was skipped, so the key is free.
    expect(r.input.elements.map((e) => e.attrs['name'])).toEqual(['Deposits']);
    expect(r.used).toEqual({ 'mixed.csv': 1 });
  });
});

describe('readWorkbook', () => {
  it('reads typed cells: dates, numbers, booleans and formulas', async () => {
    const wb = new Workbook();
    const s = wb.addWorksheet('Platforms');
    s.addRow(['Name', 'validFrom', 'Count']);
    s.addRow(['Kafka', new Date(Date.UTC(2027, 0, 15)), 3]);
    s.addRow(['Snowflake', new Date(Date.UTC(2027, 5, 1)), { formula: '1+1', result: 2 }]);
    const [t] = await readWorkbook('p.xlsx', new Uint8Array(await wb.xlsx.writeBuffer()));
    expect(t).toEqual({ name: 'p.xlsx › Platforms', headers: ['Name', 'validFrom', 'Count'], rows: [['Kafka', '2027-01-15', '3'], ['Snowflake', '2027-06-01', '2']] });
    expect(suggestMapping(t!, reg)).toMatchObject({ kind: 'elements', type: 'Platform', columns: { validFrom: 'validFrom' } });
  });
});
