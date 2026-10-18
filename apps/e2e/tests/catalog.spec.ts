import { expect, test, type Locator, type Page } from '@playwright/test';
import { RUN, signIn } from './helpers';

const TITLE = `${RUN} Applications by criticality`;
const GOOD = `MATCH (a:Application)
WHERE a.workspaceId = $workspace AND a.deleted = false
  AND ($criticality IS NULL OR a.criticality = $criticality)
RETURN a.id AS id, a.name AS name, a.criticality AS criticality
ORDER BY name
LIMIT 100`;
const PARAMS = '[{ "name": "criticality", "type": "enum", "label": "Criticality", "values": ["LOW", "MEDIUM", "HIGH", "MISSION_CRITICAL"] }]';

let workspace = '';
async function openQueries(page: Page, query = '') {
  if (!workspace) {
    await page.goto('/');
    await expect(page).toHaveURL(/\/w\/[0-9A-Z]{26}/);
    workspace = /\/w\/([0-9A-Z]{26})/.exec(page.url())![1]!;
  }
  await page.goto(`/w/${workspace}/queries${query}`);
}

const section = (page: Page, name: 'Catalog' | 'Studio' | 'Stewardship') =>
  page.locator('section.accordion', { has: page.getByRole('button', { name: new RegExp(`^.?${name}`) }) });
const panel = (page: Page): Locator => page.getByRole('tabpanel');

