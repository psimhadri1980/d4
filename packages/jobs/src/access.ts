import { RoleStore, ROLES, TenantStore, UserStore, WorkspaceStore, type Db } from '@d4/db';

/**
 * Can this user still read the workspace? Background work (scheduled reports) runs long after the
 * user set it up, so it re-checks: tenant active, workspace live, user present, and at least one
 * role from their realm roles at the last sign-in plus current workspace/tenant role bindings.
 * Binding changes apply at once; IdP role changes apply after the user's next sign-in.
 */
export async function canStillRead(db: Db, tenantId: string, workspaceId: string, userId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const tenant = await new TenantStore(db).get(tenantId);
  if (!tenant || tenant.status !== 'active') return { ok: false, reason: 'the tenant is not active' };
  const ws = await new WorkspaceStore(db).get(tenantId, workspaceId);
  if (!ws || ws.archivedAt) return { ok: false, reason: 'the workspace no longer exists' };
  const user = await new UserStore(db).get(tenantId, userId);
  if (!user) return { ok: false, reason: 'the owner no longer exists' };
  const known = new Set<string>(ROLES);
  const roles = [...user.realmRoles.filter((r) => known.has(r)), ...(await new RoleStore(db).effectiveRoles(tenantId, userId, workspaceId))];
  return roles.length ? { ok: true } : { ok: false, reason: 'the owner no longer has access to the workspace' };
}
