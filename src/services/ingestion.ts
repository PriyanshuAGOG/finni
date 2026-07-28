import { withOrg, type Sql } from '../lib/db';
import type { ActorContext } from '../lib/context';
import { requirePermission } from '../lib/context';
import { ApiError, invalidInput, notFound } from '../lib/errors';
import { getEnv } from '../lib/env';
import {
  contentHash,
  extractDoi,
  extractPmid,
  normalizeText,
  normalizeUrl,
  normalizedContentHash,
  readingTimeMinutes,
  simhash,
  truncate,
  wordCount,
} from '../lib/text';
import {
  extractFromUrl,
  extractFromUrlCapturingDocument,
  extractPlainText,
  resolveDoi,
  resolvePmid,
  type ExtractionResult,
} from '../extraction/extract';
import type { FetchedDocument } from '../extraction/fetch';
import { extensionForContentType, getStorageDriver } from '../lib/storage';
import { recordAudit } from './audit';
import { enqueue, ENRICHMENT_STAGES } from './processing';
import { upsertTag, refreshTagUsage } from './taxonomy';
import { findDuplicates, withDashboardUrl, type DuplicateMatch } from './source';

export type DuplicateBehavior =
  | 'warn'
  | 'return_existing'
  | 'create_related'
  | 'create_version_when_possible';

export interface IngestUrlInput {
  url: string;
  collectionIds?: string[];
  categoryIds?: string[];
  tags?: string[];
  notes?: string | null;
  assignReviewerId?: string | null;
  priority?: 'low' | 'normal' | 'high';
  duplicateBehavior?: DuplicateBehavior;
  processingProfile?: 'standard' | 'metadata_only' | 'full';
  visibility?: string;
  /** A caller-supplied summary, stored immediately instead of waiting for the async summarize job. */
  summary?: string | null;
}

export interface IngestResult {
  source_id: string;
  title: string;
  created: boolean;
  duplicate_status: string;
  duplicates: DuplicateMatch[];
  processing_job_id: string | null;
  processing_status: string;
  review_status: string;
  current_stage: string | null;
  warnings: string[];
  dashboard_url: string;
  message: string;
}

/**
 * Creates a source record from a URL and queues enrichment.
 *
 * The fetch and extraction happen synchronously so the caller learns
 * immediately whether the URL is reachable and whether it duplicates
 * something already in the library. Everything expensive -- summarizing,
 * classifying, claim extraction, embeddings -- is queued, because no
 * browser request should wait on a model.
 */
export async function ingestUrl(ctx: ActorContext, input: IngestUrlInput): Promise<IngestResult> {
  requirePermission(ctx, 'source.create');

  let normalizedUrl: string;
  try {
    normalizedUrl = normalizeUrl(input.url);
  } catch (err) {
    throw invalidInput(err instanceof Error ? err.message : `Not a valid URL: ${input.url}`, {
      supplied_url: input.url,
    });
  }

  const behavior = input.duplicateBehavior ?? 'warn';

  // A cheap pre-check on the URL alone, so an obvious duplicate does not
  // cost a fetch of the publisher's page.
  const urlDuplicates = await withOrg(ctx.organizationId, (sql) =>
    findDuplicates(sql, { canonicalUrl: normalizedUrl, submittedUrl: normalizedUrl }),
  );

  if (urlDuplicates.length > 0 && behavior === 'return_existing') {
    return existingSourceResult(ctx, urlDuplicates[0], urlDuplicates);
  }
  if (urlDuplicates.length > 0 && behavior === 'warn') {
    throw new ApiError('DUPLICATE_SOURCE', 'A source with this URL already exists.', {
      details: {
        duplicates: urlDuplicates,
        options: {
          return_existing: 'Return the existing source instead of creating a new one.',
          create_related: 'Create a new source and mark it as related to the existing one.',
          create_version_when_possible:
            'Attach the new capture as a version of the existing source when the content has changed.',
        },
      },
      suggestedAction:
        'Tell the user the source already exists and ask whether to open the existing record, save a related copy, or capture a new version.',
    });
  }

  const { extraction, document } = await extractFromUrlCapturingDocument(normalizedUrl);
  return createFromExtraction(ctx, {
    extraction,
    document,
    submittedUrl: normalizedUrl,
    behavior,
    duplicatesAlreadySeen: urlDuplicates,
    collectionIds: input.collectionIds,
    categoryIds: input.categoryIds,
    tags: input.tags,
    notes: input.notes,
    assignReviewerId: input.assignReviewerId,
    priority: input.priority,
    processingProfile: input.processingProfile,
    visibility: input.visibility,
    summary: input.summary,
  });
}

