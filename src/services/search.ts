import { withOrg, type Sql } from '../lib/db';
import type { ActorContext } from '../lib/context';
import { requirePermission } from '../lib/context';
import { getEnv } from '../lib/env';
import { extractDoi, extractPmid, truncate } from '../lib/text';
import { embed, rerank as rerankProvider } from '../ai/provider';
import { understandQuery } from '../ai/pipeline';
import { chunkLocator } from '../extraction/chunk';
import { APPROVED_REVIEW_STATUSES } from './source';

export type ResearchMode = 'library_only' | 'library_first' | 'web_discovery' | 'evidence_review';

export type SourceOrigin =
  | 'internal_approved'
  | 'internal_unreviewed'
  | 'internal_archived'
  | 'external_web'
  | 'mixed';

export interface SearchFilters {
  reviewStatus?: string[];
  sourceTypes?: string[];
  studyDesigns?: string[];
  categoryIds?: string[];
  tagIds?: string[];
  collectionIds?: string[];
  sourceIds?: string[];
  authors?: string[];
  publishers?: string[];
  publishedAfter?: string | null;
  publishedBefore?: string | null;
  population?: string | null;
  intervention?: string | null;
  comparator?: string | null;
  outcome?: string | null;
  country?: string | null;
  language?: string | null;
  evidenceStatus?: string[];
}

export interface SearchInput {
  query: string;
  mode?: ResearchMode;
  entityTypes?: Array<'sources' | 'claims' | 'collections' | 'annotations' | 'briefs'>;
  filters?: SearchFilters;
  limit?: number;
  includePassages?: boolean;
  includeUnreviewed?: boolean;
  includeArchived?: boolean;
  explainRanking?: boolean;
}

export interface MatchedPassage {
  passage_id: string;
  text: string;
  page_number: number | null;
  section: string | null;
  locator: string;
  score: number;
}

export interface SearchResult {
  entity_type: string;
  id: string;
  title: string;
  source_type?: string;
  publisher?: string | null;
  publication_date?: string | null;
  review_status?: string;
  evidence_status?: string;
  evidence_summary?: string | null;
  relevance_reason: string;
  matched_passages: MatchedPassage[];
  categories: string[];
  collections: string[];
  original_url?: string | null;
  dashboard_url: string;
  origin: SourceOrigin;
  score: number;
  score_breakdown?: Record<string, number>;
}

export interface SearchResponse {
  interpreted_query: {
    semantic_query: string;
    keywords: string[];
    filters_applied: Record<string, unknown>;
    identifier_match: string | null;
  };
  results: SearchResult[];
  scope: {
    mode: ResearchMode;
    source_origin: SourceOrigin;
    total_matched: number;
    approved_count: number;
    unreviewed_count: number;
    searched_approved_only: boolean;
  };
  gaps: string[];
}

/**
 * Weights for the hybrid ranking signals.
 *
 * Recency is deliberately a small contributor: in a health evidence
 * library a 2015 meta-analysis routinely outranks a 2024 blog post, and
 * letting freshness dominate would quietly bury foundational evidence.
 */
const WEIGHTS = {
  fullText: 0.30,
  vector: 0.30,
  titleMatch: 0.10,
  identifierMatch: 0.40,
  taxonomy: 0.05,
  evidenceStrength: 0.08,
  approvalStatus: 0.07,
  authority: 0.04,
  recency: 0.06,
  rerank: 0.15,
};

/** Evidence weighting by study design, used as a ranking signal. */
const DESIGN_STRENGTH: Record<string, number> = {
  meta_analysis: 1.0,
  systematic_review: 0.95,
  randomized_controlled_trial: 0.85,
  clinical_guideline: 0.8,
  cohort_study: 0.6,
  case_control_study: 0.55,
  cross_sectional_study: 0.45,
  government_report: 0.6,
  policy_document: 0.5,
  research_paper: 0.6,
  case_report: 0.3,
  book: 0.4,
  book_chapter: 0.4,
  web_article: 0.25,
  newsletter: 0.15,
  social_post: 0.1,
  video: 0.2,
  podcast: 0.2,
  manual_note: 0.2,
  internal_document: 0.3,
  uploaded_pdf: 0.4,
  uploaded_document: 0.4,
  dataset: 0.5,
  other: 0.2,
};