test.describe('queries workspace', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ storageState: { cookies: [], origins: [] } });

  test('viewer sees only the Catalog section, with a count', async ({ page }) => {
    await signIn(page, 'viewer');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Queries' })).toBeVisible();
    await openQueries(page);
    // The 8 system queries, plus any tenant queries already published in the dev workspace.
    const catalog = section(page, 'Catalog');
    await expect(catalog.locator('.items li').first()).toBeVisible();
    const listed = await catalog.locator('.items li').count();
    expect(listed).toBeGreaterThanOrEqual(8);
    await expect(catalog.locator('.count')).toHaveText(String(listed));
    await expect(catalog.locator('.items li .badge.certified')).toHaveCount(8);
    await expect(section(page, 'Studio')).toHaveCount(0);
    await expect(section(page, 'Stewardship')).toHaveCount(0);
  });

  test('runs a system query in a tab with an element parameter', async ({ page }) => {
    await signIn(page, 'viewer');
    await openQueries(page);
    await section(page, 'Catalog').getByRole('button', { name: /CRUD-I matrix/ }).click();
    await expect(page.getByRole('tab', { name: /Run.*CRUD-I matrix/ })).toHaveAttribute('aria-selected', 'true');

    const p = panel(page);
    await p.getByLabel('Search BusinessProcess').fill('Client Onboarding');
    await p.getByRole('listbox', { name: /Business process/ }).selectOption({ label: 'Client Onboarding — BusinessProcess' });
    await p.getByRole('button', { name: 'Run' }).click();
    await expect(p.locator('.results table')).toContainText('Capture client details');
    await expect(p.getByText(/6 rows · v1/)).toBeVisible();
  });

  test('several tabs stay open side by side and keep their state', async ({ page }) => {
    await signIn(page, 'viewer');
    await openQueries(page);
    const catalog = section(page, 'Catalog');

    // Tab 1: run impact of retiring the Mainframe.
    await catalog.getByRole('button', { name: /Impact of retiring/ }).click();
    await panel(page).getByLabel(/Search Platform/).fill('Mainframe');
    await panel(page).getByRole('listbox', { name: /Element to retire/ }).selectOption({ label: 'Mainframe — Platform' });
    await panel(page).getByRole('button', { name: 'Run' }).click();
    await expect(panel(page).locator('.results table')).toContainText('Core Banking System');

    // Tab 2: a different query.
    await catalog.getByRole('button', { name: /Orphan elements/ }).click();
    await expect(page.getByRole('tab')).toHaveCount(2);
    await expect(page.getByRole('tab', { name: /Orphan elements/ })).toHaveAttribute('aria-selected', 'true');

    // Back to tab 1: its result is still there; opening it again doesn't duplicate it.
    await page.getByRole('tab', { name: /Impact of retiring/ }).click();
    await expect(panel(page).locator('.results table')).toContainText('Core Banking System');
    await catalog.getByRole('button', { name: /Impact of retiring/ }).click();
    await expect(page.getByRole('tab')).toHaveCount(2);

    // Tabs survive a reload (they are in the URL).
    await page.reload();
    await expect(page.getByRole('tab')).toHaveCount(2);

    // Close one, then the other.
    await page.getByRole('button', { name: /Close .*Orphan elements/ }).click();
    await expect(page.getByRole('tab')).toHaveCount(1);
    await page.getByRole('button', { name: /Close .*Impact of retiring/ }).click();
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.getByText(/Each opens in its own tab/)).toBeVisible();
  });

  test('graph-shaped results render as a graph with a table toggle', async ({ page }) => {
    await signIn(page, 'viewer');
    await openQueries(page);
    await section(page, 'Catalog').getByRole('button', { name: /Lineage graph/ }).click();
    const p = panel(page);
    await p.getByLabel('Search DataProduct').fill('Client Master');
    await p.getByRole('listbox', { name: /Data product/ }).selectOption({ label: 'Client Master — DataProduct' });
    await p.getByRole('button', { name: 'Run' }).click();
    await expect(p.getByText(/\d+ elements · \d+ relationships · v1/)).toBeVisible();
    await expect(p.locator('.result-graph canvas').first()).toBeVisible();
    await p.getByRole('group', { name: 'Result view' }).getByRole('button', { name: 'Table' }).click();
    await expect(p.locator('.results table')).toContainText('Client Master');
  });

  test('element picker never looks selected when it is not, and asks for missing values', async ({ page }) => {
    await signIn(page, 'viewer');
    await openQueries(page);
    await section(page, 'Catalog').getByRole('button', { name: /Impact of retiring/ }).click();
    const p = panel(page);
    await expect(p.getByRole('listbox', { name: /Element to retire/ })).toHaveValue('');
    await p.getByRole('button', { name: 'Run' }).click();
    await expect(p.getByRole('alert')).toContainText('Please fill in: Element to retire');
    await p.getByLabel(/Search Platform/).fill('Mainframe');
    await p.getByRole('listbox', { name: /Element to retire/ }).selectOption({ label: 'Mainframe — Platform' });
    await expect(p.getByText('Selected: Mainframe — Platform')).toBeVisible();
  });

  test('old routes open the matching tab in Queries', async ({ page }) => {
    await signIn(page, 'viewer');
    await openQueries(page);
    await section(page, 'Catalog').getByRole('button', { name: /Orphan elements/ }).click();
    const id = /run:([0-9A-Z]{26})/.exec(decodeURIComponent(page.url()))![1];
    await page.goto(`/w/${workspace}/catalog/${id}`);
    await expect(page).toHaveURL(/\/queries\?tabs=run/);
    await expect(page.getByRole('tab', { name: /Orphan elements/ })).toHaveAttribute('aria-selected', 'true');
  });

  test('author drafts, sees checks, test-runs and submits — from the Studio section', async ({ page }) => {
    await signIn(page, 'author');
    await openQueries(page);
    await expect(section(page, 'Stewardship')).toHaveCount(0);
    const studio = section(page, 'Studio');
    await studio.getByRole('button', { name: '+ New query' }).click();
    await studio.getByLabel('Title *').fill(TITLE);
    await studio.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('tab', { name: new RegExp(`Edit.*${TITLE}`) })).toHaveAttribute('aria-selected', 'true');

    const p = panel(page);
    await p.getByLabel('Cypher', { exact: true }).fill('MATCH (a:Application) SET a.flag = true RETURN a');
    await p.getByRole('button', { name: 'Save draft' }).click();
    await expect(p.getByText('✗ SET is not allowed in a read-only query')).toBeVisible();
    await expect(p.getByRole('button', { name: 'Submit for review' })).toBeDisabled();

    await p.getByLabel('Cypher', { exact: true }).fill(GOOD);
    await p.getByLabel('Parameters (JSON)').fill(PARAMS);
    await p.getByRole('button', { name: 'Save draft' }).click();
    await expect(p.getByText('✓ All checks pass')).toBeVisible();

    const testRun = p.locator('.test-run');
    await testRun.getByLabel('Criticality').selectOption('MISSION_CRITICAL');
    await testRun.getByRole('button', { name: 'Test run' }).click();
    await expect(testRun.locator('table')).toContainText('Core Banking System');

    await p.getByRole('button', { name: 'Submit for review' }).click();
    await expect(p.getByText(/waiting for a steward/)).toBeVisible();
  });

  test('steward reviews from the Stewardship section and grants to viewers', async ({ page }) => {
    await signIn(page, 'steward');
    await openQueries(page);
    await expect(section(page, 'Studio')).toHaveCount(0);
    const stewardship = section(page, 'Stewardship');
    await expect(stewardship.locator('.count')).not.toHaveText('0');
    await stewardship.getByRole('button', { name: new RegExp(TITLE) }).first().click();

    const p = panel(page);
    await expect(p.getByRole('heading', { name: 'Review v1' })).toBeVisible();
    await p.getByLabel('Note to the author').fill('Scoped and read-only.');
    await p.getByRole('button', { name: 'Publish' }).click();
    await expect(p.getByText('✓ Published')).toBeVisible();
    await p.getByLabel('Grant to viewer').check();
    await p.getByRole('button', { name: 'Save grants' }).click();
    await expect(p.getByText('✓ Grants saved')).toBeVisible();
  });

  test('viewer runs the newly published query', async ({ page }) => {
    await signIn(page, 'viewer');
    await openQueries(page);
    await page.getByLabel('Search queries').fill(RUN);
    await section(page, 'Catalog').getByRole('button', { name: new RegExp(TITLE) }).click();
    const p = panel(page);
    await p.getByLabel('Criticality').selectOption('MISSION_CRITICAL');
    await p.getByRole('button', { name: 'Run' }).click();
    await expect(p.locator('.results table')).toContainText('Credit Risk Engine');
    await expect(p.locator('.results table')).not.toContainText('Client Onboarding Portal');
  });

  test('steward retires and archives the test query; its tab closes', async ({ page }) => {
    await signIn(page, 'steward');
    await openQueries(page);
    const stewardship = section(page, 'Stewardship');
    await stewardship.getByText(/Manage any query/).click();
    await stewardship.locator('.all-queries').getByRole('button', { name: new RegExp(TITLE) }).click();
    const p = panel(page);
    await expect(p.locator('.card', { hasText: 'Recent runs' }).locator('tbody tr').first()).toContainText('ok');
    await p.getByRole('button', { name: 'Deprecate' }).click();
    await expect(p.getByText('✓ v1 deprecated')).toBeVisible();
    await p.getByRole('button', { name: 'Retire' }).click();
    await expect(p.getByText('✓ v1 retired')).toBeVisible();
    page.once('dialog', (d) => void d.accept());
    await p.getByRole('button', { name: 'Archive query' }).click();
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.getByRole('button', { name: new RegExp(TITLE) })).toHaveCount(0);
  });

  test('author can delete a never-published draft; its tab closes', async ({ page }) => {
    await signIn(page, 'author');
    await openQueries(page);
    const studio = section(page, 'Studio');
    await studio.getByRole('button', { name: '+ New query' }).click();
    await studio.getByLabel('Title *').fill(`${RUN} Scratch`);
    await studio.getByRole('button', { name: 'Create' }).click();
    await panel(page).getByRole('button', { name: 'Save draft' }).click();
    page.once('dialog', (d) => void d.accept());
    await panel(page).getByRole('button', { name: 'Delete query' }).click();
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(studio.getByRole('button', { name: new RegExp(`${RUN} Scratch`) })).toHaveCount(0);
  });
});
