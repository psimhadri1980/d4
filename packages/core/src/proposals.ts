import type { MetamodelRegistry } from '@d4/metamodel';
import { DomainError } from './errors';
import { ModelService, type ModelServiceOptions } from './model-service';
import type { ChangeSet, ModelReader, ModelRepository } from './ports';
import type { Attributes, CommandContext, DomainEvent, Element, IsoDate, Relationship } from './types';

/**
 * One step of a change proposal. Elements created by the proposal get a `ref` that later steps use
 * in place of an id (`from`, `to`, `id`).
 */
export type ProposalOperation =
  | { op: 'createElement'; ref: string; type: string; attrs: Attributes; validFrom?: IsoDate | null; validTo?: IsoDate | null; scenarioId?: string | null }
  | { op: 'updateElement'; id: string; expectedVersion: number; set?: Attributes; unset?: string[]; validFrom?: IsoDate | null; validTo?: IsoDate | null }
  | { op: 'deleteElement'; id: string; expectedVersion: number }
  | { op: 'createRelationship'; type: string; from: string; to: string; attrs?: Attributes; validFrom?: IsoDate | null; validTo?: IsoDate | null; scenarioId?: string | null }
  | { op: 'updateRelationship'; id: string; expectedVersion: number; set?: Attributes; unset?: string[]; validFrom?: IsoDate | null; validTo?: IsoDate | null }
  | { op: 'deleteRelationship'; id: string; expectedVersion: number };

export interface StepResult {
  index: number;
  op: ProposalOperation['op'];
  /** The element or relationship the step created or changed. */
  subjectId?: string;
  /** Present when the step failed; later steps were not tried. */
  error?: { code: string; message: string; issues?: string[] };
}

export interface StagedProposal {
  ok: boolean;
  steps: StepResult[];
  /** All steps as one change, when ok. Apply it with ModelRepository.apply. */
  change?: ChangeSet;
  /** Element `ref` → id assigned by this run. */
  refs: Record<string, string>;
}

/**
 * Runs a proposal's steps through ModelService (metamodel, lifecycle, rules, versions) against a
 * staging layer over the live model, without writing anything. The result is a single ChangeSet so
 * the proposal applies all-or-nothing. Each element or relationship may change only once per
 * proposal, because the store checks that every version advances by exactly one.
 */
export async function stageProposal(
  reg: MetamodelRegistry,
  base: ModelReader,
  ctx: CommandContext,
  ops: ProposalOperation[],
  opts: ModelServiceOptions = {},
): Promise<StagedProposal> {
  const stage = new StagingRepository(base);
  const service = new ModelService(reg, stage, opts);
  const refs: Record<string, string> = {};
  const steps: StepResult[] = [];
  const resolve = (idOrRef: string) => refs[idOrRef] ?? idOrRef;

  for (const [index, o] of ops.entries()) {
    const step: StepResult = { index, op: o.op };
    steps.push(step);
    try {
      switch (o.op) {
        case 'createElement': {
          if (refs[o.ref]) throw new DomainError('VALIDATION', `ref '${o.ref}' is used twice`);
          const { ref, ...input } = withoutOp(o);
          const el = await service.createElement(ctx, input);
          refs[ref] = el.id;
          step.subjectId = el.id;
          break;
        }
        case 'updateElement': {
          step.subjectId = (await service.updateElement(ctx, { ...withoutOp(o), id: resolve(o.id) })).id;
          break;
        }
        case 'deleteElement':
          await service.deleteElement(ctx, { id: resolve(o.id), expectedVersion: o.expectedVersion });
          step.subjectId = resolve(o.id);
          break;
        case 'createRelationship': {
          const { from, to, ...input } = withoutOp(o);
          step.subjectId = (await service.createRelationship(ctx, { ...input, fromId: resolve(from), toId: resolve(to) })).id;
          break;
        }
        case 'updateRelationship': {
          step.subjectId = (await service.updateRelationship(ctx, { ...withoutOp(o), id: resolve(o.id) })).id;
          break;
        }
        case 'deleteRelationship':
          await service.deleteRelationship(ctx, { id: resolve(o.id), expectedVersion: o.expectedVersion });
          step.subjectId = resolve(o.id);
          break;
      }
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      step.error = { code: e.code, message: e.message, ...(e.issues.length && { issues: e.issues }) };
      return { ok: false, steps, refs };
    }
  }
  return { ok: true, steps, refs, change: stage.merged() };
}

