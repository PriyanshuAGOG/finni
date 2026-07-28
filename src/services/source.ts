import { withOrg, type Sql } from '../lib/db';
import type { ActorContext } from '../lib/context';
import { hasPermission, requirePermission } from '../lib/context';
import { ApiError, conflict, fieldLocked, invalidInput, notFound, versionConflict } from '../lib/errors';
import { getEnv } from '../lib/env';
import {
  hammingDistance,
  jaccardSimilarity,
  normalizeUrl,
  simhash,
  truncate,
} from '../lib/text';
import { recordAudit } from './audit';
import { guardConfirmation } from './confirmation';
import { refreshTagUsage, upsertTag } from './taxonomy';
import { decodeCursor, encodeCursor } from './audit';

export interface SourceSummary {
  id: string;
  title: string;
  subtitle: string | null;
  source_type: string;
  canonical_url: string | null;
  submitted_url: string | null;
  doi: string | null;
  pmid: string | null;
  author_text: string | null;
  publisher: string | null;
  journal: string | null;
  publication_date: string | null;
  language: string | null;
  review_status: string;
  processing_status: string;
  status: string;
  visibility: string;
  duplicate_status: string;
  evidence_summary: string | null;
  ai_summary_short: string | null;
  human_summary: string | null;
  key_findings: string[];
  limitations: string[];
  safety_notes: string[];
  word_count: number | null;
  reading_time_minutes: number | null;
  version: number;
  locked_fields: string[];
  retraction_status: string;
  assigned_reviewer_id: string | null;
  added_by: string | null;
  approved_at: string | null;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
  categories: Array<{ id: string; name: string }>;
  dashboard_url?: string;
}

const SUMMARY_COLUMNS = `
  s.id, s.title, s.subtitle, s.source_type, s.canonical_url, s.submitted_url,
  s.doi, s.pmid, s.author_text, s.publisher, s.journal, s.publication_date,
  s.language, s.review_status, s.processing_status, s.status, s.visibility,
  s.duplicate_status, s.evidence_summary, s.ai_summary_short, s.human_summary,
  s.key_findings, s.limitations, s.safety_notes, s.word_count,
  s.reading_time_minutes, s.version, s.locked_fields, s.retraction_status,
  s.assigned_reviewer_id, s.added_by, s.approved_at, s.last_verified_at,
  s.created_at, s.updated_at,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) ORDER BY c.name), '[]'::jsonb)
   FROM source_categories sc JOIN categories c ON c.id = sc.category_id
   WHERE sc.source_id = s.id) AS categories
`;

export function withDashboardUrl<T extends { id: string }>(row: T): T & { dashboard_url: string } {
  return { ...row, dashboard_url: `/library/${row.id}` };
}

/**
 * Review statuses that count as approved organizational evidence. Kept in
 * one place so "approved only" means the same thing everywhere.
 */
export const APPROVED_REVIEW_STATUSES = ['approved', 'approved_with_conditions'];

// ---------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------

export type DuplicateKind =
  | 'exact_duplicate'
  | 'canonical_url_duplicate'
  | 'doi_duplicate'
  | 'file_duplicate'
  | 'near_duplicate'
  | 'updated_version';

export interface DuplicateMatch {
  source_id: string;
  title: string;
  kind: DuplicateKind;
  confidence: number;
  explanation: string;
  review_status: string;
  created_at: string;
  dashboard_url: string;
}

export interface DuplicateCheckInput {
  canonicalUrl?: string | null;
  submittedUrl?: string | null;
  doi?: string | null;
  pmid?: string | null;
  contentHash?: string | null;
  normalizedContentHash?: string | null;
  simhashValue?: bigint | null;
  title?: string | null;
  text?: string | null;
  excludeSourceId?: string | null;
}

/**
 * Looks for existing sources that may be the same document.
 *
 * The checks run from strongest signal to weakest: identical content,
 * then a shared identifier, then a shared URL, then near-identical text.
 * A near-duplicate that shares a URL is reported as an updated version
 * rather than a duplicate, because that is a different decision for the
 * user -- keep both versions, or attach the new capture to the old record.
 */
