import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { stageProposal, type ModelReader, type ProposalOperation, type StagedProposal } from '@d4/core';
import { PROPOSAL_STATUSES, ProposalStore, withLockedProposal, type ProposalRow } from '@d4/db';
import type { Principal } from '../auth/identity';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { parse } from '../http/errors';
import { CreateProposalBody, EditProposalBody, ReviewBody, z } from '../http/schemas';
import { Database } from '../infra/database.service';
import { ModelFactory } from './model.factory';
import { WorkspaceAccess, type Access, type WorkspaceScope } from './workspace-access.service';

// `status` may repeat (`?status=a&status=b`) or be comma-separated (`?status=a,b`, as the web client sends it).
const ListQuery = z.object({
  status: z
    .preprocess((v) => ([] as unknown[]).concat(v ?? []).flatMap((s) => (typeof s === 'string' ? s.split(',').map((x) => x.trim()).filter(Boolean) : [s])), z.array(z.enum(PROPOSAL_STATUSES)))
    .optional(),
});

/**
 * Change proposals: model changes drafted by a contributor, checked against the live model, and
 * applied as one change when an architect or admin (not the author) approves. Approval re-runs
 * every step against the model as it is then, so a proposal whose items changed meanwhile is
 * refused with the failing step instead of overwriting newer work.
 */
@Controller('v1/workspaces/:ws/proposals')
export class ProposalsController {
  constructor(
    @Inject(WorkspaceAccess) private readonly access: WorkspaceAccess,
    @Inject(ModelFactory) private readonly models: ModelFactory,
    @Inject(Database) private readonly database: Database,
  ) {}

  @Get()
  async list(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Query() query: unknown) {
    const q = parse(ListQuery, query);
    const scope = await this.access.resolve(p, ws, 'read');
    const statuses = q.status?.length ? q.status : undefined;
    return (await this.store().list(scope.tenantId, scope.workspaceId, statuses)).map(summary);
  }

  @Post()
  @HttpCode(201)
  async create(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Body() body: unknown) {
    const b = parse(CreateProposalBody, body);
    const scope = await this.access.resolve(p, ws, 'write');
    const row = await this.store().create(scope.tenantId, { workspaceId: scope.workspaceId, title: b.title, description: b.description ?? null, operations: b.operations, createdBy: p.userId });
    return this.detail(scope, row);
  }

  /** The proposal with each step described, and whether it would apply to the model as it is now. */
  @Get(':id')
  async get(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('id') id: string) {
    const { scope, row } = await this.find(p, ws, id, 'read');
    return this.detail(scope, row);
  }

  @Patch(':id')
  async edit(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(EditProposalBody, body);
    const { scope, row } = await this.find(p, ws, id, 'write');
    this.author(p, row);
    const updated = await this.store().editDraft(scope.tenantId, id, b);
    if (!updated) throw new ConflictException(`Only drafts can be changed; this proposal is ${row.status}`);
    return this.detail(scope, updated);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('id') id: string) {
    const { scope, row } = await this.find(p, ws, id, 'write');
    this.author(p, row);
    if (!(await this.store().remove(scope.tenantId, id))) throw new ConflictException(`Only drafts can be deleted; withdraw a ${row.status} proposal instead`);
  }

  /** Sends a draft for review; it must apply cleanly to the current model. */
  @Post(':id/submit')
  async submit(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('id') id: string) {
    const { scope, row } = await this.find(p, ws, id, 'write');
    this.author(p, row);
    const ops = row.operations as ProposalOperation[];
    if (!ops.length) throw new BadRequestException('Add at least one change before submitting');
    const staged = await this.stage(scope, row);
    if (!staged.ok) throw new ConflictException(failure(staged));
    return this.moved(scope, await this.store().transition(scope.tenantId, id, ['draft'], 'submitted', { submittedAt: new Date() }), row);
  }

  /** Takes a submitted proposal back to draft so the author can change it. */
  @Post(':id/reopen')
  async reopen(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('id') id: string) {
    const { scope, row } = await this.find(p, ws, id, 'write');
    this.author(p, row);
    return this.moved(scope, await this.store().transition(scope.tenantId, id, ['submitted'], 'draft', { submittedAt: null }), row);
  }

  @Post(':id/withdraw')
  async withdraw(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('id') id: string) {
    const { scope, row } = await this.find(p, ws, id, 'write');
    this.author(p, row);
    return this.moved(scope, await this.store().transition(scope.tenantId, id, ['draft', 'submitted'], 'withdrawn'), row);
  }

  @Post(':id/reject')
  async reject(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('id') id: string, @Body() body: unknown) {
    const { comment } = parse(ReviewBody, body ?? {});
    if (!comment) throw new BadRequestException('Say why the proposal is rejected');
    const { scope, row } = await this.find(p, ws, id, 'review');
    this.notAuthor(p, row);
    return this.moved(scope, await this.store().transition(scope.tenantId, id, ['submitted'], 'rejected', { decidedBy: p.userId, decidedAt: new Date(), reviewComment: comment }), row);
  }

  /** Applies every step as one change, then marks the proposal applied. */
  @Post(':id/approve')
  async approve(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('id') id: string, @Body() body: unknown) {
    const { comment } = parse(ReviewBody, body ?? {});
    const { scope, row } = await this.find(p, ws, id, 'review');
    this.notAuthor(p, row);
    const { repository } = this.models.for(scope);
    // The row lock makes a second approver wait, then see the proposal already applied.
    const applied = await withLockedProposal(this.database.db, scope.tenantId, id, async (locked, store) => {
      if (locked.status !== 'submitted') throw new ConflictException(`The proposal is ${locked.status}, not waiting for review`);
      const staged = await this.stage(scope, locked);
      if (!staged.ok) throw new ConflictException(failure(staged));
      const change = staged.change!;
      // Events keep the author as actor and record the proposal and who approved it.
      for (const e of change.events) e.data = { ...e.data, proposalId: id, approvedBy: p.userId };
      if (change.events.length) await repository.apply(scope.workspaceId, change);
      return store.transition(scope.tenantId, id, ['submitted'], 'applied', { decidedBy: p.userId, decidedAt: new Date(), reviewComment: comment ?? null, appliedRefs: staged.refs });
    });
    return this.moved(scope, applied, row);
  }

