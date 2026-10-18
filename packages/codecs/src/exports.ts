import type { Element, ModelSnapshot, Relationship } from '@d4/core';
import type { MetamodelRegistry } from '@d4/metamodel';

/**
 * Export formats over a model snapshot (or part of one): CSV, Mermaid, ArchiMate Open Exchange
 * and a Cypher script. All are pure and deterministic (sorted by id) so exports diff cleanly.
 */
export const EXPORT_FORMATS = ['yaml', 'json', 'elements-csv', 'relationships-csv', 'mermaid', 'archimate', 'cypher'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_MEDIA: Record<ExportFormat, { contentType: string; extension: string }> = {
  yaml: { contentType: 'application/yaml', extension: 'yaml' },
  json: { contentType: 'application/json', extension: 'json' },
  'elements-csv': { contentType: 'text/csv', extension: 'elements.csv' },
  'relationships-csv': { contentType: 'text/csv', extension: 'relationships.csv' },
  mermaid: { contentType: 'text/plain', extension: 'mmd' },
  archimate: { contentType: 'application/xml', extension: 'archimate.xml' },
  cypher: { contentType: 'text/plain', extension: 'cypher' },
};

const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
const nameOf = (e: Element | undefined) => (e ? String(e.attrs['name'] ?? e.id) : '');
const text = (v: unknown): string => (v === null || v === undefined ? '' : Array.isArray(v) ? v.map(text).join('; ') : typeof v === 'object' ? JSON.stringify(v) : String(v));

// ── CSV ────────────────────────────────────────────────────────────────────

const csvCell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const csv = (rows: string[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

const FIRST_ATTRS = ['name', 'lifecycle', 'description'];

/** One row per element: system columns, then every attribute used, alphabetically. */
export function elementsToCsv(s: ModelSnapshot, reg: MetamodelRegistry): string {
  const attrs = [...new Set(s.elements.flatMap((e) => Object.keys(e.attrs)))].filter((k) => !FIRST_ATTRS.includes(k)).sort();
  const header = ['id', 'type', 'layer', ...FIRST_ATTRS, 'validFrom', 'validTo', 'scenarioId', ...attrs];
  const rows = byId(s.elements).map((e) => [
    e.id,
    e.type,
    reg.nodeType(e.type)?.layer ?? '',
    ...FIRST_ATTRS.map((k) => text(e.attrs[k])),
    e.validFrom ?? '',
    e.validTo ?? '',
    e.scenarioId ?? '',
    ...attrs.map((k) => text(e.attrs[k])),
  ]);
  return csv([header, ...rows]);
}

/** One row per relationship, with the names of both ends for readability. */
export function relationshipsToCsv(s: ModelSnapshot): string {
  const els = new Map(s.elements.map((e) => [e.id, e]));
  const attrs = [...new Set(s.relationships.flatMap((r) => Object.keys(r.attrs)))].sort();
  const header = ['id', 'type', 'fromId', 'fromName', 'toId', 'toName', 'validFrom', 'validTo', 'scenarioId', ...attrs];
  const rows = byId(s.relationships).map((r) => [
    r.id,
    r.type,
    r.fromId,
    nameOf(els.get(r.fromId)),
    r.toId,
    nameOf(els.get(r.toId)),
    r.validFrom ?? '',
    r.validTo ?? '',
    r.scenarioId ?? '',
    ...attrs.map((k) => text(r.attrs[k])),
  ]);
  return csv([header, ...rows]);
}

// ── Mermaid ────────────────────────────────────────────────────────────────

/** Mermaid flowchart: one subgraph per layer, edges labelled with the type (and role/op). */
export function toMermaid(s: ModelSnapshot, reg: MetamodelRegistry, title?: string): string {
  const ids = new Map(byId(s.elements).map((e, i) => [e.id, `n${i + 1}`]));
  // Mermaid labels are quoted strings; quotes and line breaks would end them.
  const label = (v: string) => v.replace(/"/g, "'").replace(/[\r\n]+/g, ' ').replace(/[<>]/g, '');
  const lines = [...(title ? ['---', `title: ${label(title)}`, '---'] : []), 'flowchart LR'];
  const layers = new Map<string, Element[]>();
  for (const e of byId(s.elements)) {
    const layer = reg.nodeType(e.type)?.layer ?? 'Other';
    layers.set(layer, [...(layers.get(layer) ?? []), e]);
  }
  for (const [layer, list] of [...layers].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  subgraph ${layer.replace(/\W/g, '')}["${label(layer)}"]`);
    for (const e of list) lines.push(`    ${ids.get(e.id)}["${label(nameOf(e))}<br/><small>${label(e.type)}</small>"]`);
    lines.push('  end');
  }
  for (const r of byId(s.relationships)) {
    const a = ids.get(r.fromId);
    const b = ids.get(r.toId);
    if (!a || !b) continue;
    const detail = r.attrs['role'] ?? r.attrs['op'] ?? r.attrs['action'];
    const arrow = r.validFrom || r.validTo ? '-.->' : '-->';
    lines.push(`  ${a} ${arrow}|"${label(r.type)}${detail ? ` ${label(String(detail))}` : ''}"| ${b}`);
  }
  return lines.join('\n') + '\n';
}

// ── ArchiMate Open Exchange (3.1) ─────────────────────────────────────────

/** D4 type → ArchiMate element type. Subtypes fall back to their ancestors (see `lineage`). */
export const ARCHIMATE_ELEMENTS: Record<string, string> = {
  // Strategy and motivation
  Vision: 'Goal',
  Goal: 'Goal',
  Objective: 'Goal',
  KeyResult: 'Outcome',
  Outcome: 'Outcome',
  Driver: 'Driver',
  Principle: 'Principle',
  KPI: 'Meaning',
  ValueStream: 'ValueStream',
  ValueStreamStage: 'ValueStream',
  Capability: 'Capability',
  Requirement: 'Requirement',
  Constraint: 'Constraint',
  Assumption: 'Assessment',
  Risk: 'Assessment',
  // Business
  BusinessProcess: 'BusinessProcess',
  ProcessStep: 'BusinessProcess',
  BusinessFunction: 'BusinessFunction',
  BusinessEvent: 'BusinessEvent',
  BusinessObject: 'BusinessObject',
  BusinessService: 'BusinessService',
  Product: 'Product',
  Actor: 'BusinessActor',
  Role: 'BusinessRole',
  Person: 'BusinessActor',
  OrgUnit: 'BusinessActor',
  LegalEntity: 'BusinessActor',
  Location: 'Location',
  Contract: 'Contract',
  // Data and application
  DataProduct: 'DataObject',
  DataEntity: 'DataObject',
  DataSet: 'DataObject',
  DataContract: 'Contract',
  Application: 'ApplicationComponent',
  ApplicationComponent: 'ApplicationComponent',
  ApplicationService: 'ApplicationService',
  Interface: 'ApplicationInterface',
  EventType: 'ApplicationEvent',
  Integration: 'ApplicationInteraction',
  // Technology
  DataStore: 'SystemSoftware',
  Platform: 'Node',
  PlatformService: 'TechnologyService',
  Environment: 'Node',
  InfrastructureNode: 'Node',
  Network: 'CommunicationNetwork',
  SoftwareProduct: 'SystemSoftware',
  // Implementation and migration
  Portfolio: 'WorkPackage',
  Program: 'WorkPackage',
  Initiative: 'WorkPackage',
  Deliverable: 'Deliverable',
  Milestone: 'ImplementationEvent',
  Release: 'ImplementationEvent',
  Plateau: 'Plateau',
};

/** D4 relationship → ArchiMate relationship where the meaning is clear; the rest are Association. */
const ARCHIMATE_RELATIONSHIPS: Record<string, { type: string; reverse?: boolean }> = {
  REALIZES: { type: 'Realization' },
  REALIZED_BY: { type: 'Realization', reverse: true },
  PARENT_OF: { type: 'Composition' },
  HAS_STEP: { type: 'Composition' },
  NEXT: { type: 'Triggering' },
  ACTS_ON: { type: 'Access' },
  // ArchiMate assigns the actor to the behaviour; D4 says the step is performed by the actor.
  PERFORMED_BY: { type: 'Assignment', reverse: true },
};

const xml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** XML ids must not start with a digit; ULIDs can. */
const xid = (id: string) => `id-${id}`;

export interface ArchiMateExport {
  xml: string;
  /** D4 types with no ArchiMate equivalent; their elements (and relationships) are left out. */
  skippedTypes: string[];
}

export function toArchiMate(s: ModelSnapshot, reg: MetamodelRegistry, meta: { name: string; documentation?: string }): ArchiMateExport {
  const archType = (t: string) => reg.lineage(t).map((x) => ARCHIMATE_ELEMENTS[x]).find(Boolean);
  const kept = byId(s.elements).filter((e) => archType(e.type));
  const keptIds = new Set(kept.map((e) => e.id));
  const skippedTypes = [...new Set(s.elements.filter((e) => !archType(e.type)).map((e) => e.type))].sort();

  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model xmlns="http://www.opengroup.org/xsd/archimate/3.0/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '       xsi:schemaLocation="http://www.opengroup.org/xsd/archimate/3.0/ http://www.opengroup.org/xsd/archimate/3.1/archimate3_Diagram.xsd"',
    `       identifier="${xid('model')}">`,
    `  <name xml:lang="en">${xml(meta.name)}</name>`,
    ...(meta.documentation ? [`  <documentation xml:lang="en">${xml(meta.documentation)}</documentation>`] : []),
    '  <elements>',
  ];
  for (const e of kept) {
    out.push(`    <element identifier="${xid(e.id)}" xsi:type="${archType(e.type)}">`);
    out.push(`      <name xml:lang="en">${xml(nameOf(e))}</name>`);
    const doc = [e.attrs['description'], `D4 type: ${e.type}`].filter(Boolean).map(text).join('\n');
    out.push(`      <documentation xml:lang="en">${xml(doc)}</documentation>`);
    out.push('    </element>');
  }
  out.push('  </elements>', '  <relationships>');
  for (const r of byId(s.relationships)) {
    if (!keptIds.has(r.fromId) || !keptIds.has(r.toId)) continue;
    const m = ARCHIMATE_RELATIONSHIPS[r.type] ?? { type: 'Association' };
    const [source, target] = m.reverse ? [r.toId, r.fromId] : [r.fromId, r.toId];
    const access = r.type === 'ACTS_ON' ? ` accessType="${r.attrs['op'] === 'READ' ? 'Read' : 'Write'}"` : '';
    out.push(`    <relationship identifier="${xid(r.id)}" source="${xid(source)}" target="${xid(target)}" xsi:type="${m.type}"${access}>`);
    const detail = r.attrs['role'] ?? r.attrs['op'];
    out.push(`      <name xml:lang="en">${xml(r.type + (detail ? ` (${text(detail)})` : ''))}</name>`);
    out.push('    </relationship>');
  }
  out.push('  </relationships>', '</model>');
  if (skippedTypes.length) out.splice(1, 0, `<!-- Not exported (no ArchiMate equivalent): ${skippedTypes.join(', ')} -->`);
  return { xml: out.join('\n') + '\n', skippedTypes };
}

// ── Cypher script ─────────────────────────────────────────────────────────

const cypherString = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
function cypherValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(cypherValue).join(', ')}]`;
  return cypherString(typeof v === 'object' ? JSON.stringify(v) : String(v));
}
const ident = (s: string) => `\`${s.replace(/`/g, '``')}\``;
function props(item: Element | Relationship, extra: Record<string, unknown>): string {
  const p: Record<string, unknown> = { ...item.attrs, ...extra };
  return `{${Object.keys(p)
    .filter((k) => p[k] !== null && p[k] !== undefined)
    .sort()
    .map((k) => `${ident(k)}: ${cypherValue(p[k])}`)
    .join(', ')}}`;
}
const system = (x: Element | Relationship) => ({
  id: x.id,
  workspaceId: x.workspaceId,
  version: x.version,
  validFrom: x.validFrom,
  validTo: x.validTo,
  scenarioId: x.scenarioId,
  deleted: false,
  createdAt: x.createdAt,
  createdBy: x.createdBy,
  updatedAt: x.updatedAt,
  updatedBy: x.updatedBy,
});

/**
 * Cypher that recreates the snapshot with the same labels and properties D4 writes, using MERGE
 * on id so it can be re-run. For moving a model between databases or into another Neo4j tool.
 */
export function toCypherScript(s: ModelSnapshot, reg: MetamodelRegistry): string {
  const lines = ['// D4 model export: run with cypher-shell or Neo4j Browser (multi-statement).', ':begin'];
  for (const e of byId(s.elements)) {
    const labels = reg.labelsFor(e.type).map(ident).join(':');
    lines.push(`MERGE (n:Element {id: ${cypherString(e.id)}}) SET n:${labels}, n += ${props(e, { ...system(e), type: e.type })};`);
  }
  for (const r of byId(s.relationships)) {
    lines.push(
      `MATCH (a:Element {id: ${cypherString(r.fromId)}}), (b:Element {id: ${cypherString(r.toId)}}) ` +
        `MERGE (a)-[r:${ident(r.type)} {id: ${cypherString(r.id)}}]->(b) SET r += ${props(r, system(r))};`,
    );
  }
  lines.push(':commit');
  return lines.join('\n') + '\n';
}
