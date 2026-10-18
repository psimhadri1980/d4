import { expect, test, type Page } from '@playwright/test';
import { API, api, defaultWorkspaceId, RUN, token } from './helpers';

interface El { id: string; version: number; attrs: Record<string, unknown> }

async function find(ws: string, name: string): Promise<El> {
  const page = await api<{ items: El[] }>(`/v1/workspaces/${ws}/elements?q=${encodeURIComponent(name)}&first=20`);
  const hit = page.items.find((e) => e.attrs['name'] === name);
  if (!hit) throw new Error(`${name} missing; run deploy/dev.sh sample`);
  return hit;
}

async function openClientMaster(page: Page, ws: string) {
  const client = await find(ws, 'Client Master');
  await page.goto(`/w/${ws}/e/${client.id}`);
  await expect(page.getByRole('heading', { level: 2, name: 'Client Master' })).toBeVisible();
}

// HOLDS rows are the only relationships of Client Master with a `role` attribute.
const holdsRows = (page: Page) => page.locator('.pane.right li').filter({ hasText: /\brole=/ });

test.describe('time and scenarios', () => {
  test.describe.configure({ mode: 'serial' });
  let ws = '';
  let scenario: El;
  const rels: { id: string; version: number }[] = [];

  test.beforeAll(async () => {
    ws = await defaultWorkspaceId();
    const legacy = await find(ws, 'Legacy Client Database');
    const mdm = await find(ws, 'Client MDM Hub');
    const client = await find(ws, 'Client Master');
    scenario = await api<El>(`/v1/workspaces/${ws}/elements`, {
      method: 'POST',
      body: JSON.stringify({ type: 'Scenario', attrs: { name: `${RUN} Early cut-over` } }),
    });
    for (const [store, p] of [
      [legacy, { validTo: '2027-04-01' }],
      [mdm, { validFrom: '2027-04-01' }],
    ] as const) {
      rels.push(
        await api(`/v1/workspaces/${ws}/relationships`, {
          method: 'POST',
          body: JSON.stringify({ type: 'HOLDS', fromId: store.id, toId: client.id, attrs: { role: 'MASTER' }, scenarioId: scenario.id, ...p }),
        }),
      );
    }
  });

  test.afterAll(async () => {
    // By id, never by search. Deleting the scenario also deletes its relationships.
    if (!scenario) return;
    await api(`/v1/workspaces/${ws}/elements/${scenario.id}?expectedVersion=${scenario.version}`, { method: 'DELETE' });
    for (const r of rels) {
      const res = await fetch(`${API}/v1/workspaces/${ws}/relationships/${r.id}`, { headers: { authorization: `Bearer ${await token('admin')}` } });
      expect(res.status, 'scenario relationship should be gone').toBe(404);
    }
  });

  test('Explorer shows the model as of a date and can reset', async ({ page }) => {
    await openClientMaster(page, ws);
    await page.getByLabel('As of').fill('2027-01-01');
    await expect(page.getByRole('status')).toHaveText('Viewing the model as of 2027-01-01, baseline.');
    await expect(holdsRows(page).filter({ hasText: 'role=GOLDEN_COPY' })).toHaveCount(1);
    await expect(holdsRows(page).filter({ hasText: 'role=REPLICA' })).toHaveCount(0);

    await page.getByLabel('As of').fill('2027-08-01');
    await expect(holdsRows(page).filter({ hasText: 'role=REPLICA' })).toHaveCount(1);
    await expect(holdsRows(page).filter({ hasText: 'role=GOLDEN_COPY' })).toHaveCount(0);

    // The view survives navigation and reloads (per browser tab).
    await page.reload();
    await expect(page.getByLabel('As of')).toHaveValue('2027-08-01');
    await page.getByRole('group', { name: 'Model view' }).getByRole('button', { name: 'Reset' }).click();
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(holdsRows(page)).toHaveCount(6);
  });

  test('a scenario overlays the baseline in the Explorer', async ({ page }) => {
    await openClientMaster(page, ws);
    await page.getByLabel('As of').fill('2027-05-01');
    const master = holdsRows(page).filter({ hasText: 'role=MASTER' });
    await expect(master).toHaveCount(1);
    await expect(master).toContainText('Legacy Client Database');

    await page.getByLabel('Scenario').selectOption({ label: `${RUN} Early cut-over` });
    await expect(page.getByRole('status')).toContainText(`scenario “${RUN} Early cut-over” on top of the baseline`);
    await expect(master).toHaveCount(1);
    await expect(master).toContainText('Client MDM Hub');
    await expect(master.locator('.badge.scenario')).toBeVisible();
    await page.getByRole('group', { name: 'Model view' }).getByRole('button', { name: 'Reset' }).click();
  });

  test('Compare shows the planned hand-over between two dates', async ({ page }) => {
    await page.goto(`/w/${ws}/compare?fromAsOf=2027-01-01&toAsOf=2027-08-01`);
    await expect(page.getByRole('link', { name: 'Compare' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByLabel('Comparison summary')).toContainText('~2 changed');
    const changed = page.getByRole('region', { name: 'Relationships changed' });
    await expect(changed.locator('li', { hasText: 'Legacy Client Database' }).first()).toContainText('MASTER → REPLICA');
    await expect(changed.locator('li', { hasText: 'Client MDM Hub' }).first()).toContainText('GOLDEN_COPY → MASTER');

    // Swapping reverses the change.
    await page.getByRole('button', { name: 'Swap from and to' }).click();
    await expect(page).toHaveURL(/fromAsOf=2027-08-01/);
    await expect(changed.locator('li', { hasText: 'Legacy Client Database' }).first()).toContainText('REPLICA → MASTER');
  });

  test('Compare shows what a scenario changes on the same date', async ({ page }) => {
    await page.goto(`/w/${ws}/compare?fromAsOf=2027-05-01&toAsOf=2027-05-01`);
    await expect(page.getByText('Pick two different dates, or a scenario on one side.')).toBeVisible();
    await page.getByLabel('To scenario').selectOption({ label: `${RUN} Early cut-over` });
    await expect(page.getByLabel('Comparison summary')).toContainText('−1 relationships');
    await expect(page.getByRole('region', { name: 'Relationships removed' })).toContainText('Legacy Client Database');
    await expect(page.getByRole('region', { name: 'Relationships changed' })).toContainText('GOLDEN_COPY → MASTER');
  });
});
