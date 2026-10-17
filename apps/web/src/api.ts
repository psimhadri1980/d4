import type { Element, Relationship } from '@d4/core';
import type { Metamodel } from '@d4/metamodel';
import { userManager } from './auth';
import { config } from './config';

export type { Element, Relationship };

/** Error body shared by REST and GraphQL (`extensions.code`). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: string[] = [],
    readonly ruleId?: string,
  ) {
    super(message);
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const user = await userManager.getUser();
  return user ? { authorization: `Bearer ${user.access_token}` } : {};
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: { ...(await authHeader()), ...(body !== undefined && { 'content-type': 'application/json' }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      String(json['error'] ?? res.status),
      String(json['message'] ?? res.statusText),
      (json['issues'] as string[] | undefined) ?? [],
      json['ruleId'] as string | undefined,
    );
  }
  return json as T;
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  description: string | null;
}

export interface ElementPage {
  items: Element[];
  endCursor: string | null;
  hasMore: boolean;
}

export interface Connection {
  relationship: Relationship;
  other: Element;
}

export interface Subgraph {
  root: Element;
  elements: Element[];
  relationships: Relationship[];
  truncated: boolean;
}

export interface DomainEvent {
  seq: number;
  id: string;
  type: string;
  actor: string;
  occurredAt: string;
  version: number;
  data: Record<string, unknown>;
}

export interface ListFilter {
  type?: string[];
  layer?: string;
  lifecycle?: string[];
  q?: string;
  first?: number;
  after?: string;
}

const qs = (params: Record<string, string | number | string[] | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
};

export interface AttrChanges {
  set?: Record<string, unknown>;
  unset?: string[];
  validFrom?: string | null;
  validTo?: string | null;
}

/** REST commands and reads (see /v1/openapi.json). */
export const api = {
  workspaces: () => request<Workspace[]>('GET', '/v1/workspaces'),
  metamodel: (ws: string) => request<Metamodel>('GET', `/v1/workspaces/${ws}/metamodel`),
  me: () => request<{ userId: string; roles: string[]; tenantId: string }>('GET', '/v1/me'),

  listElements: (ws: string, f: ListFilter) =>
    request<ElementPage>('GET', `/v1/workspaces/${ws}/elements${qs({ ...f })}`),
  element: (ws: string, id: string) => request<Element>('GET', `/v1/workspaces/${ws}/elements/${id}`),
  connections: (ws: string, id: string) =>
    request<Connection[]>('GET', `/v1/workspaces/${ws}/elements/${id}/relationships`),
  neighbourhood: (ws: string, id: string, depth: number) =>
    request<Subgraph>('GET', `/v1/workspaces/${ws}/elements/${id}/neighbourhood${qs({ depth, limit: 800 })}`),
  history: (ws: string, id: string) => request<DomainEvent[]>('GET', `/v1/workspaces/${ws}/elements/${id}/history`),

  createElement: (ws: string, body: { type: string; attrs: Record<string, unknown>; validFrom?: string | null; validTo?: string | null }) =>
    request<Element>('POST', `/v1/workspaces/${ws}/elements`, body),
  updateElement: (ws: string, id: string, expectedVersion: number, changes: AttrChanges) =>
    request<Element>('PATCH', `/v1/workspaces/${ws}/elements/${id}`, { expectedVersion, ...changes }),
  deleteElement: (ws: string, id: string, expectedVersion: number) =>
    request<void>('DELETE', `/v1/workspaces/${ws}/elements/${id}${qs({ expectedVersion })}`),

  createRelationship: (
    ws: string,
    body: { type: string; fromId: string; toId: string; attrs?: Record<string, unknown>; validFrom?: string | null; validTo?: string | null },
  ) => request<Relationship>('POST', `/v1/workspaces/${ws}/relationships`, body),
  deleteRelationship: (ws: string, id: string, expectedVersion: number) =>
    request<void>('DELETE', `/v1/workspaces/${ws}/relationships/${id}${qs({ expectedVersion })}`),
};
