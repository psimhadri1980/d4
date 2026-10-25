import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { MetamodelStore, RoleStore, WorkspaceStore } from '@d4/db';
import type { CommandContext } from '@d4/core';
import { MetamodelRegistry } from '@d4/metamodel';
import { hasAnyRole, type Principal, type Role } from '../auth/identity';
import { Database } from '../infra/database.service';

export type Access = 'read' | 'write' | 'review';

/** Roles that may change the model. Any role at all grants read access. */
const WRITE_ROLES: readonly Role[] = ['contributor', 'planner', 'architect'];
/** Roles that may approve or reject change proposals (admins always may). */
const REVIEW_ROLES: readonly Role[] = ['architect'];

export interface WorkspaceScope {
  tenantId: string;
  workspaceId: string;
  registry: MetamodelRegistry;
  /** Command context for ModelService; the actor is the D4 user id. */
  ctx: CommandContext;
}

/**
 * Resolves a workspace for the caller's tenant, checks access (tenant-wide roles plus roles
 * bound to that workspace) and supplies the workspace's metamodel registry.
 */
@Injectable()
export class WorkspaceAccess {
  private readonly registries = new Map<string, Promise<MetamodelRegistry>>();

  constructor(@Inject(Database) private readonly database: Database) {}

  async resolve(principal: Principal, workspaceId: string, access: Access): Promise<WorkspaceScope> {
    const db = this.database.db;
    const ws = await new WorkspaceStore(db).get(principal.tenantId, workspaceId);
    // Same response for "missing" and "other tenant's", so ids can't be probed.
    if (!ws || ws.archivedAt) throw new NotFoundException(`Workspace '${workspaceId}' not found`);

    let roles = principal.roles;
    if (!this.allows(roles, access)) {
      const bound = await new RoleStore(db).effectiveRoles(principal.tenantId, principal.userId, ws.id);
      roles = [...new Set([...roles, ...bound])];
      if (!this.allows(roles, access)) {
        throw new ForbiddenException(`No ${access} access to workspace '${workspaceId}'`);
      }
    }

    return {
      tenantId: principal.tenantId,
      workspaceId: ws.id,
      registry: await this.registry(principal.tenantId, ws.metamodelId),
      ctx: { workspaceId: ws.id, actor: principal.userId },
    };
  }

  private allows(roles: readonly Role[], access: Access): boolean {
    if (access === 'read') return roles.length > 0;
    return hasAnyRole(roles, access === 'review' ? REVIEW_ROLES : WRITE_ROLES);
  }

  /** Metamodel versions are immutable, so registries are cached by id. */
  private registry(tenantId: string, metamodelId: string): Promise<MetamodelRegistry> {
    const key = `${tenantId}|${metamodelId}`;
    let r = this.registries.get(key);
    if (!r) {
      r = new MetamodelStore(this.database.db)
        .get(tenantId, metamodelId)
        .then((mm) => new MetamodelRegistry(mm));
      r.catch(() => this.registries.delete(key));
      this.registries.set(key, r);
    }
    return r;
  }
}