export async function searchKnowledge(
  ctx: ActorContext,
  input: SearchInput,
): Promise<SearchResponse> {
  requirePermission(ctx, 'knowledge.read');

  const started = Date.now();
  const mode = input.mode ?? 'library_first';
  const entityTypes = input.entityTypes?.length ? input.entityTypes : ['sources'];
  const limit = Math.min(input.limit ?? 20, 50);

  // An exact identifier in the query short-circuits ranking entirely: if
  // someone pastes a DOI they want that record, not things like it.
  const doi = extractDoi(input.query);
  const pmid = extractPmid(input.query);

  const understanding = await understandQuery(
    { organizationId: ctx.organizationId, requestId: ctx.requestId, userId: ctx.userId },
    input.query,
  ).catch(() => null);

  const filters: SearchFilters = { ...input.filters };

  // Filters inferred from the query only fill gaps the caller left; an
  // explicit filter from the user is never overridden by inference.
  if (understanding) {
    if (!filters.publishedAfter && understanding.published_after) {
      filters.publishedAfter = understanding.published_after;
    }
    if (!filters.publishedBefore && understanding.published_before) {
      filters.publishedBefore = understanding.published_before;
    }
    if (!filters.sourceTypes?.length && understanding.study_designs.length > 0) {
      filters.sourceTypes = understanding.study_designs;
    }
    if (!filters.population && understanding.population) filters.population = understanding.population;
  }

  const approvedOnly =
    !input.includeUnreviewed &&
    (filters.reviewStatus?.length
      ? filters.reviewStatus.every((s) => APPROVED_REVIEW_STATUSES.includes(s))
      : mode === 'library_only');

  if (!filters.reviewStatus?.length && approvedOnly) {
    filters.reviewStatus = APPROVED_REVIEW_STATUSES;
  }

  const semanticQuery = understanding?.semantic_query ?? input.query;
  const keywords = understanding?.keywords ?? [];

  const [queryVector] = await embed(
    { organizationId: ctx.organizationId, requestId: ctx.requestId, userId: ctx.userId },
    [semanticQuery],
  );

  const results: SearchResult[] = [];

  if (entityTypes.includes('sources')) {
    results.push(
      ...(await searchSources(ctx, {
        query: input.query,
        semanticQuery,
        queryVector,
        filters,
        limit,
        includePassages: input.includePassages ?? true,
        includeArchived: input.includeArchived ?? false,
        doi,
        pmid,
        explainRanking: input.explainRanking ?? false,
      })),
    );
  }

  if (entityTypes.includes('claims')) {
    results.push(...(await searchClaimsInternal(ctx, { query: input.query, filters, limit })));
  }

  if (entityTypes.includes('collections')) {
    results.push(...(await searchCollections(ctx, input.query, limit)));
  }

  if (entityTypes.includes('annotations')) {
    results.push(...(await searchAnnotations(ctx, input.query, limit)));
  }

  if (entityTypes.includes('briefs')) {
    results.push(...(await searchBriefs(ctx, input.query, limit)));
  }

  results.sort((a, b) => b.score - a.score);
  const page = results.slice(0, limit);

  const approvedCount = page.filter((r) => r.origin === 'internal_approved').length;
  const unreviewedCount = page.filter((r) => r.origin === 'internal_unreviewed').length;

  await withOrg(ctx.organizationId, (sql) =>
    sql.query(
      `INSERT INTO search_events (organization_id, user_id, query, mode, filters, result_count, latency_ms, source_interface)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::source_interface)`,
      [
        ctx.organizationId,
        ctx.userId,
        truncate(input.query, 500),
        mode,
        JSON.stringify(filters),
        page.length,
        Date.now() - started,
        ctx.sourceInterface,
      ],
    ),
  ).catch(() => undefined);

  return {
    interpreted_query: {
      semantic_query: semanticQuery,
      keywords,
      filters_applied: cleanFilters(filters),
      identifier_match: doi ?? pmid ?? null,
    },
    results: page,
    scope: {
      mode,
      source_origin: originOf(page),
      total_matched: results.length,
      approved_count: approvedCount,
      unreviewed_count: unreviewedCount,
      searched_approved_only: approvedOnly,
    },
    gaps: describeGaps(page, filters, approvedOnly),
  };
}

