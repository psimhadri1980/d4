import { useQuery } from '@tanstack/react-query';
import { MetamodelRegistry } from '@d4/metamodel';
import { api } from './api';
import { keys } from './queries';

/** The signed-in user as the API sees them: id, tenant and realm roles. */
export const useMe = () => useQuery({ queryKey: keys.me, queryFn: api.me });

/** Who sees a screen or menu item. Hidden items are not rendered at all (the API still enforces access). */
export interface Access {
  admin: boolean;
  author: boolean;
  steward: boolean;
  /** Reviews change proposals (workspace-bound roles are checked by the API). */
  reviewer: boolean;
}

/** The current user's roles decide which screens they get. */
export function accessOf(roles: string[] | undefined): Access {
  const has = (...r: string[]) => !!roles && r.some((x) => roles.includes(x));
  return {
    admin: has('admin'),
    author: has('query-author', 'admin'),
    steward: has('query-steward', 'admin'),
    reviewer: has('architect', 'admin'),
  };
}

/** The current user's access, or undefined while `/v1/me` loads. */
export function useAccess(): Access | undefined {
  const me = useMe();
  return me.data ? accessOf(me.data.roles) : undefined;
}

/** Roles a binding can grant (same list as the API's). */
export const ROLES = [
  'viewer',
  'contributor',
  'planner',
  'architect',
  'query-author',
  'query-steward',
  'admin',
] as const;

/** The workspace metamodel as a registry: same rules the server enforces. */
export function useRegistry(ws: string | undefined) {
  return useQuery({
    queryKey: keys.metamodel(ws ?? ''),
    enabled: !!ws,
    staleTime: Infinity,
    queryFn: async () => new MetamodelRegistry(await api.metamodel(ws!)),
  });
}
