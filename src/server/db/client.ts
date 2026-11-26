import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { mkdirSync } from 'node:fs';
import pg from 'pg';
import { BOOTSTRAP_SQL } from './schema';

export type DB = PgDatabase<any, any, any>;

export interface OpenDb {
  db: DB;
  kind: 'postgres' | 'pglite';
  close: () => Promise<void>;
}

/**
 * Production uses a real PostgreSQL server (DATABASE_URL).
 * Without one we run PGlite, an embedded Postgres: on disk for local use, in memory for tests.
 */
export async function openDb(opts: { databaseUrl?: string; dataDir?: string } = {}): Promise<OpenDb> {
  if (opts.databaseUrl) {
    const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 5 });
    await pool.query(BOOTSTRAP_SQL);
    return { db: drizzlePg(pool) as unknown as DB, kind: 'postgres', close: () => pool.end() };
  }
  if (opts.dataDir) mkdirSync(opts.dataDir, { recursive: true });
  const client = new PGlite(opts.dataDir);
  await client.exec(BOOTSTRAP_SQL);
  return { db: drizzlePglite(client) as unknown as DB, kind: 'pglite', close: () => client.close() };
}
