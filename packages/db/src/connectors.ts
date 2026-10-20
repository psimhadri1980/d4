import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { ulid } from '@d4/core';
import type { Db, DbOrTx } from './client';
import { connectorItems, connectors } from './schema';

export type ConnectorRow = typeof connectors.$inferSelect;
export type ConnectorItemRow = typeof connectorItems.$inferSelect;

export type NewConnector = Pick<ConnectorRow, 'workspaceId' | 'key' | 'name' | 'kind' | 'config' | 'mapping' | 'conflictPolicy' | 'createdBy'> &
  Partial<Pick<ConnectorRow, 'secret' | 'cadence' | 'nextRunAt' | 'enabled'>>;
export type ConnectorChanges = Partial<Pick<ConnectorRow, 'name' | 'config' | 'mapping' | 'secret' | 'conflictPolicy' | 'cadence' | 'nextRunAt' | 'enabled'>>;

export class ConnectorStore {
  constructor(private readonly db: DbOrTx) {}

  async create(tenantId: string, c: NewConnector): Promise<ConnectorRow> {
    const [row] = await this.db.insert(connectors).values({ id: ulid(), tenantId, ...c }).returning();
    return row!;
  }

  async get(tenantId: string, workspaceId: string, id: string): Promise<ConnectorRow | undefined> {
    const [row] = await this.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenantId, tenantId), eq(connectors.workspaceId, workspaceId), eq(connectors.id, id)));
    return row;
  }

  async byKey(tenantId: string, workspaceId: string, key: string): Promise<ConnectorRow | undefined> {
    const [row] = await this.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenantId, tenantId), eq(connectors.workspaceId, workspaceId), eq(connectors.key, key)));
    return row;
  }

  async list(tenantId: string, workspaceId: string): Promise<ConnectorRow[]> {
    return this.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenantId, tenantId), eq(connectors.workspaceId, workspaceId)))
      .orderBy(asc(connectors.name), asc(connectors.id));
  }

  async update(tenantId: string, id: string, changes: ConnectorChanges): Promise<ConnectorRow | undefined> {
    const [row] = await this.db
      .update(connectors)
      .set({ ...changes, updatedAt: sql`now()` })
      .where(and(eq(connectors.tenantId, tenantId), eq(connectors.id, id)))
      .returning();
    return row;
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.db.delete(connectors).where(and(eq(connectors.tenantId, tenantId), eq(connectors.id, id))).returning({ id: connectors.id });
    return rows.length > 0;
  }

  async recordRun(tenantId: string, id: string, jobId: string, at: Date): Promise<void> {
    await this.db.update(connectors).set({ lastJobId: jobId, lastRunAt: at }).where(and(eq(connectors.tenantId, tenantId), eq(connectors.id, id)));
  }

  async items(connectorId: string): Promise<ConnectorItemRow[]> {
    return this.db.select().from(connectorItems).where(eq(connectorItems.connectorId, connectorId));
  }

  /** Records what a sync wrote or confirmed (upsert by external key). */
  async saveItems(connectorId: string, items: Omit<ConnectorItemRow, 'connectorId' | 'syncedAt'>[]): Promise<void> {
    for (let i = 0; i < items.length; i += 500) {
      const batch = items.slice(i, i + 500).map((x) => ({ connectorId, ...x }));
      await this.db
        .insert(connectorItems)
        .values(batch)
        .onConflictDoUpdate({
          target: [connectorItems.connectorId, connectorItems.externalKey],
          set: { elementId: sql`excluded.element_id`, syncedVersion: sql`excluded.synced_version`, sourceHash: sql`excluded.source_hash`, syncedAt: sql`now()` },
        });
    }
  }

  async forgetItems(connectorId: string, externalKeys: string[]): Promise<void> {
    if (!externalKeys.length) return;
    await this.db.delete(connectorItems).where(and(eq(connectorItems.connectorId, connectorId), inArray(connectorItems.externalKey, externalKeys)));
  }
}

/**
 * Claims connectors whose scheduled sync is due and moves each one's next run forward in the
 * same transaction (as for report schedules), so several workers never start the same sync twice.
 */
export async function claimDueConnectors(db: Db, now: Date, nextRun: (row: ConnectorRow) => Date, limit = 20): Promise<ConnectorRow[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(connectors)
      .where(and(eq(connectors.enabled, true), lte(connectors.nextRunAt, now)))
      .orderBy(asc(connectors.nextRunAt))
      .limit(limit)
      .for('update', { skipLocked: true });
    for (const row of due) await tx.update(connectors).set({ nextRunAt: nextRun(row) }).where(eq(connectors.id, row.id));
    return due;
  });
}
