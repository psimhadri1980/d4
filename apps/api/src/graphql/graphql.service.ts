import { Inject, Injectable } from '@nestjs/common';
import { GraphQLError, GraphQLScalarType, valueFromASTUntyped } from 'graphql';
import mercurius, { type MercuriusOptions } from 'mercurius';
import type { Element, Relationship } from '@d4/core';
import { WorkspaceStore } from '@d4/db';
import type { AttributeDef, MetamodelRegistry } from '@d4/metamodel';
import { AuthService } from '../auth/auth.service';
import type { Principal } from '../auth/identity';
import { toErrorResponse } from '../http/errors';
import { Database } from '../infra/database.service';
import { ModelFactory, type ModelHandles } from '../model/model.factory';
import { WorkspaceAccess, type WorkspaceScope } from '../model/workspace-access.service';
import { typeDefs } from './schema';

interface Ctx {
  /**
   * Authenticates on first use. Kept lazy so auth failures surface as normal GraphQL errors
   * (`extensions.code: UNAUTHORIZED`) rather than a non-GraphQL error body.
   */
  principal: () => Promise<Principal>;
  /** Per-request cache of resolved workspaces, so access is checked once per workspace. */
  scopes: Map<string, Promise<WorkspaceScope & ModelHandles>>;
}

interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
}

type Args = Record<string, unknown>;
type Direction = 'OUT' | 'IN' | 'BOTH';

const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  serialize: (v) => v,
  parseValue: (v) => v,
  parseLiteral: (ast) => valueFromASTUntyped(ast),
});

