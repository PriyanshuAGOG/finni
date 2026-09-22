/**
 * Recover source records from Appwrite document snapshots after accidental
 * Postgres deletion. This script is deliberately idempotent and non-destructive:
 * it never deletes or updates an existing source row.
 *
 * Required:
 *   RECOVERY_CONFIRM=restore-nb-sources-2026-09-22
 *   DATABASE_URL
 *   APPWRITE_ENDPOINT / APPWRITE_PROJECT_ID / APPWRITE_API_KEY
 *
 * Optional:
 *   APPWRITE_BUCKET_ID (defaults to research_os_sources)
 *   ORG_SLUG (defaults to nirog-bhoomi)
 */
import { Client, Query, Storage } from 'node-appwrite';
import { closePool, withOrg, withoutOrg } from '../src/lib/db';
import { extractHtml, extractPdf, extractPlainText, type ExtractionResult } from '../src/extraction/extract';
import {
  contentHash,
  normalizeText,
  normalizedContentHash,
  readingTimeMinutes,
  simhash,
  truncate,
  wordCount,
} from '../src/lib/text';
import { assignCanonicalKnowledgeCategory } from '../src/services/knowledge-category';

const CONFIRM = 'restore-nb-sources-2026-09-22';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AppwriteFile = {
  $id: string;
  $createdAt: string;
  name: string;
  mimeType: string;
  sizeOriginal: number;
};

type Group = {
  sourceId: string;
  original?: AppwriteFile;
  snapshot?: AppwriteFile;
  files: AppwriteFile[];
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.hostname.endsWith('recovery.invalid')) return null;
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function fileSourceId(name: string): string | null {
  const normalized = name.replace(/^\/+/, '');
  const match = normalized.match(/^sources\/([^/]+)\/(?:original(?:\.[^/]+)?|snapshot\.html)$/i);
  const id = match?.[1] ?? null;
  return id && UUID_RE.test(id) ? id : null;
}

function pickKind(file: AppwriteFile): 'original' | 'snapshot' | null {
  const normalized = file.name.replace(/^\/+/, '');
  if (/\/snapshot\.html$/i.test(normalized)) return 'snapshot';
  if (/\/original(?:\.[^/]+)?$/i.test(normalized)) return 'original';
  return null;
}

async function extractStoredDocument(
  bytes: Buffer,
  file: AppwriteFile,
): Promise<ExtractionResult> {
  const mime = (file.mimeType || '').toLowerCase();
  const lowerName = file.name.toLowerCase();

  if (mime === 'application/pdf' || lowerName.endsWith('.pdf') || bytes.subarray(0,5).toString('latin1') === '%PDF-') {
    return extractPdf(bytes);
  }

  if (mime.includes('html') || lowerName.endsWith('.html') || lowerName.endsWith('.htm')) {
    return extractHtml(bytes.toString('utf8'), 'https://recovery.invalid/');
  }

  if (mime.startsWith('text/') || lowerName.endsWith('.txt')) {
    return extractPlainText(bytes.toString('utf8'));
  }

  // Some Appwrite uploads may have a generic octet-stream MIME type while
  // still containing HTML/text. Prefer a conservative text sniff before
  // giving up.
  const head = bytes.subarray(0, 4096).toString('utf8').toLowerCase();
  if (head.includes('<html') || head.includes('<!doctype html')) {
    return extractHtml(bytes.toString('utf8'), 'https://recovery.invalid/');
  }

  throw new Error(`Unsupported retained document type: ${file.mimeType || 'unknown'} (${file.name})`);
}

