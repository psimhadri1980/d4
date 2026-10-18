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
  // Match the exact name, not longer ones such as "Client Master contract v2".
  const exact = page.locator('.name', { hasText: new RegExp(`^${name}$`) });
  await page.locator('.items li a', { has: exact }).first().click();
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

interface Box {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}
/** The slice of Cytoscape's API the measurements need (the e2e package doesn't depend on it). */
interface CyNode {
  renderedBoundingBox(o: { includeLabels: boolean }): Box;
  renderedPosition(): { x: number; y: number };
}
interface Cy {
  nodes(): { length: number; map<T>(f: (n: CyNode) => T): T[] };
}

/** Node geometry from the Cytoscape instance behind the explorer canvas. */
async function layoutStats(page: Page) {
  return page.locator('.graph').first().evaluate((el) => {
    const cy = (el as unknown as { __cy: Cy }).__cy;
    const nodes = cy.nodes();
    const boxes = nodes.map((n) => n.renderedBoundingBox({ includeLabels: false }));
    const labelBoxes = nodes.map((n) => n.renderedBoundingBox({ includeLabels: true }));
    const centres = nodes.map((n) => n.renderedPosition());
    const overlap = (a: Box, b: Box) =>
      a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
    let nodeOverlaps = 0;
    let labelOverlaps = 0;
    let pairs = 0;
    let minDistance = Infinity;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        pairs++;
        if (overlap(boxes[i]!, boxes[j]!)) nodeOverlaps++;
        if (overlap(labelBoxes[i]!, labelBoxes[j]!)) labelOverlaps++;
        minDistance = Math.min(minDistance, Math.hypot(centres[i]!.x - centres[j]!.x, centres[i]!.y - centres[j]!.y));
      }
    }
    const xs = centres.map((c) => c.x);
    const ys = centres.map((c) => c.y);
    return {
      count: nodes.length,
      nodeOverlaps,
      labelOverlapRate: pairs ? labelOverlaps / pairs : 0,
      minDistance,
      spreadX: (Math.max(...xs) - Math.min(...xs)) / el.clientWidth,
      spreadY: (Math.max(...ys) - Math.min(...ys)) / el.clientHeight,
    };
  });
}

test.describe('graph readability', () => {
  for (const [layout, depth] of [
    ['Radial', '1'],
    ['Radial', '2'],
    ['Force', '1'],
    ['Force', '2'],
    ['Hierarchy', '2'],
  ] as const) {
    test(`${layout} layout at depth ${depth} spreads nodes without overlaps`, async ({ page }) => {
      await open(page, 'Client Master');
      await page.getByRole('combobox', { name: 'Layout' }).selectOption({ label: layout });
      await page.getByRole('combobox', { name: 'Depth' }).selectOption(depth);
      await expect.poll(async () => (await viewCounts(page)).elements).toBeGreaterThan(depth === '1' ? 10 : 25);
      await page.getByRole('button', { name: 'Fit' }).click();

      const s = await layoutStats(page);
      expect(s.nodeOverlaps, JSON.stringify(s)).toBe(0);
      expect(s.minDistance, JSON.stringify(s)).toBeGreaterThan(30);
      expect(s.labelOverlapRate, JSON.stringify(s)).toBeLessThan(0.02);
      // Uses the canvas rather than clumping in the middle.
      expect(Math.max(s.spreadX, s.spreadY), JSON.stringify(s)).toBeGreaterThan(0.6);
    });
  }
});