export async function ingestUrlsBatch(
  ctx: ActorContext,
  input: {
    urls: string[];
    collectionIds?: string[];
    categoryIds?: string[];
    tags?: string[];
    duplicateBehavior?: DuplicateBehavior;
  },
): Promise<{
  results: Array<{ url: string; status: string; result?: IngestResult; error?: unknown }>;
  summary: { total: number; created: number; duplicates: number; failed: number };
}> {
  requirePermission(ctx, 'source.create');
  const env = getEnv();

  if (input.urls.length === 0) throw invalidInput('At least one URL is required.');
  if (input.urls.length > env.MAX_INGEST_BATCH_SIZE) {
    throw invalidInput(
      `A batch is limited to ${env.MAX_INGEST_BATCH_SIZE} URLs; ${input.urls.length} were supplied.`,
      { max_batch_size: env.MAX_INGEST_BATCH_SIZE, supplied: input.urls.length },
    );
  }

  const results: Array<{ url: string; status: string; result?: IngestResult; error?: unknown }> = [];
  let created = 0;
  let duplicates = 0;
  let failed = 0;

  // Sequential rather than parallel: a batch of URLs to the same
  // publisher should not arrive as a burst.
  for (const url of input.urls) {
    try {
      const result = await ingestUrl(ctx, {
        url,
        collectionIds: input.collectionIds,
        categoryIds: input.categoryIds,
        tags: input.tags,
        duplicateBehavior: input.duplicateBehavior ?? 'return_existing',
      });
      results.push({ url, status: result.created ? 'created' : 'duplicate', result });
      if (result.created) created += 1;
      else duplicates += 1;
    } catch (err) {
      failed += 1;
      results.push({
        url,
        status: 'failed',
        error:
          err instanceof ApiError
            ? { code: err.code, message: err.message, details: err.details }
            : { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Unknown error' },
      });
    }
  }

  return {
    results,
    summary: { total: input.urls.length, created, duplicates, failed },
  };
}

export async function ingestIdentifier(
  ctx: ActorContext,
  input: {
    doi?: string;
    pmid?: string;
    collectionIds?: string[];
    categoryIds?: string[];
    tags?: string[];
    summary?: string | null;
  },
): Promise<IngestResult> {
  requirePermission(ctx, 'source.create');

  const doi = input.doi ? extractDoi(input.doi) ?? input.doi.trim().toLowerCase() : null;
  const pmid = input.pmid ? extractPmid(input.pmid) ?? input.pmid.trim() : null;
  if (!doi && !pmid) throw invalidInput('Either a DOI or a PMID is required.');

  const existing = await withOrg(ctx.organizationId, (sql) => findDuplicates(sql, { doi, pmid }));
  if (existing.length > 0) {
    return existingSourceResult(ctx, existing[0], existing);
  }

  const resolved = doi ? await resolveDoi(doi) : await resolvePmid(pmid!);
  return ingestUrl(ctx, {
    url: resolved.url,
    collectionIds: input.collectionIds,
    categoryIds: input.categoryIds,
    tags: input.tags,
    duplicateBehavior: 'return_existing',
    summary: input.summary,
  });
}

export interface CreateManualSourceInput {
  title: string;
  sourceType?: string;
  text: string;
  originalUrl?: string | null;
  authors?: string[];
  publisher?: string | null;
  publicationDate?: string | null;
  abstract?: string | null;
  categoryIds?: string[];
  tags?: string[];
  collectionIds?: string[];
  visibility?: string;
  skipEnrichment?: boolean;
  summary?: string | null;
}

export async function createManualSource(
  ctx: ActorContext,
  input: CreateManualSourceInput,
): Promise<IngestResult> {
  requirePermission(ctx, 'source.create');

  if (!input.title?.trim()) throw invalidInput('A title is required.');
  if (!input.text?.trim()) throw invalidInput('Source text is required.');

  const extraction: ExtractionResult = {
    ...extractPlainText(input.text, input.originalUrl ?? undefined),
    title: input.title.trim(),
    authorText: input.authors?.join(', ') ?? null,
    publisher: input.publisher ?? null,
    publicationDate: input.publicationDate ?? null,
    excerpt: input.abstract ?? null,
    sourceTypeHint: input.sourceType ?? 'manual_note',
    confidence: 1,
    warnings: [],
  };

  return createFromExtraction(ctx, {
    extraction,
    submittedUrl: input.originalUrl ? normalizeUrl(input.originalUrl) : null,
    behavior: 'warn',
    duplicatesAlreadySeen: [],
    categoryIds: input.categoryIds,
    tags: input.tags,
    collectionIds: input.collectionIds,
    visibility: input.visibility,
    skipEnrichment: input.skipEnrichment,
    summary: input.summary,
  });
}

export async function ingestFile(
  ctx: ActorContext,
  input: {
    filename: string;
    mimeType: string;
    body: Buffer;
    collectionIds?: string[];
    categoryIds?: string[];
    tags?: string[];
    summary?: string | null;
  },
): Promise<IngestResult> {
  requirePermission(ctx, 'source.create');
  const env = getEnv();

  if (input.body.length > env.MAX_UPLOAD_BYTES) {
    throw new ApiError(
      'PAYLOAD_TOO_LARGE',
      `The file exceeds the ${Math.round(env.MAX_UPLOAD_BYTES / 1_048_576)} MB upload limit.`,
    );
  }

  // Content sniffing, not the declared type or the extension: a file
  // named .pdf that is not a PDF must not be treated as one.
  const isPdf = input.body.subarray(0, 5).toString('latin1') === '%PDF-';
  const isText = /^text\//.test(input.mimeType) || /\.(txt|md|csv)$/i.test(input.filename);

  if (!isPdf && !isText) {
    throw new ApiError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Only PDF and plain-text files can be ingested directly.',
      {
        details: { filename: sanitizeFilename(input.filename), declared_type: input.mimeType },
        suggestedAction: 'Convert the document to PDF or paste its text as a manual source.',
      },
    );
  }

  const fileHash = contentHash(input.body.toString('base64'));
  const fileDuplicates = await withOrg(ctx.organizationId, (sql) =>
    sql.query<{ id: string; title: string; review_status: string; created_at: string }>(
      `SELECT id, title, review_status, created_at FROM sources
       WHERE metadata->>'file_hash' = $1 AND status != 'deleted' LIMIT 3`,
      [fileHash],
    ),
  );

  if (fileDuplicates.length > 0) {
    const matches: DuplicateMatch[] = fileDuplicates.map((row) => ({
      source_id: row.id,
      title: row.title,
      kind: 'file_duplicate',
      confidence: 1,
      explanation: 'A file with identical contents has already been uploaded.',
      review_status: row.review_status,
      created_at: row.created_at,
      dashboard_url: `/library/${row.id}`,
    }));
    return existingSourceResult(ctx, matches[0], matches);
  }

  const extraction = isPdf
    ? await (await import('../extraction/extract')).extractPdf(input.body)
    : extractPlainText(input.body.toString('utf8'));

  return createFromExtraction(ctx, {
    extraction: {
      ...extraction,
      sourceTypeHint: isPdf ? 'uploaded_pdf' : 'uploaded_document',
    },
    submittedUrl: null,
    behavior: 'warn',
    duplicatesAlreadySeen: [],
    collectionIds: input.collectionIds,
    categoryIds: input.categoryIds,
    tags: input.tags,
    summary: input.summary,
    fileMetadata: {
      file_hash: fileHash,
      original_filename: sanitizeFilename(input.filename),
      file_size_bytes: input.body.length,
      declared_mime_type: input.mimeType,
    },
  });
}

