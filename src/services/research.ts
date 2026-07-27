import { withOrg } from '../lib/db';
import type { ActorContext } from '../lib/context';
import { requirePermission } from '../lib/context';
import { ApiError, conflict, invalidInput, notFound } from '../lib/errors';
import { getEnv } from '../lib/env';
import { normalizeUrl, truncate } from '../lib/text';
import { extractFromUrl } from '../extraction/extract';
import { recordAudit } from './audit';
import { guardConfirmation } from './confirmation';
import { enqueue } from './processing';
import { findDuplicates } from './source';
import { searchKnowledge } from './search';
import { ingestUrl } from './ingestion';
import { createCollection } from './collection';
import { externalSearch, type ExternalHit } from '../extraction/external-search';

export interface ResearchCandidate {
  id: string;
  url: string | null;
  title: string;
  publisher: string | null;
  publication_date: string | null;
  source_type: string | null;
  study_design: string | null;
  population: string | null;
  snippet: string | null;
  relevance_reason: string | null;
  relevance_score: number | null;
  key_limitation: string | null;
  /** Always `external_web` until the candidate has been ingested and reviewed. */
  origin: string;
  duplicate_status: string;
  existing_source_id: string | null;
  decision: string;
  ingested_source_id: string | null;
}

export interface ResearchJobSpec {
  title?: string;
  researchQuestion: string;
  instructions?: string | null;
  searchScope?: 'internal' | 'external' | 'combined';
  dateRange?: { from?: string | null; to?: string | null };
  sourceTypes?: string[];
  studyDesigns?: string[];
  population?: string | null;
  intervention?: string | null;
  outcomes?: string[];
  geography?: string[];
  inclusionCriteria?: string[];
  exclusionCriteria?: string[];
  maximumCandidates?: number;
  createCollection?: boolean;
  collectionName?: string | null;
  automaticallyIngestSelected?: boolean;
}

/**
 * Runs external discovery without creating a job or touching the library.
 *
 * Candidates returned here are web results. They are explicitly not
 * organizational evidence, and every response says so, because the
 * distinction between "found online" and "approved by us" is the one the
 * whole review workflow exists to protect.
 */
export async function previewExternalResearch(
  ctx: ActorContext,
  input: ResearchJobSpec,
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'research.run');

  const question = input.researchQuestion?.trim();
  if (!question) throw invalidInput('A research question is required.');

  const maximum = Math.min(input.maximumCandidates ?? 20, 50);
  const queries = buildSearchQueries(input);

  const hits = await externalSearch(queries, {
    limit: maximum,
    publishedAfter: input.dateRange?.from ?? null,
    publishedBefore: input.dateRange?.to ?? null,
  });

  // Existing internal coverage is reported alongside, so a user can see
  // what the library already holds before saving anything new.
  const internal = await searchKnowledge(ctx, {
    query: question,
    entityTypes: ['sources'],
    limit: 10,
    includeUnreviewed: true,
    includePassages: false,
  });

  const candidates = await withOrg(ctx.organizationId, async (sql) => {
    const results = [];
    for (const hit of hits) {
      const duplicates = await findDuplicates(sql, {
        canonicalUrl: safeNormalize(hit.url),
        submittedUrl: safeNormalize(hit.url),
        doi: hit.doi ?? null,
      });
      results.push({
        url: hit.url,
        title: hit.title,
        publisher: hit.publisher,
        publication_date: hit.publicationDate,
        snippet: hit.snippet,
        source_type: hit.sourceTypeHint ?? null,
        study_design: hit.studyDesign ?? null,
        relevance_reason: hit.relevanceReason,
        relevance_score: hit.score,
        key_limitation: hit.keyLimitation ?? null,
        origin: 'external_web',
        already_in_library: duplicates.length > 0,
        existing_source_id: duplicates[0]?.source_id ?? null,
        duplicate_status: duplicates[0]?.kind ?? 'none',
      });
    }
    return results;
  });

  return {
    research_question: question,
    search_queries_used: queries,
    provider: getEnv().SEARCH_PROVIDER,
    candidates,
    internal_coverage: {
      matched_sources: internal.results.length,
      approved_count: internal.scope.approved_count,
      results: internal.results.slice(0, 5).map((r) => ({
        id: r.id,
        title: r.title,
        review_status: r.review_status,
        dashboard_url: r.dashboard_url,
      })),
    },
    note: 'These candidates are external web results. They are not approved Nirog Bhoomi evidence and have not been reviewed. Nothing was saved to the library.',
  };
}

