import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withOrg } from '../../src/lib/db';
import { createTestOrg, destroyTestOrg, type TestOrg } from './fixtures';
import { createManualSource } from '../../src/services/ingestion';

let orgA: TestOrg;
let orgB: TestOrg;

beforeAll(async () => {
  orgA = await createTestOrg('rls-a');
  orgB = await createTestOrg('rls-b');
});

afterAll(async () => {
  await destroyTestOrg(orgA.organizationId);
  await destroyTestOrg(orgB.organizationId);
});

describe('row-level security', () => {
  it('a query scoped to org A cannot see org B rows', async () => {
    await createManualSource(orgA.adminCtx, { title: 'Org A source', text: 'Text for org A source, long enough to pass validation.' });
    await createManualSource(orgB.adminCtx, { title: 'Org B source', text: 'Text for org B source, long enough to pass validation.' });

    const seenByA = await withOrg(orgA.organizationId, (sql) =>
      sql.query<{ title: string }>(`SELECT title FROM sources`),
    );
    expect(seenByA.map((r) => r.title)).toEqual(['Org A source']);

    const seenByB = await withOrg(orgB.organizationId, (sql) =>
      sql.query<{ title: string }>(`SELECT title FROM sources`),
    );
    expect(seenByB.map((r) => r.title)).toEqual(['Org B source']);
  });

  it('rejects an insert that declares a different organization_id than the session context', async () => {
    await expect(
      withOrg(orgA.organizationId, (sql) =>
        sql.query(`INSERT INTO sources (organization_id, title) VALUES ($1, 'smuggled')`, [
          orgB.organizationId,
        ]),
      ),
    ).rejects.toThrow();
  });

  it('a query with no organization context set sees no rows at all', async () => {
    // withoutOrg deliberately never sets app.current_organization_id.
    const { withoutOrg } = await import('../../src/lib/db');
    const rows = await withoutOrg((sql) => sql.query(`SELECT title FROM sources`));
    expect(rows).toEqual([]);
  });
});
