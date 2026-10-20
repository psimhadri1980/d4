import { expect, test } from '@playwright/test';
import { api, defaultWorkspaceId, RUN, signIn } from './helpers';

/**
 * Four eyes: dev-author (made a contributor in the workspace for this test) proposes, dev-admin
 * approves. Nothing reaches the model until the approval.
 */
let ws: string;
let authorId: string;

test.beforeAll(async () => {
  ws = await defaultWorkspaceId();
  // Users exist after their first API call; then the author gets write access here.
  authorId = (await api<{ userId: string }>('/v1/me', { as: 'author' })).userId;
  await api(`/v1/admin/members/${ws}`, { method: 'POST', body: JSON.stringify({ principalId: authorId, role: 'contributor' }) });
});
test.afterAll(async () => {
  await api(`/v1/admin/members/${ws}`, { method: 'DELETE', body: JSON.stringify({ principalId: authorId, role: 'contributor' }) });
});

test('a contributor proposes a new element, and an admin approves it into the model', async ({ browser, page: admin }) => {
  // Two people, two sign-ins: longer than the default on a busy machine.
  test.setTimeout(60_000);
  const title = `${RUN} add a store`;
  const storeName = `${RUN} Proposed Store`;

  // ── The author drafts and submits ─────────────────────────────────────
  const authorCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const author = await authorCtx.newPage();
  await signIn(author, 'author');
  await author.getByRole('link', { name: 'Proposals' }).click();
  await author.getByLabel('New proposal title').fill(title);
  await author.getByRole('button', { name: 'Create', exact: true }).click();
  const proposal = author.getByRole('article', { name: `Proposal ${title}` });
  await expect(proposal.getByLabel('Status')).toHaveText('draft');

  const add = proposal.getByRole('form', { name: 'New element' });
  await add.getByLabel('Type').selectOption('DataStore');
  await add.getByLabel('Name').fill(storeName);
  await add.getByRole('button', { name: 'Add to proposal' }).click();
  await expect(proposal.getByRole('list', { name: 'Changes' })).toContainText(`Add DataStore '${storeName}'`);
  await expect(proposal.getByRole('status')).toContainText('Every change applies');

  // Not in the model yet.
  expect((await api<{ items: { attrs: { name: string } }[] }>(`/v1/workspaces/${ws}/elements?q=${RUN}`)).items.filter((e) => e.attrs.name === storeName)).toEqual([]);

  await proposal.getByRole('button', { name: 'Submit for review' }).click();
  await expect(proposal.getByLabel('Status')).toHaveText('submitted');
  await expect(proposal.getByText('Waiting for an architect or admin other than you to review.')).toBeVisible();
  const url = author.url();
  await authorCtx.close();

  // ── The admin approves ────────────────────────────────────────────────
  await admin.goto(new URL(url).pathname);
  const review = admin.getByRole('article', { name: `Proposal ${title}` });
  await review.getByRole('group', { name: 'Review' }).getByLabel('Review comment').fill('Fine by me');
  await review.getByRole('button', { name: 'Approve and apply' }).click();
  await expect(review.getByLabel('Status')).toHaveText('applied');
  await expect(review.getByLabel('Review comment')).toHaveText('Fine by me');

  await review.getByRole('link', { name: 'open' }).click();
  await expect(admin.getByRole('heading', { name: storeName })).toBeVisible();

  // Clean up the element the proposal created.
  const created = (await api<{ items: { id: string; version: number; attrs: { name: string } }[] }>(`/v1/workspaces/${ws}/elements?q=${RUN}`)).items.find((e) => e.attrs.name === storeName)!;
  await api(`/v1/workspaces/${ws}/elements/${created.id}?expectedVersion=${created.version}`, { method: 'DELETE' });
});

test('every filter lists without errors, and opening a proposal keeps the filter', async ({ page }) => {
  await page.goto(`/w/${ws}/proposals`);
  const show = page.getByLabel('Show');
  for (const label of ['Open', 'Waiting for review', 'Closed', 'All']) {
    await show.selectOption({ label });
    await expect(page.getByRole('list', { name: 'Proposals' }).or(page.getByText('No proposals here.')).first()).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
  await show.selectOption({ label: 'All' });
  const first = page.getByRole('list', { name: 'Proposals' }).getByRole('link').first();
  await first.click();
  await expect(page).toHaveURL(/show=all/);
  await expect(show).toHaveValue('3');
});
