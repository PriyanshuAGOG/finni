import { withOrg, type Sql } from '../lib/db';
import { systemContext, type ActorContext } from '../lib/context';
import { ApiError } from '../lib/errors';
import { truncate } from '../lib/text';
import { embed } from '../ai/provider';
import {
  assessEvidence,
  classifySource,
  extractClaims,
  extractStudyMetadata,
  summarizeSource,
} from '../ai/pipeline';
import { chunkDocument } from '../extraction/chunk';
import { toVectorLiteral } from '../services/search';
import { recomputeEvidenceStatus } from '../services/claim';
import { recordAudit } from '../services/audit';
import { externalSearch } from '../extraction/external-search';
import { buildSearchQueries } from '../services/research';
import type { ProcessingJob } from '../services/processing';
import { markJobProgress } from '../services/processing';

export interface HandlerResult {
  output: Record<string, unknown>;
  warnings: string[];
}

type Handler = (job: ProcessingJob, ctx: ActorContext) => Promise<HandlerResult>;

/**
 * Loads the text a stage needs. A stage that finds no text fails with a
 * clear message rather than silently producing empty enrichment.
 */
async function loadSource(sql: Sql, sourceId: string) {
  const source = await sql.one<{
    id: string;
    title: string;
    normalized_text: string | null;
    source_type: string;
    publication_year: number | null;
    human_summary: string | null;
    locked_fields: string[];
    metadata: Record<string, unknown>;
  }>(
    `SELECT id, title, normalized_text, source_type::text, publication_year,
            human_summary, locked_fields, metadata
     FROM sources WHERE id = $1 AND status != 'deleted'`,
    [sourceId],
  );

  if (!source) {
    throw new ApiError('NOT_FOUND', `Source ${sourceId} no longer exists.`, { retryable: false });
  }
  if (!source.normalized_text || source.normalized_text.trim().length < 20) {
    throw new ApiError('EXTRACTION_FAILED', 'This source has no extracted text to work from.', {
      details: { source_id: sourceId },
      retryable: false,
      suggestedAction: 'Re-run extraction, or add the text manually.',
    });
  }
  return source;
}

// ---------------------------------------------------------------------
// Stage handlers
// ---------------------------------------------------------------------

const summarize: Handler = async (job, ctx) => {
  const sourceId = job.source_id!;
  await markJobProgress(job.id, { stage: 'summarizing', progress: 0.2 });

  const source = await withOrg(ctx.organizationId, (sql) => loadSource(sql, sourceId));

  const summary = await summarizeSource(
    { organizationId: ctx.organizationId, requestId: ctx.requestId, sourceId },
    { text: source.normalized_text!, title: source.title },
  );

  return withOrg(ctx.organizationId, async (sql) => {
    const locked = new Set(source.locked_fields ?? []);
    // A human summary is never overwritten by the model, and neither is
    // any field a reviewer has locked.
    const setIfAllowed = (field: string) => !locked.has(field);

    await sql.query(
      `UPDATE sources
       SET ai_summary_one_line = CASE WHEN $2 THEN $3 ELSE ai_summary_one_line END,
           ai_summary_short    = CASE WHEN $2 THEN $4 ELSE ai_summary_short END,
           ai_summary_detailed = CASE WHEN $2 THEN $5 ELSE ai_summary_detailed END,
           key_findings           = CASE WHEN $6 THEN $7::jsonb  ELSE key_findings END,
           practical_implications = CASE WHEN $8 THEN $9::jsonb  ELSE practical_implications END,
           limitations            = CASE WHEN $10 THEN $11::jsonb ELSE limitations END,
           safety_notes           = CASE WHEN $12 THEN $13::jsonb ELSE safety_notes END,
           review_questions = $14::jsonb,
           processing_status = 'enriching'::processing_status,
           updated_at = now()
       WHERE id = $1`,
      [
        sourceId,
        setIfAllowed('ai_summary_short'),
        truncate(summary.one_sentence, 1000),
        truncate(summary.short, 4000),
        summary.detailed,
        setIfAllowed('key_findings'),
        JSON.stringify(summary.key_findings),
        setIfAllowed('practical_implications'),
        JSON.stringify(summary.practical_implications),
        setIfAllowed('limitations'),
        JSON.stringify(summary.limitations),
        setIfAllowed('safety_notes'),
        JSON.stringify(summary.safety_implications),
        JSON.stringify(summary.questions_requiring_review),
      ],
    );

    await recordAudit(sql, ctx, {
      action: 'source.ai_summarized',
      resourceType: 'source',
      resourceId: sourceId,
      newState: {
        key_finding_count: summary.key_findings.length,
        confidence: summary.confidence,
        generated_by: 'ai',
      },
    });

    const warnings: string[] = [];
    if (summary.confidence < 0.5) {
      warnings.push(
        `The model reported low confidence (${summary.confidence.toFixed(2)}) in this summary. A reviewer should check it closely.`,
      );
    }
    if (source.human_summary) {
      warnings.push('A human summary already exists and was left unchanged.');
    }

    return { output: { confidence: summary.confidence }, warnings };
  });
};