function originOf(results: SearchResult[]): SourceOrigin {
  if (results.length === 0) return 'internal_approved';
  const origins = new Set(results.map((r) => r.origin));
  if (origins.size === 1) return [...origins][0];
  return 'mixed';
}

function describeGaps(
  results: SearchResult[],
  filters: SearchFilters,
  approvedOnly: boolean,
): string[] {
  const gaps: string[] = [];
  if (results.length === 0) {
    gaps.push(
      approvedOnly
        ? 'No approved sources matched this query. There may be unreviewed material; searching with include_unreviewed will show it, clearly labelled as not yet approved.'
        : 'No sources matched this query within the selected scope.',
    );
    return gaps;
  }
  if (approvedOnly && results.length < 3) {
    gaps.push(
      `Only ${results.length} approved source(s) matched. The evidence base for this question is thin.`,
    );
  }
  const unreviewed = results.filter((r) => r.origin === 'internal_unreviewed').length;
  if (unreviewed > 0) {
    gaps.push(
      `${unreviewed} of these results are unreviewed and do not count as approved organizational evidence.`,
    );
  }
  if (filters.population) {
    gaps.push(
      `Results were not filtered by study population beyond the query terms. Confirm each source's population matches "${filters.population}".`,
    );
  }
  return gaps;
}

function cleanFilters(filters: SearchFilters): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------
// Source search
// ---------------------------------------------------------------------

interface SourceSearchInput {
  query: string;
  semanticQuery: string;
  queryVector: number[];
  filters: SearchFilters;
  limit: number;
  includePassages: boolean;
  includeArchived: boolean;
  doi: string | null;
  pmid: string | null;
  explainRanking: boolean;
}

