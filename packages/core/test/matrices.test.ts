import { describe, expect, it } from 'vitest';
import {
  buildMatrix,
  decisionLog,
  lifecycleMatrix,
  matrixToCsv,
  type Element,
  type Relationship,
} from '../src';

const sys = (id: string) => ({
  id,
  workspaceId: 'ws1',
  version: 1,
  validFrom: null,
  validTo: null,
  scenarioId: null,
  deleted: false,
  createdAt: '2026-10-17T00:00:00Z',
  createdBy: 'test',
  updatedAt: '2026-10-17T00:00:00Z',
  updatedBy: 'test',
});
const el = (id: string, type: string, attrs: Record<string, unknown> = {}): Element => ({ ...sys(id), type, attrs: { name: id, ...attrs } });
let n = 0;
const rel = (type: string, fromId: string, toId: string, attrs: Record<string, unknown> = {}): Relationship => ({
  ...sys(`r${++n}`),
  type,
  fromId,
  toId,
  attrs,
});
const cell = (m: ReturnType<typeof buildMatrix>, row: string, column: string) => m.cells.find((c) => c.row === row && c.column === column)?.values;

describe('CRUD-I matrix', () => {
  const m = buildMatrix('crud', {
    elements: [el('Onboarding', 'BusinessProcess'), el('Capture', 'ProcessStep'), el('Screen', 'ProcessStep'), el('Report', 'ProcessStep'), el('Client', 'DataProduct'), el('Rates', 'DataProduct')],
    relationships: [
      rel('HAS_STEP', 'Onboarding', 'Screen', { seq: 2 }),
      rel('HAS_STEP', 'Onboarding', 'Capture', { seq: 1 }),
      rel('ACTS_ON', 'Capture', 'Client', { op: 'CREATE' }),
      rel('ACTS_ON', 'Screen', 'Client', { op: 'UPDATE' }),
      rel('ACTS_ON', 'Screen', 'Client', { op: 'READ' }),
      rel('ACTS_ON', 'Report', 'Rates', { op: 'READ' }),
    ],
  });

  it('orders steps by process and sequence and operations by C, R, U, I, D', () => {
    expect(m.rows.map((r) => `${r.group}/${r.name}`)).toEqual(['(no process)/Report', 'Onboarding/Capture', 'Onboarding/Screen']);
    expect(m.columns.map((c) => c.name)).toEqual(['Client', 'Rates']);
    expect(cell(m, 'Screen', 'Client')).toEqual(['READ', 'UPDATE']);
    expect(cell(m, 'Capture', 'Rates')).toBeUndefined();
  });

  it('finds data that nothing creates or maintains', () => {
    expect(m.findings).toEqual(['Rates: no step creates it', 'Rates: read but never maintained']);
  });

  it('exports CSV', () => {
    expect(matrixToCsv(m).split('\n')).toEqual([
      'group,Process step,Client,Rates',
      '(no process),Report,,READ',
      'Onboarding,Capture,CREATE,',
      'Onboarding,Screen,READ UPDATE,',
    ]);
  });
});

describe('capability × application and data store roles', () => {
  it('shows TIME classes and capabilities without applications', () => {
    const m = buildMatrix('capability-application', {
      elements: [el('KYC', 'Capability', { level: 2 }), el('Payments', 'Capability', { level: 1 }), el('Screener', 'Application', { timeClass: 'ELIMINATE' })],
      relationships: [rel('REALIZES', 'Screener', 'KYC')],
    });
    expect(m.rows.map((r) => r.name)).toEqual(['Payments', 'KYC']);
    expect(cell(m, 'KYC', 'Screener')).toEqual(['ELIMINATE']);
    expect(m.findings).toEqual(['Payments: no application realizes it', 'KYC: only applications marked ELIMINATE']);
  });

  it('shows store roles and products without a master', () => {
    const m = buildMatrix('data-store-roles', {
      elements: [el('Client', 'DataProduct'), el('Rates', 'DataProduct'), el('MDM', 'DataStore', { category: 'OPERATIONAL' }), el('Lake', 'DataStore', { category: 'ANALYTICAL' })],
      relationships: [rel('HOLDS', 'MDM', 'Client', { role: 'MASTER' }), rel('HOLDS', 'Lake', 'Client', { role: 'APPROVED_DISTRIBUTOR' }), rel('HOLDS', 'Lake', 'Rates', { role: 'REPLICA' })],
    });
    expect(m.rows.map((r) => `${r.group}/${r.name}`)).toEqual(['ANALYTICAL/Lake', 'OPERATIONAL/MDM']);
    expect(cell(m, 'Lake', 'Client')).toEqual(['APPROVED_DISTRIBUTOR']);
    expect(m.findings).toEqual(['Rates: no master store']);
  });

  it('accepts a master hand-over but flags overlapping masters', () => {
    const els = [el('Client', 'DataProduct'), el('Old', 'DataStore'), el('New', 'DataStore')];
    const handOver = buildMatrix('data-store-roles', {
      elements: els,
      relationships: [
        { ...rel('HOLDS', 'Old', 'Client', { role: 'MASTER' }), validTo: '2027-07-01' },
        { ...rel('HOLDS', 'New', 'Client', { role: 'MASTER' }), validFrom: '2027-07-01' },
      ],
    });
    expect(cell(handOver, 'New', 'Client')).toEqual(['MASTER']);
    expect(handOver.findings).toEqual([]);
    const clash = buildMatrix('data-store-roles', {
      elements: els,
      relationships: [rel('HOLDS', 'Old', 'Client', { role: 'MASTER' }), { ...rel('HOLDS', 'New', 'Client', { role: 'MASTER' }), validFrom: '2027-07-01' }],
    });
    expect(clash.findings).toEqual(['Client: more than one master store at the same time']);
  });
});

