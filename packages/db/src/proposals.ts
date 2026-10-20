import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { ulid } from '@d4/core';
import type { Db, DbOrTx } from './client';
import { changeProposals, PROPOSAL_STATUSES } from './schema';

export type ProposalRow = typeof changeProposals.$inferSelect;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export interface NewProposal {
  workspaceId: string;
  title: string;
  description?: string | null;
  operations: unknown[];
  createdBy: string;
}

export class ProposalStore {
  constructor(private readonly db: DbOrTx) {}

  async create(tenantId: string, p: NewProposal): Promise<ProposalRow> {
    const [row] = await this.db.insert(changeProposals).values({ id: ulid(), tenantId, ...p }).returning();
    return row!;
  }

  async get(tenantId: string, workspaceId: string, id: string): Promise<ProposalRow | undefined> {
    const [row] = await this.db
      .select()
      .from(changeProposals)
      .where(and(eq(changeProposals.tenantId, tenantId), eq(changeProposals.workspaceId, workspaceId), eq(changeProposals.id, id)));
    return row;
  }

  async list(tenantId: string, workspaceId: string, statuses?: ProposalStatus[]): Promise<ProposalRow[]> {
    return this.db
      .select()
      .from(changeProposals)
      .where(
        and(
          eq(changeProposals.tenantId, tenantId),
          eq(changeProposals.workspaceId, workspaceId),
          ...(statuses?.length ? [inArray(changeProposals.status, statuses)] : []),
        ),
      )
      .orderBy(desc(changeProposals.updatedAt), desc(changeProposals.id))
      .limit(200);
  }

  /** Changes a draft's content. Returns undefined when it is no longer a draft. */
  async editDraft(tenantId: string, id: string, changes: Partial<Pick<ProposalRow, 'title' | 'description' | 'operations'>>): Promise<ProposalRow | undefined> {
    const [row] = await this.db
      .update(changeProposals)
      .set({ ...changes, updatedAt: sql`now()` })
      .where(and(eq(changeProposals.tenantId, tenantId), eq(changeProposals.id, id), eq(changeProposals.status, 'draft')))
      .returning();
    return row;
  }

  /**
   * Moves a proposal from one of `from` to `to`, only if it is still in one of them, so two people
   * acting at once cannot both succeed. Returns undefined when the status had already moved on.
   */
  async transition(
    tenantId: string,
    id: string,
    from: ProposalStatus[],
    to: ProposalStatus,
    fields: Partial<Pick<ProposalRow, 'submittedAt' | 'decidedBy' | 'decidedAt' | 'reviewComment' | 'appliedRefs'>> = {},
  ): Promise<ProposalRow | undefined> {
    const [row] = await this.db
      .update(changeProposals)
      .set({ status: to, ...fields, updatedAt: sql`now()` })
      .where(and(eq(changeProposals.tenantId, tenantId), eq(changeProposals.id, id), inArray(changeProposals.status, from)))
      .returning();
    return row;
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(changeProposals)
      .where(and(eq(changeProposals.tenantId, tenantId), eq(changeProposals.id, id), eq(changeProposals.status, 'draft')))
      .returning({ id: changeProposals.id });
    return rows.length > 0;
  }
}

/**
 * Runs `fn` while holding a row lock on the proposal, so only one reviewer can apply it. The lock
 * is held while `fn` writes the graph; if `fn` throws, nothing about the proposal changes.
 */
export async function withLockedProposal<T>(db: Db, tenantId: string, id: string, fn: (row: ProposalRow, store: ProposalStore) => Promise<T>): Promise<T | undefined> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(changeProposals)
      .where(and(eq(changeProposals.tenantId, tenantId), eq(changeProposals.id, id)))
      .for('update');
    if (!row) return undefined;
    return fn(row, new ProposalStore(tx));
  });
}