async function searchSources(
  ctx: ActorContext,
  input: SourceSearchInput,
): Promise<SearchResult[]> {
  return withOrg(ctx.organizationId, async (sql) => {
    const params: unknown[] = [];
    const add = (v: unknown) => `$${params.push(v)}`;

    const queryParam = add(input.query);
    const vectorParam = add(toVectorLiteral(input.queryVector));
    const doiParam = add(input.doi);
    const pmidParam = add(input.pmid);

    const where: string[] = [
      input.includeArchived ? `s.status IN ('active','archived')` : `s.status = 'active'`,
    ];
    const f = input.filters;

    if (f.reviewStatus?.length) {
      where.push(`s.review_status = ANY(${add(f.reviewStatus)}::review_status[])`);
    }
    if (f.sourceTypes?.length) {
      // Values coming from query understanding may not all be valid enum
      // members, so unknown ones are dropped rather than failing the query.
      const valid = f.sourceTypes.filter((t) => t in DESIGN_STRENGTH);
      if (valid.length > 0) where.push(`s.source_type = ANY(${add(valid)}::source_type[])`);
    }
    if (f.categoryIds?.length) {
      where.push(
        `EXISTS (SELECT 1 FROM source_categories sc WHERE sc.source_id = s.id AND sc.category_id = ANY(${add(f.categoryIds)}::uuid[]))`,
      );
    }
    if (f.tagIds?.length) {
      where.push(
        `EXISTS (SELECT 1 FROM source_tags st WHERE st.source_id = s.id AND st.tag_id = ANY(${add(f.tagIds)}::uuid[]))`,
      );
    }
    if (f.collectionIds?.length) {
      where.push(
        `EXISTS (SELECT 1 FROM collection_sources cs WHERE cs.source_id = s.id AND cs.collection_id = ANY(${add(f.collectionIds)}::uuid[]))`,
      );
    }
    if (f.sourceIds?.length) where.push(`s.id = ANY(${add(f.sourceIds)}::uuid[])`);
    if (f.publishers?.length) where.push(`s.publisher = ANY(${add(f.publishers)}::text[])`);
    if (f.authors?.length) {
      where.push(`(${f.authors.map((a) => `s.author_text ILIKE ${add(`%${a}%`)}`).join(' OR ')})`);
    }
    if (f.publishedAfter) where.push(`s.publication_date >= ${add(f.publishedAfter)}`);
    if (f.publishedBefore) where.push(`s.publication_date <= ${add(f.publishedBefore)}`);
    if (f.country) where.push(`s.country = ${add(f.country)}`);
    if (f.language) where.push(`s.language = ${add(f.language)}`);
    if (f.studyDesigns?.length) {
      where.push(
        `EXISTS (SELECT 1 FROM study_metadata sm WHERE sm.source_id = s.id AND sm.study_design = ANY(${add(f.studyDesigns)}::text[]))`,
      );
    }
    if (f.population) {
      where.push(
        `(EXISTS (SELECT 1 FROM study_metadata sm WHERE sm.source_id = s.id
                  AND (sm.population_description ILIKE ${add(`%${f.population}%`)}
                       OR sm.pico_population ILIKE ${add(`%${f.population}%`)}))
          OR s.normalized_text ILIKE ${add(`%${f.population}%`)})`,
      );
    }
    if (f.intervention) {
      where.push(
        `(EXISTS (SELECT 1 FROM study_metadata sm WHERE sm.source_id = s.id
                  AND (sm.intervention ILIKE ${add(`%${f.intervention}%`)}
                       OR sm.pico_intervention ILIKE ${add(`%${f.intervention}%`)}))
          OR s.normalized_text ILIKE ${add(`%${f.intervention}%`)})`,
      );
    }

    // Candidate retrieval is deliberately wider than the requested page:
    // reranking can only reorder what the first pass surfaced.
    const candidateLimit = Math.max(input.limit * 4, 40);

    const rows = await sql.query<{
      id: string;
      title: string;
      source_type: string;
      publisher: string | null;
      publication_date: string | null;
      review_status: string;
      status: string;
      evidence_summary: string | null;
      ai_summary_short: string | null;
      canonical_url: string | null;
      publication_year: number | null;
      source_authority_rating: string | null;
      fts_score: number;
      title_score: number;
      vector_score: number | null;
      taxonomy_hits: number;
      identifier_hit: boolean;
    }>(
      `WITH scored AS (
         SELECT s.id, s.title, s.source_type::text, s.publisher, s.publication_date,
                s.review_status::text, s.status::text, s.evidence_summary, s.ai_summary_short,
                s.canonical_url, s.publication_year, s.source_authority_rating,
                ts_rank_cd(s.search_vector, plainto_tsquery('english', ${queryParam}))::float AS fts_score,
                similarity(lower(s.title), lower(${queryParam}))::float AS title_score,
                (SELECT min(ec.embedding <=> ${vectorParam}::vector)
                 FROM embedding_chunks ec WHERE ec.source_id = s.id)::float AS vector_distance,
                (SELECT count(*) FROM source_categories sc
                 JOIN categories c ON c.id = sc.category_id
                 WHERE sc.source_id = s.id
                   AND lower(c.name) = ANY(string_to_array(lower(${queryParam}), ' ')))::int AS taxonomy_hits,
                (${doiParam}::text IS NOT NULL AND lower(s.doi) = lower(${doiParam}::text))
                  OR (${pmidParam}::text IS NOT NULL AND s.pmid = ${pmidParam}::text) AS identifier_hit
         FROM sources s
         WHERE ${where.join(' AND ')}
       )
       SELECT *, CASE WHEN vector_distance IS NULL THEN NULL
                      ELSE 1 - vector_distance END AS vector_score
       FROM scored
       WHERE fts_score > 0
          OR title_score > 0.25
          OR identifier_hit
          OR (vector_distance IS NOT NULL AND vector_distance < 0.75)
       ORDER BY identifier_hit DESC,
                (coalesce(fts_score,0) * 2 + coalesce(1 - vector_distance, 0)) DESC
       LIMIT ${add(candidateLimit)}`,
      params,
    );

    if (rows.length === 0) return [];

    const passagesBySource = input.includePassages
      ? await fetchPassages(
          sql,
          rows.map((r) => r.id),
          input.query,
          input.queryVector,
        )
      : new Map<string, MatchedPassage[]>();

    const taxonomy = await fetchTaxonomyLabels(
      sql,
      rows.map((r) => r.id),
    );

    // Reranking runs over the passage that actually matched, which is a
    // far better signal for a cross-encoder than a title alone.
    const rerankInputs = rows.map((row) => {
      const passage = passagesBySource.get(row.id)?.[0];
      return `${row.title}. ${passage?.text ?? row.ai_summary_short ?? ''}`;
    });
    const rerankScores = await rerankProvider(
      { organizationId: ctx.organizationId, requestId: ctx.requestId },
      input.semanticQuery,
      rerankInputs,
    );

    const currentYear = new Date().getFullYear();

    return rows.map((row, index) => {
      const breakdown: Record<string, number> = {};

      const fts = Math.min(1, (row.fts_score ?? 0) * 8);
      const vector = row.vector_score != null ? Math.max(0, row.vector_score) : 0;
      const title = Math.max(0, row.title_score ?? 0);
      const identifier = row.identifier_hit ? 1 : 0;
      const taxonomyScore = Math.min(1, (row.taxonomy_hits ?? 0) / 2);
      const evidence = DESIGN_STRENGTH[row.source_type] ?? 0.2;
      const approval = APPROVED_REVIEW_STATUSES.includes(row.review_status)
        ? 1
        : row.review_status === 'rejected' || row.review_status === 'superseded'
          ? 0
          : 0.4;
      const authority =
        row.source_authority_rating === 'high'
          ? 1
          : row.source_authority_rating === 'moderate'
            ? 0.6
            : 0.3;
      // Saturating rather than linear, so a very old but strong source is
      // not pushed off the page by a recent weak one.
      const age = row.publication_year ? currentYear - row.publication_year : 12;
      const recency = age <= 0 ? 1 : Math.max(0, 1 - Math.log1p(Math.max(0, age)) / Math.log1p(25));
      const rerankScore = Math.max(0, rerankScores[index] ?? 0);

      breakdown.full_text = Number((fts * WEIGHTS.fullText).toFixed(4));
      breakdown.vector = Number((vector * WEIGHTS.vector).toFixed(4));
      breakdown.title_match = Number((title * WEIGHTS.titleMatch).toFixed(4));
      breakdown.identifier_match = Number((identifier * WEIGHTS.identifierMatch).toFixed(4));
      breakdown.taxonomy = Number((taxonomyScore * WEIGHTS.taxonomy).toFixed(4));
      breakdown.evidence_strength = Number((evidence * WEIGHTS.evidenceStrength).toFixed(4));
      breakdown.approval_status = Number((approval * WEIGHTS.approvalStatus).toFixed(4));
      breakdown.authority = Number((authority * WEIGHTS.authority).toFixed(4));
      breakdown.recency = Number((recency * WEIGHTS.recency).toFixed(4));
      breakdown.rerank = Number((rerankScore * WEIGHTS.rerank).toFixed(4));

      const score = Object.values(breakdown).reduce((sum, v) => sum + v, 0);
      const passages = passagesBySource.get(row.id) ?? [];
      const labels = taxonomy.get(row.id) ?? { categories: [], collections: [] };

      return {
        entity_type: 'source',
        id: row.id,
        title: row.title,
        source_type: row.source_type,
        publisher: row.publisher,
        publication_date: row.publication_date,
        review_status: row.review_status,
        evidence_summary: row.evidence_summary,
        relevance_reason: explainRelevance(row, breakdown, passages.length),
        matched_passages: passages,
        categories: labels.categories,
        collections: labels.collections,
        original_url: row.canonical_url,
        dashboard_url: `/library/${row.id}`,
        origin:
          row.status === 'archived'
            ? 'internal_archived'
            : APPROVED_REVIEW_STATUSES.includes(row.review_status)
              ? 'internal_approved'
              : 'internal_unreviewed',
        score: Number(score.toFixed(4)),
        ...(input.explainRanking ? { score_breakdown: breakdown } : {}),
      } satisfies SearchResult;
    });
  });
}

