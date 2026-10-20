import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { expect, test } from '@playwright/test';
import { openNav, RUN } from './helpers';

/**
 * A receiver in the test process. In the Docker stack the worker reaches it at this container's
 * network address; with a local worker (`e2e-local`) the port is published and E2E_HOOK_URL says
 * where.
 */
const received: { headers: IncomingHttpHeaders; body: string }[] = [];
let server: Server;
let hookUrl: string;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((r) => server.listen(Number(process.env.E2E_HOOK_PORT ?? 0), '0.0.0.0', r));
  const ip = Object.values(networkInterfaces())
    .flat()
    .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
  hookUrl = process.env.E2E_HOOK_URL ?? `http://${ip ?? '127.0.0.1'}:${(server.address() as AddressInfo).port}/d4-hook`;
});
test.afterAll(() => server?.close());

test('admins add a webhook, see its secret once and receive a signed test delivery', async ({ page }) => {
  const name = `${RUN} hook`;
  await page.goto('/');
  await openNav(page, 'Admin', 'Webhooks');
  const section = page.getByRole('region', { name: 'Webhooks' });

  const form = section.getByRole('form', { name: 'New webhook' });
  await form.getByLabel('Webhook name').fill(name);
  await form.getByLabel('URL').fill(hookUrl);
  await form.getByLabel('ElementCreated').check();
  await form.getByRole('button', { name: 'Add webhook' }).click();

  const notice = section.getByRole('status', { name: 'Signing secret' });
  await expect(notice).toContainText(name);
  const secret = (await notice.locator('code').textContent())!.trim();
  expect(secret).toMatch(/^whsec_/);
  await notice.getByRole('button', { name: 'Done' }).click();
  await expect(notice).toBeHidden();

  const row = section.getByRole('table', { name: 'All webhooks' }).locator('tr', { hasText: name });
  await expect(row).toContainText('ElementCreated');
  await expect(row.locator('.badge')).toHaveText('on');

  await row.getByRole('button', { name: 'Send test' }).click();
  const deliveries = section.getByRole('table', { name: 'Deliveries' });
  await expect(deliveries.locator('tr', { hasText: 'Ping' }).locator('.badge')).toHaveText('succeeded', { timeout: 20_000 });
  await expect(deliveries).toContainText('HTTP 200');

  // The receiver got a body signed with the secret shown above.
  const ping = received.find((r) => r.headers['d4-event'] === 'Ping');
  expect(ping).toBeTruthy();
  const [t, v1] = String(ping!.headers['d4-signature']).split(',').map((p) => p.split('=')[1]);
  expect(v1).toBe(createHmac('sha256', secret).update(`${t}.${ping!.body}`).digest('hex'));

  await row.getByRole('button', { name: 'Turn off' }).click();
  await expect(row.locator('.badge')).toHaveText('off');
  page.once('dialog', (d) => void d.accept());
  await row.getByRole('button', { name: `Delete webhook ${name}` }).click();
  await expect(section.getByRole('table', { name: 'All webhooks' }).locator('tr', { hasText: name })).toHaveCount(0);
});
