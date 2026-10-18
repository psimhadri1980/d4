import { expect, test } from '@playwright/test';
import { api, defaultWorkspaceId, RUN } from './helpers';

test.describe('relationships', () => {
  let ws: string;
  const store = `${RUN} Shadow Store`;

  test.beforeAll(async () => {
    ws = await defaultWorkspaceId();
    await api(`/v1/workspaces/${ws}/elements`, {
      method: 'POST',
      body: JSON.stringify({ type: 'DataStore', attrs: { name: store, category: 'OPERATIONAL' } }),
    });
  });

  test.afterAll(async () => {
    const found = await api<{ items: { id: string; version: number }[] }>(
      `/v1/workspaces/${ws}/elements?q=${encodeURIComponent(RUN)}&first=200`,
    );
    for (const e of found.items) {
      await api(`/v1/workspaces/${ws}/elements/${e.id}?expectedVersion=${e.version}`, { method: 'DELETE' });
    }
  });

  async function openStore(page: import('@playwright/test').Page) {
    await page.goto('/');
    await page.getByLabel('Search elements').fill(store);
    await page.getByRole('link', { name: new RegExp(store) }).click();
    await expect(page.getByRole('heading', { level: 2, name: store })).toBeVisible();
  }

  test('only offers relationship types the metamodel allows', async ({ page }) => {
    await openStore(page);
    await page.getByRole('button', { name: '+ Add' }).click();
    const types = await page.getByLabel('Relationship', { exact: true }).locator('option').allInnerTexts();
    expect(types).toContain('HOLDS →');
    expect(types).toContain('FEEDS →');
    expect(types).not.toContain('ACTS_ON →');
  });

  test('adds a HOLDS relationship with a role and validity, then removes it', async ({ page }) => {
    await openStore(page);
    await page.getByRole('button', { name: '+ Add' }).click();
    await page.getByLabel('Relationship', { exact: true }).selectOption({ label: 'HOLDS →' });
    await page.getByPlaceholder(/Search/).last().fill('Product Reference');
    await page.locator('#rel-target').selectOption({ label: 'Product Reference — DataProduct' });
    await page.getByLabel('Role *').selectOption('REPLICA');
    await page.getByLabel('Valid from').last().fill('2027-01-01');
    await page.getByRole('button', { name: 'Add relationship' }).click();

    const group = page.locator('.rel-group', { hasText: 'HOLDS →' });
    await expect(group).toContainText('Product Reference');
    await expect(group).toContainText('role=REPLICA');
    await expect(group).toContainText('(2027-01-01 → …)');

    page.once('dialog', (d) => void d.accept());
    await group.getByRole('button', { name: '×' }).click();
    await expect(page.locator('.rel-group', { hasText: 'HOLDS →' })).toHaveCount(0);
  });

  test('shows the rule violation when a second master is added', async ({ page }) => {
    await openStore(page);
    await page.getByRole('button', { name: '+ Add' }).click();
    await page.getByLabel('Relationship', { exact: true }).selectOption({ label: 'HOLDS →' });
    await page.getByPlaceholder(/Search/).last().fill('Account');
    await page.locator('#rel-target').selectOption({ label: 'Account — DataProduct' });
    await page.getByLabel('Role *').selectOption('MASTER');
    await page.getByRole('button', { name: 'Add relationship' }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toContainText('This would break a modelling rule.');
    await expect(alert).toContainText('single-master-per-data-product');
    await expect(page.locator('.rel-group', { hasText: 'HOLDS →' })).toHaveCount(0);
  });
});