function explainRelevance(
  row: { identifier_hit: boolean; title_score: number; source_type: string; review_status: string },
  breakdown: Record<string, number>,
  passageCount: number,
): string {
  if (row.identifier_hit) return 'Exact identifier match (DOI or PMID).';

  const reasons: string[] = [];
  if (breakdown.title_match > 0.03) reasons.push('the title matches the query');
  if (breakdown.full_text > 0.1) reasons.push('the text contains the query terms');
  if (breakdown.vector > 0.15) reasons.push('the content is semantically close to the query');
  if (passageCount > 0) reasons.push(`${passageCount} passage(s) matched directly`);
  if (breakdown.taxonomy > 0) reasons.push('an assigned category matches the query');

  const base =
    reasons.length > 0
      ? `Matched because ${reasons.join(', ')}.`
      : 'Matched on overall relevance to the query.';

  const caveat = APPROVED_REVIEW_STATUSES.includes(row.review_status)
    ? ''
    : ' This source is not yet approved.';

  return base + caveat;
}

async function fetchPassages(
  sql: Sql,
  sourceIds: string[],
  query: string,
  queryVector: number[],
): Promise<Map<string, MatchedPassage[]>> {
  const rows = await sql.query<{
    id: string;
    source_id: string;
    chunk_text: string;
    page_number: number | null;
    heading_path: string | null;
    chunk_index: number;
    start_offset: number | null;
    score: number;
  }>(
    `SELECT * FROM (
       SELECT ec.id, ec.source_id, ec.chunk_text, ec.page_number, ec.heading_path,
              ec.chunk_index, ec.start_offset,
              (coalesce(ts_rank_cd(ec.search_vector, plainto_tsquery('english', $2)), 0) * 4
               + CASE WHEN ec.embedding IS NULL THEN 0
                      ELSE greatest(0, 1 - (ec.embedding <=> $3::vector)) END)::float AS score,
              row_number() OVER (
                PARTITION BY ec.source_id
                ORDER BY (coalesce(ts_rank_cd(ec.search_vector, plainto_tsquery('english', $2)), 0) * 4
                          + CASE WHEN ec.embedding IS NULL THEN 0
                                 ELSE greatest(0, 1 - (ec.embedding <=> $3::vector)) END) DESC
              ) AS rank
       FROM embedding_chunks ec
       WHERE ec.source_id = ANY($1::uuid[])
     ) ranked
     WHERE rank <= 3 AND score > 0.05
     ORDER BY source_id, score DESC`,
    [sourceIds, query, toVectorLiteral(queryVector)],
  );

  const map = new Map<string, MatchedPassage[]>();
  for (const row of rows) {
    const list = map.get(row.source_id) ?? [];
    list.push({
      passage_id: row.id,
      text: truncate(row.chunk_text, 1200),
      page_number: row.page_number,
      section: row.heading_path,
      locator: chunkLocator({
        pageNumber: row.page_number,
        headingPath: row.heading_path,
        chunkIndex: row.chunk_index,
        startOffset: row.start_offset,
      }),
      score: Number(row.score.toFixed(4)),
    });
    map.set(row.source_id, list);
  }
  return map;
}

