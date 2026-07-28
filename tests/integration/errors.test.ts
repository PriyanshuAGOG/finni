import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestOrg, destroyTestOrg, type TestOrg } from './fixtures';
import { errorLogCounts, listErrorLogs, logError, resolveErrorLog } from '../../src/services/errors';
import { withoutOrg } from '../../src/lib/db';

let org: TestOrg;

beforeAll(async () => {
  org = await createTestOrg('errors');
});

afterAll(async () => {
  await destroyTestOrg(org.organizationId);
  // organization_id-less rows aren't cascade-deleted with the test org,
  // since they exist specifically to prove they have none.
  await withoutOrg((sql) =>
    sql.query(`DELETE FROM error_logs WHERE message = $1`, [
      'unattributed pre-auth failure for isolation test',
    ]),
  );
});

describe('error_logs', () => {
  it('persists a server-side error with its context', async () => {
    await logError({
      origin: 'api_server',
      severity: 'error',
      message: 'boom while creating a collection',
      stack: 'Error: boom\n  at handler (handler.ts:1:1)',
      organizationId: org.organizationId,
      userId: org.adminCtx.userId,
      operationId: 'createCollection',
      errorCode: 'INTERNAL_ERROR',
      path: '/collections',
      method: 'POST',
      statusCode: 500,
    });

    const { items } = await listErrorLogs(org.adminCtx, { limit: 10 });
    expect(items.some((i) => i.message === 'boom while creating a collection')).toBe(true);
    const row = items.find((i) => i.message === 'boom while creating a collection')!;
    expect(row.operation_id).toBe('createCollection');
    expect(row.status_code).toBe(500);
    expect(row.resolved).toBe(false);
  });

  it('persists an error with no organization (a pre-authentication failure)', async () => {
    await logError({
      origin: 'api_server',
      severity: 'fatal',
      message: 'unattributed pre-auth failure for isolation test',
    });

    const row = await withoutOrg((sql) =>
      sql.one<{ organization_id: string | null }>(
        `SELECT organization_id FROM error_logs WHERE message = $1`,
        ['unattributed pre-auth failure for isolation test'],
      ),
    );
    expect(row?.organization_id).toBeNull();
  });

  it('a viewer without audit.read cannot list the error log', async () => {
    await expect(listErrorLogs(org.viewerCtx, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('marks an error resolved with a note', async () => {
    await logError({
      origin: 'dashboard_client',
      severity: 'fatal',
      message: 'resolve-me test error',
      organizationId: org.organizationId,
    });
    const { items } = await listErrorLogs(org.adminCtx, { limit: 20 });
    const target = items.find((i) => i.message === 'resolve-me test error')!;

    const resolved = await resolveErrorLog(org.adminCtx, target.id, 'fixed the null check');
    expect(resolved.resolved).toBe(true);
    expect(resolved.resolution_note).toBe('fixed the null check');
    expect(resolved.resolved_by).toBe(org.adminCtx.userId);
  });

  it('counts unresolved and recent errors', async () => {
    const counts = await errorLogCounts(org.adminCtx);
    expect(counts.unresolved).toBeGreaterThanOrEqual(1);
    expect(counts.last_24h).toBeGreaterThanOrEqual(1);
  });
});