/** Builds the Mercurius plugin options: schema, resolvers, auth context and error mapping. */
@Injectable()
export class GraphqlService {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(WorkspaceAccess) private readonly access: WorkspaceAccess,
    @Inject(ModelFactory) private readonly models: ModelFactory,
    @Inject(Database) private readonly database: Database,
  ) {}

  options(): MercuriusOptions {
    return {
      schema: typeDefs,
      resolvers: this.resolvers() as MercuriusOptions['resolvers'],
      path: '/graphql',
      graphiql: false,
      queryDepth: 8,
      context: (request) => {
        let auth: Promise<Principal> | undefined;
        const ctx: Ctx = {
          principal: () => (auth ??= this.auth.authenticate(request.headers.authorization)),
          scopes: new Map(),
        };
        return ctx;
      },
      errorFormatter: (execution, context) => {
        // Map domain/HTTP errors to stable codes before Mercurius formats the response.
        const errors = execution.errors.map((err) => {
          const original = err.originalError;
          if (!original || original instanceof mercurius.ErrorWithProps) return err;
          const { status, body } = toErrorResponse(original);
          if (status >= 500) console.error(original);
          return new GraphQLError(body.message, {
            nodes: err.nodes,
            source: err.source,
            positions: err.positions,
            path: err.path,
            originalError: original,
            extensions: {
              ...err.extensions,
              code: body.error,
              ...(body.issues && { issues: body.issues }),
              ...(body.ruleId && { ruleId: body.ruleId }),
            },
          });
        });
        return mercurius.defaultErrorFormatter({ ...execution, errors }, context);
      },
    };
  }

  private scope(ctx: Ctx, workspaceId: string) {
    let s = ctx.scopes.get(workspaceId);
    if (!s) {
      s = ctx
        .principal()
        .then((principal) => this.access.resolve(principal, workspaceId, 'read'))
        .then((scope) => ({ ...scope, ...this.models.for(scope) }));
      ctx.scopes.set(workspaceId, s);
    }
    return s;
  }

  private resolvers() {
    const relDirection = (rel: Relationship, fromElementId: string): Direction =>
      rel.fromId === fromElementId ? 'OUT' : 'IN';

    return {
      JSON: JSONScalar,

      Query: {
        me: (_: unknown, __: Args, ctx: Ctx) => ctx.principal(),
        workspaces: async (_: unknown, __: Args, ctx: Ctx) =>
          new WorkspaceStore(this.database.db).list((await ctx.principal()).tenantId),
        workspace: async (_: unknown, args: { id: string }, ctx: Ctx) => {
          const s = await this.scope(ctx, args.id);
          return new WorkspaceStore(this.database.db).get(s.tenantId, s.workspaceId);
        },
      },

      Workspace: {
        metamodel: async (ws: WorkspaceRow, _: Args, ctx: Ctx) =>
          metamodelView((await this.scope(ctx, ws.id)).registry),
        elements: async (
          ws: WorkspaceRow,
          args: {
            filter?: { types?: string[]; layer?: string; lifecycle?: string[]; search?: string };
            first?: number;
            after?: string;
          },
          ctx: Ctx,
        ) => {
          const s = await this.scope(ctx, ws.id);
          const page = await s.queries.listElements(ws.id, args.filter ?? {}, {
            first: args.first,
            after: args.after,
          });
          return { nodes: page.items, pageInfo: { endCursor: page.endCursor, hasNextPage: page.hasMore } };
        },
        element: async (ws: WorkspaceRow, args: { id: string }, ctx: Ctx) =>
          (await (await this.scope(ctx, ws.id)).queries.getElement(ws.id, args.id)) ?? null,
        relationship: async (ws: WorkspaceRow, args: { id: string }, ctx: Ctx) =>
          (await (await this.scope(ctx, ws.id)).queries.getRelationship(ws.id, args.id)) ?? null,
      },

      Element: {
        name: (e: Element) => e.attrs['name'] ?? null,
        lifecycle: (e: Element) => e.attrs['lifecycle'] ?? null,
        connections: async (e: Element, args: { direction: Direction; types?: string[] }, ctx: Ctx) => {
          const s = await this.scope(ctx, e.workspaceId);
          const list = await s.queries.connections(e.workspaceId, e.id, {
            direction: args.direction,
            types: args.types,
          });
          return list.map((c) => ({ ...c, direction: relDirection(c.relationship, e.id) }));
        },
        neighbourhood: async (
          e: Element,
          args: { depth: number; types?: string[]; limit: number },
          ctx: Ctx,
        ) => {
          const s = await this.scope(ctx, e.workspaceId);
          return (
            (await s.queries.neighbourhood(e.workspaceId, e.id, args)) ?? {
              root: e,
              elements: [],
              relationships: [],
              truncated: false,
            }
          );
        },
        history: async (e: Element, _: Args, ctx: Ctx) => {
          const s = await this.scope(ctx, e.workspaceId);
          return (await s.events.forSubject(s.tenantId, e.id)).filter((ev) => ev.workspaceId === e.workspaceId);
        },
      },

      Relationship: {
        from: async (r: Relationship, _: Args, ctx: Ctx) =>
          (await (await this.scope(ctx, r.workspaceId)).queries.getElement(r.workspaceId, r.fromId)) ?? null,
        to: async (r: Relationship, _: Args, ctx: Ctx) =>
          (await (await this.scope(ctx, r.workspaceId)).queries.getElement(r.workspaceId, r.toId)) ?? null,
        history: async (r: Relationship, _: Args, ctx: Ctx) => {
          const s = await this.scope(ctx, r.workspaceId);
          return (await s.events.forSubject(s.tenantId, r.id)).filter((ev) => ev.workspaceId === r.workspaceId);
        },
      },
    };
  }
}

function metamodelView(reg: MetamodelRegistry) {
  const mm = reg.metamodel;
  const attr = (a: AttributeDef) => ({ ...a, values: a.enum ? (mm.enums[a.enum] ?? null) : null });
  return {
    id: mm.id,
    version: mm.version,
    layers: mm.layers,
    enums: mm.enums,
    nodeTypes: reg.nodeTypes().map((t) => ({
      ...t,
      labels: reg.labelsFor(t.name),
      attributes: reg.attributesFor(t.name).map(attr),
    })),
    relationshipTypes: reg.relationshipTypes().map((r) => ({ ...r, attributes: r.attributes.map(attr) })),
  };
}
