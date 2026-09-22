/**
 * Reclassifies every retained source into exactly one of the four canonical
 * Nirog Bhoomi knowledge categories. Safe to rerun.
 */
import { closePool, withOrg, withoutOrg } from '../src/lib/db';
import { assignCanonicalKnowledgeCategory } from '../src/services/knowledge-category';
import { reportError } from './lib/report-error';

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

  for (const org of orgs) {
    const sources = await withOrg(org.id, (sql) =>
      sql.query<{
        id: string;
        title: string;
        normalized_text: string | null;
        abstract: string | null;
        ai_summary_short: string | null;
        ai_summary_detailed: string | null;
        added_by: string | null;
      }>(
        `SELECT id, title, normalized_text, abstract, ai_summary_short,
                ai_summary_detailed, added_by
         FROM sources
         WHERE status != 'deleted'
         ORDER BY created_at`,
      ),
    );

    let assigned = 0;
    await withOrg(org.id, async (sql) => {
      for (const source of sources) {
        const text = [
          source.abstract,
          source.ai_summary_short,
          source.ai_summary_detailed,
          source.normalized_text,
        ]
          .filter(Boolean)
          .join('\n\n');

        const result = await assignCanonicalKnowledgeCategory(
          sql,
          source.id,
          source.title,
          text,
          { assignmentSource: 'rule', assignedBy: source.added_by },
        );
        if (result) assigned += 1;
      }
    });

    console.log(`${org.name}: classified ${assigned}/${sources.length} retained source(s).`);
  }

  await closePool();
}

main().catch((err) => {
  reportError(err);
  process.exit(1);
});
