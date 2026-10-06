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
    const orgRow = await withoutOrg((sql) =>
      sql.one<{ created_at: string }>(`SELECT created_at FROM organizations WHERE id = $1`, [org.id]),
    );
    console.log(`\nOrganization: ${org.name} (${org.slug}), created ${orgRow?.created_at ?? '?'}`);

    const userCount = await withOrg(org.id, (sql) =>
      sql.one<{ total: number; earliest: string | null }>(
        `SELECT count(*)::int AS total, min(created_at) AS earliest FROM users`,
      ),
    );
    console.log(`  Users: ${userCount?.total ?? 0} (earliest created ${userCount?.earliest ?? 'n/a'})`);

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

    const otherCounts = await withOrg(org.id, (sql) =>
      sql.one<{ categories: number; claims: number; collections: number; processing_jobs: number }>(
        `SELECT
           (SELECT count(*) FROM categories)::int AS categories,
           (SELECT count(*) FROM claims)::int AS claims,
           (SELECT count(*) FROM collections)::int AS collections,
           (SELECT count(*) FROM processing_jobs)::int AS processing_jobs`,
      ),
    );
    console.log(
      `  Other tables: ${otherCounts?.categories ?? 0} categories, ${otherCounts?.claims ?? 0} claims, ` +
        `${otherCounts?.collections ?? 0} collections, ${otherCounts?.processing_jobs ?? 0} processing_jobs`,
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

    // audit_logs is append-only and never cleaned up by any migration, so
    // it answers "did this org ever actually have source data" even when
    // the sources table itself is currently empty.
    const auditSummary = await withOrg(org.id, (sql) =>
      sql.one<{ total: number; earliest: string | null; latest: string | null; source_created: number }>(
        `SELECT count(*)::int AS total,
                min(created_at) AS earliest,
                max(created_at) AS latest,
                count(*) FILTER (WHERE action = 'source.created')::int AS source_created
         FROM audit_logs`,
      ),
    );
    console.log(
      `  Audit log: ${auditSummary?.total ?? 0} events total ` +
        `(earliest ${auditSummary?.earliest ?? 'n/a'}, latest ${auditSummary?.latest ?? 'n/a'}), ` +
        `${auditSummary?.source_created ?? 0} were 'source.created'`,
    );

    if ((auditSummary?.total ?? 0) > 0 && (auditSummary?.total ?? 0) <= 20) {
      const events = await withOrg(org.id, (sql) =>
        sql.query<{
          action: string;
          resource_type: string;
          actor_type: string;
          actor_name: string | null;
          source_interface: string;
          created_at: string;
        }>(
          `SELECT a.action, a.resource_type, a.actor_type, u.full_name AS actor_name,
                  a.source_interface, a.created_at
           FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
           ORDER BY a.created_at`,
        ),
      );
      console.log('  All audit events (table is small enough to show in full):');
      for (const e of events) {
        console.log(
          `    - [${e.created_at}] ${e.action} on ${e.resource_type} ` +
            `by ${e.actor_name ?? e.actor_type} via ${e.source_interface}`,
        );
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
