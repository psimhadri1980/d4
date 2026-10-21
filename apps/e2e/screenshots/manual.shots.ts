import { test, type Page } from '@playwright/test';
import { api, defaultWorkspaceId, signIn, USERS } from '../tests/helpers';

/**
 * Captures the screenshots used by user-manual/ from the live stack and the UBS sample.
 * Rows left behind by browser-test runs (prefix "e2erun") are hidden, not deleted.
 */
const OUT = 'results/shots';
const failures: string[] = [];

async function shot(page: Page, name: string) {
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('tr, li, option')) {
      if (el.textContent?.includes('e2erun')) (el as HTMLElement).style.display = 'none';
    }
  });
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

/** One capture step; a failure is logged and the run carries on. */
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    failures.push(`${name}: ${String(e).split('\n')[0]}`);
  }
}

let ws = '';
test.beforeAll(async () => {
  ws = await defaultWorkspaceId();
});

test.afterAll(() => {
  if (failures.length) console.log(`CAPTURE FAILURES:\n${failures.join('\n')}`);
});

test('sign-in and viewer', async ({ browser }) => {
  const page = await browser.newPage();
  await step('login', async () => {
    await page.goto('/');
    await page.getByLabel('Username or email').waitFor();
    await shot(page, 'sign-in');
  });
  await step('viewer', async () => {
    await signIn(page, 'viewer');
    await page.goto(`/w/${ws}`);
    await page.locator('.sidebar, nav').first().hover();
    await shot(page, 'viewer-home');
  });
  await page.close();
});

test('explorer', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto(`/w/${ws}`);
  await step('home', () => shot(page, 'explorer-home'));
  await step('nav-expanded', async () => {
    await page.getByRole('button', { name: /expand|collapse|navigation/i }).last().click();
    await shot(page, 'nav-expanded');
    await page.getByRole('button', { name: /expand|collapse|navigation/i }).last().click();
  });
  await step('search', async () => {
    await page.getByLabel('Search elements').fill('client');
    await page.waitForTimeout(1200);
    await shot(page, 'explorer-search');
    await page.getByLabel('Search elements').fill('');
  });
  await step('filters', async () => {
    await page.getByLabel('Layer').selectOption('Data');
    await shot(page, 'explorer-filter-layer');
    await page.getByLabel('Layer').selectOption('');
  });
  await step('element', async () => {
    await page.getByLabel('Search elements').fill('Client Master');
    await page.waitForTimeout(1200);
    await page.locator('.items li a', { has: page.locator('.name', { hasText: /^Client Master$/ }) }).first().click();
    await page.waitForTimeout(2500);
    await shot(page, 'explorer-element');
    await page.locator('select').filter({ hasText: '2' }).first().selectOption('2').catch(() => undefined);
    await page.waitForTimeout(2000);
    await shot(page, 'explorer-depth2');
    await page.getByLabel('Layout').selectOption('hierarchy');
    await page.waitForTimeout(1500);
    await shot(page, 'explorer-hierarchy');
    await page.getByLabel('Layout').selectOption('radial');
  });
  await step('palette', async () => {
    await page.keyboard.press('Control+k');
    await page.locator('.palette input').fill('road');
    await page.waitForTimeout(1000);
    await shot(page, 'command-palette');
    await page.keyboard.press('Escape');
  });
  await step('export-menu', async () => {
    await page.getByRole('group', { name: 'Export' }).getByRole('combobox').first().selectOption('mermaid');
    await shot(page, 'export-menu');
    await page.getByRole('button', { name: 'Schedule…' }).click();
    await page.waitForTimeout(600);
    await shot(page, 'schedule-form');
  });
  await step('theme-dark', async () => {
    await page.getByLabel('Theme').selectOption('dark');
    await shot(page, 'explorer-dark');
    await page.getByLabel('Theme').selectOption('light');
  });
});

