import { expect, test, type Page } from '@playwright/test';
import { api, creditWorkspaceId, defaultWorkspaceId, openNav, RUN } from './helpers';

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
    // Nodes, not group stubs: a deeper level opens groups into nodes, so there may be fewer stubs.
    const nodes = result(page).locator('.graph-canvas-node:not(.group)');
    const one = await nodes.count();
    await result(page).getByRole('button', { name: 'Depth 2' }).click();
    await expect.poll(() => nodes.count()).toBeGreaterThan(one);
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

  test('a pinned node stays on the canvas through a new search until it is unpinned (D85)', async ({ page }) => {
    await findClientMaster(page);
    await card(page, 'Client Master').click();
    const pin = page.getByRole('complementary', { name: 'Client Master' }).getByRole('button', { name: 'Pin' });
    await pin.click();
    await expect(pin).toHaveAttribute('aria-pressed', 'true');
    await expect(card(page, 'Client Master')).toHaveAttribute('aria-label', 'Client Master, DataProduct, Data, root, pinned');

    await nameBox(page).fill('Product Reference');
    await nameBox(page).press('Escape');
    await nameBox(page).press('Enter');
    await expect(card(page, 'Product Reference')).toHaveAttribute('aria-label', /, root$/);
    await expect(card(page, 'Client Master')).toHaveAttribute('aria-label', 'Client Master, DataProduct, Data, pinned');

    await card(page, 'Client Master').click();
    await page.getByRole('complementary', { name: 'Client Master' }).getByRole('button', { name: 'Unpin' }).click();
    await expect(result(page).locator('.graph-canvas-node.pinned')).toHaveCount(0);
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
      expect(label).toMatch(/, DataStore, |, root$|data stores?, group, click to open$/);
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

  test('a new lens is built in the editor from what the data links, saved, used, edited and deleted', async ({ page }) => {
    await page.goto('/');
    await openNav(page, 'Graph Studio');
    await search(page).getByRole('button', { name: '＋ New lens…' }).click();
    const editor = page.getByRole('dialog', { name: 'New lens' });
    await expect(editor.getByRole('button', { name: 'Save' })).toBeDisabled();

    await editor.getByRole('button', { name: /Choose a node type/ }).click();
    await editor.getByRole('searchbox', { name: 'Find a node type', exact: true }).fill('DataProduct');
    await editor.getByRole('dialog', { name: 'Contour type' }).getByRole('button', { name: 'DataProduct', exact: true }).click();
    await expect(editor).toContainText('nodes of this type in the data.');
    // Facets the data actually links, with counts.
    await editor.getByRole('list', { name: 'Facet suggestions' }).getByRole('button', { name: /HOLDS DataStore/ }).click();
    await expect(editor.locator('.lens-facet summary')).toHaveText('Linked to DataStore by HOLDS');
    const preview = editor.getByRole('complementary', { name: 'Preview' });
    await expect(preview).toContainText('roots');
    await expect(preview.locator('.lens-sample li').first()).toBeVisible();

    const name = `Held products ${RUN}`;
    await editor.getByLabel('Name', { exact: true }).fill(name);
    await editor.getByLabel('Layout').selectOption('flow');
    await editor.getByRole('button', { name: 'Save' }).click();

    // Back in the Studio with the lens selected and its result, in its layout.
    await expect(search(page).getByLabel('Lens', { exact: true }).locator('option:checked')).toHaveText(new RegExp(`^${name}`));
    await expect(result(page).getByRole('button', { name: 'Flow' })).toHaveAttribute('aria-pressed', 'true');
    await expect(result(page).locator('.graph-canvas-node.root').first()).toBeVisible();

    // It lasts beyond the session.
    await page.reload();
    await search(page).getByLabel('Lens', { exact: true }).selectOption({ label: `${name} (DataProduct · 1 facet)` });
    await search(page).getByRole('button', { name: `Edit the lens ${name}` }).click();
    const edit = page.getByRole('dialog', { name: `Edit lens: ${name}` });
    await edit.getByLabel('Depth').selectOption('1');
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(result(page).getByRole('button', { name: 'Depth 1' })).toHaveAttribute('aria-pressed', 'true');

    await search(page).getByRole('button', { name: `Edit the lens ${name}` }).click();
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('dialog', { name: `Edit lens: ${name}` }).getByRole('button', { name: 'Delete lens' }).click();
    await expect(search(page).getByLabel('Lens', { exact: true }).locator('option', { hasText: name })).toHaveCount(0);
  });

  test('a Query Author writes a lens query; once a steward publishes it, the lens finds its roots with its parameters', async ({ page }) => {
    await page.goto('/');
    await openNav(page, 'Graph Studio');
    await search(page).getByRole('button', { name: '＋ New lens…' }).click();
    const editor = page.getByRole('dialog', { name: 'New lens' });
    await editor.getByRole('button', { name: /Choose a node type/ }).click();
    await editor.getByRole('searchbox', { name: 'Find a node type', exact: true }).fill('Application');
    await editor.getByRole('dialog', { name: 'Contour type' }).getByRole('button', { name: 'Application', exact: true }).click();
    await editor.getByRole('radio', { name: 'A catalog query' }).check();

    const title = `Apps by criticality ${RUN}`;
    await editor.getByRole('button', { name: 'Write a new query…' }).click();
    const writer = editor.getByRole('group', { name: 'New catalog query' });
    await writer.getByLabel('Query title').fill(title);
    await writer.getByLabel('Cypher').fill(
      'MATCH (a:Application) WHERE a.workspaceId = $workspace AND a.deleted = false AND ($criticality IS NULL OR a.criticality = $criticality) RETURN a.id AS id',
    );
    await writer.getByLabel('Parameters (JSON)').fill('[{ "name": "criticality", "type": "enum", "values": ["LOW", "MEDIUM", "HIGH", "MISSION_CRITICAL"] }]');
    await writer.getByRole('button', { name: 'Submit for review' }).click();
    // Submitted and chosen; nothing runs until a steward publishes it.
    await expect(editor.getByLabel('Catalog query').locator('option:checked')).toHaveText(`${title} (in review)`);
    await expect(editor.getByRole('status')).toContainText('Waiting for review');
    await editor.getByRole('group', { name: 'Query parameters' }).getByLabel('Criticality').selectOption('HIGH');
    await editor.getByRole('group', { name: 'Quick filter attributes' }).getByLabel('Hosting').check();
    const name = `Apps query ${RUN}`;
    await editor.getByLabel('Name', { exact: true }).fill(name);
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(search(page).getByLabel('Lens', { exact: true }).locator('option:checked')).toHaveText(new RegExp(`^${name}`));

    // Another person reviews and publishes it (authors cannot review their own).
    const entry = (await api<{ id: string; title: string }[]>('/v1/catalog', { as: 'steward' })).find((q) => q.title === title)!;
    await api(`/v1/catalog/${entry.id}/review`, { method: 'POST', as: 'steward', body: JSON.stringify({ decision: 'publish' }) });

    await page.reload();
    await search(page).getByLabel('Lens', { exact: true }).selectOption({ label: `${name} (Application · catalog query)` });
    const params = search(page).getByRole('group', { name: 'Query parameters' });
    await expect(params.getByLabel('Criticality')).toHaveValue('HIGH');
    await params.getByLabel('Criticality').selectOption('MISSION_CRITICAL');
    await search(page).getByRole('button', { name: 'Search' }).click();
    await expect(card(page, 'Core Banking System')).toHaveAttribute('aria-label', /Application, root$/);
    await expect(result(page).locator('.graph-canvas-node.root')).toHaveCount(2);
    // Its quick filters are the ones the lens chose.
    await nameBox(page).focus();
    await expect(search(page).getByRole('option', { name: /^Hosting / }).first()).toBeVisible();
    await expect(search(page).getByRole('option', { name: /^Criticality / })).toHaveCount(0);

    const ws = await defaultWorkspaceId();
    const saved = (await api<{ id: string; name: string }[]>(`/v1/workspaces/${ws}/studio/lenses`)).find((l) => l.name === name)!;
    await api(`/v1/workspaces/${ws}/studio/lenses/${saved.id}`, { method: 'DELETE' });
    await api(`/v1/catalog/${entry.id}`, { method: 'DELETE', as: 'steward' });
  });

  test('Save as lens opens the editor filled in from the search', async ({ page }) => {
    await findClientMaster(page);
    await search(page).getByRole('button', { name: 'Save as lens' }).click();
    const editor = page.getByRole('dialog', { name: 'New lens' });
    await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Client Master');
    await expect(editor.getByRole('button', { name: /DataProduct/ }).first()).toBeVisible();
    await expect(editor.getByRole('group', { name: 'Filter on Name' })).toBeVisible();
    await editor.getByRole('button', { name: 'Cancel' }).click();
    await expect(card(page, 'Client Master')).toBeVisible();
  });

  test('the Overview shows one bubble per type; isolating one shows only it in the graph', async ({ page }) => {
    await findClientMaster(page);
    await result(page).getByRole('button', { name: 'Depth 2' }).click();
    await result(page).getByRole('tab', { name: 'Overview' }).click();
    const bubbles = result(page).locator('.graph-canvas-bubble');
    await expect(bubbles.first()).toBeVisible();
    await expect(result(page).getByRole('table', { name: 'Node types in this result' })).toContainText('DataProduct');
    await result(page).getByRole('button', { name: /^DataStore, Data: \d+ nodes?\. Isolate$/ }).click();
    await expect(result(page).getByRole('tab', { name: 'Graph' })).toHaveAttribute('aria-selected', 'true');
    await expect(result(page).getByRole('button', { name: 'Remove DataStore' })).toBeVisible();
    for (const label of await result(page).locator('.graph-canvas-node').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!)))
      expect(label).toMatch(/, DataStore, |, root$|data stores?, group, click to open$/);
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

  test.describe('credit graph', () => {
    // The lens and its root count from the requirements (CG-4).
    for (const [id, lens, roots] of [
      ['credit-margin-calls', 'Facilities with margin calls', 8],
      ['credit-ifrs-stage-2-3', 'Facilities in IFRS stage 2 or 3', 23],
      ['credit-breached-covenants', 'Facilities with a breached covenant', 10],
      ['credit-large-facilities', 'Large facilities (10m and over)', 2],
    ] as const) {
      test(`${lens} finds ${roots} roots`, async ({ page }) => {
        await page.goto(`/w/${await creditWorkspaceId()}/graph-studio`);
        await search(page).getByLabel('Lens', { exact: true }).selectOption(id);
        await search(page).getByRole('button', { name: 'Search' }).click();
        await expect(result(page).getByLabel('Result summary')).toContainText(`${roots} roots`);
      });
    }

    test('a Hierarchy lens shows the first level, folds the rest into groups, and opens a group on a click (D85)', async ({ page }) => {
      await page.goto(`/w/${await creditWorkspaceId()}/graph-studio`);
      await search(page).getByLabel('Lens', { exact: true }).selectOption('credit-facility-breakdown');
      await search(page).getByRole('button', { name: 'Search' }).click();
      await result(page).getByRole('tab', { name: 'Graph' }).click();
      const groups = result(page).locator('.graph-canvas-node.group');
      await expect(groups.first()).toBeVisible();
      const before = await result(page).locator('.graph-canvas-node:not(.group)').count();
      const label = (await groups.first().getAttribute('aria-label'))!;
      expect(label).toMatch(/^\d+ [a-z ]+, group, click to open$/);
      await groups.first().click();
      await expect.poll(() => result(page).locator('.graph-canvas-node:not(.group)').count()).toBeGreaterThan(before);
    });

    test('only credit lenses show on the credit workspace, and none on the default one', async ({ page }) => {
      await page.goto(`/w/${await creditWorkspaceId()}/graph-studio`);
      const options = search(page).getByLabel('Lens', { exact: true }).locator('option');
      await expect(options.filter({ hasText: 'Facilities with margin calls' })).toHaveCount(1);
      await expect(options.filter({ hasText: 'Data products' })).toHaveCount(0);
      await page.goto('/');
      await openNav(page, 'Graph Studio');
      await expect(search(page).getByLabel('Lens', { exact: true }).locator('option', { hasText: 'Facilities with margin calls' })).toHaveCount(0);
    });
  });
});
