/**
 * Drops every application table and re-applies migrations from scratch.
 * For local development only -- refuses to run against anything that
 * doesn't look like a local database, as a guard against fat-fingering a
 * shared environment.
 */
import { Pool } from 'pg';
import { getEnv } from '../src/lib/env';

async function main() {
  const env = getEnv();
  const url = env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL;

  if (!/localhost|127\.0\.0\.1/.test(url) && env.NODE_ENV !== 'test') {
    throw new Error(
      'db:reset refuses to run against a non-local DATABASE_URL. ' +
        'This drops every table. If you really mean it, run the DROP SCHEMA ' +
        'manually against the target database.',
    );
  }

  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    console.log('Dropping and recreating the public schema...');
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    console.log('Schema reset. Run `npm run db:migrate` next.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