export async function findDuplicates(
  sql: Sql,
  input: DuplicateCheckInput,
): Promise<DuplicateMatch[]> {
  const matches = new Map<string, DuplicateMatch>();
  const record = (match: DuplicateMatch) => {
    const existing = matches.get(match.source_id);
    if (!existing || existing.confidence < match.confidence) matches.set(match.source_id, match);
  };

  const exclude = input.excludeSourceId ?? '00000000-0000-0000-0000-000000000000';

  if (input.contentHash) {
    const rows = await sql.query<{ id: string; title: string; review_status: string; created_at: string }>(
      `SELECT id, title, review_status, created_at FROM sources
       WHERE content_hash = $1 AND status != 'deleted' AND id != $2 LIMIT 5`,
      [input.contentHash, exclude],
    );
    for (const row of rows) {
      record({
        source_id: row.id,
        title: row.title,
        kind: 'exact_duplicate',
        confidence: 1,
        explanation: 'The extracted content is byte-for-byte identical to this existing source.',
        review_status: row.review_status,
        created_at: row.created_at,
        dashboard_url: `/library/${row.id}`,
      });
    }
  }

  if (input.normalizedContentHash) {
    const rows = await sql.query<{ id: string; title: string; review_status: string; created_at: string }>(
      `SELECT id, title, review_status, created_at FROM sources
       WHERE normalized_content_hash = $1 AND status != 'deleted' AND id != $2 LIMIT 5`,
      [input.normalizedContentHash, exclude],
    );
    for (const row of rows) {
      record({
        source_id: row.id,
        title: row.title,
        kind: 'exact_duplicate',
        confidence: 0.98,
        explanation:
          'The content is identical once formatting and punctuation differences are ignored.',
        review_status: row.review_status,
        created_at: row.created_at,
        dashboard_url: `/library/${row.id}`,
      });
    }
  }

  if (input.doi) {
    const rows = await sql.query<{ id: string; title: string; review_status: string; created_at: string }>(
      `SELECT id, title, review_status, created_at FROM sources
       WHERE lower(doi) = lower($1) AND status != 'deleted' AND id != $2 LIMIT 5`,
      [input.doi, exclude],
    );
    for (const row of rows) {
      record({
        source_id: row.id,
        title: row.title,
        kind: 'doi_duplicate',
        confidence: 0.99,
        explanation: `Another source already records DOI ${input.doi}.`,
        review_status: row.review_status,
        created_at: row.created_at,
        dashboard_url: `/library/${row.id}`,
      });
    }
  }

  if (input.pmid) {
    const rows = await sql.query<{ id: string; title: string; review_status: string; created_at: string }>(
      `SELECT id, title, review_status, created_at FROM sources
       WHERE pmid = $1 AND status != 'deleted' AND id != $2 LIMIT 5`,
      [input.pmid, exclude],
    );
    for (const row of rows) {
      record({
        source_id: row.id,
        title: row.title,
        kind: 'doi_duplicate',
        confidence: 0.99,
        explanation: `Another source already records PMID ${input.pmid}.`,
        review_status: row.review_status,
        created_at: row.created_at,
        dashboard_url: `/library/${row.id}`,
      });
    }
  }

  const urls = [input.canonicalUrl, input.submittedUrl].filter(
    (u): u is string => typeof u === 'string' && u.length > 0,
  );
  if (urls.length > 0) {
    const rows = await sql.query<{
      id: string;
      title: string;
      review_status: string;
      created_at: string;
      content_hash: string | null;
    }>(
      `SELECT id, title, review_status, created_at, content_hash FROM sources
       WHERE (canonical_url = ANY($1::text[]) OR submitted_url = ANY($1::text[]))
         AND status != 'deleted' AND id != $2 LIMIT 5`,
      [urls, exclude],
    );
    for (const row of rows) {
      const contentDiffers = Boolean(
        input.contentHash && row.content_hash && input.contentHash !== row.content_hash,
      );
      record({
        source_id: row.id,
        title: row.title,
        // Same address, different content: the page changed since it was
        // captured, which is a version, not a duplicate.
        kind: contentDiffers ? 'updated_version' : 'canonical_url_duplicate',
        confidence: contentDiffers ? 0.85 : 0.95,
        explanation: contentDiffers
          ? 'A source with this URL already exists, but the page content has changed since it was captured.'
          : 'A source with this URL already exists.',
        review_status: row.review_status,
        created_at: row.created_at,
        dashboard_url: `/library/${row.id}`,
      });
    }
  }

  // Near-duplicate detection, run last because it is the most expensive.
  // SimHash narrows the candidate set; Jaccard confirms it, so an
  // unlucky hash collision does not produce a false positive.
  if (input.simhashValue != null && input.text) {
    const candidates = await sql.query<{
      id: string;
      title: string;
      review_status: string;
      created_at: string;
      simhash: string | null;
      normalized_text: string | null;
    }>(
      `SELECT id, title, review_status, created_at, simhash, left(normalized_text, 20000) AS normalized_text
       FROM sources
       WHERE simhash IS NOT NULL AND status != 'deleted' AND id != $1
       ORDER BY created_at DESC LIMIT 400`,
      [exclude],
    );

    for (const candidate of candidates) {
      if (matches.has(candidate.id) || !candidate.simhash) continue;
      const distance = hammingDistance(input.simhashValue, BigInt(candidate.simhash));
      if (distance > 12) continue;

      const similarity = candidate.normalized_text
        ? jaccardSimilarity(input.text.slice(0, 20000), candidate.normalized_text)
        : 0;
      if (similarity < 0.7) continue;

      record({
        source_id: candidate.id,
        title: candidate.title,
        kind: 'near_duplicate',
        confidence: Number(similarity.toFixed(2)),
        explanation: `The text is ${Math.round(similarity * 100)}% similar to this existing source. It may be a syndicated copy, a translation, or a revised version.`,
        review_status: candidate.review_status,
        created_at: candidate.created_at,
        dashboard_url: `/library/${candidate.id}`,
      });
    }
  }

  return [...matches.values()].sort((a, b) => b.confidence - a.confidence);
}

export async function checkDuplicates(
  ctx: ActorContext,
  input: DuplicateCheckInput,
): Promise<DuplicateMatch[]> {
  requirePermission(ctx, 'source.read');
  return withOrg(ctx.organizationId, (sql) => findDuplicates(sql, input));
}

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

export interface ListSourcesQuery {
  query?: string;
  reviewStatus?: string[];
  processingStatus?: string[];
  sourceType?: string[];
  categoryId?: string;
  tagId?: string;
  collectionId?: string;
  publisher?: string;
  author?: string;
  publishedAfter?: string;
  publishedBefore?: string;
  addedBy?: string;
  assignedReviewerId?: string;
  archived?: boolean;
  duplicatesOnly?: boolean;
  cursor?: string;
  limit?: number;
  sort?: 'created_at' | 'updated_at' | 'publication_date' | 'title';
  order?: 'asc' | 'desc';
}

const SORTABLE = new Set(['created_at', 'updated_at', 'publication_date', 'title']);