describe('lifecycle heat-map', () => {
  it('counts by type and state and flags missing states', () => {
    const m = lifecycleMatrix(
      [
        { type: 'Application', layer: 'Application', lifecycle: 'LIVE', count: 5 },
        { type: 'Application', layer: 'Application', lifecycle: 'DEPRECATED', count: 1 },
        { type: 'Goal', layer: 'Strategy', lifecycle: null, count: 2 },
      ],
      ['PROPOSED', 'LIVE', 'DEPRECATED'],
    );
    expect(m.columns.map((c) => c.name)).toEqual(['PROPOSED', 'LIVE', 'DEPRECATED', '(none)']);
    expect(m.rows.map((r) => r.name)).toEqual(['Application', 'Goal']);
    expect(m.cells).toContainEqual({ row: 'Goal', column: '(none)', values: ['2'] });
    expect(m.findings).toEqual(['1 elements are deprecated and still in the model', '2 elements have no lifecycle state']);
  });
});

describe('decisionLog', () => {
  const log = decisionLog({
    elements: [
      el('ADR-2 Use MDM hub', 'Decision', { status: 'ACCEPTED', decidedOn: '2026-05-01', context: 'Many client copies' }),
      el('ADR-1 Extend legacy', 'Decision', { status: 'ACCEPTED', decidedOn: '2025-01-10' }),
      el('ADR-3 Draft', 'Decision', { status: 'PROPOSED' }),
      el('Hub', 'Option'),
      el('Legacy', 'Option'),
      el('MDM', 'DataStore', { lifecycle: 'PLANNED' }),
    ],
    relationships: [
      rel('CONSIDERED', 'ADR-2 Use MDM hub', 'Legacy'),
      rel('CONSIDERED', 'ADR-2 Use MDM hub', 'Hub'),
      rel('CHOSE', 'ADR-2 Use MDM hub', 'Hub'),
      rel('DECIDES', 'ADR-2 Use MDM hub', 'MDM'),
      rel('SUPERSEDES', 'ADR-2 Use MDM hub', 'ADR-1 Extend legacy'),
      rel('DECIDES', 'ADR-1 Extend legacy', 'MDM'),
    ],
  });

  it('lists newest first with options, decided elements and supersession', () => {
    expect(log.map((d) => d.name)).toEqual(['ADR-2 Use MDM hub', 'ADR-1 Extend legacy', 'ADR-3 Draft']);
    const adr2 = log[0]!;
    expect(adr2.options).toEqual([
      expect.objectContaining({ name: 'Hub', chosen: true }),
      expect.objectContaining({ name: 'Legacy', chosen: false }),
    ]);
    expect(adr2.decides).toEqual([{ id: 'MDM', name: 'MDM', type: 'DataStore', lifecycle: 'PLANNED' }]);
    expect(adr2.supersedes.map((s) => s.name)).toEqual(['ADR-1 Extend legacy']);
    expect(adr2.context).toBe('Many client copies');
    expect(adr2.findings).toEqual([]);
  });

  it('flags inconsistent records', () => {
    expect(log[1]!.supersededBy.map((s) => s.name)).toEqual(['ADR-2 Use MDM hub']);
    expect(log[1]!.findings).toEqual(['Superseded by ADR-2 Use MDM hub but status is ACCEPTED']);
    expect(log[2]!.findings).toEqual(['Not linked to any element it decides']);
  });
});
