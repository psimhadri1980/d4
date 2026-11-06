import { expect, test, type Page } from '@playwright/test';
import { openNav } from './helpers';

const search = (page: Page) => page.getByRole('search', { name: 'Find nodes' });
const result = (page: Page) => page.getByRole('region', { name: 'Result' });
const nameBox = (page: Page) => search(page).getByRole('combobox', { name: /name/i });
const card = (page: Page, name: string) => result(page).locator('.graph-canvas-node', { has: page.locator('title', { hasText: new RegExp(`^${name}$`) }) });

async function findClientMaster(page: Page) {
  await page.goto('/');
  await openNav(page, 'Graph Studio');
  await search(page).getByLabel('Lens', { exact: true }).selectOption({ label: 'Data products (DataProduct)' });
  await nameBox(page).fill('Client Master');
  await nameBox(page).press('Escape');
  await nameBox(page).press('Enter');
  await expect(card(page, 'Client Master')).toHaveAttribute('aria-label', 'Client Master, DataProduct, Data, root');
}

test.describe('graph studio', () => {
  test('opens empty, then shows every match as a root with its neighbourhood', async ({ page }) => {
    await page.goto('/');
    await openNav(page, 'Graph Studio');
    await expect(result(page)).toContainText('Find a node to start.');

    // Choosing a lens shows what it fixes; nothing runs before Search.
    await search(page).getByLabel('Lens', { exact: true }).selectOption({ label: 'Data products (DataProduct)' });
    await expect(search(page).getByLabel('Search criteria')).toContainText('DataProduct from lens');
    await expect(result(page)).toContainText('Find a node to start.');

    await nameBox(page).fill('Client Master');
    await search(page).getByRole('button', { name: 'Search' }).click();
    await expect(card(page, 'Client Master')).toBeVisible();
    await expect(result(page).getByLabel('Result summary')).toContainText('1 root');
    // The lens opens at its own depth, 1; Depth 2 loads more.
    await expect(result(page).getByRole('button', { name: 'Depth 1' })).toHaveAttribute('aria-pressed', 'true');
    const one = await result(page).locator('.graph-canvas-node').count();
    await result(page).getByRole('button', { name: 'Depth 2' }).click();
    await expect.poll(() => result(page).locator('.graph-canvas-node').count()).toBeGreaterThan(one);
    // Labels show from the Label level up; a wide result opens fitted, maybe at Dot.
    await result(page).getByRole('toolbar', { name: 'Zoom' }).getByRole('button', { name: 'Card' }).click();
    await expect(result(page).locator('.graph-canvas-label').first()).toBeVisible();
  });

  test('graph and table share the selection; the inspector follows it', async ({ page }) => {
    await findClientMaster(page);
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toContainText('Select a node to see its attributes');
    await card(page, 'Client Master').click();
    const inspector = page.getByRole('complementary', { name: 'Client Master' });
    await expect(inspector).toContainText('DataProduct · Data');
    await expect(inspector).toContainText('RESTRICTED');

    await result(page).getByRole('tab', { name: 'Table' }).click();
    const tree = result(page).getByRole('tree');
    await expect(tree.getByRole('treeitem').first()).toContainText('Client Master');
    await expect(tree.getByRole('treeitem').first()).toHaveAttribute('aria-selected', 'true');
    await expect(tree.getByRole('treeitem').first()).toHaveAttribute('aria-expanded', 'true');
    await result(page).getByRole('button', { name: /Collapse all/ }).click();
    await expect(tree.getByRole('treeitem')).toHaveCount(1);
    // Keyboard: Right expands again.
    await tree.getByRole('treeitem').first().press('ArrowRight');
    await expect.poll(() => tree.getByRole('treeitem').count()).toBeGreaterThan(1);

    await result(page).getByRole('tab', { name: 'Graph' }).click();
    await expect(card(page, 'Client Master')).toHaveAttribute('aria-pressed', 'true');
  });

  test('drills down along a focus path and goes back to what was there', async ({ page }) => {
    await findClientMaster(page);
    await card(page, 'Client Master').click();
    const neighbour = page.getByRole('complementary', { name: 'Client Master' }).getByRole('listitem').getByRole('button').first();
    const name = (await neighbour.innerText()).trim();
    await neighbour.click();
    await page.getByRole('button', { name: 'Focus on this node' }).click();

    const path = result(page).getByRole('navigation', { name: 'Focus path' });
    await expect(path.locator('[aria-current="location"]')).toHaveText(name);
    await expect(card(page, name)).toHaveAttribute('aria-label', new RegExp(', root$'));

    await result(page).getByRole('button', { name: 'Back' }).click();
    await expect(path.locator('[aria-current="location"]')).toHaveText('Data products · "Client Master"');
    // The selection at that step is back.
    await expect(card(page, name)).toHaveAttribute('aria-pressed', 'true');
  });

  test('Show only narrows both views to the ticked kinds, shown as chips', async ({ page }) => {
    await findClientMaster(page);
    const all = await result(page).locator('.graph-canvas-node').count();
    await result(page).getByRole('button', { name: 'Filter' }).click();
    const panel = result(page).getByRole('dialog', { name: 'Show only' });
    await expect(panel.getByLabel('All node types')).toBeChecked();
    await panel.getByRole('checkbox', { name: /^DataStore/ }).check();
    await panel.getByRole('button', { name: 'Done' }).click();
    await expect(result(page).getByRole('button', { name: 'Filter, 1 ticked' })).toBeVisible();
    await expect(result(page).getByText('Showing only:')).toBeVisible();
    await expect.poll(() => result(page).locator('.graph-canvas-node').count()).toBeLessThan(all);
    for (const label of await result(page).locator('.graph-canvas-node').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!)))
      expect(label).toMatch(/, DataStore, |, root$/);
    await expect(result(page).getByLabel('Result summary')).toContainText(` of ${all} nodes`);

    await result(page).getByRole('button', { name: 'Remove DataStore' }).click();
    await expect(result(page).locator('.graph-canvas-node')).toHaveCount(all);
  });

  test('nodes can be dragged and moved with the arrow keys; Reset layout puts them back', async ({ page }) => {
    await findClientMaster(page);
    const node = card(page, 'Client Master');
    const reset = result(page).getByRole('button', { name: 'Reset layout' });
    // Positions are compared at one level of detail: box sizes, and so positions, follow the level.
    const cardLevel = result(page).getByRole('toolbar', { name: 'Zoom' }).getByRole('button', { name: 'Card' });
    await cardLevel.click();
    await expect(reset).toBeDisabled();
    const before = await node.getAttribute('transform');
    await node.scrollIntoViewIfNeeded();
    const box = (await node.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 5 });
    await page.mouse.up();
    await expect(node).not.toHaveAttribute('transform', before!);
    // Dragging does not select.
    await expect(node).toHaveAttribute('aria-pressed', 'false');
    await expect(reset).toBeEnabled();

    await node.focus();
    const dragged = await node.getAttribute('transform');
    await node.press('ArrowDown');
    await expect(node).not.toHaveAttribute('transform', dragged!);

    // Kept per layout: another layout starts clean, and coming back keeps the move.
    await result(page).getByRole('button', { name: 'Radial' }).click();
    await expect(reset).toBeDisabled();
    await result(page).getByRole('button', { name: 'Hierarchical' }).click();
    await expect(reset).toBeEnabled();
    await cardLevel.click();
    await reset.click();
    await expect(node).toHaveAttribute('transform', before!);
  });

  test('opens fitted; zooms with the wheel and the zoom box through four levels; the view is kept per step', async ({ page }) => {
    await findClientMaster(page);
    const zoombox = result(page).getByRole('toolbar', { name: 'Zoom' });
    const percent = async () => Number((await zoombox.locator('.graph-canvas-zoom-value').innerText()).replace('%', ''));
    // A wide result opens fitted, below 100 %, with the root on screen.
    expect(await percent()).toBeLessThanOrEqual(100);
    await expect(card(page, 'Client Master')).toBeInViewport();

    await zoombox.getByRole('button', { name: 'Card' }).click();
    await expect(zoombox.getByRole('button', { name: 'Card' })).toHaveAttribute('aria-pressed', 'true');
    const svg = result(page).locator('svg.graph-canvas-svg');
    const box = (await result(page).locator('.graph-canvas-scroll').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 600);
    await expect.poll(percent).toBeLessThan(50);
    await expect(svg).toHaveClass(/level-dot/);
    await expect(result(page).locator('.graph-canvas-dot').first()).toBeVisible();

    await zoombox.getByRole('button', { name: 'Detail' }).click();
    await expect(card(page, 'Client Master')).toContainText('rel.');

    // Drill and come back: the zoom of the first step returns.
    await card(page, 'Client Master').click();
    await page.getByRole('button', { name: 'Focus on this node' }).click();
    await expect(zoombox.getByRole('button', { name: 'Detail' })).toHaveAttribute('aria-pressed', 'false');
    await result(page).getByRole('button', { name: 'Back' }).click();
    await expect(zoombox.getByRole('button', { name: 'Detail' })).toHaveAttribute('aria-pressed', 'true');

    await zoombox.getByRole('button', { name: 'Fit' }).click();
    await expect.poll(percent).toBeLessThanOrEqual(100);
  });

  test('not sure yet: the lenses that fit the text show with counts; picking one searches inside it with its defaults', async ({ page }) => {
    await page.goto('/');
    await openNav(page, 'Graph Studio');
    await nameBox(page).fill('client');
    const list = search(page).getByRole('listbox', { name: 'Suggestions' });
    // Counts arrive for the lenses whose roots match "client".
    await expect(list.getByRole('option', { name: /^Data products ?\d+$/ })).toBeVisible();
    await list.getByRole('option', { name: /^Data products with a store/ }).click();
    await expect(search(page).getByLabel('Lens', { exact: true })).toHaveValue('mastered-data-products');
    await expect(search(page).getByLabel('Search criteria')).toContainText('Linked to DataStore by HOLDS');
    await nameBox(page).fill('client');
    await nameBox(page).press('Escape');
    await nameBox(page).press('Enter');
    // This lens opens in the Flow layout.
    await expect(result(page).getByRole('button', { name: 'Flow' })).toHaveAttribute('aria-pressed', 'true');
    for (const label of await result(page).locator('.graph-canvas-node.root').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!)))
      expect(label).toMatch(/, DataProduct, Data, root$/);
  });

  test('quick filters narrow a lens and show as removable chips', async ({ page }) => {
    await page.goto('/');
    await openNav(page, 'Graph Studio');
    await search(page).getByLabel('Lens', { exact: true }).selectOption({ label: 'Data products (DataProduct)' });
    await nameBox(page).fill('live');
    await search(page).getByRole('option', { name: 'Lifecycle LIVE' }).click();
    await expect(search(page).getByRole('button', { name: 'Remove Lifecycle LIVE' })).toBeVisible();
    await search(page).getByRole('button', { name: 'Search' }).click();
    await expect(result(page).getByLabel('Result summary')).toBeVisible();
    await expect(result(page).getByRole('navigation', { name: 'Focus path' })).toContainText('Data products · Lifecycle LIVE');
  });

  test('names the criteria when nothing matches and offers to clear them', async ({ page }) => {
    await page.goto('/');
    await openNav(page, 'Graph Studio');
    await nameBox(page).fill('zz-no-such-node');
    await nameBox(page).press('Escape');
    await search(page).getByRole('button', { name: 'Search' }).click();
    await expect(result(page)).toContainText('No nodes match "zz-no-such-node".');
    await result(page).getByRole('button', { name: 'Clear the search' }).click();
    await expect(result(page)).toContainText('Find a node to start.');
    await expect(nameBox(page)).toHaveValue('');
  });
});
