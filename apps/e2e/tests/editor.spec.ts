import { expect, test, type Page } from '@playwright/test';
import { api, defaultWorkspaceId, RUN } from './helpers';

const name = (suffix: string) => `${RUN} ${suffix}`;

async function create(page: Page, type: string, elementName: string, fill: Record<string, string> = {}) {
  await page.goto('/');
  await page.getByRole('link', { name: 'New element', exact: true }).click();
  await page.getByLabel('Type').selectOption(type);
  await page.getByLabel('Name *').fill(elementName);
  for (const [label, value] of Object.entries(fill)) {
    const field = page.getByLabel(label, { exact: true });
    if ((await field.evaluate((el) => el.tagName)) === 'SELECT') await field.selectOption(value);
    else await field.fill(value);
  }
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { level: 2, name: elementName })).toBeVisible();
}

test.describe('editing', () => {
  test.afterAll(async () => {
    // Remove everything this run created (soft delete, via the API).
    const ws = await defaultWorkspaceId();
    const page = await api<{ items: { id: string; version: number }[] }>(
      `/v1/workspaces/${ws}/elements?q=${encodeURIComponent(RUN)}&first=200`,
    );
    for (const e of page.items) {
      await api(`/v1/workspaces/${ws}/elements/${e.id}?expectedVersion=${e.version}`, { method: 'DELETE' });
    }
  });

  test('creates an element from the metamodel-driven form', async ({ page }) => {
    await create(page, 'Platform', name('Platform'), { 'Platform Type': 'integration' });
    await expect(page.getByText('Technology · Platform')).toBeVisible();
    await expect(page.getByText('IDEA', { exact: true })).toBeVisible();
    await expect(page.locator('.attrs')).toContainText('integration');
    await expect(page.locator('.history')).toContainText('Created');
  });

  test('form fields follow the chosen type', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'New element', exact: true }).click();
    await page.getByLabel('Type').selectOption('DataStore');
    await expect(page.getByLabel('Category', { exact: true })).toBeVisible();
    const categories = await page.getByLabel('Category', { exact: true }).locator('option').allInnerTexts();
    expect(categories).toEqual(['—', 'OPERATIONAL', 'ANALYTICAL', 'ARCHIVE', 'STREAMING']);
    await page.getByLabel('Type').selectOption('Application');
    await expect(page.getByLabel('Category', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Criticality', { exact: true })).toBeVisible();
  });

  test('edits are versioned and recorded in history', async ({ page }) => {
    const n = name('Ledger');
    await create(page, 'Application', n);
    await page.getByRole('link', { name: 'Edit', exact: true }).click();
    await page.getByLabel('Criticality', { exact: true }).selectOption('HIGH');
    await page.getByLabel('Description', { exact: true }).fill('General ledger');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByRole('heading', { level: 2, name: n })).toBeVisible();
    await expect(page.getByText('v2', { exact: true })).toBeVisible();
    await expect(page.locator('.details .card p').first()).toHaveText('General ledger');
    await expect(page.locator('.history')).toContainText('criticality: null → "HIGH"');
  });

  test('lifecycle only offers allowed moves', async ({ page }) => {
    await create(page, 'Platform', name('Lifecycle'));
    await page.getByRole('link', { name: 'Edit', exact: true }).click();
    const lifecycle = page.getByLabel('Lifecycle', { exact: true });
    expect(await lifecycle.locator('option').allInnerTexts()).toEqual(['—', 'IDEA', 'PROPOSED', 'RETIRED']);

    await lifecycle.selectOption('PROPOSED');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('PROPOSED', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Edit', exact: true }).click();
    expect(await lifecycle.locator('option').allInnerTexts()).toEqual(['—', 'PROPOSED', 'DECIDED', 'IDEA', 'RETIRED']);
  });

  test('client-side validation blocks bad values before saving', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'New element', exact: true }).click();
    await page.getByLabel('Type').selectOption('Capability');
    await page.getByLabel('Name *').fill(name('Bad level'));
    await page.getByLabel('Level', { exact: true }).fill('1.5');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('alert')).toContainText('Capability.level must be an integer');
    await expect(page).toHaveURL(/\/new$/);
  });

  test('deletes an element after confirmation', async ({ page }) => {
    const n = name('Temporary');
    await create(page, 'Platform', n);
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(page).toHaveURL(/\/w\/[0-9A-Z]{26}$/);
    await page.getByLabel('Search elements').fill(n);
    await expect(page.getByText('No elements match.')).toBeVisible();
  });
});
