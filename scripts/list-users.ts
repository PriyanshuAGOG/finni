/**
 * Diagnostic: lists every organization and user this DATABASE_URL can
 * see, plus the host/database it actually connected to (never the
 * credentials). Use this to confirm whether the database bootstrap-admin
 * wrote to is the same one a given deployment (e.g. Vercel) is reading
 * from -- if this script shows the account but sign-in still fails,
 * the two are pointed at different databases, not a credential problem.
 */
import { withoutOrg, withOrg, closePool } from '../src/lib/db';
import { getEnv } from '../src/lib/env';
import { reportError } from './lib/report-error';

async function main() {
  const env = getEnv();
  const { hostname, pathname } = new URL(env.DATABASE_URL);
  console.log(`Connected to: ${hostname}${pathname}\n`);

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
    console.log(`Organization: ${org.name} (${org.slug})`);
    const users = await withOrg(org.id, (sql) =>
      sql.query<{ email: string; status: string; full_name: string }>(
        `SELECT email, status::text, full_name FROM users ORDER BY created_at`,
      ),
    );
    for (const user of users) {
      console.log(`  - ${user.email}  [${user.status}]  ${user.full_name}`);
    }
    if (users.length === 0) console.log('  (no users)');
  }

  await closePool();
}

main().catch((err) => {
  reportError(err);
  process.exit(1);
});
