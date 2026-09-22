import { Client, Query, Storage } from 'node-appwrite';
import { closePool, withOrg, withoutOrg } from '../src/lib/db';

async function main() {
  const dbIdentity = await withoutOrg((sql) =>
    sql.one<{
      current_user: string;
      current_database: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      server_version: string;
    }>(
      `SELECT current_user,
              current_database(),
              r.rolsuper,
              r.rolbypassrls,
              current_setting('server_version') AS server_version
       FROM pg_roles r
       WHERE r.rolname = current_user`,
    ),
  );
  console.log('DB_IDENTITY', JSON.stringify(dbIdentity));

  const orgs = await withoutOrg((sql) =>
    sql.query<{ id: string; name: string; slug: string }>(
      `SELECT id, name, slug FROM organizations ORDER BY created_at`,
    ),
  );

  for (const org of orgs) {
    const counts = await withOrg(org.id, async (sql) => {
      const sources = await sql.one<{ count: number }>(
        `SELECT count(*)::int AS count FROM sources`,
      );
      const versions = await sql.one<{ count: number }>(
        `SELECT count(*)::int AS count FROM source_versions`,
      );
      const audit = await sql.one<{ count: number }>(
        `SELECT count(*)::int AS count FROM audit_logs`,
      );
      const categories = await sql.one<{ count: number }>(
        `SELECT count(*)::int AS count FROM categories`,
      );
      const collections = await sql.one<{ count: number }>(
        `SELECT count(*)::int AS count FROM collections`,
      );
      return {
        sources: sources?.count ?? 0,
        source_versions: versions?.count ?? 0,
        audit_logs: audit?.count ?? 0,
        categories: categories?.count ?? 0,
        collections: collections?.count ?? 0,
      };
    });
    console.log('TENANT_COUNTS', JSON.stringify({ org, ...counts }));
  }

  const endpoint = process.env.APPWRITE_ENDPOINT?.trim();
  const projectId = process.env.APPWRITE_PROJECT_ID?.trim();
  const apiKey = process.env.APPWRITE_API_KEY?.trim();
  const bucketId = process.env.APPWRITE_BUCKET_ID?.trim() || 'research_os_sources';

  if (!endpoint || !projectId || !apiKey) {
    console.log('APPWRITE_STATUS', JSON.stringify({ configured: false }));
    await closePool();
    return;
  }

  const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
  const storage = new Storage(client);

  const files: Array<{
    id: string;
    name: string;
    mimeType: string;
    sizeOriginal: number;
    dateCreated: string;
  }> = [];

  let offset = 0;
  const pageSize = 100;
  while (true) {
    const page = await storage.listFiles({
      bucketId,
      queries: [Query.limit(pageSize), Query.offset(offset)],
    });
    for (const file of page.files) {
      files.push({
        id: file.$id,
        name: file.name,
        mimeType: file.mimeType,
        sizeOriginal: file.sizeOriginal,
        dateCreated: file.$createdAt,
      });
    }
    offset += page.files.length;
    if (page.files.length < pageSize || offset >= page.total) break;
  }

  console.log('APPWRITE_STATUS', JSON.stringify({
    configured: true,
    bucketId,
    total: files.length,
  }));

  for (const file of files) {
    console.log('APPWRITE_FILE', JSON.stringify(file));
  }

  await closePool();
}

main().catch(async (err) => {
  console.error('RECOVERY_STORAGE_AUDIT_FAILED', err);
  try { await closePool(); } catch {}
  process.exit(1);
});