async function fetchTaxonomyLabels(
  sql: Sql,
  sourceIds: string[],
): Promise<Map<string, { categories: string[]; collections: string[] }>> {
  const [categories, collections] = await Promise.all([
    sql.query<{ source_id: string; name: string }>(
      `SELECT sc.source_id, c.name FROM source_categories sc
       JOIN categories c ON c.id = sc.category_id
       WHERE sc.source_id = ANY($1::uuid[])`,
      [sourceIds],
    ),
    sql.query<{ source_id: string; name: string }>(
      `SELECT cs.source_id, c.name FROM collection_sources cs
       JOIN collections c ON c.id = cs.collection_id
       WHERE cs.source_id = ANY($1::uuid[]) AND c.status = 'active'`,
      [sourceIds],
    ),
  ]);

  const map = new Map<string, { categories: string[]; collections: string[] }>();
  const ensure = (id: string) => {
    if (!map.has(id)) map.set(id, { categories: [], collections: [] });
    return map.get(id)!;
  };
  for (const row of categories) ensure(row.source_id).categories.push(row.name);
  for (const row of collections) ensure(row.source_id).collections.push(row.name);
  return map;
}

// ---------------------------------------------------------------------
// Other entity types
// ---------------------------------------------------------------------

async function searchClaimsInternal(
  ctx: ActorContext,
  input: { query: string; filters: SearchFilters; limit: number },
): Promise<SearchResult[]> {
  return withOrg(ctx.organizationId, async (sql) => {
    const params: unknown[] = [input.query];
    const add = (v: unknown) => `$${params.push(v)}`;
    const where = [`c.status = 'active'`];

    if (input.filters.evidenceStatus?.length) {
      where.push(`c.evidence_status = ANY(${add(input.filters.evidenceStatus)}::evidence_status[])`);
    }
    if (input.filters.categoryIds?.length) {
      where.push(
        `EXISTS (SELECT 1 FROM claim_categories cc WHERE cc.claim_id = c.id AND cc.category_id = ANY(${add(input.filters.categoryIds)}::uuid[]))`,
      );
    }
    if (input.filters.collectionIds?.length) {
      where.push(
        `EXISTS (SELECT 1 FROM claim_evidence ce
                 JOIN collection_sources cs ON cs.source_id = ce.source_id
                 WHERE ce.claim_id = c.id AND cs.collection_id = ANY(${add(input.filters.collectionIds)}::uuid[]))`,
      );
    }

    const rows = await sql.query<{
      id: string;
      canonical_text: string;
      simplified_text: string | null;
      evidence_status: string;
      clinical_review_status: string;
      safety_relevance: string;
      supporting: number;
      contradicting: number;
      score: number;
    }>(
      `SELECT c.id, c.canonical_text, c.simplified_text, c.evidence_status::text,
              c.clinical_review_status, c.safety_relevance,
              (SELECT count(*) FROM claim_evidence ce WHERE ce.claim_id = c.id AND ce.relationship = 'supports')::int AS supporting,
              (SELECT count(*) FROM claim_evidence ce WHERE ce.claim_id = c.id AND ce.relationship = 'contradicts')::int AS contradicting,
              (ts_rank_cd(c.search_vector, plainto_tsquery('english', $1)) * 4
               + similarity(lower(c.canonical_text), lower($1)))::float AS score
       FROM claims c
       WHERE ${where.join(' AND ')}
         AND (c.search_vector @@ plainto_tsquery('english', $1)
              OR lower(c.canonical_text) % lower($1))
       ORDER BY score DESC
       LIMIT ${add(input.limit)}`,
      params,
    );

    return rows.map((row) => ({
      entity_type: 'claim',
      id: row.id,
      title: truncate(row.canonical_text, 300),
      evidence_status: row.evidence_status,
      relevance_reason: `Claim with ${row.supporting} supporting and ${row.contradicting} contradicting source(s). Evidence status: ${row.evidence_status}.`,
      matched_passages: [],
      categories: [],
      collections: [],
      dashboard_url: `/claims/${row.id}`,
      origin:
        row.clinical_review_status === 'reviewed' ? 'internal_approved' : 'internal_unreviewed',
      score: Number(row.score.toFixed(4)),
    }));
  });
}

