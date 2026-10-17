import type { MetamodelRegistry } from '@d4/metamodel';
import { DomainError } from './errors';
import { ulid, ULID_PATTERN } from './ids';
import { assertTransition, INITIAL_LIFECYCLE, isLifecycleState } from './lifecycle';
import { systemClock, type ChangeSet, type Clock, type ModelRepository } from './ports';
import { assertRelationshipRules } from './rules';
import type {
  Attributes,
  CommandContext,
  DomainEvent,
  DomainEventType,
  Element,
  IsoDate,
  Relationship,
  SystemFields,
} from './types';
import { periodIssues } from './validity';

export interface CreateElementInput {
  type: string;
  attrs: Attributes;
  /** Optional caller-supplied ULID (used by imports to keep ids stable). */
  id?: string;
  validFrom?: IsoDate | null;
  validTo?: IsoDate | null;
  scenarioId?: string | null;
}

export interface CreateRelationshipInput {
  type: string;
  fromId: string;
  toId: string;
  attrs?: Attributes;
  id?: string;
  validFrom?: IsoDate | null;
  validTo?: IsoDate | null;
  scenarioId?: string | null;
}

/** `undefined` leaves a field unchanged; `null` clears a validity bound. */
export interface UpdateInput {
  id: string;
  expectedVersion: number;
  set?: Attributes;
  unset?: string[];
  validFrom?: IsoDate | null;
  validTo?: IsoDate | null;
}

export interface DeleteInput {
  id: string;
  expectedVersion: number;
}

export interface ModelServiceOptions {
  clock?: Clock;
  newId?: () => string;
}

/**
 * Validates model commands against the metamodel, lifecycle and rules, then hands the resulting
 * ChangeSet (new state + domain events) to the repository to apply atomically.
 */
export class ModelService {
  private readonly clock: Clock;
  private readonly newId: () => string;

  constructor(
    private readonly reg: MetamodelRegistry,
    private readonly repo: ModelRepository,
    opts: ModelServiceOptions = {},
  ) {
    this.clock = opts.clock ?? systemClock;
    this.newId = opts.newId ?? (() => ulid(this.clock.now().getTime()));
  }

  // ── Elements ──────────────────────────────────────────────────────────

  async createElement(ctx: CommandContext, input: CreateElementInput): Promise<Element> {
    const t = this.reg.nodeType(input.type);
    if (!t) throw new DomainError('VALIDATION', `Unknown element type '${input.type}'`);
    const id = await this.claimId(ctx, input.id);
    const attrs: Attributes = { lifecycle: INITIAL_LIFECYCLE, ...input.attrs };
    const el: Element = {
      ...this.newSystemFields(ctx, id, input),
      type: input.type,
      attrs,
    };
    this.assertValid(
      `${input.type}`,
      [...this.reg.validateNodeAttributes(input.type, attrs), ...periodIssues(el)],
    );
    await this.commit(ctx, { elements: [el] }, [
      this.event(ctx, 'ElementCreated', el, {
        type: el.type,
        attrs: el.attrs,
        validFrom: el.validFrom,
        validTo: el.validTo,
        scenarioId: el.scenarioId,
      }),
    ]);
    return el;
  }

  async updateElement(ctx: CommandContext, input: UpdateInput): Promise<Element> {
    const current = await this.liveElement(ctx, input.id);
    this.assertVersion(current, input.expectedVersion);

    const next: Element = {
      ...current,
      attrs: applyAttrChanges(current.attrs, input),
      validFrom: input.validFrom === undefined ? current.validFrom : input.validFrom,
      validTo: input.validTo === undefined ? current.validTo : input.validTo,
    };
    const changes = diff(current, next);
    if (!Object.keys(changes).length) return current;

    this.assertValid(current.type, [
      ...this.reg.validateNodeAttributes(current.type, next.attrs),
      ...periodIssues(next),
    ]);
    const from = current.attrs['lifecycle'];
    const to = next.attrs['lifecycle'];
    if (isLifecycleState(from) && isLifecycleState(to)) assertTransition(from, to);

    const updated = this.bump(ctx, next);
    await this.commit(ctx, { elements: [updated] }, [
      this.event(ctx, 'ElementUpdated', updated, { changes }),
    ]);
    return updated;
  }