export async function previewExternalSource(
  ctx: ActorContext,
  url: string,
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'research.run');

  let normalized: string;
  try {
    normalized = normalizeUrl(url);
  } catch (err) {
    throw invalidInput(err instanceof Error ? err.message : 'Not a valid URL.');
  }

  const duplicates = await withOrg(ctx.organizationId, (sql) =>
    findDuplicates(sql, { canonicalUrl: normalized, submittedUrl: normalized }),
  );

  const warnings: string[] = [];
  let extraction = null;
  try {
    const result = await extractFromUrl(normalized);
    extraction = {
      title: result.title,
      author_text: result.authorText,
      publisher: result.publisher,
      publication_date: result.publicationDate,
      doi: result.doi,
      pmid: result.pmid,
      language: result.language,
      source_type_hint: result.sourceTypeHint,
      extraction_confidence: result.confidence,
      text_preview: truncate(result.text, 2000),
      word_count: result.text.split(/\s+/).length,
    };
    warnings.push(...result.warnings);
  } catch (err) {
    warnings.push(
      err instanceof ApiError
        ? `Extraction preview failed: ${err.message}`
        : 'Extraction preview failed for an unknown reason.',
    );
  }

  return {
    url: normalized,
    normalized_metadata: extraction,
    duplicate_status: duplicates[0]?.kind ?? 'none',
    duplicates,
    ingestion_warnings: warnings,
    origin: 'external_web',
    note: 'Nothing was saved. Use ingestUrl to add this source to the library.',
  };
}

export async function startResearchJob(
  ctx: ActorContext,
  input: ResearchJobSpec,
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'research.run');

  const question = input.researchQuestion?.trim();
  if (!question) throw invalidInput('A research question is required.');

  return withOrg(ctx.organizationId, async (sql) => {
    // A job already running on the same question is almost always an
    // accidental resubmission, not a deliberate second run.
    const running = await sql.one<{ id: string; title: string }>(
      `SELECT id, title FROM research_jobs
       WHERE status IN ('queued','running') AND lower(research_question) = lower($1)`,
      [question],
    );
    if (running) {
      throw conflict('A research job for this question is already running.', {
        existing_job_id: running.id,
        dashboard_url: `/research-jobs/${running.id}`,
      });
    }

    const row = await sql.one<{ id: string }>(
      `INSERT INTO research_jobs (
         organization_id, title, research_question, instructions, search_scope,
         internal_search_enabled, external_search_enabled, date_range,
         source_type_filters, study_design_filters, population, intervention,
         outcomes, geography, inclusion_criteria, exclusion_criteria,
         maximum_candidates, automatically_ingest_selected, requested_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING id`,
      [
        ctx.organizationId,
        input.title ?? truncate(question, 200),
        question,
        input.instructions ?? null,
        input.searchScope ?? 'combined',
        (input.searchScope ?? 'combined') !== 'external',
        (input.searchScope ?? 'combined') !== 'internal',
        JSON.stringify(input.dateRange ?? {}),
        JSON.stringify(input.sourceTypes ?? []),
        JSON.stringify(input.studyDesigns ?? []),
        input.population ?? null,
        input.intervention ?? null,
        JSON.stringify(input.outcomes ?? []),
        JSON.stringify(input.geography ?? []),
        JSON.stringify(input.inclusionCriteria ?? []),
        JSON.stringify(input.exclusionCriteria ?? []),
        Math.min(input.maximumCandidates ?? 25, 100),
        input.automaticallyIngestSelected ?? false,
        ctx.userId,
      ],
    );

    const jobId = row!.id;

    let collectionId: string | null = null;
    if (input.createCollection) {
      const collection = await createCollection(ctx, {
        name: input.collectionName ?? truncate(question, 120),
        researchQuestion: question,
        collectionType: 'research_project',
        purpose: 'Created automatically by a research job.',
      });
      collectionId = collection.id;
      await sql.query(`UPDATE research_jobs SET created_collection_id = $1 WHERE id = $2`, [
        collectionId,
        jobId,
      ]);
    }

    await enqueue(sql, ctx, {
      jobType: 'research_job',
      researchJobId: jobId,
      priority: 60,
      dedupeKey: `research_job:${jobId}`,
    });

    await recordAudit(sql, ctx, {
      action: 'research_job.started',
      resourceType: 'research_job',
      resourceId: jobId,
      newState: {
        research_question: question,
        search_scope: input.searchScope ?? 'combined',
        maximum_candidates: input.maximumCandidates ?? 25,
        created_collection_id: collectionId,
      },
    });

    return {
      id: jobId,
      status: 'queued',
      research_question: question,
      created_collection_id: collectionId,
      dashboard_url: `/research-jobs/${jobId}`,
      message:
        'The research job was queued. Candidates will appear as they are found; nothing is saved to the library until candidates are selected.',
    };
  });
}