export async function listSources(
  ctx: ActorContext,
  query: ListSourcesQuery,
): Promise<{ items: SourceSummary[]; nextCursor: string | null }> {
  requirePermission(ctx, 'source.read');

  const limit = Math.min(query.limit ?? 25, 100);
  const sort = query.sort && SORTABLE.has(query.sort) ? query.sort : 'created_at';
  const order = query.order === 'asc' ? 'ASC' : 'DESC';

  return withOrg(ctx.organizationId, async (sql) => {
    const params: unknown[] = [];
    const add = (v: unknown) => `$${params.push(v)}`;
    const where: string[] = [query.archived ? `s.status = 'archived'` : `s.status = 'active'`];

    if (query.query) {
      where.push(
        `(s.search_vector @@ plainto_tsquery('english', ${add(query.query)})
          OR lower(s.title) LIKE ${add(`%${query.query.toLowerCase()}%`)})`,
      );
    }
    if (query.reviewStatus?.length) {
      where.push(`s.review_status = ANY(${add(query.reviewStatus)}::review_status[])`);
    }
    if (query.processingStatus?.length) {
      where.push(`s.processing_status = ANY(${add(query.processingStatus)}::processing_status[])`);
    }
    if (query.sourceType?.length) {
      where.push(`s.source_type = ANY(${add(query.sourceType)}::source_type[])`);
    }
    if (query.categoryId) {
      where.push(
        `EXISTS (SELECT 1 FROM source_categories sc WHERE sc.source_id = s.id AND sc.category_id = ${add(query.categoryId)})`,
      );
    }
    if (query.tagId) {
      where.push(
        `EXISTS (SELECT 1 FROM source_tags st WHERE st.source_id = s.id AND st.tag_id = ${add(query.tagId)})`,
      );
    }
    if (query.collectionId) {
      where.push(
        `EXISTS (SELECT 1 FROM collection_sources cs WHERE cs.source_id = s.id AND cs.collection_id = ${add(query.collectionId)})`,
      );
    }
    if (query.publisher) where.push(`s.publisher ILIKE ${add(`%${query.publisher}%`)}`);
    if (query.author) where.push(`s.author_text ILIKE ${add(`%${query.author}%`)}`);
    if (query.publishedAfter) where.push(`s.publication_date >= ${add(query.publishedAfter)}`);
    if (query.publishedBefore) where.push(`s.publication_date <= ${add(query.publishedBefore)}`);
    if (query.addedBy) where.push(`s.added_by = ${add(query.addedBy)}`);
    if (query.assignedReviewerId) {
      where.push(`s.assigned_reviewer_id = ${add(query.assignedReviewerId)}`);
    }
    if (query.duplicatesOnly) where.push(`s.duplicate_status NOT IN ('none','resolved_keep_both','resolved_merged')`);

    if (query.cursor) {
      const decoded = decodeCursor(query.cursor);
      const comparison = order === 'DESC' ? '<' : '>';
      where.push(
        `(coalesce(s.${sort}::text, ''), s.id::text) ${comparison} (${add(decoded.createdAt)}, ${add(decoded.id)})`,
      );
    }

    const rows = await sql.query<SourceSummary & Record<string, unknown>>(
      `SELECT ${SUMMARY_COLUMNS}
       FROM sources s
       WHERE ${where.join(' AND ')}
       ORDER BY s.${sort} ${order} NULLS LAST, s.id ${order}
       LIMIT ${add(limit + 1)}`,
      params,
    );

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(withDashboardUrl);
    const last = page[page.length - 1] as unknown as Record<string, string> | undefined;

    return {
      items: page,
      nextCursor:
        hasMore && last
          ? encodeCursor({ createdAt: String(last[sort] ?? ''), id: last.id })
          : null,
    };
  });
}

export interface GetSourceOptions {
  includeText?: boolean;
  includeStudyMetadata?: boolean;
  includeClaims?: boolean;
  includeAnnotations?: boolean;
  includeVersions?: boolean;
  includeActivity?: boolean;
}

export async function getSource(
  ctx: ActorContext,
  sourceId: string,
  options: GetSourceOptions = {},
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'source.read');
  const env = getEnv();

  return withOrg(ctx.organizationId, async (sql) => {
    const source = await sql.one<SourceSummary & Record<string, unknown>>(
      `SELECT ${SUMMARY_COLUMNS},
              s.abstract, s.ai_summary_one_line, s.ai_summary_detailed,
              s.practical_implications, s.review_questions, s.extraction_confidence,
              s.source_authority_rating, s.conflicts_of_interest, s.funding_information,
              s.rejection_reason, s.review_conditions, s.duplicate_of_source_id,
              s.supersedes_source_id, s.superseded_by_source_id, s.retraction_reason,
              s.thumbnail_url, s.favicon_url, s.added_via, s.approved_by, s.metadata
       FROM sources s WHERE s.id = $1`,
      [sourceId],
    );
    if (!source) throw notFound('source', sourceId);

    const [categories, tags, collections] = await Promise.all([
      sql.query(
        `SELECT c.id, c.name, sc.assignment_source, sc.confidence, sc.approved
         FROM source_categories sc JOIN categories c ON c.id = sc.category_id
         WHERE sc.source_id = $1 ORDER BY c.name`,
        [sourceId],
      ),
      sql.query(
        `SELECT t.id, t.name, st.assignment_source, st.confidence
         FROM source_tags st JOIN tags t ON t.id = st.tag_id
         WHERE st.source_id = $1 ORDER BY t.name`,
        [sourceId],
      ),
      sql.query(
        `SELECT c.id, c.name, cs.section, cs.reason_added
         FROM collection_sources cs JOIN collections c ON c.id = cs.collection_id
         WHERE cs.source_id = $1 AND c.status = 'active' ORDER BY c.name`,
        [sourceId],
      ),
    ]);

    const result: Record<string, unknown> = {
      ...withDashboardUrl(source),
      categories,
      tags,
      collections,
      // Every response says plainly where this sits in the review
      // workflow, so a consumer never has to infer it from a status enum.
      provenance: provenanceOf(source),
    };

    if (options.includeText) {
      const textRow = await sql.one<{ extracted_text: string | null; total: number }>(
        `SELECT left(extracted_text, $2) AS extracted_text,
                coalesce(length(extracted_text), 0) AS total
         FROM sources WHERE id = $1`,
        [sourceId, env.MAX_SOURCE_TEXT_BYTES],
      );
      result.text = textRow?.extracted_text ?? null;
      result.text_truncated = (textRow?.total ?? 0) > env.MAX_SOURCE_TEXT_BYTES;
      result.text_total_length = textRow?.total ?? 0;
    }

    if (options.includeStudyMetadata) {
      result.study_metadata = await sql.one(`SELECT * FROM study_metadata WHERE source_id = $1`, [
        sourceId,
      ]);
      result.evidence_assessments = await sql.query(
        `SELECT * FROM evidence_assessments WHERE source_id = $1 ORDER BY created_at DESC`,
        [sourceId],
      );
    }

    if (options.includeClaims) {
      result.claims = await sql.query(
        `SELECT DISTINCT c.id, c.canonical_text, c.simplified_text, c.evidence_status,
                c.clinical_review_status, c.safety_relevance, ce.relationship
         FROM claim_evidence ce JOIN claims c ON c.id = ce.claim_id
         WHERE ce.source_id = $1 AND c.status = 'active'
         ORDER BY c.canonical_text`,
        [sourceId],
      );
    }

    if (options.includeAnnotations) {
      result.annotations = await sql.query(
        `SELECT a.id, a.annotation_type, a.body, a.selected_text, a.page_number,
                a.locator, a.status, a.created_at, u.full_name AS author_name
         FROM annotations a JOIN users u ON u.id = a.user_id
         WHERE a.source_id = $1 AND a.archived_at IS NULL
         ORDER BY a.created_at DESC`,
        [sourceId],
      );
    }

    if (options.includeVersions) {
      result.versions = await sql.query(
        `SELECT id, version_number, captured_at, content_hash, title, change_summary, created_at
         FROM source_versions WHERE source_id = $1 ORDER BY version_number DESC`,
        [sourceId],
      );
    }

    if (options.includeActivity) {
      result.activity = await sql.query(
        `SELECT a.id, a.action, a.changed_fields, a.source_interface, a.created_at,
                a.actor_type, u.full_name AS actor_name
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
         WHERE a.resource_type = 'source' AND a.resource_id = $1
         ORDER BY a.created_at DESC LIMIT 100`,
        [sourceId],
      );
    }

    return result;
  });
}