  /** Soft-deletes the element and every live relationship attached to it. */
  async deleteElement(ctx: CommandContext, input: DeleteInput): Promise<void> {
    const current = await this.liveElement(ctx, input.id);
    this.assertVersion(current, input.expectedVersion);

    const rels = (await this.repo.relationshipsOf(ctx.workspaceId, current.id)).map((r) =>
      this.bump(ctx, { ...r, deleted: true }),
    );
    const deleted = this.bump(ctx, { ...current, deleted: true });
    await this.commit(ctx, { elements: [deleted], relationships: rels }, [
      ...rels.map((r) =>
        this.event(ctx, 'RelationshipDeleted', r, { type: r.type, reason: 'endpoint-deleted' }),
      ),
      this.event(ctx, 'ElementDeleted', deleted, {
        type: deleted.type,
        cascadedRelationships: rels.map((r) => r.id),
      }),
    ]);
  }

  // ── Relationships ─────────────────────────────────────────────────────

  async createRelationship(
    ctx: CommandContext,
    input: CreateRelationshipInput,
  ): Promise<Relationship> {
    if (!this.reg.relationshipType(input.type)) {
      throw new DomainError('VALIDATION', `Unknown relationship type '${input.type}'`);
    }
    const [from, to] = await Promise.all([
      this.liveElement(ctx, input.fromId),
      this.liveElement(ctx, input.toId),
    ]);
    const id = await this.claimId(ctx, input.id, 'relationship');
    const rel: Relationship = {
      ...this.newSystemFields(ctx, id, input),
      type: input.type,
      fromId: from.id,
      toId: to.id,
      attrs: { ...input.attrs },
    };
    this.assertValid(input.type, [
      ...this.reg.validateRelationship(input.type, from.type, to.type, rel.attrs),
      ...periodIssues(rel),
    ]);
    await assertRelationshipRules(this.reg, this.repo, rel, true);
    await this.commit(ctx, { relationships: [rel] }, [
      this.event(ctx, 'RelationshipCreated', rel, {
        type: rel.type,
        fromId: rel.fromId,
        toId: rel.toId,
        attrs: rel.attrs,
        validFrom: rel.validFrom,
        validTo: rel.validTo,
        scenarioId: rel.scenarioId,
      }),
    ]);
    return rel;
  }

  async updateRelationship(ctx: CommandContext, input: UpdateInput): Promise<Relationship> {
    const current = await this.liveRelationship(ctx, input.id);
    this.assertVersion(current, input.expectedVersion);

    const next: Relationship = {
      ...current,
      attrs: applyAttrChanges(current.attrs, input),
      validFrom: input.validFrom === undefined ? current.validFrom : input.validFrom,
      validTo: input.validTo === undefined ? current.validTo : input.validTo,
    };
    const changes = diff(current, next);
    if (!Object.keys(changes).length) return current;

    const [from, to] = await Promise.all([
      this.liveElement(ctx, current.fromId),
      this.liveElement(ctx, current.toId),
    ]);
    this.assertValid(current.type, [
      ...this.reg.validateRelationship(current.type, from.type, to.type, next.attrs),
      ...periodIssues(next),
    ]);
    await assertRelationshipRules(this.reg, this.repo, next, false);

    const updated = this.bump(ctx, next);
    await this.commit(ctx, { relationships: [updated] }, [
      this.event(ctx, 'RelationshipUpdated', updated, { changes }),
    ]);
    return updated;
  }

