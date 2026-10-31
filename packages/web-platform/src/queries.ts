import { QueryClient } from '@tanstack/react-query';

/** One query cache for the whole app: modules share what they read (the user, workspaces, elements). */
export const createQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

/**
 * Keys of the queries more than one module reads or invalidates. A module's own queries keep
 * their keys next to the query, starting with the module id.
 */
export const keys = {
  me: ['me'] as const,
  workspaces: ['workspaces'] as const,
  metamodel: (ws: string) => ['metamodel', ws] as const,
  /** Every element list and lookup in a workspace (invalidate after model changes). */
  elements: (ws: string) => ['elements', ws] as const,
  element: (ws: string, id: string) => ['element', ws, id] as const,
  schedules: (ws: string) => ['schedules', ws] as const,
  catalog: ['catalog'] as const,
};