/** Where a record sits: approved evidence, unreviewed, or archived. */
export function provenanceOf(source: { review_status: string; status: string }): string {
  if (source.status === 'archived') return 'internal_archived';
  return APPROVED_REVIEW_STATUSES.includes(source.review_status)
    ? 'internal_approved'
    : 'internal_unreviewed';
}

// ---------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------

/** Metadata fields a user may edit directly. */
const EDITABLE_FIELDS = new Set([
  'title',
  'subtitle',
  'source_type',
  'canonical_url',
  'doi',
  'pmid',
  'isbn',
  'author_text',
  'publisher',
  'journal',
  'publication_date',
  'language',
  'country',
  'abstract',
  'human_summary',
  'evidence_summary',
  'key_findings',
  'limitations',
  'safety_notes',
  'practical_implications',
  'conflicts_of_interest',
  'funding_information',
  'copyright_notes',
  'license_information',
  'visibility',
  'retraction_status',
  'retraction_reason',
  'source_authority_rating',
]);

const JSON_FIELDS = new Set([
  'key_findings',
  'limitations',
  'safety_notes',
  'practical_implications',
]);

export async function updateSource(
  ctx: ActorContext,
  sourceId: string,
  updates: Record<string, unknown>,
  options: { expectedVersion?: number } = {},
): Promise<SourceSummary> {
  requirePermission(ctx, 'source.update');

  return withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<
      SourceSummary & { locked_fields: string[]; version: number } & Record<string, unknown>
    >(`SELECT * FROM sources WHERE id = $1 FOR UPDATE`, [sourceId]);
    if (!existing) throw notFound('source', sourceId);
    if (existing.status === 'archived') {
      throw conflict('This source is archived. Restore it before editing.', { status: 'archived' });
    }

    // Optimistic concurrency: refuse a write based on a stale read rather
    // than silently overwriting someone else's change.
    if (options.expectedVersion !== undefined && options.expectedVersion !== existing.version) {
      throw versionConflict('source', existing.version);
    }

    const unknownFields = Object.keys(updates).filter((f) => !EDITABLE_FIELDS.has(f));
    if (unknownFields.length > 0) {
      throw invalidInput(
        `These fields cannot be updated through this operation: ${unknownFields.join(', ')}.`,
        {
          rejected_fields: unknownFields,
          editable_fields: [...EDITABLE_FIELDS],
          note: 'Review status, categories, tags and collections have their own operations.',
        },
      );
    }

    // Fields a reviewer locked stay locked to anyone without the
    // permission to unlock them, including the AI pipeline.
    const locked = new Set(existing.locked_fields ?? []);
    const attemptedLocked = Object.keys(updates).filter((f) => locked.has(f));
    if (attemptedLocked.length > 0 && !hasPermission(ctx, 'source.lock_fields')) {
      throw fieldLocked(attemptedLocked);
    }

    const params: unknown[] = [];
    const add = (v: unknown) => `$${params.push(v)}`;
    const sets: string[] = [];
    const previous: Record<string, unknown> = {};
    const next: Record<string, unknown> = {};

    for (const [field, value] of Object.entries(updates)) {
      if (value === undefined) continue;
      previous[field] = existing[field];
      next[field] = value;
      if (JSON_FIELDS.has(field)) sets.push(`${field} = ${add(JSON.stringify(value))}`);
      else if (field === 'source_type') sets.push(`${field} = ${add(value)}::source_type`);
      else if (field === 'visibility') sets.push(`${field} = ${add(value)}::visibility_level`);
      else sets.push(`${field} = ${add(value)}`);
    }

    if (sets.length === 0) return withDashboardUrl(existing);

    sets.push(`updated_by = ${add(ctx.userId)}`, 'updated_at = now()', 'version = version + 1');

    const row = await sql.one<SourceSummary>(
      `UPDATE sources s SET ${sets.join(', ')} WHERE s.id = ${add(sourceId)}
       RETURNING ${SUMMARY_COLUMNS}`,
      params,
    );

    await recordAudit(sql, ctx, {
      action: 'source.updated',
      resourceType: 'source',
      resourceId: sourceId,
      previousState: previous,
      newState: next,
    });

    return withDashboardUrl(row!);
  });
}

