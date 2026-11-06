import { and, asc, eq, or, sql } from 'drizzle-orm';
import type { DbOrTx } from './client';
import { studioLenses } from './schema';

export type StudioLensRow = typeof studioLenses.$inferSelect;
export type StudioLensFields = Pick<StudioLensRow, 'name' | 'description' | 'visibility' | 'body'>;

/** Saved Graph Studio lenses, per workspace (D82). */
export class StudioLensStore {
  constructor(private readonly db: DbOrTx) {}

  /** What `userId` sees: their own lenses and every workspace lens, by name. */
  async list(tenantId: string, workspaceId: string, userId: string): Promise<StudioLensRow[]> {
    return this.db
      .select()
      .from(studioLenses)
      .where(and(eq(studioLenses.tenantId, tenantId), eq(studioLenses.workspaceId, workspaceId), or(eq(studioLenses.visibility, 'workspace'), eq(studioLenses.createdBy, userId))))
      .orderBy(asc(studioLenses.name), asc(studioLenses.id));
  }

  async get(tenantId: string, workspaceId: string, id: string): Promise<StudioLensRow | undefined> {
    const [row] = await this.db
      .select()
      .from(studioLenses)
      .where(and(eq(studioLenses.tenantId, tenantId), eq(studioLenses.workspaceId, workspaceId), eq(studioLenses.id, id)));
    return row;
  }

  async create(tenantId: string, workspaceId: string, id: string, fields: StudioLensFields, by: string): Promise<StudioLensRow> {
    const [row] = await this.db.insert(studioLenses).values({ id, tenantId, workspaceId, ...fields, createdBy: by }).returning();
    return row!;
  }

  async update(tenantId: string, workspaceId: string, id: string, fields: StudioLensFields): Promise<StudioLensRow | undefined> {
    const [row] = await this.db
      .update(studioLenses)
      .set({ ...fields, updatedAt: sql`now()` })
      .where(and(eq(studioLenses.tenantId, tenantId), eq(studioLenses.workspaceId, workspaceId), eq(studioLenses.id, id)))
      .returning();
    return row;
  }

  async remove(tenantId: string, workspaceId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(studioLenses)
      .where(and(eq(studioLenses.tenantId, tenantId), eq(studioLenses.workspaceId, workspaceId), eq(studioLenses.id, id)))
      .returning({ id: studioLenses.id });
    return rows.length > 0;
  }
}
