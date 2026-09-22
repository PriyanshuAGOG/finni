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

    const membership = await client.query(
      `SELECT pg_has_role(current_user, 'neon_superuser', 'MEMBER') AS is_member,
              pg_has_role(current_user, 'neon_superuser', 'USAGE') AS can_set_role`
    );
    console.log('NEON_SUPERUSER_MEMBERSHIP', JSON.stringify(membership.rows[0]));

    // Neon's project-owner role is normally allowed to SET ROLE into the
    // managed neon_superuser role for extension management. Use that role
    // only to install pageinspect, then reset immediately. All page reads
    // below remain forensic/read-only.
    if (membership.rows[0]?.can_set_role) {
      await client.query('SET ROLE neon_superuser');
      await client.query('CREATE EXTENSION IF NOT EXISTS pageinspect');
      await client.query('RESET ROLE');
    } else {
      throw new Error('Current Neon owner cannot SET ROLE neon_superuser; pageinspect unavailable.');
    }

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