export async function updateSourceTaxonomy(
  ctx: ActorContext,
  sourceId: string,
  input: {
    addCategoryIds?: string[];
    removeCategoryIds?: string[];
    addTags?: string[];
    removeTagIds?: string[];
  },
): Promise<{ categories: unknown[]; tags: unknown[] }> {
  requirePermission(ctx, 'source.update');

  return withOrg(ctx.organizationId, async (sql) => {
    const source = await sql.one<{ id: string; title: string }>(
      `SELECT id, title FROM sources WHERE id = $1 AND status = 'active'`,
      [sourceId],
    );
    if (!source) throw notFound('source', sourceId);

    const changed: Record<string, unknown> = {};

    if (input.addCategoryIds?.length) {
      const valid = await sql.query<{ id: string }>(
        `SELECT id FROM categories WHERE id = ANY($1::uuid[]) AND status = 'active'`,
        [input.addCategoryIds],
      );
      const validIds = valid.map((v) => v.id);
      const missing = input.addCategoryIds.filter((id) => !validIds.includes(id));
      if (missing.length > 0) throw notFound('category', missing[0]);

      for (const categoryId of validIds) {
        await sql.query(
          `INSERT INTO source_categories (source_id, category_id, assignment_source, approved, assigned_by)
           VALUES ($1,$2,$3::assignment_source,true,$4)
           ON CONFLICT (source_id, category_id)
           DO UPDATE SET approved = true, assignment_source = EXCLUDED.assignment_source,
                         assigned_by = EXCLUDED.assigned_by`,
          [sourceId, categoryId, ctx.sourceInterface === 'custom_gpt' ? 'custom_gpt' : 'human', ctx.userId],
        );
      }
      changed.added_category_ids = validIds;
    }

    if (input.removeCategoryIds?.length) {
      await sql.query(
        `DELETE FROM source_categories WHERE source_id = $1 AND category_id = ANY($2::uuid[])`,
        [sourceId, input.removeCategoryIds],
      );
      changed.removed_category_ids = input.removeCategoryIds;
    }

    const touchedTagIds: string[] = [];
    if (input.addTags?.length) {
      const added: string[] = [];
      for (const name of input.addTags) {
        if (!name.trim()) continue;
        const tag = await upsertTag(sql, ctx, name);
        await sql.query(
          `INSERT INTO source_tags (source_id, tag_id, assignment_source, created_by)
           VALUES ($1,$2,$3::assignment_source,$4)
           ON CONFLICT (source_id, tag_id) DO NOTHING`,
          [sourceId, tag.id, ctx.sourceInterface === 'custom_gpt' ? 'custom_gpt' : 'human', ctx.userId],
        );
        added.push(tag.name);
        touchedTagIds.push(tag.id);
      }
      changed.added_tags = added;
    }

    if (input.removeTagIds?.length) {
      await sql.query(`DELETE FROM source_tags WHERE source_id = $1 AND tag_id = ANY($2::uuid[])`, [
        sourceId,
        input.removeTagIds,
      ]);
      touchedTagIds.push(...input.removeTagIds);
      changed.removed_tag_ids = input.removeTagIds;
    }

    await refreshTagUsage(sql, touchedTagIds);

    await recordAudit(sql, ctx, {
      action: 'source.taxonomy_updated',
      resourceType: 'source',
      resourceId: sourceId,
      newState: changed,
    });

    const [categories, tags] = await Promise.all([
      sql.query(
        `SELECT c.id, c.name FROM source_categories sc JOIN categories c ON c.id = sc.category_id
         WHERE sc.source_id = $1 ORDER BY c.name`,
        [sourceId],
      ),
      sql.query(
        `SELECT t.id, t.name FROM source_tags st JOIN tags t ON t.id = st.tag_id
         WHERE st.source_id = $1 ORDER BY t.name`,
        [sourceId],
      ),
    ]);

    return { categories, tags };
  });
}

export async function assignReviewer(
  ctx: ActorContext,
  sourceId: string,
  reviewerId: string,
  note?: string,
): Promise<SourceSummary> {
  requirePermission(ctx, 'source.update');

  return withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<SourceSummary>(
      `SELECT ${SUMMARY_COLUMNS} FROM sources s WHERE s.id = $1`,
      [sourceId],
    );
    if (!existing) throw notFound('source', sourceId);

    const reviewer = await sql.one<{ id: string; full_name: string }>(
      `SELECT id, full_name FROM users WHERE id = $1 AND status = 'active'`,
      [reviewerId],
    );
    if (!reviewer) throw notFound('user', reviewerId);

    const row = await sql.one<SourceSummary>(
      `UPDATE sources s
       SET assigned_reviewer_id = $1,
           review_status = CASE WHEN s.review_status = 'unreviewed' THEN 'needs_review'::review_status
                                ELSE s.review_status END,
           updated_by = $2, updated_at = now(), version = version + 1
       WHERE s.id = $3
       RETURNING ${SUMMARY_COLUMNS}`,
      [reviewerId, ctx.userId, sourceId],
    );

    if (note) {
      await sql.query(
        `INSERT INTO annotations (organization_id, source_id, user_id, annotation_type, body, assigned_to, created_via)
         VALUES ($1,$2,$3,'review_request',$4,$5,$6::source_interface)`,
        [ctx.organizationId, sourceId, ctx.userId, note, reviewerId, ctx.sourceInterface],
      );
    }

    await recordAudit(sql, ctx, {
      action: 'source.reviewer_assigned',
      resourceType: 'source',
      resourceId: sourceId,
      previousState: { assigned_reviewer_id: existing.assigned_reviewer_id },
      newState: { assigned_reviewer_id: reviewerId, reviewer_name: reviewer.full_name },
    });

    return withDashboardUrl(row!);
  });
}

/**
 * Review status transitions. Not every status may follow every other:
 * approving a rejected source without re-review, for instance, would
 * bypass the workflow the rejection exists to enforce.
 */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  unreviewed: ['needs_review', 'in_review', 'approved', 'approved_with_conditions', 'rejected', 'disputed'],
  needs_review: ['in_review', 'approved', 'approved_with_conditions', 'rejected', 'disputed', 'unreviewed'],
  in_review: ['approved', 'approved_with_conditions', 'rejected', 'disputed', 'needs_review'],
  approved: ['disputed', 'superseded', 'needs_review', 'approved_with_conditions'],
  approved_with_conditions: ['approved', 'disputed', 'superseded', 'needs_review'],
  rejected: ['needs_review', 'in_review'],
  disputed: ['in_review', 'needs_review', 'approved', 'approved_with_conditions', 'rejected'],
  superseded: ['needs_review'],
};

/**
 * Set by a bulk operation that already obtained one confirmation for the
 * whole set, so each record is not asked to confirm again. It is never
 * populated from request input: the API schemas do not carry this field.
 */
