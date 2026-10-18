import { Workbook, type CellValue } from 'exceljs';
import type { Element, ImportElement, ImportInput, ImportRelationship, ModelSnapshot } from '@d4/core';
import type { AttributeDef, MetamodelRegistry } from '@d4/metamodel';

/**
 * Spreadsheet imports: CSV files and Excel workbooks become tables, each table gets a column
 * mapping (suggested from its headers, adjustable by the user), and mapped rows become an
 * ImportInput for `planImport`. Problems are reported per row and column so users can fix the
 * sheet rather than read a stack trace.
 */

export interface Table {
  /** File name, or "file › sheet" for workbooks. */
  name: string;
  headers: string[];
  rows: string[][];
}

export type ElementField = 'key' | 'id' | 'externalKey' | 'type' | 'name' | 'lifecycle' | 'description' | 'validFrom' | 'validTo' | 'scenarioId' | 'ignore' | `attr:${string}`;
export type RelationshipField = 'id' | 'type' | 'from' | 'to' | 'validFrom' | 'validTo' | 'scenarioId' | 'ignore' | `attr:${string}`;

export type TableMapping =
  | { kind: 'elements'; /** Used when no column is mapped to `type`. */ type?: string; columns: Record<string, ElementField> }
  | { kind: 'relationships'; type?: string; columns: Record<string, RelationshipField> }
  | { kind: 'ignore' };

export interface RowIssue {
  table: string;
  /** 1-based spreadsheet row (the header is row 1). */
  row: number;
  column?: string;
  message: string;
}

// ── Reading ────────────────────────────────────────────────────────────────

/** RFC 4180 CSV (quoted cells, doubled quotes, CRLF), with a UTF-8 BOM tolerated. */
export function parseCsv(name: string, text: string): Table {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += c;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return toTable(name, rows);
}

function toTable(name: string, raw: string[][]): Table {
  const nonEmpty = raw.filter((r) => r.some((c) => c.trim() !== ''));
  const [header = [], ...rows] = nonEmpty;
  const headers = header.map((h, i) => h.trim() || `Column ${i + 1}`);
  return { name, headers, rows: rows.map((r) => headers.map((_, i) => (r[i] ?? '').trim())) };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Excel cells → text: dates as YYYY-MM-DD, formulas as their result, rich text flattened. */
function cellText(v: CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return iso(v);
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result as CellValue);
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return String(v.text);
    if ('error' in v) return '';
    return '';
  }
  return String(v);
}

