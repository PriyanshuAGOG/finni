/**
 * Diagnostic: lists every api_clients row this DATABASE_URL can see --
 * name, status, scope count, who it acts as, and when it was last used
 * -- never the credential itself. Use this to tell apart "the Custom GPT
 * never actually reached the server" (last_used_at stays null forever)
 * from "it reached the server and was rejected" (last_used_at updates,
 * status is not active, or the acting user is not active).
 */
import { withoutOrg, withOrg, closePool } from '../src/lib/db';
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
    console.log(`Organization: ${org.name} (${org.slug})`);
    const clients = await withOrg(org.id, (sql) =>
      sql.query<{
        id: string;
        name: string;
        client_type: string;
        status: string;
        acts_as_email: string | null;
        acts_as_status: string | null;
        scope_count: number;
        expires_at: string | null;
        revoked_at: string | null;
        last_used_at: string | null;
        created_at: string;
      }>(
        `SELECT c.id, c.name, c.client_type::text, c.status,
                u.email AS acts_as_email, u.status::text AS acts_as_status,
                jsonb_array_length(c.scopes) AS scope_count,
                c.expires_at, c.revoked_at, c.last_used_at, c.created_at
         FROM api_clients c
         LEFT JOIN users u ON u.id = c.acts_as_user_id
         ORDER BY c.created_at DESC`,
      ),
    );

    if (clients.length === 0) {
      console.log('  (no API clients -- the Custom GPT has never been connected with a key)');
      continue;
    }

    for (const c of clients) {
      const issues: string[] = [];
      if (c.status !== 'active') issues.push(`status=${c.status}`);
      if (c.revoked_at) issues.push('revoked');
      if (c.expires_at && new Date(c.expires_at).getTime() < Date.now()) issues.push('expired');
      if (!c.acts_as_email) issues.push('acting user missing');
      else if (c.acts_as_status !== 'active') issues.push(`acting user is ${c.acts_as_status}`);

      const flag = issues.length > 0 ? `  <-- ${issues.join(', ')}` : '';
      console.log(
        `  - ${c.name} [${c.client_type}] scopes=${c.scope_count} acts_as=${c.acts_as_email ?? '(none)'} ` +
          `last_used=${c.last_used_at ?? 'never'}${flag}`,
      );
    }
  }

  await closePool();
}

main().catch((err) => {
  reportError(err);
  process.exit(1);
});