export interface BatchAuthorization {
  confirmationId: string | null;
  parentAuditId: string;
}

export async function changeReviewStatus(
  ctx: ActorContext,
  sourceId: string,
  input: {
    status: string;
    reason?: string;
    conditions?: string[];
    expectedVersion?: number;
    confirmationId?: string | null;
  },
  batch?: BatchAuthorization,
): Promise<SourceSummary> {
  const approving = ['approved', 'approved_with_conditions'].includes(input.status);
  requirePermission(ctx, approving ? 'source.approve' : 'source.reject');

  return withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<SourceSummary>(
      `SELECT ${SUMMARY_COLUMNS} FROM sources s WHERE s.id = $1 FOR UPDATE`,
      [sourceId],
    );
    if (!existing) throw notFound('source', sourceId);
    if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
      throw versionConflict('source', existing.version);
    }

    if (existing.review_status === input.status) return withDashboardUrl(existing);

    const allowed = ALLOWED_TRANSITIONS[existing.review_status] ?? [];
    if (!allowed.includes(input.status)) {
      throw conflict(
        `A source cannot move directly from "${existing.review_status}" to "${input.status}".`,
        { current_status: existing.review_status, allowed_transitions: allowed },
      );
    }

    if (input.status === 'rejected' && !input.reason?.trim()) {
      throw invalidInput('A reason is required when rejecting a source.', {
        required_field: 'reason',
      });
    }
    if (input.status === 'approved_with_conditions' && !input.conditions?.length) {
      throw invalidInput('At least one condition is required for conditional approval.', {
        required_field: 'conditions',
      });
    }

    if (existing.processing_status !== 'completed' &&
        existing.processing_status !== 'completed_with_warnings' &&
        approving) {
      throw conflict(
        `This source is still ${existing.processing_status}. Wait for processing to finish before approving it.`,
        { processing_status: existing.processing_status },
      );
    }

    const confirmationId = batch
      ? batch.confirmationId
      : await guardConfirmation(sql, ctx, {
          actionType: 'changeSourceReviewStatus',
          resourceType: 'source',
          resourceIds: [sourceId],
          actionPayload: { status: input.status },
          humanSummary: `Change the review status of "${truncate(existing.title, 80)}" from ${existing.review_status} to ${input.status}.`,
          confirmationId: input.confirmationId,
        });

    const rejected = input.status === 'rejected';
    const row = await sql.one<SourceSummary>(
      `UPDATE sources s
       SET review_status = $1::review_status,
           approved_by = CASE WHEN $2 THEN $3::uuid ELSE s.approved_by END,
           approved_at = CASE WHEN $2 THEN now() ELSE s.approved_at END,
           rejected_by = CASE WHEN $4 THEN $3::uuid ELSE s.rejected_by END,
           rejected_at = CASE WHEN $4 THEN now() ELSE s.rejected_at END,
           rejection_reason = CASE WHEN $4 THEN $5 ELSE s.rejection_reason END,
           review_conditions = $6::jsonb,
           last_verified_at = CASE WHEN $2 THEN now() ELSE s.last_verified_at END,
           updated_by = $3, updated_at = now(), version = version + 1
       WHERE s.id = $7
       RETURNING ${SUMMARY_COLUMNS}`,
      [
        input.status,
        approving,
        ctx.userId,
        rejected,
        input.reason ?? null,
        JSON.stringify(input.conditions ?? []),
        sourceId,
      ],
    );

    await recordAudit(sql, ctx, {
      action: `source.review_${input.status}`,
      resourceType: 'source',
      resourceId: sourceId,
      previousState: { review_status: existing.review_status },
      newState: {
        review_status: input.status,
        reason: input.reason ?? null,
        conditions: input.conditions ?? [],
      },
      confirmationId,
      parentAuditId: batch?.parentAuditId ?? null,
    });

    return withDashboardUrl(row!);
  });
}

export async function archiveSource(
  ctx: ActorContext,
  sourceId: string,
  confirmationId?: string | null,
  batch?: BatchAuthorization,
): Promise<SourceSummary> {
  requirePermission(ctx, 'source.archive');

  return withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<SourceSummary>(
      `SELECT ${SUMMARY_COLUMNS} FROM sources s WHERE s.id = $1 FOR UPDATE`,
      [sourceId],
    );
    if (!existing) throw notFound('source', sourceId);
    if (existing.status === 'archived') throw conflict('This source is already archived.');

    const usedConfirmation = batch
      ? batch.confirmationId
      : await guardConfirmation(sql, ctx, {
          actionType: 'archiveSource',
          resourceType: 'source',
          resourceIds: [sourceId],
          actionPayload: {},
          humanSummary: `Archive the source "${truncate(existing.title, 80)}" (${existing.review_status}). It will be removed from default searches but kept, and can be restored.`,
          confirmationId,
        });

    const row = await sql.one<SourceSummary>(
      `UPDATE sources s
       SET status = 'archived', archived_at = now(), archived_by = $1,
           updated_by = $1, updated_at = now(), version = version + 1
       WHERE s.id = $2
       RETURNING ${SUMMARY_COLUMNS}`,
      [ctx.userId, sourceId],
    );

    await recordAudit(sql, ctx, {
      action: 'source.archived',
      resourceType: 'source',
      resourceId: sourceId,
      previousState: { status: 'active' },
      newState: { status: 'archived' },
      confirmationId: usedConfirmation,
      parentAuditId: batch?.parentAuditId ?? null,
    });

    return withDashboardUrl(row!);
  });
}

export async function restoreSource(ctx: ActorContext, sourceId: string): Promise<SourceSummary> {
  requirePermission(ctx, 'source.restore');

  return withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<SourceSummary>(
      `SELECT ${SUMMARY_COLUMNS} FROM sources s WHERE s.id = $1 FOR UPDATE`,
      [sourceId],
    );
    if (!existing) throw notFound('source', sourceId);
    if (existing.status === 'active') throw conflict('This source is already active.');

    const row = await sql.one<SourceSummary>(
      `UPDATE sources s
       SET status = 'active', archived_at = NULL, archived_by = NULL,
           updated_by = $1, updated_at = now(), version = version + 1
       WHERE s.id = $2
       RETURNING ${SUMMARY_COLUMNS}`,
      [ctx.userId, sourceId],
    );

    await recordAudit(sql, ctx, {
      action: 'source.restored',
      resourceType: 'source',
      resourceId: sourceId,
      previousState: { status: existing.status },
      newState: { status: 'active' },
    });

    return withDashboardUrl(row!);
  });
}

