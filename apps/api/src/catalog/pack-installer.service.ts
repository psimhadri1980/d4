import { Inject, Injectable } from '@nestjs/common';
import { loadPack, type SystemQuery } from '@d4/cypher';
import { QueryCatalogStore } from '@d4/db';
import { Database } from '../infra/database.service';

/** Actor recorded on system-pack entries and versions. */
const SYSTEM_ACTOR = 'system';

/**
 * Keeps each tenant's catalog in step with the built-in system pack. Runs once per tenant per
 * process (on first catalog access) and is idempotent: unchanged queries are left alone, new ones
 * are published with their default grants, changed ones get a new published version while the
 * previous version is deprecated.
 */
@Injectable()
export class PackInstaller {
  private readonly pack: SystemQuery[] = loadPack();
  private readonly installed = new Map<string, Promise<void>>();

  constructor(@Inject(Database) private readonly database: Database) {}

  ensureInstalled(tenantId: string): Promise<void> {
    let p = this.installed.get(tenantId);
    if (!p) {
      p = this.install(tenantId);
      p.catch(() => this.installed.delete(tenantId));
      this.installed.set(tenantId, p);
    }
    return p;
  }

  private async install(tenantId: string): Promise<void> {
    for (const q of this.pack) {
      await this.database.db.transaction(async (tx) => {
        const store = new QueryCatalogStore(tx);
        const existing = await store.bySlug(tenantId, q.slug);
        const entry =
          existing ??
          (await store.create(
            tenantId,
            { slug: q.slug, title: q.title, description: q.description, tags: q.tags, system: true },
            SYSTEM_ACTOR,
          ));
        if (!existing) {
          await store.setGrants(
            entry.id,
            q.defaultRoles.map((role) => ({ principalType: 'role' as const, principal: role })),
            SYSTEM_ACTOR,
          );
          await store.updateMeta(tenantId, entry.id, { certified: true });
        } else if (existing.system) {
          await store.updateMeta(tenantId, entry.id, { title: q.title, description: q.description, tags: q.tags });
        } else {
          // A tenant query already uses this slug; never overwrite tenant content.
          return;
        }

        const current = await store.latestPublished(entry.id);
        if (current?.contentHash === q.contentHash) return;

        const version = await store.saveDraft(
          entry.id,
          { cypher: q.cypher, params: q.params, resultShape: q.resultShape, kind: 'read', contentHash: q.contentHash },
          SYSTEM_ACTOR,
        );
        await store.setChecks(version.id, { errors: [], warnings: q.warnings, source: 'system-pack' });
        await store.setStatus(version.id, 'in_review', SYSTEM_ACTOR);
        await store.setStatus(version.id, 'published', SYSTEM_ACTOR, 'system pack');
        if (current) await store.setStatus(current.id, 'deprecated', SYSTEM_ACTOR, 'superseded by system pack');
      });
    }
  }
}
