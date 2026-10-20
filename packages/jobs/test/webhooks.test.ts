import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, EventStore, LOCAL_TENANT, runMigrations, seedLocal, WebhookStore, type DbHandle } from '@d4/db';
import { Client } from 'pg';
import { checkWebhookUrl, DISABLE_AFTER, isPrivateAddress, RETRY_DELAYS_MS, runWebhookPass, signPayload, verifySignature } from '../src';

const PG = process.env.D4_TEST_POSTGRES_URL;

describe('webhook signatures', () => {
  const at = new Date('2027-01-01T00:00:00Z');
  it('verifies its own signature and rejects changes, other secrets and old timestamps', () => {
    const sig = signPayload('s1', '{"a":1}', at);
    expect(sig).toMatch(/^t=1798761600,v1=[0-9a-f]{64}$/);
    expect(verifySignature('s1', '{"a":1}', sig, 300, at)).toBe(true);
    expect(verifySignature('s1', '{"a":2}', sig, 300, at)).toBe(false);
    expect(verifySignature('s2', '{"a":1}', sig, 300, at)).toBe(false);
    expect(verifySignature('s1', '{"a":1}', sig, 300, new Date(at.getTime() + 301_000))).toBe(false);
  });
});

describe('webhook URLs', () => {
  it('knows private and local addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('needs https, no credentials and a public address unless private is allowed', async () => {
    expect(await checkWebhookUrl('http://example.com/hook', false)).toBe('must use https');
    expect(await checkWebhookUrl('https://u:p@example.com/hook', false)).toBe('must not contain credentials');
    expect(await checkWebhookUrl('https://127.0.0.1/hook', false)).toBe('must not point to a private or local address');
    expect(await checkWebhookUrl('https://[::1]/hook', false)).toBe('must not point to a private or local address');
    expect(await checkWebhookUrl('ftp://example.com', true)).toBe('must use https');
    expect(await checkWebhookUrl('http://localhost:9999/hook', true)).toBeNull();
  });
});

describe.skipIf(!PG)('webhook delivery (Postgres)', () => {
  let handle: DbHandle;
  let dbName: string;
  let ws: string;
  let server: Server;
  let url: string;
  const received: { headers: IncomingMessage['headers']; body: string }[] = [];
  let reply = 200;

  beforeAll(async () => {
    dbName = `d4_test_wh_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const admin = new Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const u = new URL(PG!);
    u.pathname = `/${dbName}`;
    handle = createDb(u.toString(), 4);
    await runMigrations(handle.db);
    ({ workspaceId: ws } = await seedLocal(handle.db));

    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(reply).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });
  afterAll(async () => {
    server?.close();
    await handle?.close();
    const c = new Client({ connectionString: PG });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await c.end();
  });

  const event = (id: string, type: 'ElementCreated' | 'ElementUpdated', workspaceId = ws) => ({
    id,
    type,
    workspaceId,
    actor: 'u1',
    occurredAt: new Date().toISOString(),
    subjectId: `el-${id}`,
    version: 1,
    data: { name: `Element ${id}` },
  });

  it('relays new events to matching webhooks once, signed, and ignores events from before the webhook', async () => {
    const events = new EventStore(handle.db);
    await events.append(LOCAL_TENANT, [event('old-1', 'ElementCreated')]);
    await new Promise((r) => setTimeout(r, 20));
    const store = new WebhookStore(handle.db);
    const all = await store.create(LOCAL_TENANT, { workspaceId: null, name: 'All', url, secret: 'sec-all', eventTypes: [], createdBy: 'u1' });
    const created = await store.create(LOCAL_TENANT, { workspaceId: ws, name: 'Created only', url, secret: 'sec-c', eventTypes: ['ElementCreated'], createdBy: 'u1' });
    await store.create(LOCAL_TENANT, { workspaceId: 'other-ws', name: 'Other workspace', url, secret: 'x', eventTypes: [], createdBy: 'u1' });

    await events.append(LOCAL_TENANT, [event('e1', 'ElementCreated'), event('e2', 'ElementUpdated')]);
    const r = await runWebhookPass(handle.db, { allowPrivate: true });
    expect(r).toEqual({ relayed: 3, sent: 3, failed: 0 });

    // A second pass finds nothing new.
    expect(await runWebhookPass(handle.db, { allowPrivate: true })).toEqual({ relayed: 0, sent: 0, failed: 0 });

    expect(received.map((x) => `${x.headers['d4-event']}`).sort()).toEqual(['ElementCreated', 'ElementCreated', 'ElementUpdated']);
    for (const x of received) {
      const body = JSON.parse(x.body) as { id: string; subjectId: string };
      expect(body.id).not.toBe('old-1');
      const secret = (await store.delivery(all.id, String(x.headers['d4-delivery']))) ? 'sec-all' : 'sec-c';
      expect(verifySignature(secret, x.body, String(x.headers['d4-signature']))).toBe(true);
    }
    expect((await store.deliveries(created.id)).map((d) => [d.eventType, d.status, d.responseStatus])).toEqual([['ElementCreated', 'succeeded', 200]]);
  });

  it('retries failures with back-off and turns the webhook off after repeated failures', async () => {
    const store = new WebhookStore(handle.db);
    const hook = await store.create(LOCAL_TENANT, { workspaceId: ws, name: 'Flaky', url, secret: 's', eventTypes: ['ElementUpdated'], createdBy: 'u1' });
    // Keep the earlier webhooks out of this test.
    for (const w of await store.list(LOCAL_TENANT)) if (w.id !== hook.id) await store.update(LOCAL_TENANT, w.id, { enabled: false });
    reply = 500;

    for (let i = 0; i < DISABLE_AFTER; i++) await new EventStore(handle.db).append(LOCAL_TENANT, [event(`f${i}`, 'ElementUpdated')]);
    let now = new Date(Date.now() + 1000);
    // Every attempt fails; step the clock past each retry delay.
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      const r = await runWebhookPass(handle.db, { allowPrivate: true, now: () => now });
      expect(r.failed).toBe(DISABLE_AFTER);
      now = new Date(now.getTime() + (RETRY_DELAYS_MS[attempt] ?? 0) + 1000);
    }
    const deliveries = await store.deliveries(hook.id);
    expect(deliveries.every((d) => d.status === 'failed' && d.attempts === RETRY_DELAYS_MS.length + 1 && d.lastError === 'HTTP 500')).toBe(true);
    const after = (await store.get(LOCAL_TENANT, hook.id))!;
    expect(after.enabled).toBe(false);
    expect(after.disabledReason).toMatch(/Turned off after 5 failed deliveries/);

    // Turning it back on resets the streak; a redelivered ping succeeds.
    reply = 204;
    await store.update(LOCAL_TENANT, hook.id, { enabled: true });
    await store.redeliver(hook.id, deliveries[0]!.id);
    const ping = await store.ping((await store.get(LOCAL_TENANT, hook.id))!, 'u1');
    expect(await runWebhookPass(handle.db, { allowPrivate: true, now: () => now })).toMatchObject({ sent: 2, failed: 0 });
    expect((await store.delivery(hook.id, ping.id))!.status).toBe('succeeded');
    expect((await store.get(LOCAL_TENANT, hook.id))!.consecutiveFailures).toBe(0);
  });
});
