import { expect, type Page } from '@playwright/test';

export const KEYCLOAK = process.env.E2E_KEYCLOAK_URL ?? 'http://localhost:8080';
export const API = process.env.E2E_API_URL ?? 'http://localhost:3000';

/** Local dev users from deploy/keycloak/d4-realm.json (not real accounts). */
export const USERS = {
  admin: { username: 'dev-admin', password: 'd4-local-dev' },
  viewer: { username: 'dev-viewer', password: 'd4-local-dev' },
  author: { username: 'dev-author', password: 'd4-local-dev' },
  steward: { username: 'dev-steward', password: 'd4-local-dev' },
} as const;

/** Prefix for everything a run creates; one search token (no hyphens) so cleanup can find it. */
export const RUN = `e2erun${Date.now().toString(36)}`;

/** Signs in through the real Keycloak page and waits for the explorer. */
export async function signIn(page: Page, user: keyof typeof USERS) {
  await page.goto('/');
  await page.getByLabel('Username or email').fill(USERS[user].username);
  await page.getByLabel('Password', { exact: true }).fill(USERS[user].password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByText(USERS[user].username)).toBeVisible();
}

/** Access token via the password grant, for API-side setup and cleanup. */
export async function token(user: keyof typeof USERS): Promise<string> {
  const res = await fetch(`${KEYCLOAK}/realms/d4/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ client_id: 'd4-web', grant_type: 'password', ...USERS[user] }),
  });
  if (!res.ok) throw new Error(`token for ${user}: ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

export async function api<T>(path: string, init: RequestInit & { as?: keyof typeof USERS } = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await token(init.as ?? 'admin')}`, 'content-type': 'application/json' },
  });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export async function defaultWorkspaceId(): Promise<string> {
  const list = await api<{ id: string; slug: string }[]>('/v1/workspaces');
  const ws = list.find((w) => w.slug === 'default');
  if (!ws) throw new Error('default workspace missing; run deploy/dev.sh up');
  return ws.id;
}

/** Opens a page from the left navigation: an item, or one of its sub-items through the icon rail's flyout. */
export async function openNav(page: Page, item: string, sub?: string) {
  const nav = page.getByRole('navigation', { name: 'Main' });
  const link = nav.getByRole('link', { name: item, exact: true });
  if (!sub) return link.click();
  await link.hover();
  await nav.getByRole('group', { name: `${item} pages` }).getByRole('link', { name: sub, exact: true }).click();
}
