import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from './client';
import { webModules } from './schema';

export type WebModuleRow = typeof webModules.$inferSelect;
export type WebModuleFields = Pick<WebModuleRow, 'title' | 'description' | 'owner' | 'entry' | 'version' | 'contract' | 'framework' | 'enabled'>;

/** The module registry (D64), per tenant. */
export class WebModuleStore {
  constructor(private readonly db: DbOrTx) {}

  async list(tenantId: string): Promise<WebModuleRow[]> {
    return this.db.select().from(webModules).where(eq(webModules.tenantId, tenantId)).orderBy(asc(webModules.name));
  }

  async get(tenantId: string, name: string): Promise<WebModuleRow | undefined> {
    const [row] = await this.db.select().from(webModules).where(and(eq(webModules.tenantId, tenantId), eq(webModules.name, name)));
    return row;
  }

  /** Registers a module, or updates its entry and details (a new release). */
  async put(tenantId: string, name: string, fields: WebModuleFields, by: string): Promise<WebModuleRow> {
    const [row] = await this.db
      .insert(webModules)
      .values({ tenantId, name, ...fields, createdBy: by })
      .onConflictDoUpdate({ target: [webModules.tenantId, webModules.name], set: { ...fields, updatedAt: sql`now()` } })
      .returning();
    return row!;
  }

  /** Registers a module only if it is not there yet (seeds; keeps an admin's changes). */
  async putIfAbsent(tenantId: string, name: string, fields: WebModuleFields, by: string): Promise<void> {
    await this.db.insert(webModules).values({ tenantId, name, ...fields, createdBy: by }).onConflictDoNothing();
  }

  async remove(tenantId: string, name: string): Promise<boolean> {
    const rows = await this.db.delete(webModules).where(and(eq(webModules.tenantId, tenantId), eq(webModules.name, name))).returning({ name: webModules.name });
    return rows.length > 0;
  }
}
