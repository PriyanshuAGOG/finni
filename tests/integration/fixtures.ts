import { randomUUID } from 'node:crypto';
import { withOrg, withoutOrg } from '../../src/lib/db';
import type { ActorContext } from '../../src/lib/context';
import { SYSTEM_ROLES } from '../../src/domain/permissions';

export interface TestOrg {
  organizationId: string;
  adminCtx: ActorContext;
  viewerCtx: ActorContext;
}

/**
 * Creates an isolated organization, an administrator and a viewer for one
 * test file. Each test file gets its own organization so tests never see
 * each other's data even when RLS is the thing under test.
 */
export async function createTestOrg(label: string): Promise<TestOrg> {
  const organizationId = randomUUID();
  const slug = `test-${label}-${randomUUID().slice(0, 8)}`;

  await withoutOrg((sql) =>
    sql.query(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)`, [
      organizationId,
      `Test Org ${label}`,
      slug,
    ]),
  );

  const roleIds = new Map<string, string>();
  await withOrg(organizationId, async (sql) => {
    for (const role of SYSTEM_ROLES) {
      const id = randomUUID();
      roleIds.set(role.slug, id);
      await sql.query(
        `INSERT INTO roles (id, organization_id, name, slug, is_system_role, permissions)
         VALUES ($1,$2,$3,$4,true,$5)`,
        [id, organizationId, role.name, role.slug, JSON.stringify(role.permissions)],
      );
    }
  });

  const adminId = randomUUID();
  const viewerId = randomUUID();
  await withOrg(organizationId, async (sql) => {
    await sql.query(
      `INSERT INTO users (id, organization_id, full_name, email, status)
       VALUES ($1,$2,'Test Admin',$3,'active')`,
      [adminId, organizationId, `admin-${adminId.slice(0, 8)}@test.local`],
    );
    await sql.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [
      adminId,
      roleIds.get('administrator'),
    ]);
    await sql.query(
      `INSERT INTO users (id, organization_id, full_name, email, status)
       VALUES ($1,$2,'Test Viewer',$3,'active')`,
      [viewerId, organizationId, `viewer-${viewerId.slice(0, 8)}@test.local`],
    );
    await sql.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [
      viewerId,
      roleIds.get('viewer'),
    ]);
  });

  const adminPermissions = new Set(SYSTEM_ROLES.find((r) => r.slug === 'administrator')!.permissions);
  const viewerPermissions = new Set(SYSTEM_ROLES.find((r) => r.slug === 'viewer')!.permissions);

  return {
    organizationId,
    adminCtx: {
      organizationId,
      userId: adminId,
      userName: 'Test Admin',
      actorType: 'user',
      sourceInterface: 'api',
      permissions: adminPermissions,
      scopes: null,
      requestId: `test-${randomUUID().slice(0, 8)}`,
    },
    viewerCtx: {
      organizationId,
      userId: viewerId,
      userName: 'Test Viewer',
      actorType: 'user',
      sourceInterface: 'api',
      permissions: viewerPermissions,
      scopes: null,
      requestId: `test-${randomUUID().slice(0, 8)}`,
    },
  };
}

/** Deletes everything belonging to a test organization, in FK order. */
export async function destroyTestOrg(organizationId: string): Promise<void> {
  await withOrg(organizationId, async (sql) => {
    for (const table of [
      'source_categories', 'source_tags', 'source_contributors', 'source_versions',
      'evidence_assessments', 'study_metadata', 'claim_evidence', 'claim_categories',
      'claim_relations', 'claims', 'collection_sources', 'smart_collection_rules',
      'collections', 'embedding_chunks', 'annotations', 'processing_jobs',
      'research_candidates', 'research_jobs', 'brief_sources', 'brief_versions',
      'research_briefs', 'generated_content_citations', 'generated_content',
      'saved_searches', 'ai_usage_events', 'search_events', 'action_confirmations',
      'idempotency_keys', 'audit_logs', 'sources', 'categories', 'tags',
      'api_clients', 'oauth_clients', 'user_permission_overrides', 'user_invitations',
      'user_roles', 'roles',
    ]) {
      await sql.query(`DELETE FROM ${table}`);
    }
    await sql.query(`DELETE FROM users`);
  });
  await withoutOrg((sql) => sql.query(`DELETE FROM organizations WHERE id = $1`, [organizationId]));
}