export async function getResearchJob(
  ctx: ActorContext,
  jobId: string,
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'research.run');

  return withOrg(ctx.organizationId, async (sql) => {
    const job = await sql.one<Record<string, unknown>>(
      `SELECT * FROM research_jobs WHERE id = $1`,
      [jobId],
    );
    if (!job) throw notFound('research job', jobId);

    const counts = await sql.one<{
      total: number;
      included: number;
      excluded: number;
      pending: number;
      ingested: number;
      duplicates: number;
    }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE decision = 'included')::int AS included,
              count(*) FILTER (WHERE decision = 'excluded')::int AS excluded,
              count(*) FILTER (WHERE decision = 'pending')::int AS pending,
              count(*) FILTER (WHERE ingested_source_id IS NOT NULL)::int AS ingested,
              count(*) FILTER (WHERE duplicate_status != 'none')::int AS duplicates
       FROM research_candidates WHERE research_job_id = $1`,
      [jobId],
    );

    return {
      ...job,
      candidate_counts: counts,
      dashboard_url: `/research-jobs/${jobId}`,
      cancellable: job.status === 'queued' || job.status === 'running',
    };
  });
}

export async function listResearchCandidates(
  ctx: ActorContext,
  jobId: string,
  options: { decision?: string; limit?: number } = {},
): Promise<ResearchCandidate[]> {
  requirePermission(ctx, 'research.run');

  return withOrg(ctx.organizationId, async (sql) => {
    const job = await sql.one(`SELECT id FROM research_jobs WHERE id = $1`, [jobId]);
    if (!job) throw notFound('research job', jobId);

    const params: unknown[] = [jobId];
    const add = (v: unknown) => `$${params.push(v)}`;
    const where = ['research_job_id = $1'];
    if (options.decision) where.push(`decision = ${add(options.decision)}`);

    return sql.query<ResearchCandidate>(
      `SELECT id, url, title, publisher, publication_date, source_type::text,
              study_design, population, snippet, relevance_reason, relevance_score,
              key_limitation, origin, duplicate_status::text, existing_source_id,
              decision, ingested_source_id
       FROM research_candidates
       WHERE ${where.join(' AND ')}
       ORDER BY relevance_score DESC NULLS LAST, created_at
       LIMIT ${add(Math.min(options.limit ?? 100, 200))}`,
      params,
    );
  });
}

export async function selectResearchCandidates(
  ctx: ActorContext,
  jobId: string,
  input: {
    includeCandidateIds?: string[];
    exclude?: Array<{ candidateId: string; reason: string }>;
    ingestIncluded?: boolean;
    addToCollectionId?: string | null;
  },
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'research.run');
  if (input.ingestIncluded) requirePermission(ctx, 'source.create');

  const included = input.includeCandidateIds ?? [];
  const excluded = input.exclude ?? [];

  const { candidates, collectionId } = await withOrg(ctx.organizationId, async (sql) => {
    const job = await sql.one<{ id: string; created_collection_id: string | null }>(
      `SELECT id, created_collection_id FROM research_jobs WHERE id = $1`,
      [jobId],
    );
    if (!job) throw notFound('research job', jobId);

    for (const exclusion of excluded) {
      await sql.query(
        `UPDATE research_candidates
         SET decision = 'excluded', decision_reason = $1, decided_by = $2, decided_at = now()
         WHERE id = $3 AND research_job_id = $4`,
        [exclusion.reason, ctx.userId, exclusion.candidateId, jobId],
      );
    }

    const candidates = await sql.query<{ id: string; url: string | null; title: string }>(
      `UPDATE research_candidates
       SET decision = 'included', decided_by = $1, decided_at = now()
       WHERE id = ANY($2::uuid[]) AND research_job_id = $3
       RETURNING id, url, title`,
      [ctx.userId, included, jobId],
    );

    await recordAudit(sql, ctx, {
      action: 'research_job.candidates_selected',
      resourceType: 'research_job',
      resourceId: jobId,
      newState: {
        included: candidates.map((c) => c.id),
        excluded: excluded.map((e) => e.candidateId),
        ingest_requested: input.ingestIncluded ?? false,
      },
    });

    return {
      candidates,
      collectionId: input.addToCollectionId ?? job.created_collection_id,
    };
  });

  const ingestion: Array<{ candidate_id: string; status: string; source_id?: string; error?: string }> =
    [];

  if (input.ingestIncluded) {
    for (const candidate of candidates) {
      if (!candidate.url) {
        ingestion.push({
          candidate_id: candidate.id,
          status: 'skipped',
          error: 'This candidate has no URL to ingest.',
        });
        continue;
      }
      try {
        const result = await ingestUrl(ctx, {
          url: candidate.url,
          collectionIds: collectionId ? [collectionId] : [],
          duplicateBehavior: 'return_existing',
          notes: `Ingested from research job ${jobId}.`,
        });
        await withOrg(ctx.organizationId, (sql) =>
          sql.query(`UPDATE research_candidates SET ingested_source_id = $1 WHERE id = $2`, [
            result.source_id,
            candidate.id,
          ]),
        );
        ingestion.push({
          candidate_id: candidate.id,
          status: result.created ? 'ingested' : 'already_in_library',
          source_id: result.source_id,
        });
      } catch (err) {
        ingestion.push({
          candidate_id: candidate.id,
          status: 'failed',
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }
  }

  return {
    research_job_id: jobId,
    included_count: candidates.length,
    excluded_count: excluded.length,
    collection_id: collectionId,
    ingestion_results: ingestion,
    note: input.ingestIncluded
      ? 'Ingested sources are unreviewed. They are not approved evidence until a reviewer approves them.'
      : 'Candidates were marked as included but not ingested. Nothing was added to the library.',
  };
}

export async function cancelResearchJob(
  ctx: ActorContext,
  jobId: string,
  confirmationId?: string | null,
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'research.run');

  return withOrg(ctx.organizationId, async (sql) => {
    const job = await sql.one<{ id: string; status: string; title: string }>(
      `SELECT id, status::text, title FROM research_jobs WHERE id = $1 FOR UPDATE`,
      [jobId],
    );
    if (!job) throw notFound('research job', jobId);

    if (!['queued', 'running'].includes(job.status)) {
      throw new ApiError('JOB_NOT_CANCELLABLE', `This job is already ${job.status}.`, {
        details: { status: job.status },
      });
    }

    const candidateCount = await sql.one<{ count: number }>(
      `SELECT count(*)::int FROM research_candidates WHERE research_job_id = $1`,
      [jobId],
    );
    const produced = candidateCount?.count ?? 0;

    const usedConfirmation = await guardConfirmation(sql, ctx, {
      actionType: 'cancelResearchJob',
      resourceType: 'research_job',
      resourceIds: [jobId],
      actionPayload: {},
      humanSummary: `Cancel the research job "${truncate(job.title, 80)}". ${produced} candidate(s) already found will be kept but no further searching will happen.`,
      confirmationId,
      riskContext: { affectedCount: produced },
    });

    await sql.query(
      `UPDATE research_jobs SET status = 'cancelled', completed_at = now(), updated_at = now()
       WHERE id = $1`,
      [jobId],
    );
    await sql.query(
      `UPDATE processing_jobs SET status = 'cancelled', completed_at = now(), updated_at = now()
       WHERE research_job_id = $1 AND status IN ('queued','running')`,
      [jobId],
    );

    await recordAudit(sql, ctx, {
      action: 'research_job.cancelled',
      resourceType: 'research_job',
      resourceId: jobId,
      previousState: { status: job.status },
      newState: { status: 'cancelled', candidates_kept: produced },
      confirmationId: usedConfirmation,
    });

    return { id: jobId, status: 'cancelled', candidates_kept: produced };
  });
}

export async function listResearchJobs(
  ctx: ActorContext,
  options: { status?: string; limit?: number } = {},
): Promise<Record<string, unknown>[]> {
  requirePermission(ctx, 'research.run');

  return withOrg(ctx.organizationId, async (sql) => {
    const params: unknown[] = [];
    const add = (v: unknown) => `$${params.push(v)}`;
    const where: string[] = ['1=1'];
    if (options.status) where.push(`status = ${add(options.status)}::job_status`);

    return sql.query(
      `SELECT id, title, research_question, status::text, progress, search_scope,
              created_collection_id, generated_brief_id, requested_by,
              started_at, completed_at, created_at,
              (SELECT count(*) FROM research_candidates rc WHERE rc.research_job_id = research_jobs.id)::int AS candidate_count
       FROM research_jobs
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ${add(Math.min(options.limit ?? 25, 100))}`,
      params,
    );
  });
}

// ---------------------------------------------------------------------

/**
 * Expands one research question into several queries. A single query
 * rarely covers a PICO-shaped question well; separate queries for the
 * intervention, the population and the study design surface material a
 * single phrasing misses.
 */
export function buildSearchQueries(spec: ResearchJobSpec): string[] {
  const queries = new Set<string>();
  const base = spec.researchQuestion.trim();
  queries.add(base);

  const parts: string[] = [];
  if (spec.intervention) parts.push(spec.intervention);
  if (spec.population) parts.push(spec.population);
  if (spec.outcomes?.length) parts.push(spec.outcomes[0]);

  if (parts.length >= 2) queries.add(parts.join(' '));

  if (spec.studyDesigns?.length) {
    const design = spec.studyDesigns[0].replace(/_/g, ' ');
    queries.add(`${parts.length > 0 ? parts.join(' ') : base} ${design}`);
  }

  if (spec.geography?.length) {
    queries.add(`${parts.length > 0 ? parts.join(' ') : base} ${spec.geography[0]}`);
  }

  return [...queries].slice(0, 5);
}

function safeNormalize(url: string | null): string | null {
  if (!url) return null;
  try {
    return normalizeUrl(url);
  } catch {
    return null;
  }
}

export type { ExternalHit };
