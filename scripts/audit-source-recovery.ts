import { closePool, withoutOrg } from '../src/lib/db';

type Row = {
  id: string;
  organization_id: string;
  title: string;
  status: string;
  review_status: string;
  processing_status: string;
  created_at: string;
  updated_at: string;
  normalized_text_length: number;
  original_url: string | null;
  category_names: string[];
};

async function main() {
  const orgs = await withoutOrg((sql) =>
    sql.query<{ id: string; name: string; slug: string }>(
      `SELECT id, name, slug FROM organizations ORDER BY created_at`,
    ),
  );

  console.log('ORGANIZATIONS', JSON.stringify(orgs));

  for (const org of orgs) {
    const rows = await withoutOrg((sql) =>
      sql.query<Row>(
        `SELECT
           s.id,
           s.organization_id,
           s.title,
           s.status::text,
           s.review_status::text,
           s.processing_status::text,
           s.created_at::text,
           s.updated_at::text,
           length(coalesce(s.normalized_text, ''))::int AS normalized_text_length,
           s.original_url,
           coalesce(
             array_agg(c.name ORDER BY c.position, c.name)
               FILTER (WHERE c.id IS NOT NULL),
             ARRAY[]::text[]
           ) AS category_names
         FROM sources s
         LEFT JOIN source_categories sc ON sc.source_id = s.id
         LEFT JOIN categories c ON c.id = sc.category_id
         WHERE s.organization_id = $1
         GROUP BY s.id
         ORDER BY s.created_at ASC`,
        [org.id],
      ),
    );

    const summary = rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1;
      return acc;
    }, {});

    console.log('ORG_SUMMARY', JSON.stringify({
      org,
      total_sources: rows.length,
      by_status: summary,
      active: rows.filter(r => r.status === 'active').length,
      archived: rows.filter(r => r.status === 'archived').length,
      deleted: rows.filter(r => r.status === 'deleted').length,
      empty_text: rows.filter(r => r.normalized_text_length === 0).length,
      uncategorized: rows.filter(r => r.category_names.length === 0).length,
    }));

    for (const row of rows) {
      console.log('SOURCE', JSON.stringify(row));
    }
  }

  await closePool();
}

main().catch(async (err) => {
  console.error('AUDIT_FAILED', err);
  try { await closePool(); } catch {}
  process.exit(1);
});