/**
 * Strips path separators, control characters and traversal sequences from
 * an uploaded filename. The value is only ever stored as metadata and
 * shown as a label, never used to build a filesystem path, but it is
 * sanitized so a hostile name cannot mislead a reader either.
 */
export function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\]/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 255);
  return cleaned || "unnamed";
}

// ---------------------------------------------------------------------
// Shared creation path
// ---------------------------------------------------------------------

interface CreateFromExtractionInput {
  extraction: ExtractionResult;
  /** The raw fetched document, when there is one, for archiving the original. */
  document?: FetchedDocument | null;
  submittedUrl: string | null;
  behavior: DuplicateBehavior;
  duplicatesAlreadySeen: DuplicateMatch[];
  collectionIds?: string[];
  categoryIds?: string[];
  tags?: string[];
  notes?: string | null;
  assignReviewerId?: string | null;
  priority?: 'low' | 'normal' | 'high';
  processingProfile?: 'standard' | 'metadata_only' | 'full';
  visibility?: string;
  fileMetadata?: Record<string, unknown>;
  skipEnrichment?: boolean;
  /** A caller-supplied summary, stored immediately instead of waiting for the async summarize job. */
  summary?: string | null;
}

async function createFromExtraction(
  ctx: ActorContext,
  input: CreateFromExtractionInput,
): Promise<IngestResult> {
  const { extraction } = input;
  const text = normalizeText(extraction.text);
  const hash = contentHash(text);
  const normalizedHash = normalizedContentHash(text);
  const simhashValue = simhash(text);
  const warnings = [...extraction.warnings];
  const providedSummary = input.summary?.trim() || null;

  return withOrg(ctx.organizationId, async (sql) => {
    // Full duplicate check now that the content is known.
    const duplicates = await findDuplicates(sql, {
      canonicalUrl: extraction.canonicalUrl ? safeNormalize(extraction.canonicalUrl) : null,
      submittedUrl: input.submittedUrl,
      doi: extraction.doi,
      pmid: extraction.pmid,
      contentHash: hash,
      normalizedContentHash: normalizedHash,
      simhashValue,
      title: extraction.title,
      text,
    });

    const strongest = duplicates[0];

    if (strongest && input.behavior === 'warn') {
      throw new ApiError('DUPLICATE_SOURCE', 'This content already exists in the library.', {
        details: { duplicates },
        suggestedAction:
          'Tell the user what already exists and ask whether to open the existing record, save it as related, or capture a new version.',
      });
    }

    // The page changed at a URL that is already saved: attach the new
    // capture to the existing record instead of splitting its history.
    if (
      strongest &&
      strongest.kind === 'updated_version' &&
      input.behavior === 'create_version_when_possible'
    ) {
      return attachAsVersion(sql, ctx, strongest.source_id, extraction, text, hash, duplicates);
    }

    const priorityValue = input.priority === 'high' ? 10 : input.priority === 'low' ? 200 : 100;

    const row = await sql.one<{ id: string; title: string }>(
      `INSERT INTO sources (
         organization_id, title, subtitle, source_type, canonical_url, submitted_url,
         doi, pmid, author_text, publisher, journal, publication_date, publication_year,
         accessed_at, language, abstract, extracted_text, normalized_text, word_count,
         reading_time_minutes, thumbnail_url, favicon_url, review_status,
         processing_status, visibility, duplicate_status, duplicate_of_source_id,
         extraction_confidence, content_hash, normalized_content_hash, simhash,
         added_via, added_by, created_by, updated_by, assigned_reviewer_id, metadata,
         ai_summary_short, ai_summary_detailed
       ) VALUES (
         $1,$2,$3,$4::source_type,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),$14,$15,$16,$17,$18,
         $19,$20,$21,$22::review_status,'queued'::processing_status,$23::visibility_level,
         $24::duplicate_status,$25,$26,$27,$28,$29,$30::source_interface,$31,$31,$31,$32,$33,
         $34,$35
       )
       RETURNING id, title`,
      [
        ctx.organizationId,
        truncate(extraction.title, 500),
        extraction.subtitle ? truncate(extraction.subtitle, 500) : null,
        extraction.sourceTypeHint ?? 'other',
        extraction.canonicalUrl ? safeNormalize(extraction.canonicalUrl) : input.submittedUrl,
        input.submittedUrl,
        extraction.doi,
        extraction.pmid,
        extraction.authorText,
        extraction.publisher,
        null,
        extraction.publicationDate,
        extraction.publicationDate ? Number(extraction.publicationDate.slice(0, 4)) : null,
        extraction.language,
        extraction.excerpt,
        text,
        text,
        wordCount(text),
        readingTimeMinutes(text),
        extraction.thumbnailUrl ?? null,
        extraction.faviconUrl ?? null,
        // This deployment is internal-only, so a newly ingested source is
        // approved evidence immediately rather than waiting in a review
        // queue nobody outside the org could see anyway. Extraction
        // confidence and warnings still travel with the record for anyone
        // who wants to sanity-check it, and changeSourceReviewStatus can
        // still mark something disputed/rejected after the fact.
        'approved',
        input.visibility ?? 'organization',
        strongest ? mapDuplicateKind(strongest.kind, input.behavior) : 'none',
        strongest && input.behavior === 'create_related' ? strongest.source_id : null,
        extraction.confidence,
        hash,
        normalizedHash,
        simhashValue.toString(),
        ctx.sourceInterface,
        ctx.userId,
        input.assignReviewerId ?? null,
        JSON.stringify({
          ...(input.fileMetadata ?? {}),
          extraction_warnings: warnings,
          page_offsets: extraction.pageOffsets ?? null,
        }),
        providedSummary ? truncate(providedSummary, 4000) : null,
        providedSummary,
      ],
    );

    const sourceId = row!.id;

    if (input.document) {
      try {
        const storage = getStorageDriver();
        const ext = extensionForContentType(input.document.contentType);
        const original = await storage.put(
          `sources/${sourceId}/original${ext}`,
          input.document.body,
          input.document.contentType || 'application/octet-stream',
        );
        let snapshotKey: string | null = null;
        if (extraction.html) {
          const snapshot = await storage.put(
            `sources/${sourceId}/snapshot.html`,
            Buffer.from(extraction.html, 'utf8'),
            'text/html',
          );
          snapshotKey = snapshot.key;
        }
        await sql.query(
          `UPDATE sources SET original_file_path = $1, snapshot_file_path = $2 WHERE id = $3`,
          [original.key, snapshotKey, sourceId],
        );
      } catch (err) {
        // Storage is best-effort: a misconfigured or unreachable storage
        // backend should not block saving the source itself, only the
        // snapshot of it. The source record and its extracted text
        // (already in `sources.extracted_text`) are unaffected.
        warnings.push(
          `The original document snapshot could not be saved: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
      }
    }

    await sql.query(
      `INSERT INTO source_versions (
         organization_id, source_id, version_number, content_hash, title,
         extracted_text, metadata_snapshot, change_summary, created_by
       ) VALUES ($1,$2,1,$3,$4,$5,$6,'Initial capture',$7)`,
      [
        ctx.organizationId,
        sourceId,
        hash,
        extraction.title,
        text,
        JSON.stringify({
          canonical_url: extraction.canonicalUrl,
          author_text: extraction.authorText,
          publisher: extraction.publisher,
          publication_date: extraction.publicationDate,
          doi: extraction.doi,
          pmid: extraction.pmid,
        }),
        ctx.userId,
      ],
    );

    await applyInitialTaxonomy(sql, ctx, sourceId, input);

    if (input.notes) {
      await sql.query(
        `INSERT INTO annotations (organization_id, source_id, user_id, annotation_type, body, created_via)
         VALUES ($1,$2,$3,'note',$4,$5::source_interface)`,
        [ctx.organizationId, sourceId, ctx.userId, input.notes, ctx.sourceInterface],
      );
    }

    let processingJobId: string | null = null;
    if (!input.skipEnrichment) {
      const baseStages =
        input.processingProfile === 'metadata_only'
          ? (['summarize', 'embeddings'] as const)
          : ENRICHMENT_STAGES.filter((s) => s !== 'extract');
      // A summary supplied at creation time replaces what this stage would
      // have produced -- running it anyway would just overwrite it a few
      // seconds later.
      const stages = providedSummary ? baseStages.filter((s) => s !== 'summarize') : baseStages;

      for (const stage of stages) {
        const job = await enqueue(sql, ctx, {
          jobType: stage,
          sourceId,
          priority: priorityValue,
          dedupeKey: `${stage}:${sourceId}`,
        });
        if (!processingJobId) processingJobId = job.id;
      }
    } else {
      await sql.query(
        `UPDATE sources SET processing_status = 'completed' WHERE id = $1`,
        [sourceId],
      );
    }

    await recordAudit(sql, ctx, {
      action: 'source.created',
      resourceType: 'source',
      resourceId: sourceId,
      newState: {
        title: extraction.title,
        canonical_url: extraction.canonicalUrl,
        submitted_url: input.submittedUrl,
        source_type: extraction.sourceTypeHint,
        duplicate_status: strongest ? strongest.kind : 'none',
        review_status: 'approved',
      },
    });

    return {
      source_id: sourceId,
      title: row!.title,
      created: true,
      duplicate_status: strongest ? mapDuplicateKind(strongest.kind, input.behavior) : 'none',
      duplicates,
      processing_job_id: processingJobId,
      processing_status: input.skipEnrichment ? 'completed' : 'queued',
      review_status: 'approved',
      current_stage: input.skipEnrichment ? null : 'queued',
      warnings,
      dashboard_url: `/library/${sourceId}`,
      message: input.skipEnrichment
        ? `Added "${truncate(row!.title, 80)}" to the library.`
        : `Added "${truncate(row!.title, 80)}" to the library.${providedSummary ? ' Summary stored.' : ''} Enrichment is queued.`,
    };
  });
}

async function applyInitialTaxonomy(
  sql: Sql,
  ctx: ActorContext,
  sourceId: string,
  input: CreateFromExtractionInput,
): Promise<void> {
  if (input.categoryIds?.length) {
    const valid = await sql.query<{ id: string }>(
      `SELECT id FROM categories WHERE id = ANY($1::uuid[]) AND status = 'active'`,
      [input.categoryIds],
    );
    for (const category of valid) {
      await sql.query(
        `INSERT INTO source_categories (source_id, category_id, assignment_source, approved, assigned_by)
         VALUES ($1,$2,$3::assignment_source,true,$4) ON CONFLICT DO NOTHING`,
        [sourceId, category.id, ctx.sourceInterface === 'custom_gpt' ? 'custom_gpt' : 'human', ctx.userId],
      );
    }
  }

  if (input.tags?.length) {
    const tagIds: string[] = [];
    for (const name of input.tags) {
      if (!name.trim()) continue;
      const tag = await upsertTag(sql, ctx, name);
      await sql.query(
        `INSERT INTO source_tags (source_id, tag_id, assignment_source, created_by)
         VALUES ($1,$2,$3::assignment_source,$4) ON CONFLICT DO NOTHING`,
        [sourceId, tag.id, ctx.sourceInterface === 'custom_gpt' ? 'custom_gpt' : 'human', ctx.userId],
      );
      tagIds.push(tag.id);
    }
    await refreshTagUsage(sql, tagIds);
  }

  if (input.collectionIds?.length) {
    const valid = await sql.query<{ id: string }>(
      `SELECT id FROM collections WHERE id = ANY($1::uuid[]) AND status = 'active'`,
      [input.collectionIds],
    );
    for (const collection of valid) {
      await sql.query(
        `INSERT INTO collection_sources (collection_id, source_id, position, added_by, added_via)
         VALUES ($1,$2,
                 (SELECT coalesce(max(position),0)+1 FROM collection_sources WHERE collection_id = $1),
                 $3,$4::source_interface)
         ON CONFLICT DO NOTHING`,
        [collection.id, sourceId, ctx.userId, ctx.sourceInterface],
      );
    }
  }
}

async function attachAsVersion(
  sql: Sql,
  ctx: ActorContext,
  sourceId: string,
  extraction: ExtractionResult,
  text: string,
  hash: string,
  duplicates: DuplicateMatch[],
): Promise<IngestResult> {
  const latest = await sql.one<{ max: number | null; title: string }>(
    `SELECT (SELECT max(version_number) FROM source_versions WHERE source_id = $1) AS max,
            (SELECT title FROM sources WHERE id = $1) AS title`,
    [sourceId],
  );
  const versionNumber = (latest?.max ?? 0) + 1;

  await sql.query(
    `INSERT INTO source_versions (
       organization_id, source_id, version_number, content_hash, title,
       extracted_text, metadata_snapshot, change_summary, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      ctx.organizationId,
      sourceId,
      versionNumber,
      hash,
      extraction.title,
      text,
      JSON.stringify({ canonical_url: extraction.canonicalUrl }),
      'Re-captured because the published content changed',
      ctx.userId,
    ],
  );

  // Content changes are re-captured as a new version but no longer demote
  // an approved source back to needs_review -- there is no approval queue
  // left to demote it into. review_status is left untouched here (a human
  // who marked it rejected/disputed stays that way; an approved one stays
  // approved) and is read back below to reflect its true current value.
  const updated = await sql.one<{ review_status: string }>(
    `UPDATE sources
     SET extracted_text = $1, normalized_text = $1, content_hash = $2,
         normalized_content_hash = $3, simhash = $4, word_count = $5,
         reading_time_minutes = $6, last_content_check_at = now(),
         processing_status = 'queued'::processing_status,
         updated_by = $7, updated_at = now(), version = version + 1
     WHERE id = $8
     RETURNING review_status::text`,
    [
      text,
      hash,
      normalizedContentHash(text),
      simhash(text).toString(),
      wordCount(text),
      readingTimeMinutes(text),
      ctx.userId,
      sourceId,
    ],
  );

  let processingJobId: string | null = null;
  for (const stage of ENRICHMENT_STAGES.filter((s) => s !== 'extract')) {
    const job = await enqueue(sql, ctx, {
      jobType: stage,
      sourceId,
      dedupeKey: `${stage}:${sourceId}:v${versionNumber}`,
    });
    if (!processingJobId) processingJobId = job.id;
  }

  await recordAudit(sql, ctx, {
    action: 'source.version_captured',
    resourceType: 'source',
    resourceId: sourceId,
    newState: { version_number: versionNumber, content_hash: hash },
  });

  return {
    source_id: sourceId,
    title: latest?.title ?? extraction.title,
    created: false,
    duplicate_status: 'updated_version',
    duplicates,
    processing_job_id: processingJobId,
    processing_status: 'queued',
    review_status: updated!.review_status,
    current_stage: 'queued',
    warnings: [
      `The published content changed, so this was saved as version ${versionNumber} of the existing source rather than as a new record.`,
    ],
    dashboard_url: `/library/${sourceId}`,
    message: `Captured version ${versionNumber} of the existing source "${truncate(latest?.title ?? '', 80)}".`,
  };
}

async function existingSourceResult(
  ctx: ActorContext,
  match: DuplicateMatch,
  duplicates: DuplicateMatch[],
): Promise<IngestResult> {
  const source = await withOrg(ctx.organizationId, (sql) =>
    sql.one<{
      id: string;
      title: string;
      review_status: string;
      processing_status: string;
    }>(`SELECT id, title, review_status, processing_status FROM sources WHERE id = $1`, [
      match.source_id,
    ]),
  );
  if (!source) throw notFound('source', match.source_id);

  return {
    source_id: source.id,
    title: source.title,
    created: false,
    duplicate_status: match.kind,
    duplicates,
    processing_job_id: null,
    processing_status: source.processing_status,
    review_status: source.review_status,
    current_stage: null,
    warnings: [`No new record was created. ${match.explanation}`],
    dashboard_url: `/library/${source.id}`,
    message: `This is already in the library as "${truncate(source.title, 80)}" (${source.review_status}). No new record was created.`,
  };
}

function mapDuplicateKind(kind: string, behavior: DuplicateBehavior): string {
  if (behavior === 'create_related') return kind === 'near_duplicate' ? 'near_duplicate' : kind;
  return kind;
}

function safeNormalize(url: string): string | null {
  try {
    return normalizeUrl(url);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Reprocessing
// ---------------------------------------------------------------------

export async function reprocessSource(
  ctx: ActorContext,
  sourceId: string,
  input: { stages?: string[]; reason?: string },
): Promise<{ source_id: string; queued_jobs: Array<{ id: string; stage: string; deduped: boolean }> }> {
  requirePermission(ctx, 'source.reprocess');

  const requested = input.stages?.length
    ? input.stages.filter((s) => (ENRICHMENT_STAGES as string[]).includes(s))
    : ENRICHMENT_STAGES.filter((s) => s !== 'extract');

  if (requested.length === 0) {
    throw invalidInput('No valid processing stages were requested.', {
      valid_stages: ENRICHMENT_STAGES,
    });
  }

  return withOrg(ctx.organizationId, async (sql) => {
    const source = await sql.one<{ id: string; title: string }>(
      `SELECT id, title FROM sources WHERE id = $1 AND status = 'active'`,
      [sourceId],
    );
    if (!source) throw notFound('source', sourceId);

    const queued: Array<{ id: string; stage: string; deduped: boolean }> = [];
    for (const stage of requested) {
      const job = await enqueue(sql, ctx, {
        jobType: stage as never,
        sourceId,
        priority: 50,
        input: { reason: input.reason ?? null, reprocess: true },
        dedupeKey: `${stage}:${sourceId}:reprocess:${Date.now()}`,
      });
      queued.push({ id: job.id, stage, deduped: job.deduped });
    }

    await sql.query(
      `UPDATE sources SET processing_status = 'queued'::processing_status, updated_at = now()
       WHERE id = $1`,
      [sourceId],
    );

    await recordAudit(sql, ctx, {
      action: 'source.reprocess_requested',
      resourceType: 'source',
      resourceId: sourceId,
      newState: { stages: requested, reason: input.reason ?? null },
    });

    return { source_id: sourceId, queued_jobs: queued };
  });
}
