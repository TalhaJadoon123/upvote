import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle migrations.
 * The CLI reads/writes JSON, so migrations are only needed for the dashboard.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/upvote',
  },
  strict: true,
  verbose: true,
});