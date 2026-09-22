/**
 * Seeds the fixed four-category Nirog Bhoomi knowledge taxonomy.
 *
 * Usage:
 *   npm run db:seed-categories
 *   ORG_SLUG=nirog-bhoomi npm run db:seed-categories
 */
import { withOrg, withoutOrg, closePool } from '../src/lib/db';
import { reportError } from './lib/report-error';

const CATEGORIES = [
  {
    name: 'Movement, Exercise and Yoga',
    normalizedName: 'movement exercise yoga',
    slug: 'movement-exercise-yoga',
    description: 'Movement, walking, exercise, fitness, strength, mobility, sports and yoga.',
    synonyms: ['movement', 'exercise', 'physical activity', 'walking', 'fitness', 'strength training', 'mobility', 'yoga'],
    guidance: 'Use for content primarily about movement, exercise, physical activity, walking, strength, fitness, mobility or yoga.',
  },
  {
    name: 'Lifestyle',
    normalizedName: 'lifestyle',
    slug: 'lifestyle',
    description: 'Sleep, stress, habits, routines, recovery, behaviour and broader lifestyle practices.',
    synonyms: ['sleep', 'stress', 'habits', 'routine', 'recovery', 'mindfulness', 'meditation', 'behaviour', 'behavior', 'hydration'],
    guidance: 'Use for content primarily about sleep, stress, habits, routines, recovery, mindfulness, behaviour or broader lifestyle practices.',
  },
  {
    name: 'Food',
    normalizedName: 'food',
    slug: 'food',
    description: 'Food, diet, nutrition, meals, nutrients, fasting and dietary patterns.',
    synonyms: ['food', 'diet', 'nutrition', 'meal', 'eating', 'carbohydrate', 'protein', 'fat', 'fibre', 'fiber', 'fasting', 'nutrient'],
    guidance: 'Use for content primarily about food, diet, nutrition, meals, nutrients, dietary patterns or fasting.',
  },
  {
    name: 'Miscellaneous',
    normalizedName: 'miscellaneous',
    slug: 'miscellaneous',
    description: 'Knowledge that does not clearly belong to movement, lifestyle or food.',
    synonyms: ['miscellaneous', 'other', 'general'],
    guidance: 'Fallback category when the source is not clearly about movement, lifestyle or food.',
  },
] as const;

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
      sql.one<{ id: string }>(
        `SELECT id FROM users WHERE status = 'active' ORDER BY created_at LIMIT 1`,
      ),
    );
    if (!admin) {
      console.log('  Skipped because there is no active user to attribute the taxonomy to.');
      continue;
    }

    await withOrg(org.id, async (sql) => {
      // Preserve old taxonomy rows for historical references, but keep them
      // out of active product surfaces.
      await sql.query(
        `UPDATE categories
         SET status = 'archived', archived_at = coalesce(archived_at, now()), updated_at = now()
         WHERE status = 'active'`,
      );

      for (const [position, category] of CATEGORIES.entries()) {
        await sql.query(
          `INSERT INTO categories (
             organization_id, name, normalized_name, slug, description, status,
             synonyms, ai_usage_guidance, position, created_by, updated_by
           ) VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$9)
           ON CONFLICT (organization_id, slug)
           DO UPDATE SET
             name = EXCLUDED.name,
             normalized_name = EXCLUDED.normalized_name,
             description = EXCLUDED.description,
             status = 'active',
             archived_at = NULL,
             synonyms = EXCLUDED.synonyms,
             ai_usage_guidance = EXCLUDED.ai_usage_guidance,
             position = EXCLUDED.position,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
          [
            org.id,
            category.name,
            category.normalizedName,
            category.slug,
            category.description,
            JSON.stringify(category.synonyms),
            category.guidance,
            position,
            admin.id,
          ],
        );
        console.log(`  - Ready: ${category.name}`);
      }
    });
  }

  await closePool();
}

main().catch((err) => {
  reportError(err);
  process.exit(1);
});