/** Every non-empty worksheet of an .xlsx workbook. */
export async function readWorkbook(name: string, data: ArrayBuffer | Uint8Array): Promise<Table[]> {
  const wb = new Workbook();
  // exceljs is typed for Node's Buffer; a Uint8Array view works at run time in Node and browsers.
  await wb.xlsx.load((data instanceof Uint8Array ? data : new Uint8Array(data)) as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const tables: Table[] = [];
  wb.eachSheet((sheet) => {
    const raw: string[][] = [];
    sheet.eachRow({ includeEmpty: true }, (r, n) => {
      const values = (r.values as CellValue[]).slice(1);
      raw[n - 1] = values.map(cellText);
    });
    const t = toTable(`${name} › ${sheet.name}`, Array.from(raw, (r) => r ?? []));
    if (t.headers.length) tables.push(t);
  });
  return tables;
}

// ── Writing (Excel export) ─────────────────────────────────────────────────

/** A workbook with Elements and Relationships sheets, in the same columns as the CSV exports. */
export async function toWorkbook(csv: { elements: string; relationships: string }): Promise<Uint8Array> {
  const wb = new Workbook();
  wb.creator = 'D4';
  for (const [title, text] of [['Elements', csv.elements], ['Relationships', csv.relationships]] as const) {
    const t = parseCsv(title, text);
    const sheet = wb.addWorksheet(title, { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.addRow(t.headers).font = { bold: true };
    for (const r of t.rows) sheet.addRow(r);
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, t.headers.length) } };
    sheet.columns.forEach((c, i) => {
      const longest = Math.max(t.headers[i]?.length ?? 0, ...t.rows.slice(0, 200).map((r) => r[i]?.length ?? 0));
      c.width = Math.min(60, Math.max(10, longest + 2));
    });
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

// ── Mapping ────────────────────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const ELEMENT_ALIASES: Record<string, ElementField> = {
  key: 'key',
  ref: 'key',
  id: 'id',
  externalkey: 'externalKey',
  externalid: 'externalKey',
  type: 'type',
  elementtype: 'type',
  name: 'name',
  title: 'name',
  lifecycle: 'lifecycle',
  status: 'lifecycle',
  description: 'description',
  validfrom: 'validFrom',
  from: 'validFrom',
  validto: 'validTo',
  until: 'validTo',
  scenarioid: 'scenarioId',
  layer: 'ignore',
};

const RELATIONSHIP_ALIASES: Record<string, RelationshipField> = {
  id: 'id',
  type: 'type',
  relationship: 'type',
  from: 'from',
  fromid: 'from',
  source: 'from',
  to: 'to',
  toid: 'to',
  target: 'to',
  fromname: 'ignore',
  toname: 'ignore',
  validfrom: 'validFrom',
  validto: 'validTo',
  scenarioid: 'scenarioId',
};

/**
 * Guesses how to read a table: relationships if it has from/to columns, otherwise elements; the
 * element type from a type column, a sheet name that is a type (e.g. "Applications"), or none.
 */
export function suggestMapping(t: Table, reg: MetamodelRegistry): TableMapping {
  const h = t.headers.map(norm);
  const isRel = h.some((x) => ['from', 'fromid', 'source'].includes(x)) && h.some((x) => ['to', 'toid', 'target'].includes(x));
  // "Applications.csv" or "model.xlsx › Applications" → "Applications".
  const sheet = t.name.split('›').at(-1)!.trim().replace(/\.(csv|xlsx|txt)$/i, '');
  if (isRel) {
    const relType = reg.relationshipTypes().find((r) => norm(r.name) === norm(sheet))?.name;
    const attrs = new Set(reg.relationshipTypes().flatMap((r) => r.attributes.map((a) => a.name)));
    const columns: Record<string, RelationshipField> = {};
    t.headers.forEach((header, i) => {
      // A real attribute name wins over an alias.
      const attr = [...attrs].find((a) => norm(a) === h[i]);
      columns[header] = attr ? `attr:${attr}` : (RELATIONSHIP_ALIASES[h[i]!] ?? 'ignore');
    });
    return { kind: 'relationships', ...(relType && { type: relType }), columns };
  }
  const singular = norm(sheet).replace(/(ies)$/, 'y').replace(/s$/, '');
  const sheetType = reg.nodeTypes().find((n) => !n.internal && (norm(n.name) === norm(sheet) || norm(n.name) === singular))?.name;
  const attrDefs = sheetType ? reg.attributesFor(sheetType) : reg.nodeTypes().flatMap((n) => reg.attributesFor(n.name));
  const columns: Record<string, ElementField> = {};
  t.headers.forEach((header, i) => {
    // A real attribute name wins over an alias (e.g. Deliverable.status is not the lifecycle).
    const attr = attrDefs.find((a) => norm(a.name) === h[i]);
    const direct = ELEMENT_ALIASES[h[i]!];
    const core = direct && direct !== 'ignore' && norm(direct) === h[i];
    columns[header] = core ? direct : attr ? (['lifecycle', 'description'].includes(attr.name) ? (attr.name as ElementField) : `attr:${attr.name}`) : (direct ?? 'ignore');
  });
  return { kind: 'elements', ...(sheetType && { type: sheetType }), columns };
}

// ── Conversion ─────────────────────────────────────────────────────────────

function coerce(def: AttributeDef, raw: string, enums: Record<string, string[]>): { value?: unknown; error?: string } {
  const v = raw.trim();
  switch (def.type) {
    case 'number':
    case 'integer': {
      const n = Number(v.replace(/[\s,](?=\d{3}\b)/g, ''));
      if (!Number.isFinite(n) || (def.type === 'integer' && !Number.isInteger(n))) return { error: `"${v}" is not ${def.type === 'integer' ? 'a whole number' : 'a number'}` };
      return { value: n };
    }
    case 'boolean': {
      const b = norm(v);
      if (['true', 'yes', 'y', '1', 'x'].includes(b)) return { value: true };
      if (['false', 'no', 'n', '0'].includes(b)) return { value: false };
      return { error: `"${v}" is not yes/no` };
    }
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) ? { value: v } : { error: `"${v}" is not a date (YYYY-MM-DD)` };
    case 'string[]':
      return { value: v.split(/[;,]/).map((x) => x.trim()).filter(Boolean) };
    case 'enum': {
      const allowed = enums[def.enum ?? ''] ?? [];
      const hit = allowed.find((a) => norm(a) === norm(v));
      return hit ? { value: hit } : { error: `"${v}" is not one of ${allowed.join(', ')}` };
    }
    default:
      return { value: v };
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Resolver {
  (ref: string): { id?: string; error?: string };
}

/**
 * Element references in relationship rows: a key from the elements being imported, then an
 * existing element's id, externalKey or name ("Type: Name" when a name is ambiguous).
 */
function resolver(keys: Map<string, ImportElement>, existing: Element[]): Resolver {
  const byId = new Map(existing.map((e) => [e.id, e]));
  const byExternal = new Map(existing.filter((e) => e.attrs['externalKey']).map((e) => [String(e.attrs['externalKey']), e]));
  const byName = new Map<string, Element[]>();
  for (const e of existing) {
    const k = norm(String(e.attrs['name'] ?? ''));
    byName.set(k, [...(byName.get(k) ?? []), e]);
  }
  const importedByName = new Map<string, string[]>();
  for (const [key, e] of keys) {
    const k = norm(String(e.attrs['name'] ?? ''));
    importedByName.set(k, [...(importedByName.get(k) ?? []), key]);
  }
  return (ref) => {
    const r = ref.trim();
    if (!r) return { error: 'empty reference' };
    if (keys.has(r)) return { id: r };
    if (byId.has(r)) return { id: r };
    if (byExternal.has(r)) return { id: byExternal.get(r)!.id };
    const typed = /^([A-Za-z][\w]*)\s*:\s*(.+)$/.exec(r);
    const name = norm(typed ? typed[2]! : r);
    const imported = (importedByName.get(name) ?? []).filter((k) => !typed || keys.get(k)!.type === typed[1]);
    if (imported.length === 1) return { id: imported[0]! };
    const found = (byName.get(name) ?? []).filter((e) => !typed || e.type === typed[1]);
    if (found.length === 1) return { id: found[0]!.id };
    if (found.length + imported.length > 1) return { error: `"${r}" matches several elements; write it as "Type: Name"` };
    return { error: `no element "${r}" in this import or the workspace` };
  };
}

export interface TabularResult {
  input: ImportInput;
  issues: RowIssue[];
  /** Rows per table that produced an element or relationship. */
  used: Record<string, number>;
}

/**
 * Converts mapped tables to an ImportInput. Element tables are read first so relationship rows
 * can refer to elements in the same upload. Rows with problems are skipped and reported.
 */
export function tablesToImport(tables: { table: Table; mapping: TableMapping }[], reg: MetamodelRegistry, existing: ModelSnapshot): TabularResult {
  const issues: RowIssue[] = [];
  const used: Record<string, number> = {};
  const enums = reg.metamodel.enums;
  const elements = new Map<string, ImportElement>();
  const relationships: ImportRelationship[] = [];
  let seq = 0;

  const cellsOf = (t: Table, row: string[], columns: Record<string, string>) => {
    const out = new Map<string, { value: string; column: string }>();
    t.headers.forEach((h, i) => {
      const field = columns[h];
      if (field && field !== 'ignore' && row[i]) out.set(field, { value: row[i]!, column: h });
    });
    return out;
  };

  for (const { table: t, mapping: m } of tables) {
    if (m.kind !== 'elements') continue;
    used[t.name] = 0;
    t.rows.forEach((row, i) => {
      const at = { table: t.name, row: i + 2 };
      const c = cellsOf(t, row, m.columns);
      const type = c.get('type')?.value ?? m.type;
      const def = type ? reg.nodeType(reg.nodeTypes().find((n) => norm(n.name) === norm(type))?.name ?? type) : undefined;
      if (!def) return void issues.push({ ...at, ...(c.get('type') && { column: c.get('type')!.column }), message: type ? `unknown element type "${type}"` : 'no type: map a Type column or choose a type for the sheet' });
      const name = c.get('name')?.value;
      if (!name) return void issues.push({ ...at, message: 'no name' });
      const attrs: Record<string, unknown> = { name };
      let bad = false;
      const defs = reg.attributesFor(def.name);
      for (const [field, cell] of c) {
        const attrName = field === 'lifecycle' || field === 'description' ? field : field.startsWith('attr:') ? field.slice(5) : null;
        if (!attrName) continue;
        const ad = defs.find((d) => d.name === attrName);
        if (!ad) {
          issues.push({ ...at, column: cell.column, message: `${def.name} has no attribute "${attrName}"` });
          bad = true;
          continue;
        }
        const r = coerce(ad, cell.value, enums);
        if (r.error) {
          issues.push({ ...at, column: cell.column, message: r.error });
          bad = true;
        } else attrs[attrName] = r.value;
      }
      for (const f of ['validFrom', 'validTo'] as const) {
        const v = c.get(f);
        if (v && !DATE.test(v.value)) {
          issues.push({ ...at, column: v.column, message: `"${v.value}" is not a date (YYYY-MM-DD)` });
          bad = true;
        }
      }
      if (bad) return;
      const key = c.get('key')?.value ?? `row-${++seq}`;
      if (elements.has(key)) return void issues.push({ ...at, column: c.get('key')?.column, message: `key "${key}" is used twice` });
      const externalKey = c.get('externalKey')?.value;
      if (externalKey) attrs['externalKey'] = externalKey;
      elements.set(key, {
        key,
        type: def.name,
        attrs,
        ...(c.get('id') && { id: c.get('id')!.value }),
        ...(c.get('validFrom') && { validFrom: c.get('validFrom')!.value }),
        ...(c.get('validTo') && { validTo: c.get('validTo')!.value }),
        ...(c.get('scenarioId') && { scenarioId: c.get('scenarioId')!.value }),
      });
      used[t.name]!++;
    });
  }

  const resolve = resolver(elements, existing.elements);
  for (const { table: t, mapping: m } of tables) {
    if (m.kind !== 'relationships') continue;
    used[t.name] = 0;
    t.rows.forEach((row, i) => {
      const at = { table: t.name, row: i + 2 };
      const c = cellsOf(t, row, m.columns);
      const typeRaw = c.get('type')?.value ?? m.type;
      const relType = typeRaw ? reg.relationshipTypes().find((r) => norm(r.name) === norm(typeRaw))?.name : undefined;
      if (!relType) return void issues.push({ ...at, message: typeRaw ? `unknown relationship type "${typeRaw}"` : 'no type: map a Type column or choose a type for the sheet' });
      const ends: string[] = [];
      for (const end of ['from', 'to'] as const) {
        const cell = c.get(end);
        const r = cell ? resolve(cell.value) : { error: `no "${end}" column value` };
        if (r.error) issues.push({ ...at, ...(cell && { column: cell.column }), message: r.error });
        else ends.push(r.id!);
      }
      if (ends.length < 2) return;
      const attrs: Record<string, unknown> = {};
      const defs = reg.relationshipType(relType)!.attributes;
      let bad = false;
      for (const [field, cell] of c) {
        if (!field.startsWith('attr:')) continue;
        const ad = defs.find((d) => d.name === field.slice(5));
        if (!ad) continue; // attribute of another relationship type in a mixed sheet
        const r = coerce(ad, cell.value, enums);
        if (r.error) {
          issues.push({ ...at, column: cell.column, message: r.error });
          bad = true;
        } else attrs[ad.name] = r.value;
      }
      if (bad) return;
      relationships.push({
        type: relType,
        from: ends[0]!,
        to: ends[1]!,
        ...(Object.keys(attrs).length && { attrs }),
        ...(c.get('id') && { id: c.get('id')!.value }),
        ...(c.get('validFrom') && { validFrom: c.get('validFrom')!.value }),
        ...(c.get('validTo') && { validTo: c.get('validTo')!.value }),
        ...(c.get('scenarioId') && { scenarioId: c.get('scenarioId')!.value }),
      });
      used[t.name]!++;
    });
  }
  return { input: { elements: [...elements.values()], relationships }, issues, used };
}
