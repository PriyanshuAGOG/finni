import { randomUUID } from 'node:crypto';
import { closePool, withOrg, withoutOrg } from '../src/lib/db';

async function main() {
  const existingOrg = await withoutOrg((sql) =>
    sql.one<{ id: string; name: string }>(
      `SELECT id, name FROM organizations WHERE slug = 'nirog-bhoomi' LIMIT 1`,
    ),
  );
  if (!existingOrg) throw new Error('Nirog Bhoomi organization not found');

  const identity = await withoutOrg((sql) =>
    sql.one<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT current_user, r.rolsuper, r.rolbypassrls
       FROM pg_roles r WHERE r.rolname = current_user`,
    ),
  );
  console.log('RUNTIME_IDENTITY', JSON.stringify(identity));
  if (
    !identity ||
    identity.current_user !== 'nirog_app_runtime' ||
    identity.rolsuper ||
    identity.rolbypassrls
  ) {
    throw new Error('Runtime DB role is not safely restricted');
  }

  const qaOrgId = randomUUID();
  const qaSourceId = randomUUID();

  try {
    await withoutOrg((sql) =>
      sql.query(
        `INSERT INTO organizations (id, name, slug)
         VALUES ($1, 'Runtime Role QA', $2)`,
        [qaOrgId, `runtime-role-qa-${qaOrgId.slice(0, 8)}`],
      ),
    );

    await withOrg(qaOrgId, (sql) =>
      sql.query(
        `INSERT INTO sources (id, organization_id, title, source_type, review_status, processing_status)
         VALUES ($1,$2,'Runtime role RLS sentinel','manual_note','approved','completed')`,
        [qaSourceId, qaOrgId],
      ),
    );

    const visibleInside = await withOrg(qaOrgId, (sql) =>
      sql.one<{ id: string }>(`SELECT id FROM sources WHERE id = $1`, [qaSourceId]),
    );
    if (!visibleInside) throw new Error('QA source was not visible inside its own tenant');

    const visibleAcross = await withOrg(existingOrg.id, (sql) =>
      sql.one<{ id: string }>(`SELECT id FROM sources WHERE id = $1`, [qaSourceId]),
    );
    if (visibleAcross) throw new Error('RLS leak: QA source visible from Nirog Bhoomi tenant');

    await withOrg(qaOrgId, (sql) => sql.query(`DELETE FROM sources`));

    const sourceAfterDelete = await withOrg(qaOrgId, (sql) =>
      sql.one<{ id: string }>(`SELECT id FROM sources WHERE id = $1`, [qaSourceId]),
    );
    if (sourceAfterDelete) throw new Error('Tenant-scoped cleanup did not remove QA source');

    console.log('PASS: runtime role is non-BYPASSRLS');
    console.log('PASS: cross-tenant source read blocked by RLS');
    console.log('PASS: unqualified DELETE remained tenant-scoped');
  } finally {
    await withoutOrg((sql) => sql.query(`DELETE FROM organizations WHERE id = $1`, [qaOrgId]));
    await closePool();
  }
}

main().catch(async (err) => {
  console.error('RUNTIME_ROLE_SMOKE_FAILED', err);
  try { await closePool(); } catch {}
  process.exit(1);
});