export async function permanentlyDeleteSource(
  ctx: ActorContext,
  sourceId: string,
  confirmationId?: string | null,
): Promise<{ deleted: true; id: string }> {
  requirePermission(ctx, 'source.delete_permanent');

  return withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<SourceSummary>(
      `SELECT ${SUMMARY_COLUMNS} FROM sources s WHERE s.id = $1 FOR UPDATE`,
      [sourceId],
    );
    if (!existing) throw notFound('source', sourceId);

    // Permanent deletion is only reachable from the archive, so nothing
    // in active use can be destroyed in a single step.
    if (existing.status !== 'archived') {
      throw conflict(
        'Only archived sources can be permanently deleted. Archive it first, which is reversible.',
        { status: existing.status },
      );
    }

    const usedConfirmation = await guardConfirmation(sql, ctx, {
      actionType: 'permanentlyDeleteSource',
      resourceType: 'source',
      resourceIds: [sourceId],
      actionPayload: {},
      humanSummary: `PERMANENTLY DELETE "${truncate(existing.title, 80)}" and all of its passages, annotations, claims evidence and versions. This cannot be undone.`,
      confirmationId,
    });

    // The audit entry is written before the row disappears, and it
    // survives the deletion as the only remaining record of it.
    await recordAudit(sql, ctx, {
      action: 'source.permanently_deleted',
      resourceType: 'source',
      resourceId: sourceId,
      previousState: {
        title: existing.title,
        canonical_url: existing.canonical_url,
        doi: existing.doi,
        review_status: existing.review_status,
      },
      newState: null,
      confirmationId: usedConfirmation,
    });

    await sql.query(`DELETE FROM sources WHERE id = $1`, [sourceId]);
    return { deleted: true, id: sourceId };
  });
}

// ---------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------

export async function createSourceVersion(
  sql: Sql,
  ctx: ActorContext,
  sourceId: string,
  input: {
    title: string;
    extractedText: string;
    contentHash: string;
    metadataSnapshot: Record<string, unknown>;
    changeSummary?: string;
  },
): Promise<{ id: string; version_number: number }> {
  const latest = await sql.one<{ max: number | null }>(
    `SELECT max(version_number) AS max FROM source_versions WHERE source_id = $1`,
    [sourceId],
  );
  const versionNumber = (latest?.max ?? 0) + 1;

  const row = await sql.one<{ id: string; version_number: number }>(
    `INSERT INTO source_versions (
       organization_id, source_id, version_number, content_hash, title,
       extracted_text, metadata_snapshot, change_summary, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, version_number`,
    [
      ctx.organizationId,
      sourceId,
      versionNumber,
      input.contentHash,
      input.title,
      input.extractedText,
      JSON.stringify(input.metadataSnapshot),
      input.changeSummary ?? null,
      ctx.actorType === 'worker' ? null : ctx.userId,
    ],
  );

  return row!;
}

export async function compareSourceVersions(
  ctx: ActorContext,
  sourceId: string,
  fromVersion: number,
  toVersion: number,
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'source.read');

  return withOrg(ctx.organizationId, async (sql) => {
    const versions = await sql.query<{
      version_number: number;
      title: string | null;
      extracted_text: string | null;
      content_hash: string | null;
      captured_at: string;
      metadata_snapshot: Record<string, unknown>;
    }>(
      `SELECT version_number, title, extracted_text, content_hash, captured_at, metadata_snapshot
       FROM source_versions
       WHERE source_id = $1 AND version_number = ANY($2::int[])
       ORDER BY version_number`,
      [sourceId, [fromVersion, toVersion]],
    );

    const from = versions.find((v) => v.version_number === fromVersion);
    const to = versions.find((v) => v.version_number === toVersion);
    if (!from) throw notFound('source version', String(fromVersion));
    if (!to) throw notFound('source version', String(toVersion));

    const fromLines = (from.extracted_text ?? '').split('\n');
    const toLines = (to.extracted_text ?? '').split('\n');
    const fromSet = new Set(fromLines);
    const toSet = new Set(toLines);

    return {
      from: {
        version_number: from.version_number,
        captured_at: from.captured_at,
        title: from.title,
        content_hash: from.content_hash,
      },
      to: {
        version_number: to.version_number,
        captured_at: to.captured_at,
        title: to.title,
        content_hash: to.content_hash,
      },
      content_changed: from.content_hash !== to.content_hash,
      title_changed: from.title !== to.title,
      added_lines: toLines.filter((l) => l.trim() && !fromSet.has(l)).slice(0, 200),
      removed_lines: fromLines.filter((l) => l.trim() && !toSet.has(l)).slice(0, 200),
      metadata_changes: diffMetadata(from.metadata_snapshot, to.metadata_snapshot),
    };
  });
}

function diffMetadata(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
): Array<{ field: string; from: unknown; to: unknown }> {
  const changes: Array<{ field: string; from: unknown; to: unknown }> = [];
  for (const key of new Set([...Object.keys(from ?? {}), ...Object.keys(to ?? {})])) {
    if (JSON.stringify(from?.[key]) !== JSON.stringify(to?.[key])) {
      changes.push({ field: key, from: from?.[key], to: to?.[key] });
    }
  }
  return changes;
}

// ---------------------------------------------------------------------
// Related sources
// ---------------------------------------------------------------------

