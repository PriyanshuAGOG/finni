/**
 * Diagnostic: prints how many sources exist (active vs archived vs
 * deleted), the most recently created ones, and the most recent server
 * errors -- no destructive queries, nothing is ever written. Use this to
 * check whether data actually went missing versus "new adds have been
 * failing," which look identical from the dashboard but have very
 * different fixes.
 */
import { withOrg, withoutOrg, closePool } from '../src/lib/db';
import { reportError } from './lib/report-error';

async function main() {
  const orgs = await withoutOrg((sql) =>
    sql.query<{ id: string; name: string; slug: string }>(
      `SELECT id, name, slug FROM organizations ORDER BY created_at`,
    ),
  );

  if (orgs.length === 0) {
    console.log('No organizations exist in this database.');
    await closePool();
    return;
  }

  for (const org of orgs) {
    console.log(`\nOrganization: ${org.name} (${org.slug})`);

    const counts = await withOrg(org.id, (sql) =>
      sql.one<{ total: number; active: number; archived: number; deleted: number }>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'active')::int AS active,
                count(*) FILTER (WHERE status = 'archived')::int AS archived,
                count(*) FILTER (WHERE status = 'deleted')::int AS deleted
         FROM sources`,
      ),
    );
    console.log(
      `  Sources: ${counts?.total ?? 0} total (${counts?.active ?? 0} active, ` +
        `${counts?.archived ?? 0} archived, ${counts?.deleted ?? 0} deleted)`,
    );

    const recent = await withOrg(org.id, (sql) =>
      sql.query<{ title: string; created_at: string; status: string }>(
        `SELECT title, created_at, status FROM sources ORDER BY created_at DESC LIMIT 10`,
      ),
    );
    if (recent.length === 0) {
      console.log('  No sources at all.');
    } else {
      console.log('  Most recent:');
      for (const r of recent) {
        console.log(`    - [${r.status}] ${r.title}  (${r.created_at})`);
      }
    }
  }

  console.log('\nRecent server errors (last 20, any organization):');
  const errors = await withoutOrg((sql) =>
    sql.query<{
      created_at: string;
      severity: string;
      message: string;
      operation_id: string | null;
      path: string | null;
    }>(
      `SELECT created_at, severity, message, operation_id, path
       FROM error_logs
       WHERE origin = 'api_server'
       ORDER BY created_at DESC LIMIT 20`,
    ),
  );
  if (errors.length === 0) {
    console.log('  None recorded.');
  } else {
    for (const e of errors) {
      console.log(`  [${e.created_at}] (${e.severity}) ${e.operation_id ?? e.path ?? '?'}: ${e.message}`);
    }
  }

  await closePool();
}

main().catch((err) => {
  reportError(err);
  process.exit(1);
});
