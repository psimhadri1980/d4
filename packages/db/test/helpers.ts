import { Client } from 'pg';
import { expect } from 'vitest';
import { createDb, runMigrations, type DbHandle } from '../src';

/** Admin connection to a Postgres server; integration tests are skipped when unset. */
export const ADMIN_URL = process.env.D4_TEST_POSTGRES_URL;

/** Creates a throwaway database, migrates it, and returns a handle plus a disposer. */
export async function freshDatabase(): Promise<DbHandle & { dispose(): Promise<void> }> {
  const name = `d4_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(ADMIN_URL!);
  url.pathname = `/${name}`;
  const handle = createDb(url.toString(), 4);
  await runMigrations(handle.db);

  return {
    ...handle,
    async dispose() {
      await handle.close();
      const c = new Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

/**
 * Expects a rejection whose message matches: the Postgres error a drizzle query error wraps
 * (constraint and trigger messages are in its `cause`), or the error itself when raised in code.
 */
export async function rejectsWith(p: Promise<unknown>, re: RegExp): Promise<void> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err as Error & { cause?: Error },
  );
  expect(e, 'expected a rejection').toBeDefined();
  expect(e!.cause?.message ?? e!.message).toMatch(re);
}
