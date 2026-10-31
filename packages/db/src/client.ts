import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction; stores accept either. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DbHandle {
  db: Db;
  pool: Pool;
  close(): Promise<void>;
}

export function createDb(connectionString: string, max = 10): DbHandle {
  const pool = new Pool({ connectionString, max });
  // An idle connection the server ends (a restart, a terminated backend, a dropped database)
  // emits 'error' on the pool; unheard, it would end the process. The pool discards that
  // connection and opens a new one for the next query.
  pool.on('error', (e) => console.warn(`Postgres closed an idle connection: ${e.message}`));
  return { db: drizzle(pool, { schema }), pool, close: () => pool.end() };
}