async function searchCollections(
  ctx: ActorContext,
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  return withOrg(ctx.organizationId, async (sql) => {
    const rows = await sql.query<{
      id: string;
      name: string;
      description: string | null;
      research_question: string | null;
      source_count: number;
      score: number;
    }>(
      `SELECT c.id, c.name, c.description, c.research_question,
              (SELECT count(*) FROM collection_sources cs WHERE cs.collection_id = c.id)::int AS source_count,
              greatest(
                similarity(lower(c.name), lower($1)),
                similarity(lower(coalesce(c.research_question,'')), lower($1))
              )::float AS score
       FROM collections c
       WHERE c.status = 'active'
         AND (lower(c.name) % lower($1)
              OR lower(coalesce(c.description,'')) LIKE '%' || lower($1) || '%'
              OR lower(coalesce(c.research_question,'')) % lower($1))
       ORDER BY score DESC LIMIT $2`,
      [query, limit],
    );

    return rows.map((row) => ({
      entity_type: 'collection',
      id: row.id,
      title: row.name,
      relevance_reason: `Collection with ${row.source_count} source(s)${row.research_question ? `, addressing: ${truncate(row.research_question, 150)}` : ''}.`,
      matched_passages: [],
      categories: [],
      collections: [],
      dashboard_url: `/collections/${row.id}`,
      origin: 'internal_approved' as const,
      score: Number(row.score.toFixed(4)),
    }));
  });
}

async function searchAnnotations(
  ctx: ActorContext,
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  return withOrg(ctx.organizationId, async (sql) => {
    const rows = await sql.query<{
      id: string;
      body: string | null;
      annotation_type: string;
      source_id: string | null;
      source_title: string | null;
      score: number;
    }>(
      `SELECT a.id, a.body, a.annotation_type::text, a.source_id, s.title AS source_title,
              similarity(lower(coalesce(a.body,'')), lower($1))::float AS score
       FROM annotations a
       LEFT JOIN sources s ON s.id = a.source_id
       WHERE a.archived_at IS NULL
         AND (lower(coalesce(a.body,'')) % lower($1)
              OR lower(coalesce(a.selected_text,'')) LIKE '%' || lower($1) || '%')
       ORDER BY score DESC LIMIT $2`,
      [query, limit],
    );

    return rows.map((row) => ({
      entity_type: 'annotation',
      id: row.id,
      title: truncate(row.body ?? '(no text)', 200),
      relevance_reason: `${row.annotation_type.replace(/_/g, ' ')} on "${truncate(row.source_title ?? 'a source', 80)}".`,
      matched_passages: [],
      categories: [],
      collections: [],
      dashboard_url: row.source_id ? `/library/${row.source_id}?tab=annotations` : '/activity',
      origin: 'internal_unreviewed' as const,
      score: Number(row.score.toFixed(4)),
    }));
  });
}