  private store() {
    return new ProposalStore(this.database.db);
  }

  private async find(p: Principal, ws: string, id: string, access: Access) {
    const scope = await this.access.resolve(p, ws, access);
    const row = await this.store().get(scope.tenantId, scope.workspaceId, id);
    if (!row) throw new NotFoundException(`Proposal '${id}' not found`);
    return { scope, row };
  }

  private author(p: Principal, row: ProposalRow) {
    if (row.createdBy !== p.userId) throw new ForbiddenException('Only the author can do this');
  }

  private notAuthor(p: Principal, row: ProposalRow) {
    if (row.createdBy === p.userId) throw new ForbiddenException('Someone other than the author must review a proposal');
  }

  private moved(scope: WorkspaceScope, next: ProposalRow | undefined, before: ProposalRow) {
    if (!next) throw new ConflictException(`The proposal is ${before.status}; that is not possible now`);
    return this.detail(scope, next);
  }

  private stage(scope: WorkspaceScope, row: ProposalRow): Promise<StagedProposal> {
    const { repository } = this.models.for(scope);
    // The author is the actor of every change, whoever approves it.
    return stageProposal(scope.registry, repository, { workspaceId: scope.workspaceId, actor: row.createdBy }, row.operations as ProposalOperation[]);
  }

  /** Final proposals are shown as recorded; open ones are checked against the live model. */
  private async detail(scope: WorkspaceScope, row: ProposalRow) {
    const ops = row.operations as ProposalOperation[];
    const open = row.status === 'draft' || row.status === 'submitted';
    const staged = open && ops.length ? await this.stage(scope, row) : undefined;
    const { repository } = this.models.for(scope);
    return {
      ...summary(row),
      operations: ops,
      steps: await describe(repository, scope.workspaceId, ops, staged, (row.appliedRefs as Record<string, string> | null) ?? {}),
      check: staged ? { ok: staged.ok } : null,
    };
  }
}

const summary = (r: ProposalRow) => ({
  id: r.id,
  workspaceId: r.workspaceId,
  title: r.title,
  description: r.description,
  status: r.status,
  stepCount: (r.operations as unknown[]).length,
  createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  submittedAt: r.submittedAt?.toISOString() ?? null,
  decidedBy: r.decidedBy,
  decidedAt: r.decidedAt?.toISOString() ?? null,
  reviewComment: r.reviewComment,
});

const failure = (s: StagedProposal) => {
  const bad = s.steps.find((x) => x.error)!;
  return `Step ${bad.index + 1} cannot be applied: ${bad.error!.message}`;
};

/** A readable line per step, using names from the model or from earlier steps. */
async function describe(repo: ModelReader, ws: string, ops: ProposalOperation[], staged: StagedProposal | undefined, appliedRefs: Record<string, string>) {
  const refNames = new Map<string, string>();
  for (const o of ops) if (o.op === 'createElement') refNames.set(o.ref, `${o.type} '${String(o.attrs['name'] ?? o.ref)}'`);
  const elName = async (idOrRef: string) => {
    if (refNames.has(idOrRef)) return refNames.get(idOrRef)!;
    const el = await repo.getElement(ws, idOrRef);
    return el ? `${el.type} '${String(el.attrs['name'] ?? el.id)}'` : `missing element ${idOrRef}`;
  };
  const relName = async (id: string) => {
    const r = await repo.getRelationship(ws, id);
    return r ? `${await elName(r.fromId)} ${r.type} ${await elName(r.toId)}` : `missing relationship ${id}`;
  };
  const fields = (o: { set?: Record<string, unknown>; unset?: string[]; validFrom?: unknown; validTo?: unknown }) =>
    [...Object.keys(o.set ?? {}), ...(o.unset ?? []).map((k) => `−${k}`), ...(o.validFrom !== undefined ? ['validFrom'] : []), ...(o.validTo !== undefined ? ['validTo'] : [])].join(', ');

  return Promise.all(
    ops.map(async (o, i) => {
      let text: string;
      switch (o.op) {
        case 'createElement':
          text = `Add ${refNames.get(o.ref)}`;
          break;
        case 'updateElement':
          text = `Change ${await elName(o.id)}: ${fields(o)}`;
          break;
        case 'deleteElement':
          text = `Delete ${await elName(o.id)} and its relationships`;
          break;
        case 'createRelationship':
          text = `Connect ${await elName(o.from)} ${o.type} ${await elName(o.to)}`;
          break;
        case 'updateRelationship':
          text = `Change ${await relName(o.id)}: ${fields(o)}`;
          break;
        case 'deleteRelationship':
          text = `Delete ${await relName(o.id)}`;
          break;
      }
      const step = staged?.steps[i];
      return {
        index: i,
        op: o.op,
        text,
        subjectId: step?.subjectId ?? (o.op === 'createElement' ? appliedRefs[o.ref] : 'id' in o ? o.id : undefined) ?? null,
        // Unchecked: a step after a failing one, or a final proposal.
        state: !staged ? 'unchecked' : !step ? 'unchecked' : step.error ? 'error' : 'ok',
        error: step?.error ?? null,
      };
    }),
  );
}
