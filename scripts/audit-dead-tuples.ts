import { Pool } from 'pg';

function normalize(connectionString: string): string {
  const url = new URL(connectionString);
  const mode = url.searchParams.get('sslmode')?.toLowerCase();
  if (mode && ['prefer','require','verify-ca'].includes(mode)) {
    url.searchParams.set('sslmode','verify-full');
  }
  return url.toString();
}

async function main() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL missing');

  const pool = new Pool({ connectionString: normalize(raw), max: 1 });
  const client = await pool.connect();
  try {
    const identity = await client.query(
      `SELECT current_user, r.rolsuper, r.rolbypassrls
       FROM pg_roles r WHERE r.rolname = current_user`
    );
    console.log('IDENTITY', JSON.stringify(identity.rows[0]));

    // pageinspect is read-only for the inspection functions used below.
    await client.query('CREATE EXTENSION IF NOT EXISTS pageinspect');

    for (const relation of ['sources','source_versions','source_categories']) {
      const stats = await client.query(
        `SELECT $1::text AS relation,
                pg_relation_size($1::regclass)::bigint AS bytes,
                ceil(pg_relation_size($1::regclass)::numeric / current_setting('block_size')::numeric)::int AS blocks`,
        [relation],
      );
      console.log('RELATION', JSON.stringify(stats.rows[0]));

      const blocks = Number(stats.rows[0]?.blocks ?? 0);
      let totalItems = 0;
      let normalItems = 0;
      const samples: unknown[] = [];

      for (let blk = 0; blk < blocks; blk++) {
        const page = await client.query(
          `SELECT lp, lp_flags, lp_len, t_xmin::text, t_xmax::text, t_ctid::text,
                  t_infomask, t_infomask2, t_hoff
           FROM heap_page_items(get_raw_page($1, $2))
           ORDER BY lp`,
          [relation, blk],
        ).catch((err) => {
          console.log('PAGE_ERROR', JSON.stringify({ relation, blk, message: err.message }));
          return { rows: [] as any[] };
        });

        totalItems += page.rows.length;
        normalItems += page.rows.filter((r:any)=>Number(r.lp_flags)===1).length;
        if (samples.length < 30) {
          for (const row of page.rows.slice(0, 30 - samples.length)) {
            samples.push({ blk, ...row });
          }
        }
      }

      console.log('HEAP_SUMMARY', JSON.stringify({
        relation,
        total_items: totalItems,
        normal_items: normalItems,
        samples,
      }));
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('DEAD_TUPLE_AUDIT_FAILED', err);
  process.exit(1);
});
