import type { LaneKind, RoadmapView } from '@d4/core';
import { d4, type Schemas, type ViewParams } from '@d4/web-platform';

export type ProposalOperation = Schemas['ProposalOperation'];
export type Proposal = Schemas['Proposal'];
export type ProposalStatus = Proposal['status'];

const text = (v: string | undefined) => v || undefined;

export const planApi = {
  // The core type is the source of truth for the Gantt (the document widens its enums to strings).
  roadmap: async (ws: string, scope: string[], lanes: LaneKind) =>
    (await d4().get('/v1/workspaces/{ws}/roadmap', {
      path: { ws },
      query: { scope: scope.join(','), lanes },
    })) as RoadmapView,
  decisions: (ws: string, v: ViewParams = {}) =>
    d4().get('/v1/workspaces/{ws}/decisions', {
      path: { ws },
      query: { asOf: text(v.asOf), scenario: text(v.scenario) },
    }),
};

type Action = 'submit' | 'reopen' | 'withdraw' | 'approve' | 'reject';

export const proposalsApi = {
  list: (ws: string, status?: ProposalStatus[]) =>
    d4().get('/v1/workspaces/{ws}/proposals', {
      path: { ws },
      query: { status: status?.length ? status.join(',') : undefined },
    }),
  get: (ws: string, id: string) =>
    d4().get('/v1/workspaces/{ws}/proposals/{id}', { path: { ws, id } }),
  create: (
    ws: string,
    body: { title: string; description?: string; operations?: ProposalOperation[] },
  ) => d4().post('/v1/workspaces/{ws}/proposals', { path: { ws }, body }),
  edit: (
    ws: string,
    id: string,
    body: { title?: string; description?: string | null; operations?: ProposalOperation[] },
  ) => d4().patch('/v1/workspaces/{ws}/proposals/{id}', { path: { ws, id }, body }),
  remove: (ws: string, id: string) =>
    d4().delete('/v1/workspaces/{ws}/proposals/{id}', { path: { ws, id } }),
  act: (ws: string, id: string, action: Action, comment?: string) =>
    d4().post(
      `/v1/workspaces/{ws}/proposals/{id}/${action}` as '/v1/workspaces/{ws}/proposals/{id}/reject',
      { path: { ws, id }, body: comment ? { comment } : {} },
    ),
};
