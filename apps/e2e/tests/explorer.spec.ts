import { expect, test, type Page } from '@playwright/test';

/** Reads "N elements · M relationships" from the graph toolbar. */
async function viewCounts(page: Page) {
  const text = await page.getByText(/\d+ elements · \d+ relationships/).innerText();
  const [, e, r] = /(\d+) elements · (\d+) relationships/.exec(text)!;
  return { elements: Number(e), relationships: Number(r) };
}

async function open(page: Page, name: string) {
  await page.goto('/');
  await page.getByLabel('Search elements').fill(name);
  await page.getByRole('link', { name: new RegExp(`^${name}`) }).first().click();
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
}

test.describe('explorer', () => {
  test('search ranks matching sample elements', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Search elements').fill('client master');
    const list = page.locator('.items li');
    await expect(list.first()).toContainText('Client Master');
    await expect(list.first()).toContainText('DataProduct');
    await expect(list).toContainText(['Migrate client master to MDM Hub']);
  });

  test('layer and type filters narrow the list', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Layer').selectOption('Organisation');
    await page.getByLabel('Type').selectOption('Division');
    const items = page.locator('.items li');
    await expect(items.filter({ hasText: 'Global Wealth Management' })).toHaveCount(1);
    await expect(items.filter({ hasText: 'Investment Bank' })).toHaveCount(1);
    // Every row is a Division (the dev workspace may hold extra divisions).
    for (const t of await items.locator('.type').allInnerTexts()) expect(t).toBe('Division');
  });

  test('shows the neighbourhood graph and grows with depth', async ({ page }) => {
    await open(page, 'Client Master');
    await expect(page.getByLabel('Relationship graph').locator('canvas').first()).toBeVisible();
    // Wait for the depth-1 neighbourhood to load before reading the count.
    await expect.poll(async () => (await viewCounts(page)).elements).toBeGreaterThan(10);
    const one = await viewCounts(page);

    await page.getByRole('combobox', { name: 'Depth' }).selectOption('2');
    await expect.poll(async () => (await viewCounts(page)).elements).toBeGreaterThan(one.elements);
  });

  test('details show roles, CRUD-I operations and the planned hand-over', async ({ page }) => {
    await open(page, 'Client Master');
    const rels = page.locator('.card', { has: page.getByRole('heading', { name: 'Relationships' }) });
    const holds = rels.locator('.rel-group', { hasText: '← HOLDS' });
    await expect(holds).toContainText('Legacy Client Database');
    await expect(holds).toContainText('role=MASTER');
    await expect(holds).toContainText('(… → 2027-07-01)');
    await expect(holds).toContainText('(2027-07-01 → …)');
    await expect(holds).toContainText('role=APPROVED_DISTRIBUTOR');
    await expect(rels.locator('.rel-group', { hasText: '← ACTS_ON' })).toContainText('op=CREATE');
    await expect(page.getByText('RESTRICTED')).toBeVisible();
  });

  test('navigating via a relationship opens the other element', async ({ page }) => {
    await open(page, 'Client Master');
    await page.locator('.rel-group', { hasText: '← OWNS' }).getByRole('link', { name: 'Group Functions' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Group Functions' })).toBeVisible();
    await expect(page.getByText('Organisation · Division')).toBeVisible();
  });
});