async function searchBriefs(
  ctx: ActorContext,
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  return withOrg(ctx.organizationId, async (sql) => {
    const rows = await sql.query<{
      id: string;
      title: string;
      brief_type: string;
      status: string;
      research_question: string | null;
      score: number;
    }>(
      `SELECT b.id, b.title, b.brief_type, b.status, b.research_question,
              greatest(similarity(lower(b.title), lower($1)),
                       similarity(lower(coalesce(b.research_question,'')), lower($1)))::float AS score
       FROM research_briefs b
       WHERE b.archived_at IS NULL
         AND (lower(b.title) % lower($1) OR lower(coalesce(b.research_question,'')) % lower($1))
       ORDER BY score DESC LIMIT $2`,
      [query, limit],
    );

    return rows.map((row) => ({
      entity_type: 'brief',
      id: row.id,
      title: row.title,
      relevance_reason: `${row.brief_type.replace(/_/g, ' ')} brief (${row.status}).`,
      matched_passages: [],
      categories: [],
      collections: [],
      dashboard_url: `/briefs/${row.id}`,
      origin: row.status === 'approved' ? 'internal_approved' : 'internal_unreviewed',
      score: Number(row.score.toFixed(4)),
    }));
  });
}

// ---------------------------------------------------------------------
// Passage search within one source
// ---------------------------------------------------------------------

export async function searchSourcePassages(
  ctx: ActorContext,
  sourceId: string,
  input: { query: string; limit?: number; includeContext?: boolean },
): Promise<{ source_id: string; source_title: string; passages: MatchedPassage[] }> {
  requirePermission(ctx, 'source.read');

  const [queryVector] = await embed(
    { organizationId: ctx.organizationId, requestId: ctx.requestId, sourceId },
    [input.query],
  );

  return withOrg(ctx.organizationId, async (sql) => {
    const source = await sql.one<{ id: string; title: string }>(
      `SELECT id, title FROM sources WHERE id = $1`,
      [sourceId],
    );
    if (!source) {
      const { notFound } = await import('../lib/errors');
      throw notFound('source', sourceId);
    }

    const rows = await sql.query<{
      id: string;
      chunk_text: string;
      page_number: number | null;
      heading_path: string | null;
      chunk_index: number;
      start_offset: number | null;
      score: number;
    }>(
      `SELECT ec.id, ec.chunk_text, ec.page_number, ec.heading_path, ec.chunk_index,
              ec.start_offset,
              (coalesce(ts_rank_cd(ec.search_vector, plainto_tsquery('english', $2)), 0) * 4
               + CASE WHEN ec.embedding IS NULL THEN 0
                      ELSE greatest(0, 1 - (ec.embedding <=> $3::vector)) END)::float AS score
       FROM embedding_chunks ec
       WHERE ec.source_id = $1
       ORDER BY score DESC
       LIMIT $4`,
      [sourceId, input.query, toVectorLiteral(queryVector), Math.min(input.limit ?? 10, 30)],
    );

    return {
      source_id: sourceId,
      source_title: source.title,
      passages: rows
        .filter((r) => r.score > 0.02)
        .map((row) => ({
          passage_id: row.id,
          text: row.chunk_text,
          page_number: row.page_number,
          section: row.heading_path,
          locator: chunkLocator({
            pageNumber: row.page_number,
            headingPath: row.heading_path,
            chunkIndex: row.chunk_index,
            startOffset: row.start_offset,
          }),
          score: Number(row.score.toFixed(4)),
        })),
    };
  });
}

/** pgvector accepts a bracketed literal rather than a JSON array. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((v) => (Number.isFinite(v) ? v.toFixed(6) : '0')).join(',')}]`;
}

export function maxSynthesisSources(): number {
  return getEnv().MAX_SYNTHESIS_SOURCES;
}