async function main() {
  if (process.env.RECOVERY_CONFIRM !== CONFIRM) {
    throw new Error(`Refusing recovery without RECOVERY_CONFIRM=${CONFIRM}`);
  }

  const endpoint = required('APPWRITE_ENDPOINT');
  const projectId = required('APPWRITE_PROJECT_ID');
  const apiKey = required('APPWRITE_API_KEY');
  const bucketId = process.env.APPWRITE_BUCKET_ID?.trim() || 'research_os_sources';
  const orgSlug = process.env.ORG_SLUG?.trim() || 'nirog-bhoomi';

  const org = await withoutOrg((sql) =>
    sql.one<{ id: string; name: string; slug: string }>(
      `SELECT id, name, slug FROM organizations WHERE slug = $1`,
      [orgSlug],
    ),
  );
  if (!org) throw new Error(`Organization "${orgSlug}" not found`);

  const actor = await withOrg(org.id, (sql) =>
    sql.one<{ id: string; full_name: string }>(
      `SELECT id, full_name FROM users WHERE status = 'active' ORDER BY created_at LIMIT 1`,
    ),
  );
  if (!actor) throw new Error('No active Nirog Bhoomi user exists to attribute recovered rows');

  const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
  const storage = new Storage(client);

  const files: AppwriteFile[] = [];
  let offset = 0;
  for (;;) {
    const page = await storage.listFiles({
      bucketId,
      queries: [Query.limit(100), Query.offset(offset)],
    });
    files.push(...(page.files as unknown as AppwriteFile[]));
    offset += page.files.length;
    if (page.files.length === 0 || offset >= page.total) break;
  }

  const groups = new Map<string, Group>();
  const unrecognized: string[] = [];
  for (const file of files) {
    const sourceId = fileSourceId(file.name);
    const kind = pickKind(file);
    if (!sourceId || !kind) {
      unrecognized.push(file.name);
      continue;
    }
    const group = groups.get(sourceId) ?? { sourceId, files: [] };
    group.files.push(file);
    if (kind === 'original') group.original = file;
    if (kind === 'snapshot') group.snapshot = file;
    groups.set(sourceId, group);
  }

  console.log('RECOVERY_DISCOVERY', JSON.stringify({
    total_files: files.length,
    source_groups: groups.size,
    unrecognized_files: unrecognized.length,
    unrecognized_sample: unrecognized.slice(0, 20),
  }));

  if (groups.size === 0) {
    throw new Error('Appwrite is reachable but no recognizable source snapshot groups were found');
  }

  let restored = 0;
  let skippedExistingId = 0;
  let skippedExistingContent = 0;
  let failed = 0;
  const outcomes: Array<Record<string, unknown>> = [];

  for (const group of [...groups.values()].sort((a,b) =>
    (a.original?.$createdAt ?? a.snapshot?.$createdAt ?? '').localeCompare(
      b.original?.$createdAt ?? b.snapshot?.$createdAt ?? ''
    )
  )) {
    const file = group.original ?? group.snapshot;
    if (!file) continue;

    try {
      const existingId = await withOrg(org.id, (sql) =>
        sql.one<{ id: string; title: string }>(`SELECT id, title FROM sources WHERE id = $1`, [group.sourceId]),
      );
      if (existingId) {
        skippedExistingId += 1;
        outcomes.push({ source_id: group.sourceId, status: 'existing_id', title: existingId.title });
        continue;
      }

      const raw = Buffer.from(
        await storage.getFileView({ bucketId, fileId: file.$id }) as unknown as ArrayBuffer,
      );
      const extraction = await extractStoredDocument(raw, file);
      const text = normalizeText(extraction.text);
      const hash = contentHash(text);
      const normalizedHash = normalizedContentHash(text);
      const simhashValue = simhash(text).toString();

      const existingContent = await withOrg(org.id, (sql) =>
        sql.one<{ id: string; title: string }>(
          `SELECT id, title FROM sources
           WHERE content_hash = $1 OR normalized_content_hash = $2
           LIMIT 1`,
          [hash, normalizedHash],
        ),
      );
      if (existingContent) {
        skippedExistingContent += 1;
        outcomes.push({
          source_id: group.sourceId,
          status: 'existing_content',
          existing_source_id: existingContent.id,
          title: existingContent.title,
        });
        continue;
      }

      const createdAt = file.$createdAt || new Date().toISOString();
      const canonicalUrl = safeUrl(extraction.canonicalUrl);
      const sourceType = extraction.sourceTypeHint ?? (file.mimeType === 'application/pdf' ? 'uploaded_pdf' : 'web_article');
      const originalPath = group.original?.name ?? null;
      const snapshotPath = group.snapshot?.name ?? null;

      await withOrg(org.id, async (sql) => {
        await sql.query(
          `INSERT INTO sources (
             id, organization_id, title, subtitle, source_type, canonical_url, submitted_url,
             doi, pmid, author_text, publisher, publication_date, publication_year, accessed_at,
             language, abstract, extracted_text, normalized_text, word_count, reading_time_minutes,
             original_file_path, snapshot_file_path, thumbnail_url, favicon_url,
             status, review_status, processing_status, visibility, duplicate_status,
             extraction_confidence, content_hash, normalized_content_hash, simhash,
             added_via, added_by, approved_by, approved_at, created_by, updated_by,
             metadata, created_at, updated_at
           ) VALUES (
             $1,$2,$3,$4,$5::source_type,$6,$7,$8,$9,$10,$11,$12,$13,$14,
             $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
             'active','approved','completed','organization','none',
             $25,$26,$27,$28,'import',$29,$29,$30,$29,$29,$31,$32,now()
           )`,
          [
            group.sourceId,
            org.id,
            truncate(extraction.title || 'Recovered source', 500),
            extraction.subtitle ? truncate(extraction.subtitle, 500) : null,
            sourceType,
            canonicalUrl,
            canonicalUrl,
            extraction.doi ?? null,
            extraction.pmid ?? null,
            extraction.authorText ?? null,
            extraction.publisher ?? null,
            extraction.publicationDate ?? null,
            extraction.publicationDate ? Number(extraction.publicationDate.slice(0,4)) : null,
            createdAt,
            extraction.language ?? null,
            extraction.excerpt ?? null,
            text,
            text,
            wordCount(text),
            readingTimeMinutes(text),
            originalPath,
            snapshotPath,
            extraction.thumbnailUrl ?? null,
            extraction.faviconUrl ?? null,
            extraction.confidence,
            hash,
            normalizedHash,
            simhashValue,
            actor.id,
            createdAt,
            JSON.stringify({
              recovered_from: 'appwrite_snapshot',
              recovered_at: new Date().toISOString(),
              retained_files: group.files.map((f) => ({
                appwrite_file_id: f.$id,
                name: f.name,
                mime_type: f.mimeType,
                created_at: f.$createdAt,
                size: f.sizeOriginal,
              })),
              extraction_warnings: extraction.warnings,
              page_offsets: extraction.pageOffsets ?? null,
            }),
            createdAt,
          ],
        );

        await sql.query(
          `INSERT INTO source_versions (
             organization_id, source_id, version_number, captured_at, content_hash,
             title, extracted_text, metadata_snapshot, change_summary, created_by, created_at
           ) VALUES ($1,$2,1,$3,$4,$5,$6,$7,'Recovered initial capture from retained Appwrite snapshot',$8,$3)
           ON CONFLICT (source_id, version_number) DO NOTHING`,
          [
            org.id,
            group.sourceId,
            createdAt,
            hash,
            extraction.title,
            text,
            JSON.stringify({
              canonical_url: canonicalUrl,
              author_text: extraction.authorText ?? null,
              publisher: extraction.publisher ?? null,
              publication_date: extraction.publicationDate ?? null,
              doi: extraction.doi ?? null,
              pmid: extraction.pmid ?? null,
              recovery: true,
            }),
            actor.id,
          ],
        );

        await assignCanonicalKnowledgeCategory(sql, group.sourceId, extraction.title, text, {
          assignmentSource: 'import',
          assignedBy: actor.id,
        });

        await sql.query(
          `INSERT INTO audit_logs (
             organization_id, actor_type, actor_user_id, source_interface, action,
             resource_type, resource_id, new_state, created_at
           ) VALUES ($1,'user',$2,'import','source.recovered','source',$3,$4,now())`,
          [
            org.id,
            actor.id,
            group.sourceId,
            JSON.stringify({
              title: extraction.title,
              recovery_source: 'appwrite_snapshot',
              original_file_path: originalPath,
              snapshot_file_path: snapshotPath,
            }),
          ],
        );
      });

      restored += 1;
      outcomes.push({
        source_id: group.sourceId,
        status: 'restored',
        title: extraction.title,
        canonical_url: canonicalUrl,
        original_file: originalPath,
        snapshot_file: snapshotPath,
        words: wordCount(text),
      });
    } catch (err) {
      failed += 1;
      outcomes.push({
        source_id: group.sourceId,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        file: file.name,
      });
    }
  }

  const final = await withOrg(org.id, async (sql) => {
    const count = await sql.one<{ count: number }>(`SELECT count(*)::int AS count FROM sources`);
    const uncategorized = await sql.one<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM sources s
       WHERE s.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM source_categories sc WHERE sc.source_id = s.id)`,
    );
    const categories = await sql.query<{ name: string; count: number }>(
      `SELECT c.name, count(sc.source_id)::int AS count
       FROM categories c
       LEFT JOIN source_categories sc ON sc.category_id = c.id
       WHERE c.status = 'active'
       GROUP BY c.id,c.name,c.position
       ORDER BY c.position,c.name`,
    );
    return {
      sources: count?.count ?? 0,
      uncategorized: uncategorized?.count ?? 0,
      categories,
    };
  });

  console.log('RECOVERY_OUTCOMES', JSON.stringify(outcomes));
  console.log('RECOVERY_SUMMARY', JSON.stringify({
    discovered_groups: groups.size,
    restored,
    skipped_existing_id: skippedExistingId,
    skipped_existing_content: skippedExistingContent,
    failed,
    final,
  }));

  if (failed > 0) process.exitCode = 2;
  await closePool();
}

main().catch(async (err) => {
  console.error('APPWRITE_SOURCE_RECOVERY_FAILED', err);
  try { await closePool(); } catch {}
  process.exit(1);
});
