import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { getEnv } from '../src/lib/env';
import { sha256 } from '../src/lib/crypto';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

async function main() {
  const env = getEnv();
  // Migrations run as the schema owner; the application role deliberately
  // lacks the privileges to alter its own schema.
  const pool = new Pool({
    connectionString: env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL,
    max: 1,
  });
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        TEXT PRIMARY KEY,
        checksum    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const { rows: applied } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const appliedMap = new Map(applied.map((r) => [r.name, r.checksum]));

    let count = 0;
    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = sha256(sql);
      const previous = appliedMap.get(file);

      if (previous) {
        // An already-applied migration whose contents changed means the
        // deployed schema no longer matches the repository. Refuse rather
        // than silently diverge.
        if (previous !== checksum) {
          throw new Error(
            `Migration ${file} has changed after being applied.\n` +
              'Create a new migration instead of editing an applied one.',
          );
        }
        continue;
      }

      process.stdout.write(`Applying ${file} ... `);
      // Each migration is one transaction: it applies completely or not at all.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
          [file, checksum],
        );
        await client.query('COMMIT');
        process.stdout.write('done\n');
        count += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        process.stdout.write('FAILED\n');
        throw err;
      }
    }

    console.log(count === 0 ? 'Schema is up to date.' : `Applied ${count} migration(s).`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
