import { d4, type Schemas } from '@d4/web-platform';

export type AdminWorkspace = Schemas['AdminWorkspace'];
type Member = Schemas['Member'];
/** A webhook; `secret` is present only right after creating it or rotating the secret. */
export type Webhook = Schemas['Webhook'] & { secret?: string };
type WebhookInput = { name: string; url: string; workspace: string | null; eventTypes: string[] };

export const adminApi = {
  workspaces: () => d4().get('/v1/admin/workspaces', { query: { archived: 'true' } }),
  createWorkspace: (body: {
    slug: string;
    name: string;
    description?: string;
    metamodel?: string;
  }) =>
    // `metamodel` is a pack id from metamodelPacks(); the document lists the packs this build ships.
    d4().post('/v1/admin/workspaces', { body: body as never }),
  metamodelPacks: () => d4().get('/v1/admin/metamodel-packs'),
  updateWorkspace: (ws: string, body: { name?: string; description?: string | null }) =>
    d4().patch('/v1/admin/workspaces/{ws}', { path: { ws }, body }),
  setArchived: (ws: string, archived: boolean) =>
    archived
      ? d4().post('/v1/admin/workspaces/{ws}/archive', { path: { ws } })
      : d4().post('/v1/admin/workspaces/{ws}/restore', { path: { ws } }),
  users: () => d4().get('/v1/admin/users'),
  members: (ws: string) => d4().get('/v1/admin/members/{ws}', { path: { ws } }),
  grant: (ws: string, principalId: string, role: string) =>
    d4().post('/v1/admin/members/{ws}', { path: { ws }, body: { principalId, role } as never }),
  revoke: (ws: string, m: Pick<Member, 'principalType' | 'principalId' | 'role'>) =>
    d4().delete('/v1/admin/members/{ws}', {
      path: { ws },
      body: { principalType: m.principalType, principalId: m.principalId, role: m.role } as never,
    }),
  usage: () => d4().get('/v1/admin/usage'),
  webhooks: () => d4().get('/v1/admin/webhooks'),
  eventTypes: () => d4().get('/v1/admin/webhooks/event-types'),
  createWebhook: (body: WebhookInput) => d4().post('/v1/admin/webhooks', { body }),
  updateWebhook: (id: string, body: Partial<WebhookInput> & { enabled?: boolean }) =>
    d4().patch('/v1/admin/webhooks/{id}', { path: { id }, body }),
  deleteWebhook: (id: string) => d4().delete('/v1/admin/webhooks/{id}', { path: { id } }),
  rotateSecret: (id: string) =>
    d4().post('/v1/admin/webhooks/{id}/rotate-secret', { path: { id } }),
  ping: (id: string) => d4().post('/v1/admin/webhooks/{id}/ping', { path: { id } }),
  deliveries: (id: string) => d4().get('/v1/admin/webhooks/{id}/deliveries', { path: { id } }),
  redeliver: (id: string, delivery: string) =>
    d4().post('/v1/admin/webhooks/{id}/deliveries/{delivery}/redeliver', {
      path: { id, delivery },
    }),
};
