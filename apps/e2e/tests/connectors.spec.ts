import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { expect, test } from '@playwright/test';
import { api, defaultWorkspaceId, RUN } from './helpers';

/**
 * A fake CMDB in the test process. As for the webhook test, the worker reaches it at this
 * container's address in Docker, or through the published port with `e2e-local` (E2E_HOOK_URL).
 */
let records: unknown[] = [];
let server: Server;
let sourceUrl: string;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.headers['authorization'] !== 'Bearer cmdb-token') return void res.writeHead(401).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: records }));
  });
  await new Promise<void>((r) => server.listen(Number(process.env.E2E_HOOK_PORT ?? 0), '0.0.0.0', r));
  const ip = Object.values(networkInterfaces())
    .flat()
    .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
  const origin = process.env.E2E_HOOK_URL ? new URL(process.env.E2E_HOOK_URL).origin : `http://${ip ?? '127.0.0.1'}:${(server.address() as AddressInfo).port}`;
  sourceUrl = `${origin}/api/now/table/cmdb_ci`;
});
test.afterAll(() => server?.close());

test('admins connect a source, preview a sync, sync it, and see source changes come in', async ({ page }) => {
  test.setTimeout(90_000);
  const key = `cmdb${RUN.slice(-6)}`;
  const app = `${RUN} CRM`;
  records = [
    { sys_id: 'a1', class: 'app', name: app, desc: 'Sales', host: 'p1' },
    { sys_id: 'p1', class: 'platform', name: `${RUN} Kubernetes` },
  ];
  const mapping = {
    itemsPath: 'result',
    entities: [
      { when: { path: 'class', equals: 'app' }, type: { value: 'Application' }, id: 'sys_id', name: 'name', attrs: { description: { path: 'desc' } }, relationships: [{ type: 'RUNS_ON', to: 'host' }] },
      { when: { path: 'class', equals: 'platform' }, type: { value: 'Platform' }, id: 'sys_id', name: 'name' },
    ],
  };

  await page.goto('/');
  await page.getByRole('link', { name: 'Admin', exact: true }).click();
  const section = page.getByRole('region', { name: 'Connectors' });
  await section.getByRole('button', { name: 'Add connector' }).click();
  const form = section.getByRole('form', { name: 'New connector' });
  await form.getByLabel('Name').fill(`${RUN} CMDB`);
  await form.getByLabel('Key').fill(key);
  await form.getByLabel('Source URL (JSON)').fill(sourceUrl);
  await form.getByLabel('Authentication').selectOption('bearer');
  await form.getByLabel('Token').fill('cmdb-token');
  await form.getByLabel('Mapping (JSON)').fill(JSON.stringify(mapping, null, 2));
  await form.getByRole('button', { name: 'Create connector' }).click();

  const row = section.getByRole('table', { name: 'All connectors' }).locator('tr', { hasText: key });
  await expect(row).toContainText('with credentials');
  const status = section.getByRole('status', { name: 'Sync result' });

  await row.getByRole('button', { name: 'Dry run' }).click();
  await expect(status).toContainText('Would write: 2 new', { timeout: 30_000 });
  await row.getByRole('button', { name: 'Sync now' }).click();
  await expect(status).toContainText('Wrote: 2 new', { timeout: 30_000 });

  const ws = await defaultWorkspaceId();
  const find = async () => (await api<{ items: { id: string; version: number; attrs: Record<string, unknown> }[] }>(`/v1/workspaces/${ws}/elements?q=${RUN}`)).items;
  expect((await find()).find((e) => e.attrs['name'] === app)?.attrs).toMatchObject({ externalKey: `${key}:a1`, description: 'Sales' });

  // The source changes; the next sync brings it in.
  records = [{ ...(records[0] as object), desc: 'Sales and service' }, records[1]];
  await row.getByRole('button', { name: 'Sync now' }).click();
  await expect(status).toContainText('Wrote: 0 new, 1 changed', { timeout: 30_000 });
  expect((await find()).find((e) => e.attrs['name'] === app)?.attrs['description']).toBe('Sales and service');

  // Clean up: the connector, then the elements it brought in.
  page.once('dialog', (d) => void d.accept());
  await row.getByRole('button', { name: `Delete connector ${RUN} CMDB` }).click();
  await expect(row).toHaveCount(0);
  for (const e of (await find()).filter((x) => String(x.attrs['externalKey'] ?? '').startsWith(`${key}:`))) {
    await api(`/v1/workspaces/${ws}/elements/${e.id}?expectedVersion=${e.version}`, { method: 'DELETE' });
  }
});
