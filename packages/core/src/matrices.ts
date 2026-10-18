import type { Element, Relationship } from './types';
import { overlaps } from './validity';

/**
 * Matrices over a part of the graph: rows × columns with the values that connect them, plus
 * findings (gaps the matrix makes visible). Inputs are the elements and relationships of the
 * types a matrix needs, already filtered to a model view.
 */
export const MATRIX_KINDS = ['crud', 'capability-application', 'data-store-roles', 'lifecycle'] as const;
export type MatrixKind = (typeof MATRIX_KINDS)[number];

export interface MatrixAxisItem {
  id: string;
  name: string;
  type: string;
  /** Row grouping, e.g. the business process of a step or the layer of a type. */
  group?: string;
}

export interface Matrix {
  kind: MatrixKind;
  title: string;
  rowLabel: string;
  columnLabel: string;
  rows: MatrixAxisItem[];
  columns: MatrixAxisItem[];
  /** Sparse: only non-empty cells. Values are ordered (e.g. C, R, U, I, D). */
  cells: { row: string; column: string; values: string[] }[];
  /** Values that can appear, in display order (for legends and colours). */
  values: string[];
  findings: string[];
}

export interface MatrixInput {
  elements: Element[];
  relationships: Relationship[];
}

const nameOf = (e: Element | undefined) => (e ? String(e.attrs['name'] ?? e.id) : '');
const byName = (a: MatrixAxisItem, b: MatrixAxisItem) => (a.group ?? '').localeCompare(b.group ?? '') || a.name.localeCompare(b.name);
const axis = (e: Element, group?: string): MatrixAxisItem => ({ id: e.id, name: nameOf(e), type: e.type, ...(group !== undefined && { group }) });

function cellsFrom(pairs: { row: string; column: string; value: string }[], order: string[]) {
  const map = new Map<string, Set<string>>();
  for (const p of pairs) {
    const k = `${p.row}\u0000${p.column}`;
    map.set(k, (map.get(k) ?? new Set()).add(p.value));
  }
  const rank = (v: string) => (order.indexOf(v) === -1 ? order.length : order.indexOf(v));
  return [...map].map(([k, vs]) => {
    const [row, column] = k.split('\u0000') as [string, string];
    return { row, column, values: [...vs].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)) };
  });
}

const OPS = ['CREATE', 'READ', 'UPDATE', 'INACTIVATE', 'DELETE'];

/** Process steps × data they act on, with CRUD-I operations. Steps are grouped by process. */
export function crudMatrix(g: MatrixInput): Matrix {
  const els = new Map(g.elements.map((e) => [e.id, e]));
  const acts = g.relationships.filter((r) => r.type === 'ACTS_ON');
  const process = new Map<string, { name: string; seq: number }>();
  for (const r of g.relationships.filter((x) => x.type === 'HAS_STEP')) {
    process.set(r.toId, { name: nameOf(els.get(r.fromId)), seq: Number(r.attrs['seq'] ?? 0) });
  }
  const stepIds = [...new Set(acts.map((r) => r.fromId))].filter((id) => els.has(id));
  const rows = stepIds
    .map((id) => axis(els.get(id)!, process.get(id)?.name ?? '(no process)'))
    .sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || (process.get(a.id)?.seq ?? 0) - (process.get(b.id)?.seq ?? 0) || a.name.localeCompare(b.name));
  const columns = [...new Set(acts.map((r) => r.toId))].filter((id) => els.has(id)).map((id) => axis(els.get(id)!)).sort(byName);
  const cells = cellsFrom(
    acts.filter((r) => els.has(r.fromId) && els.has(r.toId)).map((r) => ({ row: r.fromId, column: r.toId, value: String(r.attrs['op']) })),
    OPS,
  );
  const findings: string[] = [];
  for (const c of columns) {
    const ops = new Set(cells.filter((x) => x.column === c.id).flatMap((x) => x.values));
    if (!ops.has('CREATE')) findings.push(`${c.name}: no step creates it`);
    if (ops.has('READ') && !ops.has('UPDATE') && !ops.has('CREATE')) findings.push(`${c.name}: read but never maintained`);
  }
  return { kind: 'crud', title: 'CRUD-I matrix', rowLabel: 'Process step', columnLabel: 'Data', rows, columns, cells, values: OPS, findings };
}

/** Capabilities × the applications realizing them; cells show the application's TIME class. */
export function capabilityApplicationMatrix(g: MatrixInput): Matrix {
  const els = new Map(g.elements.map((e) => [e.id, e]));
  const realizes = g.relationships.filter((r) => r.type === 'REALIZES' && els.get(r.fromId)?.type === 'Application');
  const capabilities = g.elements.filter((e) => e.type === 'Capability');
  const rows = capabilities.map((c) => axis(c, c.attrs['level'] ? `Level ${String(c.attrs['level'])}` : '')).sort(byName);
  const apps = [...new Set(realizes.map((r) => r.fromId))].map((id) => axis(els.get(id)!)).sort(byName);
  const cells = cellsFrom(
    realizes
      .filter((r) => els.get(r.toId)?.type === 'Capability')
      .map((r) => ({ row: r.toId, column: r.fromId, value: String(els.get(r.fromId)!.attrs['timeClass'] ?? 'REALIZES') })),
    ['INVEST', 'TOLERATE', 'MIGRATE', 'ELIMINATE', 'REALIZES'],
  );
  const findings: string[] = [];
  for (const r of rows) {
    const n = cells.filter((c) => c.row === r.id).length;
    if (n === 0) findings.push(`${r.name}: no application realizes it`);
    if (n > 2) findings.push(`${r.name}: realized by ${n} applications (possible overlap)`);
  }
  for (const r of rows) {
    const apps = cells.filter((c) => c.row === r.id);
    if (apps.length && apps.every((c) => c.values.includes('ELIMINATE'))) findings.push(`${r.name}: only applications marked ELIMINATE`);
  }
  return {
    kind: 'capability-application',
    title: 'Capability × application',
    rowLabel: 'Capability',
    columnLabel: 'Application',
    rows,
    columns: apps,
    cells,
    values: ['INVEST', 'TOLERATE', 'MIGRATE', 'ELIMINATE', 'REALIZES'],
    findings,
  };
}