const classify: Handler = async (job, ctx) => {
  const sourceId = job.source_id!;
  await markJobProgress(job.id, { stage: 'classifying', progress: 0.4 });

  const { source, categories, collections, allowAiCategories } = await withOrg(
    ctx.organizationId,
    async (sql) => {
      const source = await loadSource(sql, sourceId);
      const categories = await sql.query<{ id: string; name: string; synonyms: string[]; ai_usage_guidance: string | null }>(
        `SELECT id, name, synonyms, ai_usage_guidance FROM categories WHERE status = 'active' ORDER BY name`,
      );
      const collections = await sql.query<{ id: string; name: string; research_question: string | null }>(
        `SELECT id, name, research_question FROM collections
         WHERE status = 'active' AND collection_type IN ('clinical_topic','research_project','programme')
         LIMIT 40`,
      );
      const org = await sql.one<{ settings: Record<string, unknown> }>(
        `SELECT settings FROM organizations WHERE id = $1`,
        [ctx.organizationId],
      );
      return {
        source,
        categories,
        collections,
        allowAiCategories: Boolean(org?.settings?.allow_ai_category_creation),
      };
    },
  );

  const classification = await classifySource(
    { organizationId: ctx.organizationId, requestId: ctx.requestId, sourceId },
    {
      text: source.normalized_text!,
      title: source.title,
      candidateCategories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        synonyms: c.synonyms ?? [],
        guidance: c.ai_usage_guidance ?? undefined,
      })),
      candidateCollections: collections.map((c) => ({
        id: c.id,
        name: c.name,
        research_question: c.research_question ?? undefined,
      })),
      allowNewCategoryProposals: allowAiCategories,
    },
  );

  return withOrg(ctx.organizationId, async (sql) => {
    const warnings: string[] = [];
    const validIds = new Set(categories.map((c) => c.id));
    let assigned = 0;

    for (const category of classification.categories) {
      if (!validIds.has(category.category_id)) {
        warnings.push(`The model proposed an unknown category id and it was ignored.`);
        continue;
      }
      // AI assignments are stored unapproved. They are visible and
      // searchable, but a human still confirms them.
      await sql.query(
        `INSERT INTO source_categories (source_id, category_id, assignment_source, confidence, approved)
         VALUES ($1,$2,'ai',$3,false)
         ON CONFLICT (source_id, category_id) DO NOTHING`,
        [sourceId, category.category_id, category.confidence],
      );
      assigned += 1;
    }

    const tagIds: string[] = [];
    for (const tag of classification.tags.slice(0, 8)) {
      if (tag.confidence < 0.25) continue;
      const normalized = tag.name.toLowerCase().trim();
      if (!normalized) continue;
      const row = await sql.one<{ id: string }>(
        `INSERT INTO tags (organization_id, name, normalized_name)
         VALUES ($1,$2,$3)
         ON CONFLICT (organization_id, normalized_name) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [ctx.organizationId, tag.name.trim(), normalized],
      );
      await sql.query(
        `INSERT INTO source_tags (source_id, tag_id, assignment_source, confidence)
         VALUES ($1,$2,'ai',$3) ON CONFLICT DO NOTHING`,
        [sourceId, row!.id, tag.confidence],
      );
      tagIds.push(row!.id);
    }

    if (tagIds.length > 0) {
      await sql.query(
        `UPDATE tags t SET usage_count = (SELECT count(*) FROM source_tags st WHERE st.tag_id = t.id)
         WHERE t.id = ANY($1::uuid[])`,
        [tagIds],
      );
    }

    // Proposals are recorded as review requests, never acted on.
    for (const proposal of classification.proposed_new_categories) {
      await sql.query(
        `INSERT INTO annotations (organization_id, source_id, user_id, annotation_type, body, created_via)
         VALUES ($1,$2,$3,'review_request',$4,'worker')`,
        [
          ctx.organizationId,
          sourceId,
          job.created_by ?? (await firstAdminId(sql)),
          `The classifier suggested a new category "${proposal.name}". Rationale: ${proposal.rationale}. Closest existing: ${proposal.similar_existing.join(', ') || 'none identified'}. No category was created.`,
        ],
      );
      warnings.push(
        `A new category "${proposal.name}" was proposed and recorded for review. It was not created.`,
      );
    }

    await recordAudit(sql, ctx, {
      action: 'source.ai_classified',
      resourceType: 'source',
      resourceId: sourceId,
      newState: {
        categories_assigned: assigned,
        tags_assigned: tagIds.length,
        proposals: classification.proposed_new_categories.length,
      },
    });

    return {
      output: { categories_assigned: assigned, tags_assigned: tagIds.length },
      warnings,
    };
  });
};

const studyMetadata: Handler = async (job, ctx) => {
  const sourceId = job.source_id!;
  await markJobProgress(job.id, { stage: 'extracting study metadata', progress: 0.55 });

  const source = await withOrg(ctx.organizationId, (sql) => loadSource(sql, sourceId));

  const extraction = await extractStudyMetadata(
    { organizationId: ctx.organizationId, requestId: ctx.requestId, sourceId },
    { text: source.normalized_text!, title: source.title },
  );

  if (!extraction.is_study) {
    return {
      output: { is_study: false },
      warnings: ['This source was not identified as a study, so no study metadata was extracted.'],
    };
  }

  return withOrg(ctx.organizationId, async (sql) => {
    const value = <T>(field: { value: T | null }) => field.value;
    const jsonValue = (field: { value: unknown }) => JSON.stringify(field.value ?? []);

    // Per-field confidence is preserved so a reviewer can see which
    // values were confidently read and which were a stretch.
    const fieldConfidence: Record<string, number> = {};
    for (const [key, field] of Object.entries(extraction)) {
      if (field && typeof field === 'object' && 'confidence' in field) {
        fieldConfidence[key] = (field as { confidence: number }).confidence;
      }
    }

    await sql.query(
      `INSERT INTO study_metadata (
         source_id, organization_id, study_design, registration_identifier, sample_size,
         population_description, inclusion_criteria, exclusion_criteria, age_range,
         sex_distribution, geography, setting, intervention, comparator, duration,
         follow_up_duration, primary_outcomes, secondary_outcomes, effect_sizes,
         confidence_intervals, p_values, attrition_rate, adverse_events,
         statistical_methods, funding_source, conflicts_of_interest, limitations,
         risk_of_bias, pico_population, pico_intervention, pico_comparator,
         pico_outcomes, field_confidence, extraction_confidence
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,
         $17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21::jsonb,$22,$23::jsonb,
         $24,$25,$26,$27::jsonb,$28,$29,$30,$31,$32::jsonb,$33::jsonb,$34
       )
       ON CONFLICT (source_id) DO UPDATE SET
         -- A human-verified record is never overwritten by a re-run.
         study_design = CASE WHEN study_metadata.human_verified THEN study_metadata.study_design ELSE EXCLUDED.study_design END,
         sample_size = CASE WHEN study_metadata.human_verified THEN study_metadata.sample_size ELSE EXCLUDED.sample_size END,
         population_description = CASE WHEN study_metadata.human_verified THEN study_metadata.population_description ELSE EXCLUDED.population_description END,
         intervention = CASE WHEN study_metadata.human_verified THEN study_metadata.intervention ELSE EXCLUDED.intervention END,
         comparator = CASE WHEN study_metadata.human_verified THEN study_metadata.comparator ELSE EXCLUDED.comparator END,
         primary_outcomes = CASE WHEN study_metadata.human_verified THEN study_metadata.primary_outcomes ELSE EXCLUDED.primary_outcomes END,
         field_confidence = EXCLUDED.field_confidence,
         extraction_confidence = EXCLUDED.extraction_confidence,
         updated_at = now()`,
      [
        sourceId,
        ctx.organizationId,
        value(extraction.study_design),
        value(extraction.registration_identifier),
        value(extraction.sample_size),
        value(extraction.population_description),
        jsonValue(extraction.inclusion_criteria),
        jsonValue(extraction.exclusion_criteria),
        value(extraction.age_range),
        value(extraction.sex_distribution),
        value(extraction.geography),
        value(extraction.setting),
        value(extraction.intervention),
        value(extraction.comparator),
        value(extraction.duration),
        value(extraction.follow_up_duration),
        jsonValue(extraction.primary_outcomes),
        jsonValue(extraction.secondary_outcomes),
        jsonValue(extraction.effect_sizes),
        jsonValue(extraction.confidence_intervals),
        jsonValue(extraction.p_values),
        value(extraction.attrition_rate),
        jsonValue(extraction.adverse_events),
        value(extraction.statistical_methods),
        value(extraction.funding_source),
        value(extraction.conflicts_of_interest),
        jsonValue(extraction.limitations),
        value(extraction.risk_of_bias),
        value(extraction.pico_population),
        value(extraction.pico_intervention),
        value(extraction.pico_comparator),
        jsonValue(extraction.pico_outcomes),
        JSON.stringify(fieldConfidence),
        extraction.overall_confidence,
      ],
    );

    await recordAudit(sql, ctx, {
      action: 'source.study_metadata_extracted',
      resourceType: 'source',
      resourceId: sourceId,
      newState: {
        study_design: value(extraction.study_design),
        sample_size: value(extraction.sample_size),
        confidence: extraction.overall_confidence,
      },
    });

    const lowConfidence = Object.entries(fieldConfidence)
      .filter(([, confidence]) => confidence > 0 && confidence < 0.4)
      .map(([field]) => field);

    return {
      output: { is_study: true, confidence: extraction.overall_confidence },
      warnings:
        lowConfidence.length > 0
          ? [`These fields were extracted with low confidence and need checking: ${lowConfidence.join(', ')}.`]
          : [],
    };
  });
};

const claims: Handler = async (job, ctx) => {
  const sourceId = job.source_id!;
  await markJobProgress(job.id, { stage: 'extracting claims', progress: 0.7 });

  const source = await withOrg(ctx.organizationId, (sql) => loadSource(sql, sourceId));

  const extraction = await extractClaims(
    { organizationId: ctx.organizationId, requestId: ctx.requestId, sourceId },
    { text: source.normalized_text!, title: source.title },
  );

  return withOrg(ctx.organizationId, async (sql) => {
    const warnings: string[] = [];
    let created = 0;
    let skipped = 0;

    for (const claim of extraction.claims) {
      // Only the source's own findings become claims automatically.
      // Turning an author's opinion or a cited background statement into
      // an organizational claim is precisely the error to avoid.
      if (claim.claim_nature !== 'source_finding') {
        skipped += 1;
        continue;
      }
      if (claim.extraction_confidence < 0.25) {
        skipped += 1;
        continue;
      }

      // A near-identical claim already in the library gains this source as
      // further evidence rather than becoming a duplicate proposition.
      const existing = await sql.one<{ id: string }>(
        `SELECT id FROM claims
         WHERE status = 'active' AND similarity(lower(canonical_text), lower($1)) > 0.85
         ORDER BY similarity(lower(canonical_text), lower($1)) DESC LIMIT 1`,
        [claim.canonical_text],
      );

      const claimId = existing
        ? existing.id
        : (
            await sql.one<{ id: string }>(
              `INSERT INTO claims (
                 organization_id, canonical_text, simplified_text, claim_type,
                 population, intervention, comparator, outcome, timeframe,
                 quantitative_value, units, confidence, safety_relevance,
                 evidence_status, created_via, context
               ) VALUES ($1,$2,$3,'finding',$4,$5,$6,$7,$8,$9,$10,$11,$12,'unreviewed','worker',$13)
               RETURNING id`,
              [
                ctx.organizationId,
                claim.canonical_text,
                claim.simplified_text,
                claim.population,
                claim.intervention,
                claim.comparator,
                claim.outcome,
                claim.timeframe,
                claim.quantitative_value,
                claim.units,
                claim.extraction_confidence,
                claim.safety_relevant ? 'review_required' : 'none',
                claim.qualifiers.length > 0 ? claim.qualifiers.join('; ') : null,
              ],
            )
          )!.id;

      if (!existing) created += 1;

      await sql.query(
        `INSERT INTO claim_evidence (
           organization_id, claim_id, source_id, relationship, evidence_excerpt,
           locator, extraction_confidence
         ) VALUES ($1,$2,$3,'supports',$4,$5,$6)
         ON CONFLICT (claim_id, source_id, relationship, locator) DO NOTHING`,
        [
          ctx.organizationId,
          claimId,
          sourceId,
          truncate(claim.source_excerpt, 2000),
          claim.locator,
          claim.extraction_confidence,
        ],
      );

      await recomputeEvidenceStatus(sql, claimId);
    }

    if (skipped > 0) {
      warnings.push(
        `${skipped} extracted statement(s) were not turned into claims because they were opinions, cited background, or below the confidence threshold.`,
      );
    }

    await recordAudit(sql, ctx, {
      action: 'source.claims_extracted',
      resourceType: 'source',
      resourceId: sourceId,
      newState: { claims_created: created, statements_skipped: skipped },
    });

    return { output: { claims_created: created, skipped }, warnings };
  });
};

const embeddings: Handler = async (job, ctx) => {
  const sourceId = job.source_id!;
  await markJobProgress(job.id, { stage: 'embedding', progress: 0.85 });

  const source = await withOrg(ctx.organizationId, (sql) => loadSource(sql, sourceId));

  const pageOffsets = (source.metadata?.page_offsets ?? null) as
    | Array<{ page: number; start: number; end: number }>
    | null;

  const chunks = chunkDocument(source.normalized_text!, {
    pageOffsets: pageOffsets ?? undefined,
  });

  if (chunks.length === 0) {
    return { output: { chunks: 0 }, warnings: ['The source produced no chunks to embed.'] };
  }

  const vectors = await embed(
    { organizationId: ctx.organizationId, requestId: ctx.requestId, sourceId },
    chunks.map((c) => c.text),
  );

  return withOrg(ctx.organizationId, async (sql) => {
    // Chunks are replaced wholesale: a re-run after re-extraction must
    // not leave passages from the previous text behind.
    await sql.query(`DELETE FROM embedding_chunks WHERE source_id = $1`, [sourceId]);

    for (const [index, chunk] of chunks.entries()) {
      await sql.query(
        `INSERT INTO embedding_chunks (
           organization_id, source_id, chunk_index, chunk_text, token_count,
           heading_path, page_number, start_offset, end_offset, content_type, embedding
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector)`,
        [
          ctx.organizationId,
          sourceId,
          chunk.index,
          chunk.text,
          chunk.tokenCount,
          chunk.headingPath,
          chunk.pageNumber,
          chunk.startOffset,
          chunk.endOffset,
          chunk.contentType,
          toVectorLiteral(vectors[index] ?? []),
        ],
      );
    }

    await recordAudit(sql, ctx, {
      action: 'source.embedded',
      resourceType: 'source',
      resourceId: sourceId,
      newState: { chunk_count: chunks.length },
    });

    return { output: { chunks: chunks.length }, warnings: [] };
  });
};

const evidenceAssessment: Handler = async (job, ctx) => {
  const sourceId = job.source_id!;
  await markJobProgress(job.id, { stage: 'assessing evidence', progress: 0.95 });

  const { source, sampleSize, studyDesign } = await withOrg(ctx.organizationId, async (sql) => {
    const source = await loadSource(sql, sourceId);
    const study = await sql.one<{ sample_size: number | null; study_design: string | null }>(
      `SELECT sample_size, study_design FROM study_metadata WHERE source_id = $1`,
      [sourceId],
    );
    return {
      source,
      sampleSize: study?.sample_size ?? null,
      studyDesign: study?.study_design ?? null,
    };
  });

  const assessment = await assessEvidence(
    { organizationId: ctx.organizationId, requestId: ctx.requestId, sourceId },
    {
      text: source.normalized_text!,
      sourceType: source.source_type,
      publicationYear: source.publication_year,
      sampleSize,
      studyDesign,
    },
  );

  return withOrg(ctx.organizationId, async (sql) => {
    await sql.query(
      `INSERT INTO evidence_assessments (
         organization_id, source_id, assessment_type, study_design_strength,
         source_authority, sample_adequacy, directness, consistency, precision,
         recency, population_relevance, conflict_of_interest_risk,
         overall_confidence, rationale
       ) VALUES ($1,$2,'ai',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        ctx.organizationId,
        sourceId,
        assessment.study_design_strength,
        assessment.source_authority,
        assessment.sample_adequacy,
        assessment.directness,
        assessment.consistency,
        assessment.precision,
        assessment.recency,
        assessment.population_relevance,
        assessment.conflict_of_interest_risk,
        assessment.overall_confidence,
        assessment.rationale,
      ],
    );

    await sql.query(
      `UPDATE sources
       SET source_authority_rating = $1,
           evidence_summary = $2,
           processing_status = 'completed'::processing_status,
           updated_at = now()
       WHERE id = $3`,
      [
        assessment.source_authority,
        `Design: ${assessment.study_design_strength}. Sample: ${assessment.sample_adequacy}. Recency: ${assessment.recency}. Overall confidence: ${assessment.overall_confidence}. Assessed automatically; not reviewed.`,
        sourceId,
      ],
    );

    return { output: { overall_confidence: assessment.overall_confidence }, warnings: [] };
  });
};