  async deleteRelationship(ctx: CommandContext, input: DeleteInput): Promise<void> {
    const current = await this.liveRelationship(ctx, input.id);
    this.assertVersion(current, input.expectedVersion);
    const deleted = this.bump(ctx, { ...current, deleted: true });
    await this.commit(ctx, { relationships: [deleted] }, [
      this.event(ctx, 'RelationshipDeleted', deleted, { type: deleted.type, reason: 'requested' }),
    ]);
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private async liveElement(ctx: CommandContext, id: string): Promise<Element> {
    const el = await this.repo.getElement(ctx.workspaceId, id);
    if (!el || el.deleted) throw new DomainError('NOT_FOUND', `Element '${id}' not found`);
    return el;
  }

  private async liveRelationship(ctx: CommandContext, id: string): Promise<Relationship> {
    const rel = await this.repo.getRelationship(ctx.workspaceId, id);
    if (!rel || rel.deleted) throw new DomainError('NOT_FOUND', `Relationship '${id}' not found`);
    return rel;
  }

  private async claimId(
    ctx: CommandContext,
    requested: string | undefined,
    kind: 'element' | 'relationship' = 'element',
  ): Promise<string> {
    if (requested === undefined) return this.newId();
    if (!ULID_PATTERN.test(requested)) {
      throw new DomainError('VALIDATION', `id '${requested}' is not a ULID`);
    }
    const existing =
      kind === 'element'
        ? await this.repo.getElement(ctx.workspaceId, requested)
        : await this.repo.getRelationship(ctx.workspaceId, requested);
    if (existing) throw new DomainError('VALIDATION', `id '${requested}' is already in use`);
    return requested;
  }

  private newSystemFields(
    ctx: CommandContext,
    id: string,
    input: { validFrom?: IsoDate | null; validTo?: IsoDate | null; scenarioId?: string | null },
  ): SystemFields {
    const now = this.clock.now().toISOString();
    return {
      id,
      workspaceId: ctx.workspaceId,
      version: 1,
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
      scenarioId: input.scenarioId ?? null,
      deleted: false,
      createdAt: now,
      createdBy: ctx.actor,
      updatedAt: now,
      updatedBy: ctx.actor,
    };
  }

  private bump<T extends SystemFields>(ctx: CommandContext, item: T): T {
    return {
      ...item,
      version: item.version + 1,
      updatedAt: this.clock.now().toISOString(),
      updatedBy: ctx.actor,
    };
  }

  private assertVersion(current: SystemFields, expected: number): void {
    if (current.version !== expected) {
      throw new DomainError(
        'VERSION_CONFLICT',
        `'${current.id}' is at version ${current.version}, expected ${expected}`,
      );
    }
  }

  private assertValid(subject: string, issues: string[]): void {
    if (issues.length) throw new DomainError('VALIDATION', `Invalid ${subject}`, issues);
  }

  private event(
    ctx: CommandContext,
    type: DomainEventType,
    subject: SystemFields,
    data: Record<string, unknown>,
  ): DomainEvent {
    return {
      id: this.newId(),
      type,
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      occurredAt: this.clock.now().toISOString(),
      subjectId: subject.id,
      version: subject.version,
      data,
    };
  }

  private commit(
    ctx: CommandContext,
    state: Partial<Pick<ChangeSet, 'elements' | 'relationships'>>,
    events: DomainEvent[],
  ): Promise<void> {
    return this.repo.apply(ctx.workspaceId, {
      elements: state.elements ?? [],
      relationships: state.relationships ?? [],
      events,
    });
  }
}

function applyAttrChanges(current: Attributes, input: UpdateInput): Attributes {
  const next: Attributes = { ...current, ...input.set };
  for (const k of input.unset ?? []) delete next[k];
  return next;
}

type Diffable = { attrs: Attributes; validFrom: IsoDate | null; validTo: IsoDate | null };

/** Field-level changes as `{ field: { from, to } }`; attributes are prefixed with `attrs.`. */
function diff(a: Diffable, b: Diffable): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)])) {
    if (JSON.stringify(a.attrs[k]) !== JSON.stringify(b.attrs[k])) {
      out[`attrs.${k}`] = { from: a.attrs[k] ?? null, to: b.attrs[k] ?? null };
    }
  }
  for (const k of ['validFrom', 'validTo'] as const) {
    if (a[k] !== b[k]) out[k] = { from: a[k], to: b[k] };
  }
  return out;
}