const ROLES = ['MASTER', 'GOLDEN_COPY', 'APPROVED_DISTRIBUTOR', 'REPLICA', 'CONSUMER_CACHE'];

/** Data stores × data products with the store's role(s). */
export function dataStoreRolesMatrix(g: MatrixInput): Matrix {
  const els = new Map(g.elements.map((e) => [e.id, e]));
  const holds = g.relationships.filter((r) => r.type === 'HOLDS' && els.has(r.fromId) && els.has(r.toId));
  const rows = [...new Set(holds.map((r) => r.fromId))].map((id) => axis(els.get(id)!, String(els.get(id)!.attrs['category'] ?? ''))).sort(byName);
  const products = g.elements.filter((e) => e.type === 'DataProduct').map((e) => axis(e)).sort(byName);
  const cells = cellsFrom(holds.map((r) => ({ row: r.fromId, column: r.toId, value: String(r.attrs['role']) })), ROLES);
  const findings: string[] = [];
  for (const p of products) {
    // Masters in different periods (a planned hand-over) are fine; overlapping ones are not.
    const masters = holds.filter((r) => r.toId === p.id && r.attrs['role'] === 'MASTER');
    if (masters.length === 0) findings.push(`${p.name}: no master store`);
    const clash = masters.some((a, i) => masters.slice(i + 1).some((b) => a.fromId !== b.fromId && overlaps(a, b)));
    if (clash) findings.push(`${p.name}: more than one master store at the same time`);
  }
  return { kind: 'data-store-roles', title: 'Data store roles', rowLabel: 'Data store', columnLabel: 'Data product', rows, columns: products, cells, values: ROLES, findings };
}

export interface LifecycleCount {
  type: string;
  layer: string;
  lifecycle: string | null;
  count: number;
}

/** Element types × lifecycle states with counts (a heat-map). */
export function lifecycleMatrix(counts: LifecycleCount[], lifecycle: string[]): Matrix {
  const states = [...lifecycle, ...(counts.some((c) => !c.lifecycle) ? ['(none)'] : [])];
  const types = [...new Map(counts.map((c) => [c.type, c.layer]))].map(([type, layer]) => ({ id: type, name: type, type, group: layer })).sort(byName);
  const cells = counts.map((c) => ({ row: c.type, column: c.lifecycle ?? '(none)', values: [String(c.count)] }));
  const findings: string[] = [];
  const total = (state: string) => counts.filter((c) => c.lifecycle === state).reduce((n, c) => n + c.count, 0);
  if (total('DEPRECATED')) findings.push(`${total('DEPRECATED')} elements are deprecated and still in the model`);
  const missing = counts.filter((c) => !c.lifecycle).reduce((n, c) => n + c.count, 0);
  if (missing) findings.push(`${missing} elements have no lifecycle state`);
  return {
    kind: 'lifecycle',
    title: 'Lifecycle heat-map',
    rowLabel: 'Type',
    columnLabel: 'Lifecycle',
    rows: types,
    columns: states.map((s) => ({ id: s, name: s, type: 'Lifecycle' })),
    cells,
    values: [],
    findings,
  };
}

/** Relationship types each relationship-based matrix needs (for fetching). */
export const MATRIX_RELATIONSHIPS: Record<Exclude<MatrixKind, 'lifecycle'>, string[]> = {
  crud: ['ACTS_ON', 'HAS_STEP'],
  'capability-application': ['REALIZES'],
  'data-store-roles': ['HOLDS'],
};

/** Element types listed even without relationships (rows or columns that may be empty). */
export const MATRIX_ELEMENT_TYPES: Record<Exclude<MatrixKind, 'lifecycle'>, string[]> = {
  crud: [],
  'capability-application': ['Capability'],
  'data-store-roles': ['DataProduct'],
};

export function buildMatrix(kind: Exclude<MatrixKind, 'lifecycle'>, g: MatrixInput): Matrix {
  switch (kind) {
    case 'crud':
      return crudMatrix(g);
    case 'capability-application':
      return capabilityApplicationMatrix(g);
    default:
      return dataStoreRolesMatrix(g);
  }
}

/** CSV with one row per matrix row and one column per matrix column. */
export function matrixToCsv(m: Matrix): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const cell = new Map(m.cells.map((c) => [`${c.row}\u0000${c.column}`, c.values.join(' ')]));
  const header = ['group', m.rowLabel, ...m.columns.map((c) => c.name)];
  const lines = m.rows.map((r) => [r.group ?? '', r.name, ...m.columns.map((c) => cell.get(`${r.id}\u0000${c.id}`) ?? '')].map(esc).join(','));
  return [header.map(esc).join(','), ...lines].join('\n');
}