test('editing', async ({ page }) => {
  await signIn(page, 'admin');
  await step('new', async () => {
    await page.goto(`/w/${ws}/new`);
    await page.getByLabel('Type').selectOption('DataProduct');
    await page.getByLabel(/^Name/).fill('Client Consents');
    await page.getByLabel('Description').fill('Records what each client has agreed to.');
    await page.waitForTimeout(600);
    await shot(page, 'element-new');
  });
  await step('edit-and-relationship', async () => {
    const list = await api<{ items: { id: string; attrs: { name: string } }[] }>(`/v1/workspaces/${ws}/elements?q=Client%20Master&first=5`);
    const el = list.items.find((i) => i.attrs.name === 'Client Master');
    if (!el) throw new Error('Client Master not found');
    await page.goto(`/w/${ws}/e/${el.id}/edit`);
    await page.waitForTimeout(1500);
    await shot(page, 'element-edit');
    await page.goto(`/w/${ws}/e/${el.id}`);
    await page.waitForTimeout(2000);
    await page.getByRole('button', { name: '+ Add' }).click();
    await page.waitForTimeout(800);
    await shot(page, 'relationship-add');
  });
});

test('time and scenarios', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto(`/w/${ws}`);
  await step('as-of', async () => {
    await page.getByLabel('As of').fill('2027-08-01');
    await page.getByLabel('Search elements').fill('Client Master contract');
    await page.waitForTimeout(1500);
    await page.locator('.items li a', { has: page.locator('.name', { hasText: /^Client Master contract v2$/ }) }).first().click();
    await page.waitForTimeout(2500);
    await shot(page, 'view-as-of');
  });
  await step('compare', async () => {
    await page.goto(`/w/${ws}/compare?fromAsOf=2026-10-01&toAsOf=2027-08-01`);
    await page.waitForTimeout(3000);
    await shot(page, 'compare');
  });
});

test('insight pages', async ({ page }) => {
  await signIn(page, 'admin');
  for (const [name, kind] of [['matrix-crud', ''], ['matrix-capability', 'capability-application'], ['matrix-data-store', 'data-store-roles'], ['matrix-lifecycle', 'lifecycle']] as const) {
    await step(name, async () => {
      await page.goto(`/w/${ws}/matrices${kind ? `?kind=${kind}` : ''}`);
      await page.waitForTimeout(2500);
      await shot(page, name);
    });
  }
  await step('decisions', async () => {
    await page.goto(`/w/${ws}/decisions`);
    await page.waitForTimeout(1500);
    await page.getByRole('list', { name: 'Decision log' }).getByRole('button').first().click();
    await page.waitForTimeout(1200);
    await shot(page, 'decisions');
  });
  await step('roadmap', async () => {
    await page.goto(`/w/${ws}/roadmap`);
    await page.getByLabel('Client Data Consolidation').check();
    await page.waitForTimeout(3500);
    await shot(page, 'roadmap');
    await page.locator('svg [role="button"], svg rect, svg g').filter({ hasText: /Build Client MDM Hub/ }).first().click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(1200);
    await shot(page, 'roadmap-item');
  });
});

test('queries', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto(`/w/${ws}/queries`);
  await step('catalog-run', async () => {
    await page.getByRole('button', { name: /Orphan elements/ }).first().click();
    await page.waitForTimeout(1000);
    await shot(page, 'query-run-form');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await page.waitForTimeout(3000);
    await shot(page, 'query-run-result');
  });
  await step('catalog-graph', async () => {
    await page.getByRole('button', { name: /Lineage graph of a data product/ }).first().click();
    await page.waitForTimeout(1200);
    await page.getByLabel(/Search/).last().fill('Client Master').catch(() => undefined);
    await page.waitForTimeout(1200);
    await page.locator('select[size]').last().selectOption({ label: 'Client Master — DataProduct' }).catch(() => undefined);
    await shot(page, 'query-run-graph-form');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await page.waitForTimeout(3500);
    await shot(page, 'query-run-graph');
  });
  await step('new-query', async () => {
    await page.getByRole('button', { name: '+ New query' }).click();
    await page.waitForTimeout(500);
    await shot(page, 'query-new');
  });
  await step('manage', async () => {
    await page.locator('summary', { hasText: 'Manage any query' }).click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /Orphan elements/ }).last().click();
    await page.waitForTimeout(1500);
    await shot(page, 'query-review');
  });
});

