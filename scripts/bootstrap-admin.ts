/**
 * Creates the organization and first administrator for a production
 * deployment -- no sample content, unlike scripts/seed.ts (which is
 * synthetic demo data and clears itself on every run; never point it at
 * a real deployment).
 *
 * Idempotent: re-running it with the same ORG_SLUG and ADMIN_EMAIL
 * updates the existing admin's name and password rather than erroring,
 * so it doubles as "reset the admin password" if ever needed.
 *
 * Credentials are read from the environment, not hardcoded, so this
 * file is safe to commit -- the actual email and password never enter
 * the repository.
 *
 * Usage:
 *   ORG_NAME="Nirog Bhoomi" ORG_SLUG=nirog-bhoomi \
 *   ADMIN_NAME="Priyanshu" ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' \
 *   npm run bootstrap:admin
 */
import { randomUUID } from 'node:crypto';
import { withOrg, withoutOrg, closePool } from '../src/lib/db';
import { hashPassword } from '../src/lib/crypto';
import { SYSTEM_ROLES } from '../src/domain/permissions';
import { reportError } from './lib/report-error';

async function main() {
  const orgName = requireEnv('ORG_NAME');
  const orgSlug = requireEnv('ORG_SLUG');
  const adminName = requireEnv('ADMIN_NAME');
  const adminEmail = requireEnv('ADMIN_EMAIL').trim().toLowerCase();
  const adminPassword = requireEnv('ADMIN_PASSWORD');
  if (adminPassword.length < 8) {
    throw new Error('ADMIN_PASSWORD must be at least 8 characters.');
  }

  const orgId = await ensureOrganization(orgName, orgSlug);
  const adminRoleId = await ensureRoles(orgId);
  const userId = await ensureAdmin(orgId, adminRoleId, adminName, adminEmail, adminPassword);

  console.log(`Organization: ${orgName} (${orgSlug})`);
  console.log(`Administrator: ${adminEmail} (${userId})`);
  console.log('Done. Sign in at /sign-in with the email and password you set.');

  await closePool();
}

async function ensureOrganization(name: string, slug: string): Promise<string> {
  const existing = await withoutOrg((sql) =>
    sql.one<{ id: string }>(`SELECT id FROM organizations WHERE slug = $1`, [slug]),
  );
  if (existing) return existing.id;

  const id = randomUUID();
  await withoutOrg((sql) =>
    sql.query(
      `INSERT INTO organizations (id, name, slug, timezone, default_language, settings)
       VALUES ($1,$2,$3,'Asia/Kolkata','en',$4)`,
      [id, name, slug, JSON.stringify({ product_name: name })],
    ),
  );
  return id;
}

/** Creates every system role if this is a fresh organization. Returns the administrator role id. */
async function ensureRoles(orgId: string): Promise<string> {
  return withOrg(orgId, async (sql) => {
    let adminRoleId: string | null = null;
    for (const role of SYSTEM_ROLES) {
      const existing = await sql.one<{ id: string }>(`SELECT id FROM roles WHERE slug = $1`, [
        role.slug,
      ]);
      const id = existing?.id ?? randomUUID();
      if (!existing) {
        await sql.query(
          `INSERT INTO roles (id, organization_id, name, slug, description, is_system_role, permissions)
           VALUES ($1,$2,$3,$4,$5,true,$6)`,
          [id, orgId, role.name, role.slug, role.description, JSON.stringify(role.permissions)],
        );
      }
      if (role.slug === 'administrator') adminRoleId = id;
    }
    if (!adminRoleId) throw new Error('administrator role missing from SYSTEM_ROLES.');
    return adminRoleId;
  });
}

async function ensureAdmin(
  orgId: string,
  adminRoleId: string,
  name: string,
  email: string,
  password: string,
): Promise<string> {
  const passwordHash = hashPassword(password);

  return withOrg(orgId, async (sql) => {
    const existing = await sql.one<{ id: string }>(
      `SELECT id FROM users WHERE lower(email) = $1`,
      [email],
    );

    let userId: string;
    if (existing) {
      userId = existing.id;
      await sql.query(
        `UPDATE users SET full_name = $1, password_hash = $2, status = 'active' WHERE id = $3`,
        [name, passwordHash, userId],
      );
    } else {
      userId = randomUUID();
      await sql.query(
        `INSERT INTO users (id, organization_id, full_name, email, password_hash, job_title, status, last_active_at)
         VALUES ($1,$2,$3,$4,$5,'Administrator','active', now())`,
        [userId, orgId, name, email, passwordHash],
      );
    }

    const hasRole = await sql.one<{ user_id: string }>(
      `SELECT user_id FROM user_roles WHERE user_id = $1 AND role_id = $2`,
      [userId, adminRoleId],
    );
    if (!hasRole) {
      await sql.query(`INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES ($1,$2,$1)`, [
        userId,
        adminRoleId,
      ]);
    }

    return userId;
  });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set.`);
  return value;
}

main().catch((err) => {
  reportError(err);
  process.exit(1);
});
