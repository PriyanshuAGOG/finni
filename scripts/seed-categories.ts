/**
 * Seeds the fixed top-level category taxonomy every organization should
 * have: Foundation of Health, Movement, What to Eat, What to Avoid,
 * Stress, Recovery and Tracking, Miscellaneous. Idempotent -- skips a
 * name that already exists (case-insensitively) as a top-level category
 * in that organization, so it is safe to re-run.
 *
 * Usage:
 *   npm run db:seed-categories              # every organization
 *   ORG_SLUG=nirog-bhoomi npm run db:seed-categories   # one organization
 */
import { withOrg, withoutOrg, closePool } from '../src/lib/db';
import type { ActorContext } from '../src/lib/context';
import { createCategory } from '../src/services/taxonomy';
import { normalizeTaxonomyName } from '../src/lib/text';
import { reportError } from './lib/report-error';

const TOP_LEVEL_CATEGORIES = [
  'Foundation of Health',
  'Movement',
  'What to Eat',
  'What to Avoid',
  'Stress, Recovery and Tracking',
  'Miscellaneous',
];

async function main() {
  const orgSlug = process.env.ORG_SLUG?.trim();

  const orgs = await withoutOrg((sql) =>
    sql.query<{ id: string; name: string; slug: string }>(
      orgSlug
        ? `SELECT id, name, slug FROM organizations WHERE slug = $1`
        : `SELECT id, name, slug FROM organizations ORDER BY created_at`,
      orgSlug ? [orgSlug] : [],
    ),
  );

  if (orgs.length === 0) {
    console.log(orgSlug ? `No organization found with slug "${orgSlug}".` : 'No organizations exist.');
    await closePool();
    return;
  }

  for (const org of orgs) {
    console.log(`Organization: ${org.name} (${org.slug})`);

    const admin = await withOrg(org.id, (sql) =>
      sql.one<{ id: string; full_name: string }>(
        `SELECT id, full_name FROM users WHERE status = 'active' ORDER BY created_at LIMIT 1`,
      ),
    );
    if (!admin) {
      console.log('  Skipped -- no active user to attribute the categories to yet.');
      continue;
    }

    const ctx: ActorContext = {
      organizationId: org.id,
      userId: admin.id,
      userName: admin.full_name,
      actorType: 'user',
      sourceInterface: 'automation',
      permissions: new Set(['taxonomy.create', 'taxonomy.read']),
      scopes: null,
      requestId: 'seed-categories',
    };

    const existing = await withOrg(org.id, (sql) =>
      sql.query<{ normalized_name: string }>(
        `SELECT normalized_name FROM categories WHERE parent_category_id IS NULL AND status = 'active'`,
      ),
    );
    const existingNames = new Set(existing.map((r) => r.normalized_name));

    for (const [index, name] of TOP_LEVEL_CATEGORIES.entries()) {
      if (existingNames.has(normalizeTaxonomyName(name))) {
        console.log(`  - "${name}" already exists, skipped.`);
        continue;
      }
      try {
        const category = await createCategory(ctx, { name });
        await withOrg(org.id, (sql) =>
          sql.query(`UPDATE categories SET position = $1 WHERE id = $2`, [index, category.id]),
        );
        console.log(`  - Created "${name}" (${category.id}).`);
      } catch (err) {
        console.log(
          `  - Could not create "${name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  await closePool();
}

main().catch((err) => {
  reportError(err);
  process.exit(1);
});