test('query studio and stewardship', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto(`/w/${ws}/queries`);
  const title = 'Applications by lifecycle';
  await step('studio', async () => {
    await page.getByRole('button', { name: '+ New query' }).click();
    await page.getByLabel('Title *').fill(title);
    await page.getByLabel('Tags').fill('inventory, applications');
    await shot(page, 'studio-new');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForTimeout(2000);
    await page.getByLabel('Cypher').fill(`MATCH (n:Application)
WHERE n.workspaceId = $workspace AND n.deleted = false
RETURN n.name AS name, n.lifecycle AS lifecycle
ORDER BY name
LIMIT 100`);
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.waitForTimeout(2500);
    await shot(page, 'studio-edit');
    await page.getByRole('button', { name: 'Test run' }).click();
    await page.waitForTimeout(3000);
    await page.getByRole('heading', { name: /Test run/ }).scrollIntoViewIfNeeded();
    await shot(page, 'studio-test-run');
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await page.waitForTimeout(2500);
    await shot(page, 'studio-submitted');
  });
  await step('stewardship', async () => {
    await page.reload();
    await page.waitForTimeout(2000);
    await page.getByRole('button', { name: new RegExp(title) }).nth(1).click();
    await page.waitForTimeout(2000);
    await shot(page, 'stewardship-review');
  });
  await step('cleanup', async () => {
    const list = await api<{ id: string; title: string }[]>('/v1/catalog');
    for (const q of list.filter((x) => x.title === title)) {
      await api(`/v1/catalog/${q.id}/review`, { method: 'POST', body: JSON.stringify({ action: 'reject', note: 'Sample only' }) }).catch(() => undefined);
      await api(`/v1/catalog/${q.id}`, { method: 'DELETE' }).catch((e) => failures.push(`cleanup: ${String(e)}`));
    }
  });
});

test('proposals and import', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto(`/w/${ws}/proposals`);
  await step('proposal', async () => {
    await page.getByPlaceholder('New proposal title').fill('Add a data product for client consents');
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForTimeout(1500);
    await shot(page, 'proposal-empty');
    await page.getByLabel('Type').selectOption('DataProduct');
    await page.getByLabel('Name').fill('Client Consents');
    await page.getByRole('button', { name: 'Add to proposal' }).click();
    await page.waitForTimeout(1500);
    await shot(page, 'proposal-draft');
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Delete draft' }).click();
    await page.waitForTimeout(800);
  });
  await step('import', async () => {
    await page.goto(`/w/${ws}/import`);
    await shot(page, 'import-start');
    const csv = 'name,type,description\nClient Consents,DataProduct,Records of client consent\nMarketing Preferences,DataProduct,Channel preferences\n';
    await page.getByLabel(/Files/).setInputFiles({ name: 'data-products.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.waitForTimeout(2500);
    await shot(page, 'import-mapping');
    await page.getByRole('button', { name: 'Check (dry run)' }).click();
    await page.waitForTimeout(3000);
    await shot(page, 'import-check');
  });
});

test('operations', async ({ page }) => {
  await signIn(page, 'admin');
  for (const [name, path] of [['jobs', 'jobs'], ['reports', 'reports'], ['admin-workspaces', 'admin/workspaces'], ['admin-people', 'admin/people'], ['admin-webhooks', 'admin/webhooks'], ['admin-usage', 'admin/usage'], ['backups', 'backups']] as const) {
    await step(name, async () => {
      await page.goto(`/w/${ws}/${path}`);
      await page.waitForTimeout(2500);
      await shot(page, name);
    });
  }
  await step('connector-form', async () => {
    await page.goto(`/w/${ws}/connectors`);
    await page.getByRole('button', { name: 'Add connector' }).click();
    await page.waitForTimeout(600);
    await shot(page, 'connector-form');
  });
  await step('webhook-form', async () => {
    await page.goto(`/w/${ws}/admin/webhooks`);
    await page.waitForTimeout(1500);
    await shot(page, 'admin-webhooks-form');
  });
});

void USERS;