export async function getRelatedSources(
  ctx: ActorContext,
  sourceId: string,
  limit = 10,
): Promise<unknown[]> {
  requirePermission(ctx, 'source.read');

  return withOrg(ctx.organizationId, async (sql) => {
    // Relatedness combines shared taxonomy, shared collections and shared
    // claim evidence, so an unclassified source still surfaces neighbours.
    return sql.query(
      `WITH shared_categories AS (
         SELECT sc2.source_id, count(*)::int AS shared
         FROM source_categories sc1
         JOIN source_categories sc2 ON sc2.category_id = sc1.category_id AND sc2.source_id != sc1.source_id
         WHERE sc1.source_id = $1 GROUP BY sc2.source_id
       ), shared_collections AS (
         SELECT cs2.source_id, count(*)::int AS shared
         FROM collection_sources cs1
         JOIN collection_sources cs2 ON cs2.collection_id = cs1.collection_id AND cs2.source_id != cs1.source_id
         WHERE cs1.source_id = $1 GROUP BY cs2.source_id
       ), shared_claims AS (
         SELECT ce2.source_id, count(DISTINCT ce2.claim_id)::int AS shared
         FROM claim_evidence ce1
         JOIN claim_evidence ce2 ON ce2.claim_id = ce1.claim_id AND ce2.source_id != ce1.source_id
         WHERE ce1.source_id = $1 GROUP BY ce2.source_id
       )
       SELECT s.id, s.title, s.source_type, s.publication_date, s.review_status,
              coalesce(cat.shared,0) AS shared_categories,
              coalesce(col.shared,0) AS shared_collections,
              coalesce(cl.shared,0) AS shared_claims,
              (coalesce(cat.shared,0) * 2 + coalesce(col.shared,0) * 3 + coalesce(cl.shared,0) * 4) AS relatedness_score
       FROM sources s
       LEFT JOIN shared_categories cat ON cat.source_id = s.id
       LEFT JOIN shared_collections col ON col.source_id = s.id
       LEFT JOIN shared_claims cl ON cl.source_id = s.id
       WHERE s.status = 'active' AND s.id != $1
         AND (cat.shared IS NOT NULL OR col.shared IS NOT NULL OR cl.shared IS NOT NULL)
       ORDER BY relatedness_score DESC, s.publication_date DESC NULLS LAST
       LIMIT $2`,
      [sourceId, limit],
    );
  });
}

// ---------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------

export interface BulkResult<T> {
  succeeded: Array<{ id: string; result: T }>;
  failed: Array<{ id: string; error_code: string; message: string }>;
  total: number;
}

/**
 * Applies a per-record operation across a set, reporting each outcome
 * separately. Partial failure is normal and is surfaced rather than
 * hidden behind a single success flag.
 */
export async function runBulk<T>(
  ctx: ActorContext,
  ids: string[],
  operation: (id: string) => Promise<T>,
): Promise<BulkResult<T>> {
  const env = getEnv();
  if (ids.length === 0) throw invalidInput('At least one record id is required.');
  if (ids.length > env.MAX_BULK_OPERATION_SIZE) {
    throw new ApiError(
      'INVALID_INPUT',
      `A bulk operation is limited to ${env.MAX_BULK_OPERATION_SIZE} records; ${ids.length} were supplied.`,
      { details: { max_batch_size: env.MAX_BULK_OPERATION_SIZE, supplied: ids.length } },
    );
  }

  const succeeded: Array<{ id: string; result: T }> = [];
  const failed: Array<{ id: string; error_code: string; message: string }> = [];

  for (const id of ids) {
    try {
      succeeded.push({ id, result: await operation(id) });
    } catch (err) {
      failed.push({
        id,
        error_code: err instanceof ApiError ? err.code : 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  return { succeeded, failed, total: ids.length };
}

/**
 * Confirms the set once, records one parent audit event, then applies the
 * change record by record. Each per-record audit entry hangs off the
 * parent, so the activity log shows one bulk action rather than a wall of
 * unrelated changes.
 */
async function authorizeBatch(
  ctx: ActorContext,
  input: {
    actionType: string;
    resourceIds: string[];
    actionPayload: Record<string, unknown>;
    humanSummary: string;
    auditAction: string;
    confirmationId?: string | null;
  },
): Promise<BatchAuthorization> {
  return withOrg(ctx.organizationId, async (sql) => {
    const confirmationId = await guardConfirmation(sql, ctx, {
      actionType: input.actionType,
      resourceType: 'source',
      resourceIds: [...input.resourceIds].sort(),
      actionPayload: input.actionPayload,
      humanSummary: input.humanSummary,
      confirmationId: input.confirmationId,
      riskContext: { affectedCount: input.resourceIds.length },
    });

    const parentAuditId = await recordAudit(sql, ctx, {
      action: input.auditAction,
      resourceType: 'source',
      resourceId: null,
      newState: { source_ids: input.resourceIds, ...input.actionPayload },
      confirmationId,
    });

    return { confirmationId, parentAuditId };
  });
}

export async function bulkChangeReviewStatus(
  ctx: ActorContext,
  input: { sourceIds: string[]; status: string; reason?: string; confirmationId?: string | null },
): Promise<BulkResult<SourceSummary>> {
  const approving = ['approved', 'approved_with_conditions'].includes(input.status);
  requirePermission(ctx, approving ? 'source.approve' : 'source.reject');

  const batch = await authorizeBatch(ctx, {
    actionType: 'bulkChangeSourceReviewStatus',
    resourceIds: input.sourceIds,
    actionPayload: { status: input.status },
    humanSummary: `Change the review status of ${input.sourceIds.length} source(s) to ${input.status}.`,
    auditAction: 'source.bulk_review_status_changed',
    confirmationId: input.confirmationId,
  });

  return runBulk(ctx, input.sourceIds, (id) =>
    changeReviewStatus(ctx, id, { status: input.status, reason: input.reason }, batch),
  );
}

export async function bulkArchiveSources(
  ctx: ActorContext,
  input: { sourceIds: string[]; confirmationId?: string | null },
): Promise<BulkResult<SourceSummary>> {
  requirePermission(ctx, 'source.archive');

  const batch = await authorizeBatch(ctx, {
    actionType: 'bulkArchiveSources',
    resourceIds: input.sourceIds,
    actionPayload: {},
    humanSummary: `Archive ${input.sourceIds.length} source(s). They can be restored individually.`,
    auditAction: 'source.bulk_archived',
    confirmationId: input.confirmationId,
  });

  return runBulk(ctx, input.sourceIds, (id) => archiveSource(ctx, id, null, batch));
}