const withoutOp = <T extends { op: string }>(o: T): Omit<T, 'op'> => {
  const copy: Partial<T> = { ...o };
  delete copy.op;
  return copy as Omit<T, 'op'>;
};

/**
 * Reads see the live model with staged changes on top; writes are kept in memory. A second change
 * to the same item is refused (see stageProposal).
 */
class StagingRepository implements ModelRepository {
  private readonly elements = new Map<string, Element>();
  private readonly relationships = new Map<string, Relationship>();
  private readonly events: DomainEvent[] = [];
  private readonly order: { kind: 'el' | 'rel'; id: string }[] = [];

  constructor(private readonly base: ModelReader) {}

  async getElement(ws: string, id: string) {
    return this.elements.get(id) ?? this.base.getElement(ws, id);
  }

  async getRelationship(ws: string, id: string) {
    return this.relationships.get(id) ?? this.base.getRelationship(ws, id);
  }

  async relationshipsOf(ws: string, elementId: string) {
    return this.overlay(await this.base.relationshipsOf(ws, elementId), (r) => r.fromId === elementId || r.toId === elementId);
  }

  async relationshipsTo(ws: string, type: string, toId: string) {
    return this.overlay(await this.base.relationshipsTo(ws, type, toId), (r) => r.type === type && r.toId === toId);
  }

  async scenarioItems(ws: string, scenarioId: string) {
    const b = await this.base.scenarioItems(ws, scenarioId);
    const els = new Map(b.elements.map((e) => [e.id, e]));
    for (const e of this.elements.values()) if (e.scenarioId === scenarioId) els.set(e.id, e);
    return {
      elements: [...els.values()].filter((e) => !(this.elements.get(e.id) ?? e).deleted),
      relationships: this.overlay(b.relationships, (r) => r.scenarioId === scenarioId),
    };
  }

  async pathExists(ws: string, type: string, fromId: string, toId: string) {
    if (![...this.relationships.values()].some((r) => r.type === type)) return this.base.pathExists(ws, type, fromId, toId);
    // Staged relationships of this type: walk the overlaid graph outward from `fromId`.
    const seen = new Set([fromId]);
    const queue = [fromId];
    for (let cur = queue.shift(); cur !== undefined; cur = queue.shift()) {
      if (cur === toId) return true;
      for (const r of await this.relationshipsOf(ws, cur)) {
        if (r.type === type && r.fromId === cur && !seen.has(r.toId)) {
          seen.add(r.toId);
          queue.push(r.toId);
        }
      }
    }
    return false;
  }

  async apply(_ws: string, change: ChangeSet) {
    for (const e of change.elements) this.stageItem('el', this.elements, e);
    for (const r of change.relationships) this.stageItem('rel', this.relationships, r);
    this.events.push(...change.events);
  }

  merged(): ChangeSet {
    return {
      elements: this.order.filter((o) => o.kind === 'el').map((o) => this.elements.get(o.id)!),
      relationships: this.order.filter((o) => o.kind === 'rel').map((o) => this.relationships.get(o.id)!),
      events: this.events,
    };
  }

  private stageItem<T extends Element | Relationship>(kind: 'el' | 'rel', store: Map<string, T>, item: T) {
    if (store.has(item.id)) {
      const what = kind === 'el' ? 'element' : 'relationship';
      throw new DomainError('VALIDATION', `the proposal changes ${what} '${item.id}' more than once; combine those steps into one`);
    }
    store.set(item.id, item);
    this.order.push({ kind, id: item.id });
  }

  /** Base results with staged versions swapped in, staged additions that match, and no deleted items. */
  private overlay(base: Relationship[], matches: (r: Relationship) => boolean): Relationship[] {
    const out = new Map(base.map((r) => [r.id, r]));
    for (const r of this.relationships.values()) if (matches(r)) out.set(r.id, r);
    return [...out.values()].filter((r) => !(this.relationships.get(r.id) ?? r).deleted);
  }
}