const researchJob: Handler = async (job, ctx) => {
  const researchJobId = job.research_job_id!;
  await markJobProgress(job.id, { stage: 'searching', progress: 0.1 });

  const spec = await withOrg(ctx.organizationId, (sql) =>
    sql.one<Record<string, unknown>>(`SELECT * FROM research_jobs WHERE id = $1`, [researchJobId]),
  );
  if (!spec) {
    throw new ApiError('NOT_FOUND', `Research job ${researchJobId} no longer exists.`, {
      retryable: false,
    });
  }
  if (spec.status === 'cancelled') {
    return { output: { cancelled: true }, warnings: ['The job was cancelled before it ran.'] };
  }

  await withOrg(ctx.organizationId, (sql) =>
    sql.query(
      `UPDATE research_jobs SET status = 'running', started_at = now(), progress = 0.1 WHERE id = $1`,
      [researchJobId],
    ),
  );

  const dateRange = (spec.date_range ?? {}) as { from?: string; to?: string };
  const queries = buildSearchQueries({
    researchQuestion: String(spec.research_question),
    population: (spec.population as string) ?? null,
    intervention: (spec.intervention as string) ?? null,
    outcomes: (spec.outcomes as string[]) ?? [],
    studyDesigns: (spec.study_design_filters as string[]) ?? [],
    geography: (spec.geography as string[]) ?? [],
  });

  const warnings: string[] = [];
  let hits: Awaited<ReturnType<typeof externalSearch>> = [];

  if (spec.external_search_enabled) {
    try {
      hits = await externalSearch(queries, {
        limit: Number(spec.maximum_candidates ?? 25),
        publishedAfter: dateRange.from ?? null,
        publishedBefore: dateRange.to ?? null,
      });
    } catch (err) {
      warnings.push(
        `External search failed: ${err instanceof Error ? err.message : 'unknown error'}. Internal results, if any, were still recorded.`,
      );
    }
  }

  await markJobProgress(job.id, { stage: 'evaluating candidates', progress: 0.6 });

  const { inserted, duplicates } = await withOrg(ctx.organizationId, async (sql) => {
    const { findDuplicates } = await import('../services/source');
    let inserted = 0;
    let duplicates = 0;

    for (const hit of hits) {
      const existing = await findDuplicates(sql, {
        canonicalUrl: hit.url,
        submittedUrl: hit.url,
        doi: hit.doi,
      });
      if (existing.length > 0) duplicates += 1;

      await sql.query(
        `INSERT INTO research_candidates (
           organization_id, research_job_id, url, title, publisher, publication_date,
           source_type, study_design, snippet, relevance_reason, relevance_score,
           key_limitation, origin, duplicate_status, existing_source_id, metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::source_type,$8,$9,$10,$11,$12,'external_web',
                   $13::duplicate_status,$14,$15)`,
        [
          ctx.organizationId,
          researchJobId,
          hit.url,
          truncate(hit.title, 500),
          hit.publisher,
          hit.publicationDate,
          hit.sourceTypeHint ?? 'other',
          hit.studyDesign,
          hit.snippet ? truncate(hit.snippet, 2000) : null,
          hit.relevanceReason,
          hit.score,
          hit.keyLimitation,
          existing[0]?.kind ?? 'none',
          existing[0]?.source_id ?? null,
          JSON.stringify({ provider: hit.provider }),
        ],
      );
      inserted += 1;
    }

    return { inserted, duplicates };
  });

  await withOrg(ctx.organizationId, async (sql) => {
    await sql.query(
      `UPDATE research_jobs
       SET status = $1::job_status, progress = 1, completed_at = now(),
           search_queries_used = $2::jsonb, result_summary = $3, updated_at = now()
       WHERE id = $4`,
      [
        warnings.length > 0 ? 'completed_with_warnings' : 'completed',
        JSON.stringify(queries),
        `Found ${inserted} external candidate(s) across ${queries.length} search quer${queries.length === 1 ? 'y' : 'ies'}. ${duplicates} already exist in the library. No source was saved; select candidates to ingest them.`,
        researchJobId,
      ],
    );

    await recordAudit(sql, ctx, {
      action: 'research_job.completed',
      resourceType: 'research_job',
      resourceId: researchJobId,
      newState: { candidates_found: inserted, duplicates, queries },
    });
  });

  return { output: { candidates_found: inserted, duplicates, queries }, warnings };
};

async function firstAdminId(sql: Sql): Promise<string | null> {
  const row = await sql.one<{ id: string }>(
    `SELECT u.id FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE r.slug = 'administrator' AND u.status = 'active'
     ORDER BY u.created_at LIMIT 1`,
  );
  return row?.id ?? null;
}

export const HANDLERS: Record<string, Handler> = {
  summarize,
  classify,
  study_metadata: studyMetadata,
  claims,
  embeddings,
  evidence_assessment: evidenceAssessment,
  research_job: researchJob,
};

export function contextForJob(job: ProcessingJob, requestId: string): ActorContext {
  const ctx = systemContext(job.organization_id, requestId);
  // The worker acts as the user who requested the work where one is
  // known, so the audit trail attributes enrichment to a real person.
  return job.created_by ? { ...ctx, userId: job.created_by, actorType: 'worker' } : ctx;
}
