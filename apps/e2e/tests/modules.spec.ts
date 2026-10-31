import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { api, defaultWorkspaceId, RUN } from './helpers';

/**
 * Web modules at run time (P6): a module that cannot load leaves the rest of D4 usable, a deep
 * link waits for its module, and a release swaps in on an open page and rolls back.
 */

/** The shell reads the module registry again when the tab becomes visible (instead of its 30 s poll). */
const resync = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

test.describe('web modules', () => {
  test('a module that fails to load is unavailable; the rest of D4 works', async ({ page }) => {
    const ws = await defaultWorkspaceId();
    // Reporting's entry fails, wherever the registry points it (module image or release).
    await page.route(/\/mfe\/.*reporting\.js/, (route) => route.abort());
    await page.goto(`/w/${ws}/reports`);
    await expect(page.getByRole('alert')).toContainText('This part of D4 is unavailable at the moment.');
    // The deep link stays where it was; the menu leaves the module out.
    await expect(page).toHaveURL(new RegExp(`/w/${ws}/reports$`));
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Queries', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Reports', exact: true })).toHaveCount(0);

    // Another module's pages still work.
    await nav.getByRole('link', { name: 'Queries', exact: true }).click();
    await expect(page).toHaveURL(/\/queries/);
    await expect(page.locator('section.accordion').first()).toBeVisible();
  });

  test('a deep link waits for its module instead of leaving the page', async ({ page }) => {
    const ws = await defaultWorkspaceId();
    await page.route(/\/mfe\/.*reporting\.js/, async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.goto(`/w/${ws}/jobs`);
    await expect(page.getByRole('status')).toHaveText('Loading…');
    await expect(page.getByRole('heading', { name: 'Background jobs' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/w/${ws}/jobs$`));
  });

  test('a new release swaps in on an open page and rolls back', async ({ page }) => {
    const ws = await defaultWorkspaceId();
    // A plain JavaScript module of this run's own, so the registry's real modules are not touched.
    const name = RUN;
    const source = (version: string) => `
      export const manifest = { id: '${name}', contract: 2, nav: { group: 'Labs', order: 90, items: [{ id: '${name}', label: '${name}', icon: 'flask', to: '${name}', match: ['${name}'] }] } };
      let el;
      export async function bootstrap() {}
      export async function mount({ domElementGetter }) { el = domElementGetter(); el.innerHTML = '<p>Release ${version}</p>'; }
      export async function unmount() { el.innerHTML = ''; }
    `;
    const release = async (version: string) => {
      const js = source(version);
      const published = await api<{ entry: string }>(`/v1/admin/web-modules/${name}/releases`, {
        method: 'POST',
        body: JSON.stringify({
          manifest: { name, version, contract: 2, entry: `${name}.js`, framework: 'vanilla', files: { [`${name}.js`]: createHash('sha256').update(js).digest('hex') } },
          files: { [`${name}.js`]: Buffer.from(js).toString('base64') },
        }),
      });
      return published.entry;
    };
    const activate = (entry: string, version: string) =>
      api(`/v1/admin/web-modules/${name}`, { method: 'PUT', body: JSON.stringify({ title: name, entry, version, contract: 2, framework: 'vanilla' }) });

    const first = await release('1.0.0');
    const second = await release('1.1.0');
    try {
      await activate(first, '1.0.0');
      await page.goto(`/w/${ws}/${name}`);
      await expect(page.getByText('Release 1.0.0')).toBeVisible();
      // Marks this page load: a reload would lose it.
      await page.evaluate(() => ((window as unknown as { d4Marker: boolean }).d4Marker = true));

      await activate(second, '1.1.0');
      await resync(page);
      await expect(page.getByText('Release 1.1.0')).toBeVisible();

      await activate(first, '1.0.0');
      await resync(page);
      await expect(page.getByText('Release 1.0.0')).toBeVisible();
      expect(await page.evaluate(() => (window as unknown as { d4Marker?: boolean }).d4Marker)).toBe(true);
      await expect(page).toHaveURL(new RegExp(`/w/${ws}/${name}$`));
    } finally {
      await api(`/v1/admin/web-modules/${name}`, { method: 'DELETE' }).catch(() => undefined);
      for (const v of ['1.0.0', '1.1.0']) await api(`/v1/admin/web-modules/${name}/releases/${v}`, { method: 'DELETE' }).catch(() => undefined);
    }
  });
});
