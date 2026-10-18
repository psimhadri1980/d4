import { expect, test, type Page } from '@playwright/test';
import { RUN, signIn } from './helpers';

const TITLE = `${RUN} Applications by criticality`;
const GOOD = `MATCH (a:Application)
WHERE a.workspaceId = $workspace AND a.deleted = false
  AND ($criticality IS NULL OR a.criticality = $criticality)
RETURN a.id AS id, a.name AS name, a.criticality AS criticality
ORDER BY name
LIMIT 100`;
const PARAMS = '[{ "name": "criticality", "type": "enum", "label": "Criticality", "values": ["LOW", "MEDIUM", "HIGH", "MISSION_CRITICAL"] }]';

async function go(page: Page, path: string) {
  // Workspace id comes from the app's own redirect to the first workspace.
  await page.goto('/');
  await expect(page).toHaveURL(/\/w\/[0-9A-Z]{26}/);
  const ws = /\/w\/([0-9A-Z]{26})/.exec(page.url())![1];
  await page.goto(`/w/${ws}${path}`);
}

test.describe('query catalog', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ storageState: { cookies: [], origins: [] } });

  test('viewer runs a system query with an element parameter', async ({ page }) => {
    await signIn(page, 'viewer');
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Catalog' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Studio' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Stewardship' })).toHaveCount(0);

    await go(page, '/catalog');
    await page.getByLabel('Search queries').fill('CRUD');
    await page.getByRole('link', { name: /CRUD-I matrix/ }).click();
    await expect(page.getByRole('heading', { level: 2, name: /CRUD-I matrix/ })).toBeVisible();

    await page.getByLabel('Search BusinessProcess').fill('Client Onboarding');
    await page.locator('#param-element').selectOption({ label: 'Client Onboarding — BusinessProcess' });
    await page.getByRole('button', { name: 'Run' }).click();

    const table = page.locator('.results table');
    await expect(table).toContainText('Capture client details');
    await expect(table).toContainText('Client Advisor');
    await expect(page.getByText(/6 rows · v1/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download CSV' })).toBeEnabled();
  });

  test('viewer gets a clear error for a missing required parameter', async ({ page }) => {
    await signIn(page, 'viewer');
    await go(page, '/catalog');
    await page.getByRole('link', { name: /Impact of retiring/ }).click();
    await page.getByRole('button', { name: 'Run' }).click();
    await expect(page.getByRole('alert')).toContainText("parameter 'element' is required");
  });

  test('author drafts, sees check results, fixes and submits', async ({ page }) => {
    await signIn(page, 'author');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Stewardship' })).toHaveCount(0);
    await go(page, '/studio');
    await page.getByRole('button', { name: '+ New query' }).click();
    await page.getByLabel('Title *').fill(TITLE);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { level: 2, name: TITLE })).toBeVisible();

    await page.getByLabel('Cypher', { exact: true }).fill('MATCH (a:Application) SET a.flag = true RETURN a');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText('✗ SET is not allowed in a read-only query')).toBeVisible();
    await expect(page.getByText(/must filter by \$workspace/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit for review' })).toBeDisabled();

    await page.getByLabel('Cypher', { exact: true }).fill(GOOD);
    await page.getByLabel('Parameters (JSON)').fill(PARAMS);
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText('✓ All checks pass')).toBeVisible();
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(page.getByText(/waiting for a steward/)).toBeVisible();
  });

  test('the submitted query is not visible to viewers yet', async ({ page }) => {
    await signIn(page, 'viewer');
    await go(page, '/catalog');
    await page.getByLabel('Search queries').fill(RUN);
    await expect(page.getByText('No queries match.')).toBeVisible();
  });

  test('steward reviews, publishes and grants to viewers', async ({ page }) => {
    await signIn(page, 'steward');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Studio' })).toHaveCount(0);
    await go(page, '/stewardship');
    await page.locator('.items').first().getByRole('link', { name: new RegExp(TITLE) }).click();
    await expect(page.getByRole('heading', { name: 'Review v1' })).toBeVisible();
    await expect(page.locator('pre.cypher').first()).toContainText('$criticality');

    await page.getByLabel('Note to the author').fill('Scoped and read-only.');
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText('✓ Published')).toBeVisible();

    await page.getByLabel('Grant to viewer').check();
    await page.getByRole('button', { name: 'Save grants' }).click();
    await expect(page.getByText('✓ Grants saved')).toBeVisible();
  });

  test('viewer runs the newly published query with a choice parameter', async ({ page }) => {
    await signIn(page, 'viewer');
    await go(page, '/catalog');
    await page.getByLabel('Search queries').fill(RUN);
    await page.getByRole('link', { name: new RegExp(TITLE) }).click();
    await page.getByLabel('Criticality').selectOption('MISSION_CRITICAL');
    await page.getByRole('button', { name: 'Run' }).click();
    const table = page.locator('.results table');
    await expect(table).toContainText('Core Banking System');
    await expect(table).toContainText('Credit Risk Engine');
    await expect(table).not.toContainText('Client Onboarding Portal');
    // Element ids link back to the explorer.
    await expect(table.getByRole('link', { name: 'open' }).first()).toHaveAttribute('href', /\/e\/[0-9A-Z]{26}$/);
  });

  test('steward sees the run, retires the version and archives the test query', async ({ page }) => {
    await signIn(page, 'steward');
    await go(page, '/stewardship');
    await page.getByRole('link', { name: new RegExp(TITLE) }).last().click();
    await expect(page.locator('.card', { hasText: 'Recent runs' }).locator('tbody tr').first()).toContainText('ok');
    await page.getByRole('button', { name: 'Deprecate' }).click();
    await expect(page.getByText('✓ v1 deprecated')).toBeVisible();
    await page.getByRole('button', { name: 'Retire' }).click();
    await expect(page.getByText('✓ v1 retired')).toBeVisible();

    // Published history means archive, not delete; it leaves the catalog.
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Archive query' }).click();
    await expect(page).toHaveURL(/\/stewardship$/);
    await expect(page.getByRole('link', { name: new RegExp(TITLE) })).toHaveCount(0);
  });

  test('author can delete a never-published draft', async ({ page }) => {
    await signIn(page, 'author');
    await go(page, '/studio');
    await page.getByRole('button', { name: '+ New query' }).click();
    await page.getByLabel('Title *').fill(`${RUN} Scratch`);
    await page.getByRole('button', { name: 'Create' }).click();
    await page.getByRole('button', { name: 'Save draft' }).click();
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Delete query' }).click();
    await expect(page).toHaveURL(/\/studio$/);
    await expect(page.getByRole('link', { name: new RegExp(`${RUN} Scratch`) })).toHaveCount(0);
  });
});
