import { JobSchema } from '../jobs/jobs.openapi';
import { json, errors, ws, type ApiRoute } from '../http/api-doc';
import { z } from '../http/zod';

/** OpenAPI paths for connectors and webhooks. */
export function registerIntegrationRoutes(route: ApiRoute) {
  const Webhook = z
    .object({ id: z.string(), name: z.string(), url: z.string(), workspaceId: z.string().nullable(), eventTypes: z.array(z.string()), enabled: z.boolean(), disabledReason: z.string().nullable(), consecutiveFailures: z.number(), createdBy: z.string(), createdAt: z.string() })
    .openapi('Webhook');
  const WebhookWithSecret = Webhook.extend({ secret: z.string().describe('Signing secret; shown only here') }).openapi('WebhookWithSecret');
  const Delivery = z
    .object({ id: z.string(), eventId: z.string().nullable(), eventType: z.string(), status: z.enum(['pending', 'succeeded', 'failed']), attempts: z.number(), nextAttemptAt: z.string().nullable(), responseStatus: z.number().nullable(), lastError: z.string().nullable(), durationMs: z.number().nullable(), createdAt: z.string(), deliveredAt: z.string().nullable() })
    .openapi('WebhookDelivery');
  const hookId = z.string().openapi({ param: { name: 'id', in: 'path' } });
  const ConnectorSchema = z
    .object({
      id: z.string(),
      key: z.string(),
      name: z.string(),
      kind: z.string(),
      config: z.record(z.unknown()),
      mapping: z.record(z.unknown()),
      hasSecret: z.boolean(),
      conflictPolicy: z.enum(['skip', 'source-wins']),
      cadence: z.record(z.unknown()).nullable(),
      cadenceText: z.string().nullable(),
      nextRunAt: z.string().nullable(),
      enabled: z.boolean(),
      lastJobId: z.string().nullable(),
      lastRunAt: z.string().nullable(),
      createdAt: z.string(),
    })
    .openapi('Connector');
  const cnPath = '/v1/workspaces/{ws}/connectors';
  const cnId = z.string().openapi({ param: { name: 'id', in: 'path' } });
  const ConnectorBody = z.object({
    key: z.string().describe('Prefix of the external keys of the elements it owns'),
    name: z.string(),
    kind: z.string().describe('See /connectors/kinds'),
    config: z.record(z.unknown()).describe('Kind-specific: for http-json { url, auth: none|bearer|basic, headers, nextPath, maxPages }'),
    mapping: z.record(z.unknown()).describe('{ itemsPath, entities: [{ when, type, id, name, attrs, relationships }] }'),
    secret: z.string().nullable().optional().describe('Token or user:password; write-only'),
    conflictPolicy: z.enum(['skip', 'source-wins']).optional(),
    cadence: z.record(z.unknown()).nullable().optional(),
    enabled: z.boolean().optional(),
  });
  route({ method: 'get', path: `${cnPath}/kinds`, tags: ['Connectors'], request: { params: z.object({ ws }) }, responses: { 200: json(z.array(z.object({ kind: z.string(), name: z.string(), description: z.string() })), 'Connector kinds'), ...errors } });
  route({ method: 'get', path: cnPath, tags: ['Connectors'], summary: 'Connectors of the workspace (admin)', request: { params: z.object({ ws }) }, responses: { 200: json(z.array(ConnectorSchema), 'Connectors'), ...errors } });
  route({ method: 'post', path: cnPath, tags: ['Connectors'], summary: 'Create a connector (admin)', request: { params: z.object({ ws }), body: { content: { 'application/json': { schema: ConnectorBody } } } }, responses: { 201: json(ConnectorSchema, 'Created'), ...errors } });
  route({ method: 'get', path: `${cnPath}/{id}`, tags: ['Connectors'], request: { params: z.object({ ws, id: cnId }) }, responses: { 200: json(ConnectorSchema, 'Connector'), ...errors } });
  route({ method: 'patch', path: `${cnPath}/{id}`, tags: ['Connectors'], request: { params: z.object({ ws, id: cnId }), body: { content: { 'application/json': { schema: ConnectorBody.omit({ key: true, kind: true }).partial() } } } }, responses: { 200: json(ConnectorSchema, 'Updated'), ...errors } });
  route({ method: 'delete', path: `${cnPath}/{id}`, tags: ['Connectors'], summary: 'Delete the connector; the elements it brought in stay', request: { params: z.object({ ws, id: cnId }) }, responses: { 204: { description: 'Deleted' }, ...errors } });
  route({ method: 'post', path: `${cnPath}/{id}/sync`, tags: ['Connectors'], summary: 'Start a sync job (dryRun: only report what would change)', request: { params: z.object({ ws, id: cnId }), body: { content: { 'application/json': { schema: z.object({ dryRun: z.boolean().optional() }) } } } }, responses: { 202: json(JobSchema, 'Started job'), ...errors } });
  route({ method: 'get', path: `${cnPath}/{id}/runs`, tags: ['Connectors'], summary: 'Sync runs, newest first; each result lists changes, conflicts and source problems', request: { params: z.object({ ws, id: cnId }) }, responses: { 200: json(z.array(JobSchema), 'Runs'), ...errors } });

  const hookPath = '/v1/admin/webhooks';
  const WebhookBody = z.object({ name: z.string(), url: z.string().describe('https; must not resolve to a private address'), workspace: z.string().nullable().optional().describe('Workspace id or slug; null for all'), eventTypes: z.array(z.string()).optional().describe('Empty for every type') });
  route({ method: 'get', path: hookPath, tags: ['Webhooks'], responses: { 200: json(z.array(Webhook), 'Webhooks'), ...errors } });
  route({ method: 'get', path: `${hookPath}/event-types`, tags: ['Webhooks'], responses: { 200: json(z.array(z.string()), 'Event types a webhook can subscribe to'), ...errors } });
  route({ method: 'post', path: hookPath, tags: ['Webhooks'], summary: 'Create; the response holds the signing secret', description: 'Each delivery is a JSON POST with headers D4-Event, D4-Delivery and D4-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">. Answer 2xx within 10 s; failures are retried 5 times over about 7.5 hours, and a webhook is turned off after 5 failed deliveries in a row.', request: { body: { content: { 'application/json': { schema: WebhookBody } } } }, responses: { 201: json(WebhookWithSecret, 'Created'), ...errors } });
  route({ method: 'get', path: `${hookPath}/{id}`, tags: ['Webhooks'], request: { params: z.object({ id: hookId }) }, responses: { 200: json(Webhook, 'Webhook'), ...errors } });
  route({ method: 'patch', path: `${hookPath}/{id}`, tags: ['Webhooks'], summary: 'Change, or turn on/off (turning on clears the failure count)', request: { params: z.object({ id: hookId }), body: { content: { 'application/json': { schema: WebhookBody.partial().extend({ enabled: z.boolean().optional() }) } } } }, responses: { 200: json(Webhook, 'Updated'), ...errors } });
  route({ method: 'delete', path: `${hookPath}/{id}`, tags: ['Webhooks'], request: { params: z.object({ id: hookId }) }, responses: { 204: { description: 'Deleted with its delivery log' }, ...errors } });
  route({ method: 'post', path: `${hookPath}/{id}/rotate-secret`, tags: ['Webhooks'], request: { params: z.object({ id: hookId }) }, responses: { 200: json(WebhookWithSecret, 'New secret'), ...errors } });
  route({ method: 'post', path: `${hookPath}/{id}/ping`, tags: ['Webhooks'], summary: 'Queue a test delivery', request: { params: z.object({ id: hookId }) }, responses: { 202: json(Delivery, 'Queued'), ...errors } });
  route({ method: 'get', path: `${hookPath}/{id}/deliveries`, tags: ['Webhooks'], summary: 'Latest 50 deliveries', request: { params: z.object({ id: hookId }) }, responses: { 200: json(z.array(Delivery), 'Deliveries, newest first'), ...errors } });
  route({ method: 'post', path: `${hookPath}/{id}/deliveries/{delivery}/redeliver`, tags: ['Webhooks'], request: { params: z.object({ id: hookId, delivery: z.string().openapi({ param: { name: 'delivery', in: 'path' } }) }) }, responses: { 202: json(Delivery, 'Queued again'), ...errors } });
}
