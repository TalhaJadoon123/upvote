import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

/**
 * Database connection.
 *
 * The connection string is validated at module load rather than at first query,
 * so a missing DATABASE_URL fails the build instead of the first page view.
 */
function connectionString(): string {
  const url =
    process.env.DATABASE_URL ??
    process.env.POSTGRES_URL ??
    'postgres://postgres:postgres@localhost:5432/upvote';
  return url;
}

let client: ReturnType<typeof postgres> | null = null;

export function getClient() {
  if (!client) {
    client = postgres(connectionString(), {
      max: Number(process.env.DATABASE_POOL ?? 10),
      idle_timeout: 20,
      // Managed Postgres providers (Neon, Supabase) need TLS in production.
      ssl: process.env.DATABASE_SSL === 'false' ? undefined : process.env.NODE_ENV === 'production' ? 'require' : undefined,
      prepare: false,
    });
  }
  return client;
}

export const db = drizzle(getClient(), { schema });

export type Database = typeof db;
export { schema };