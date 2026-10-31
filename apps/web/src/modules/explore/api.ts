import type { MatrixKind } from '@d4/core';
import { d4, type ViewParams } from '@d4/web-platform';

const text = (v: string | undefined) => v || undefined;
const view = (v: ViewParams) => ({ asOf: text(v.asOf), scenario: text(v.scenario) });

export const exploreApi = {
  neighbourhood: (ws: string, id: string, depth: number, v: ViewParams = {}) =>
    d4().get('/v1/workspaces/{ws}/elements/{id}/neighbourhood', {
      path: { ws, id },
      query: { depth, limit: 800, ...view(v) },
    }),
  matrix: (ws: string, kind: MatrixKind, v: ViewParams = {}) =>
    d4().get('/v1/workspaces/{ws}/matrix/{kind}', { path: { ws, kind }, query: view(v) }),
  diff: (ws: string, from: ViewParams, to: ViewParams) =>
    d4().get('/v1/workspaces/{ws}/diff', {
      path: { ws },
      query: {
        fromAsOf: text(from.asOf),
        fromScenario: text(from.scenario),
        toAsOf: text(to.asOf),
        toScenario: text(to.scenario),
      },
    }),
};
