import { closePool, withoutOrg } from '../src/lib/db';

async function main() {
  const extensions = await withoutOrg((sql) =>
    sql.query<{ extname: string; extversion: string }>(
      `SELECT extname, extversion FROM pg_extension ORDER BY extname`,
    ),
  );
  console.log('EXTENSIONS', JSON.stringify(extensions));

  const funcs = await withoutOrg((sql) =>
    sql.query<{ schema: string; name: string; args: string; result: string }>(
      `SELECT n.nspname AS schema,
              p.proname AS name,
              pg_get_function_identity_arguments(p.oid) AS args,
              pg_get_function_result(p.oid) AS result
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE lower(n.nspname) LIKE '%neon%'
          OR lower(p.proname) LIKE '%neon%'
          OR lower(p.proname) LIKE '%time%travel%'
          OR lower(p.proname) LIKE '%branch%'
       ORDER BY n.nspname, p.proname`,
    ),
  );
  console.log('NEON_FUNCTIONS', JSON.stringify(funcs));

  const settings = await withoutOrg((sql) =>
    sql.query<{ name: string; setting: string }>(
      `SELECT name, setting
       FROM pg_settings
       WHERE lower(name) LIKE '%neon%'
          OR lower(name) LIKE '%timeline%'
          OR lower(name) LIKE '%branch%'
       ORDER BY name`,
    ),
  );
  console.log('NEON_SETTINGS', JSON.stringify(settings));

  const version = await withoutOrg((sql) =>
    sql.one<{ version: string; lsn: string }>(
      `SELECT version(), pg_current_wal_lsn()::text AS lsn`,
    ),
  );
  console.log('DB_VERSION', JSON.stringify(version));
  await closePool();
}

main().catch(async (err) => {
  console.error('NEON_SQL_AUDIT_FAILED', err);
  try { await closePool(); } catch {}
  process.exit(1);
});
