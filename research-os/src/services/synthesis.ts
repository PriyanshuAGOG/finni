import { withOrg, type Sql } from '../lib/db';
import type { ActorContext } from '../lib/context';
import { requirePermission } from '../lib/context';
import { getEnv } from '../lib/env';
import { invalidInput, notFound } from '../lib/errors';
import { truncate } from '../lib/text';
import { embed } from '../ai/provider';
import { synthesizeEvidence, validateCitations, type SynthesisPassage } from '../ai/pipeline';
import { chunkLocator } from '../extraction/chunk';
import { APPROVED_REVIEW_STATUSES } from './source';
import { searchKnowledge, toVectorLiteral, type ResearchMode, type SourceOrigin } from './search';

export type CitationStyle =
  | 'internal'
  | 'numbered'
  | 'apa'
  | 'vancouver'
  | 'harvard'
  | 'url_list'
  | 'doi_list'
  | 'bibtex'
  | 'ris';

export interface Citation {
  marker: string;
  source_id: string;
  title: string;
  authors: string | null;
  publisher: string | null;
  journal: string | null;
  publication_date: string | null;
  doi: string | null;
  review_status: string;
  passage_id: string | null;
  locator: string | null;
  original_url: string | null;
  dashboard_url: string;
  formatted: string;
}

export interface SynthesisResult {
  answer: string;
  scope: {
    source_count: number;
    approved_count: number;
    unreviewed_count: number;
    passage_count: number;
    source_origin: SourceOrigin;
    approved_only: boolean;
    mode: ResearchMode;
  };
  main_findings: Array<{ statement: string; citation_markers: string[] }>;
  contradictions: Array<{ description: string; citation_markers: string[] }>;
  limitations: string[];
  safety_notes: string[];
  evidence_quality: string;
  gaps: string[];
  citations: Citation[];
  /** Markers the model produced that were not in the retrieval context. */
  rejected_citations: string[];
}

export interface SynthesizeInput {
  question: string;
  mode?: ResearchMode;
  sourceIds?: string[];
  collectionIds?: string[];
  approvedOnly?: boolean;
  includeContradictions?: boolean;
  includeLimitations?: boolean;
  includeSafetyNotes?: boolean;
  citationStyle?: CitationStyle;
  audience?: string;
  maxSources?: number;
}

/**
 * Produces a cited answer from internal sources only.
 *
 * The model never sees the library -- it sees a fixed set of retrieved
 * passages and may cite nothing else. Markers it invents are stripped
 * from the output and reported, so a fabricated citation cannot reach the
 * reader.
 */
export async function synthesizeKnowledge(
  ctx: ActorContext,
  input: SynthesizeInput,
): Promise<SynthesisResult> {
  requirePermission(ctx, 'knowledge.read');

  const env = getEnv();
  const question = input.question?.trim();
  if (!question) throw invalidInput('A question is required.');

  const mode = input.mode ?? 'library_only';
  const approvedOnly = input.approvedOnly ?? true;
  const maxSources = Math.min(input.maxSources ?? 12, env.MAX_SYNTHESIS_SOURCES);

  // Explicit source or collection selection wins; otherwise retrieval
  // decides what the answer may be built from.
  let sourceIds = input.sourceIds ?? [];

  if (input.collectionIds?.length) {
    const fromCollections = await withOrg(ctx.organizationId, (sql) =>
      sql.query<{ source_id: string }>(
        `SELECT DISTINCT cs.source_id
         FROM collection_sources cs JOIN sources s ON s.id = cs.source_id
         WHERE cs.collection_id = ANY($1::uuid[]) AND s.status = 'active'
           AND ($2 = false OR s.review_status = ANY($3::review_status[]))`,
        [input.collectionIds, approvedOnly, APPROVED_REVIEW_STATUSES],
      ),
    );
    sourceIds = [...new Set([...sourceIds, ...fromCollections.map((r) => r.source_id)])];
  }

  if (sourceIds.length === 0) {
    const search = await searchKnowledge(ctx, {
      query: question,
      mode,
      entityTypes: ['sources'],
      filters: approvedOnly ? { reviewStatus: APPROVED_REVIEW_STATUSES } : {},
      limit: maxSources,
      includePassages: true,
      includeUnreviewed: !approvedOnly,
    });
    sourceIds = search.results.map((r) => r.id);
  }

  sourceIds = sourceIds.slice(0, maxSources);

  if (sourceIds.length === 0) {
    return emptySynthesis(question, approvedOnly, mode);
  }

  const { passages, sources } = await gatherPassages(ctx, {
    question,
    sourceIds,
    approvedOnly,
    passagesPerSource: 3,
  });

  if (passages.length === 0) {
    return emptySynthesis(question, approvedOnly, mode);
  }

  const synthesis = await synthesizeEvidence(
    { organizationId: ctx.organizationId, requestId: ctx.requestId, userId: ctx.userId },
    {
      question,
      passages,
      audience: input.audience ?? 'internal_research',
      includeContradictions: input.includeContradictions ?? true,
      includeLimitations: input.includeLimitations ?? true,
      includeSafetyNotes: input.includeSafetyNotes ?? true,
    },
  );

  const availableMarkers = passages.map((p) => p.marker);
  const { invalid } = validateCitations(
    [
      ...synthesis.used_citation_markers,
      ...synthesis.main_findings.flatMap((f) => f.citation_markers),
      ...synthesis.contradictions.flatMap((c) => c.citation_markers),
    ],
    availableMarkers,
  );

  const available = new Set(availableMarkers);
  const stripInvalid = (markers: string[]) => markers.filter((m) => available.has(m));

  // A statement whose every citation was invented loses its evidentiary
  // basis, so it is dropped rather than presented uncited.
  const mainFindings = synthesis.main_findings
    .map((f) => ({ statement: f.statement, citation_markers: stripInvalid(f.citation_markers) }))
    .filter((f) => f.citation_markers.length > 0);

  const contradictions = synthesis.contradictions
    .map((c) => ({ description: c.description, citation_markers: stripInvalid(c.citation_markers) }))
    .filter((c) => c.citation_markers.length > 0);

  const usedMarkers = new Set([
    ...mainFindings.flatMap((f) => f.citation_markers),
    ...contradictions.flatMap((c) => c.citation_markers),
    ...stripInvalid(synthesis.used_citation_markers),
  ]);

  const citations = buildCitations(
    passages.filter((p) => usedMarkers.has(p.marker)),
    sources,
    input.citationStyle ?? 'numbered',
  );

  const approvedCount = sources.filter((s) =>
    APPROVED_REVIEW_STATUSES.includes(s.review_status),
  ).length;

  const answer = stripInvalidMarkers(synthesis.answer, available);

  return {
    answer,
    scope: {
      source_count: sources.length,
      approved_count: approvedCount,
      unreviewed_count: sources.length - approvedCount,
      passage_count: passages.length,
      source_origin:
        approvedCount === sources.length
          ? 'internal_approved'
          : approvedCount === 0
            ? 'internal_unreviewed'
            : 'mixed',
      approved_only: approvedOnly,
      mode,
    },
    main_findings: mainFindings,
    contradictions,
    limitations: synthesis.limitations,
    safety_notes: synthesis.safety_notes,
    evidence_quality: synthesis.evidence_quality,
    gaps: synthesis.gaps,
    citations,
    rejected_citations: invalid,
  };
}

function emptySynthesis(
  question: string,
  approvedOnly: boolean,
  mode: ResearchMode,
): SynthesisResult {
  return {
    answer: approvedOnly
      ? 'There is no approved evidence in the library that addresses this question. No answer can be given from approved sources.'
      : 'No sources in the library address this question within the selected scope.',
    scope: {
      source_count: 0,
      approved_count: 0,
      unreviewed_count: 0,
      passage_count: 0,
      source_origin: 'internal_approved',
      approved_only: approvedOnly,
      mode,
    },
    main_findings: [],
    contradictions: [],
    limitations: ['No sources were available, so nothing could be synthesized.'],
    safety_notes: [],
    evidence_quality: 'No evidence available.',
    gaps: [
      approvedOnly
        ? 'The approved library does not cover this question. Consider searching unreviewed sources or running external research.'
        : 'The library does not cover this question. Consider running external research.',
    ],
    citations: [],
    rejected_citations: [],
  };
}

/** Removes citation markers the model invented from prose output. */
function stripInvalidMarkers(text: string, available: Set<string>): string {
  return text.replace(/\[(\d+)\]/g, (match) => (available.has(match) ? match : ''));
}

// ---------------------------------------------------------------------
// Retrieval context assembly
// ---------------------------------------------------------------------

export interface GatheredSource {
  id: string;
  title: string;
  author_text: string | null;
  publisher: string | null;
  journal: string | null;
  publication_date: string | null;
  doi: string | null;
  canonical_url: string | null;
  review_status: string;
  source_type: string;
  marker: string;
}

export async function gatherPassages(
  ctx: ActorContext,
  input: {
    question: string;
    sourceIds: string[];
    approvedOnly: boolean;
    passagesPerSource?: number;
  },
): Promise<{ passages: SynthesisPassage[]; sources: GatheredSource[] }> {
  const [queryVector] = await embed(
    { organizationId: ctx.organizationId, requestId: ctx.requestId, userId: ctx.userId },
    [input.question],
  );

  return withOrg(ctx.organizationId, async (sql) => {
    const sourceRows = await sql.query<Omit<GatheredSource, 'marker'>>(
      `SELECT id, title, author_text, publisher, journal, publication_date, doi,
              canonical_url, review_status::text, source_type::text
       FROM sources
       WHERE id = ANY($1::uuid[]) AND status = 'active'
         AND ($2 = false OR review_status = ANY($3::review_status[]))
       ORDER BY publication_date DESC NULLS LAST`,
      [input.sourceIds, input.approvedOnly, APPROVED_REVIEW_STATUSES],
    );

    // Markers are assigned in a stable order so a citation list reads the
    // way a reader expects: [1], [2], [3].
    const sources: GatheredSource[] = sourceRows.map((row, index) => ({
      ...row,
      marker: `[${index + 1}]`,
    }));
    const markerBySource = new Map(sources.map((s) => [s.id, s.marker]));

    if (sources.length === 0) return { passages: [], sources: [] };

    const chunks = await sql.query<{
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
                (coalesce(ts_rank_cd(ec.search_vector, plainto_tsquery('english', $2)), 0) * 3
                 + CASE WHEN ec.embedding IS NULL THEN 0
                        ELSE greatest(0, 1 - (ec.embedding <=> $3::vector)) END)::float AS score,
                row_number() OVER (
                  PARTITION BY ec.source_id
                  ORDER BY (coalesce(ts_rank_cd(ec.search_vector, plainto_tsquery('english', $2)), 0) * 3
                            + CASE WHEN ec.embedding IS NULL THEN 0
                                   ELSE greatest(0, 1 - (ec.embedding <=> $3::vector)) END) DESC
                ) AS rank
         FROM embedding_chunks ec
         WHERE ec.source_id = ANY($1::uuid[])
       ) ranked
       WHERE rank <= $4
       ORDER BY source_id, rank`,
      [
        sources.map((s) => s.id),
        input.question,
        toVectorLiteral(queryVector),
        input.passagesPerSource ?? 3,
      ],
    );

    const passages: SynthesisPassage[] = chunks.map((chunk) => {
      const source = sources.find((s) => s.id === chunk.source_id)!;
      return {
        marker: markerBySource.get(chunk.source_id)!,
        source_id: chunk.source_id,
        title: source.title,
        text: chunk.chunk_text,
        review_status: source.review_status,
        source_type: source.source_type,
        publication_date: source.publication_date,
        locator: chunkLocator({
          pageNumber: chunk.page_number,
          headingPath: chunk.heading_path,
          chunkIndex: chunk.chunk_index,
          startOffset: chunk.start_offset,
        }),
      };
    });

    return { passages, sources: sources.filter((s) => passages.some((p) => p.source_id === s.id)) };
  });
}

// ---------------------------------------------------------------------
// Citation formatting
// ---------------------------------------------------------------------

function buildCitations(
  passages: SynthesisPassage[],
  sources: GatheredSource[],
  style: CitationStyle,
): Citation[] {
  const byMarker = new Map<string, SynthesisPassage>();
  for (const passage of passages) {
    if (!byMarker.has(passage.marker)) byMarker.set(passage.marker, passage);
  }

  return [...byMarker.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([marker, passage]) => {
      const source = sources.find((s) => s.id === passage.source_id)!;
      return {
        marker,
        source_id: source.id,
        title: source.title,
        authors: source.author_text,
        publisher: source.publisher,
        journal: source.journal,
        publication_date: source.publication_date,
        doi: source.doi,
        review_status: source.review_status,
        passage_id: null,
        locator: passage.locator ?? null,
        original_url: source.canonical_url,
        dashboard_url: `/library/${source.id}`,
        formatted: formatCitation(source, style, marker),
      };
    });
}

export function formatCitation(
  source: GatheredSource,
  style: CitationStyle,
  marker: string,
): string {
  const year = source.publication_date?.slice(0, 4) ?? 'n.d.';
  const authors = source.author_text ?? 'No author listed';
  const outlet = source.journal ?? source.publisher ?? 'No publisher listed';
  const url = source.canonical_url ?? '';
  const doi = source.doi ? `https://doi.org/${source.doi}` : '';

  switch (style) {
    case 'apa':
      return `${authors} (${year}). ${source.title}. ${outlet}.${doi ? ` ${doi}` : url ? ` ${url}` : ''}`;

    case 'vancouver':
      return `${marker.replace(/[[\]]/g, '')}. ${authors}. ${source.title}. ${outlet}. ${year}.${doi ? ` doi:${source.doi}` : ''}`;

    case 'harvard':
      return `${authors} ${year}, '${source.title}', ${outlet}.${url ? ` Available at: ${url}` : ''}`;

    case 'url_list':
      return url || doi || '(no URL recorded)';

    case 'doi_list':
      return source.doi ?? '(no DOI recorded)';

    case 'bibtex': {
      // Only fields that are actually present are emitted; a BibTeX entry
      // with invented values is worse than an incomplete one.
      const key = `${(source.author_text ?? 'anon').split(/[,\s]+/)[0].toLowerCase()}${year}`;
      const fields = [
        `  title = {${source.title}}`,
        source.author_text ? `  author = {${source.author_text}}` : null,
        source.journal ? `  journal = {${source.journal}}` : null,
        source.publisher ? `  publisher = {${source.publisher}}` : null,
        source.publication_date ? `  year = {${year}}` : null,
        source.doi ? `  doi = {${source.doi}}` : null,
        url ? `  url = {${url}}` : null,
      ].filter(Boolean);
      return `@${source.journal ? 'article' : 'misc'}{${key},\n${fields.join(',\n')}\n}`;
    }

    case 'ris': {
      const lines = [
        `TY  - ${source.journal ? 'JOUR' : 'ELEC'}`,
        `TI  - ${source.title}`,
        ...(source.author_text ?? '').split(',').filter(Boolean).map((a) => `AU  - ${a.trim()}`),
        source.journal ? `JO  - ${source.journal}` : null,
        source.publisher ? `PB  - ${source.publisher}` : null,
        source.publication_date ? `PY  - ${year}` : null,
        source.doi ? `DO  - ${source.doi}` : null,
        url ? `UR  - ${url}` : null,
        'ER  - ',
      ].filter(Boolean);
      return lines.join('\n');
    }

    case 'internal':
      return `${source.title} — ${outlet}${source.publication_date ? `, ${year}` : ''} (${source.review_status}) /library/${source.id}`;

    case 'numbered':
    default:
      return `${marker} ${source.title}. ${outlet}${source.publication_date ? `, ${year}` : ''}. Review status: ${source.review_status}.${url ? ` ${url}` : ''}`;
  }
}

// ---------------------------------------------------------------------
// Evidence lookup, comparison and gap analysis
// ---------------------------------------------------------------------

export async function findEvidence(
  ctx: ActorContext,
  input: {
    claimOrQuestion: string;
    relationship?: 'supporting' | 'contradicting' | 'qualifying' | 'all';
    approvedOnly?: boolean;
    collectionIds?: string[];
    limit?: number;
  },
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'knowledge.read');

  const relationship = input.relationship ?? 'all';
  const approvedOnly = input.approvedOnly ?? true;
  const limit = Math.min(input.limit ?? 20, 50);

  // Existing curated claim evidence is the strongest answer available,
  // so it is returned ahead of anything derived from raw retrieval.
  const claimEvidence = await withOrg(ctx.organizationId, async (sql) => {
    const relationshipFilter =
      relationship === 'all'
        ? `('supports','contradicts','qualifies','contextualizes')`
        : relationship === 'supporting'
          ? `('supports')`
          : relationship === 'contradicting'
            ? `('contradicts')`
            : `('qualifies')`;

    return sql.query(
      `SELECT ce.id, ce.relationship::text, ce.evidence_excerpt, ce.locator,
              ce.evidence_strength, c.id AS claim_id, c.canonical_text,
              c.evidence_status::text, s.id AS source_id, s.title, s.source_type::text,
              s.publication_date, s.review_status::text
       FROM claims c
       JOIN claim_evidence ce ON ce.claim_id = c.id
       JOIN sources s ON s.id = ce.source_id
       WHERE c.status = 'active' AND s.status = 'active'
         AND ce.relationship IN ${relationshipFilter}
         AND ($3 = false OR s.review_status = ANY($4::review_status[]))
         AND (c.search_vector @@ plainto_tsquery('english', $1)
              OR lower(c.canonical_text) % lower($1))
       ORDER BY ts_rank_cd(c.search_vector, plainto_tsquery('english', $1)) DESC
       LIMIT $2`,
      [input.claimOrQuestion, limit, approvedOnly, APPROVED_REVIEW_STATUSES],
    );
  });

  // Passage-level retrieval fills in where no claim has been curated yet.
  const search = await searchKnowledge(ctx, {
    query: input.claimOrQuestion,
    entityTypes: ['sources'],
    filters: {
      ...(approvedOnly ? { reviewStatus: APPROVED_REVIEW_STATUSES } : {}),
      ...(input.collectionIds?.length ? { collectionIds: input.collectionIds } : {}),
    },
    limit,
    includePassages: true,
    includeUnreviewed: !approvedOnly,
  });

  return {
    question: input.claimOrQuestion,
    relationship,
    approved_only: approvedOnly,
    curated_claim_evidence: claimEvidence,
    passage_evidence: search.results.map((r) => ({
      source_id: r.id,
      title: r.title,
      source_type: r.source_type,
      publication_date: r.publication_date,
      review_status: r.review_status,
      origin: r.origin,
      passages: r.matched_passages,
      dashboard_url: r.dashboard_url,
    })),
    scope: search.scope,
    note:
      claimEvidence.length === 0
        ? 'No curated claim evidence exists for this question yet. The passages below are retrieval results, not reviewed evidence relationships.'
        : 'Curated claim evidence has been reviewed and attached to a claim. Passage evidence has not.',
  };
}

export async function compareSources(
  ctx: ActorContext,
  input: { sourceIds: string[]; dimensions?: string[] },
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'knowledge.read');

  if (input.sourceIds.length < 2) {
    throw invalidInput('At least two sources are required for a comparison.', {
      supplied: input.sourceIds.length,
    });
  }
  if (input.sourceIds.length > 8) {
    throw invalidInput('A comparison is limited to eight sources.', {
      supplied: input.sourceIds.length,
    });
  }

  const dimensions = input.dimensions?.length
    ? input.dimensions
    : [
        'study_design',
        'population',
        'intervention',
        'comparator',
        'duration',
        'outcomes',
        'findings',
        'limitations',
        'funding',
        'conflicts_of_interest',
      ];

  return withOrg(ctx.organizationId, async (sql) => {
    const rows = await sql.query<Record<string, unknown>>(
      `SELECT s.id, s.title, s.source_type::text, s.publisher, s.journal,
              s.publication_date, s.review_status::text, s.key_findings,
              s.limitations, s.safety_notes, s.funding_information,
              s.conflicts_of_interest, s.ai_summary_short,
              sm.study_design, sm.sample_size, sm.population_description,
              sm.intervention, sm.comparator, sm.duration, sm.follow_up_duration,
              sm.primary_outcomes, sm.secondary_outcomes, sm.effect_sizes,
              sm.p_values, sm.risk_of_bias, sm.funding_source,
              sm.conflicts_of_interest AS study_conflicts, sm.limitations AS study_limitations,
              sm.human_verified
       FROM sources s
       LEFT JOIN study_metadata sm ON sm.source_id = s.id
       WHERE s.id = ANY($1::uuid[]) AND s.status = 'active'`,
      [input.sourceIds],
    );

    const missing = input.sourceIds.filter((id) => !rows.some((r) => r.id === id));
    if (missing.length > 0) throw notFound('source', missing[0]);

    const valueFor = (row: Record<string, unknown>, dimension: string): unknown => {
      switch (dimension) {
        case 'study_design':
          return row.study_design ?? row.source_type;
        case 'population':
          return row.population_description ?? null;
        case 'sample_size':
          return row.sample_size ?? null;
        case 'intervention':
          return row.intervention ?? null;
        case 'comparator':
          return row.comparator ?? null;
        case 'duration':
          return row.duration ?? row.follow_up_duration ?? null;
        case 'outcomes':
          return row.primary_outcomes ?? null;
        case 'findings':
          return row.key_findings ?? null;
        case 'limitations':
          return row.study_limitations ?? row.limitations ?? null;
        case 'funding':
          return row.funding_source ?? row.funding_information ?? null;
        case 'conflicts_of_interest':
          return row.study_conflicts ?? row.conflicts_of_interest ?? null;
        default:
          return row[dimension] ?? null;
      }
    };

    const comparison = dimensions.map((dimension) => ({
      dimension,
      values: rows.map((row) => ({
        source_id: row.id,
        title: row.title,
        value: valueFor(row, dimension),
      })),
      // Naming which sources simply have no data for a dimension is more
      // useful than presenting a table full of silent blanks.
      missing_for: rows.filter((row) => valueFor(row, dimension) == null).map((row) => row.id),
    }));

    return {
      sources: rows.map((row) => ({
        id: row.id,
        title: row.title,
        source_type: row.source_type,
        publisher: row.publisher ?? row.journal,
        publication_date: row.publication_date,
        review_status: row.review_status,
        study_metadata_verified: row.human_verified ?? false,
        dashboard_url: `/library/${row.id}`,
      })),
      comparison,
      note: rows.some((r) => !r.human_verified)
        ? 'Some study metadata in this comparison was extracted automatically and has not been verified by a human. Check the source records before relying on it.'
        : 'All study metadata in this comparison has been human-verified.',
    };
  });
}

export async function findKnowledgeGaps(
  ctx: ActorContext,
  input: {
    topic: string;
    collectionIds?: string[];
    approvedOnly?: boolean;
    dimensions?: string[];
  },
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'knowledge.read');

  const approvedOnly = input.approvedOnly ?? true;
  const dimensions = input.dimensions?.length
    ? input.dimensions
    : ['population', 'intervention', 'outcomes', 'geography', 'study_design', 'recency'];

  const search = await searchKnowledge(ctx, {
    query: input.topic,
    entityTypes: ['sources'],
    filters: {
      ...(approvedOnly ? { reviewStatus: APPROVED_REVIEW_STATUSES } : {}),
      ...(input.collectionIds?.length ? { collectionIds: input.collectionIds } : {}),
    },
    limit: 50,
    includePassages: false,
    includeUnreviewed: !approvedOnly,
  });

  const sourceIds = search.results.map((r) => r.id);
  if (sourceIds.length === 0) {
    return {
      topic: input.topic,
      source_count: 0,
      gaps: [
        {
          dimension: 'coverage',
          finding: `The library contains no ${approvedOnly ? 'approved ' : ''}sources on "${input.topic}". This is a complete gap.`,
          severity: 'high',
        },
      ],
      coverage: {},
    };
  }

  return withOrg(ctx.organizationId, async (sql) => {
    const coverage = await sql.one<Record<string, unknown>>(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE s.source_type IN ('meta_analysis','systematic_review'))::int AS syntheses,
         count(*) FILTER (WHERE s.source_type = 'randomized_controlled_trial')::int AS trials,
         count(*) FILTER (WHERE s.source_type IN ('cohort_study','case_control_study','cross_sectional_study'))::int AS observational,
         count(*) FILTER (WHERE s.publication_date > now() - interval '3 years')::int AS recent,
         count(*) FILTER (WHERE s.publication_date < now() - interval '10 years')::int AS old,
         count(*) FILTER (WHERE sm.source_id IS NOT NULL)::int AS with_study_metadata,
         count(*) FILTER (WHERE sm.sample_size >= 200)::int AS larger_samples,
         count(*) FILTER (WHERE s.country = 'IN' OR sm.geography ILIKE '%india%')::int AS india_specific,
         count(DISTINCT sm.population_description)::int AS distinct_populations
       FROM sources s
       LEFT JOIN study_metadata sm ON sm.source_id = s.id
       WHERE s.id = ANY($1::uuid[])`,
      [sourceIds],
    );

    const c = coverage as unknown as Record<string, number>;
    const gaps: Array<{ dimension: string; finding: string; severity: string }> = [];

    if (dimensions.includes('study_design')) {
      if (c.syntheses === 0) {
        gaps.push({
          dimension: 'study_design',
          finding:
            'No systematic reviews or meta-analyses are held on this topic. The library relies on individual studies, which is weaker ground for an organizational position.',
          severity: 'high',
        });
      }
      if (c.trials === 0 && c.observational > 0) {
        gaps.push({
          dimension: 'study_design',
          finding:
            'All held evidence is observational. Causal claims are not supportable from this evidence base.',
          severity: 'high',
        });
      }
    }

    if (dimensions.includes('recency') && c.recent === 0 && c.total > 0) {
      gaps.push({
        dimension: 'recency',
        finding: `No source on this topic is from the last three years${c.old > 0 ? `, and ${c.old} are more than ten years old` : ''}. Check whether guidance has since changed.`,
        severity: 'medium',
      });
    }

    if (dimensions.includes('geography') && c.india_specific === 0) {
      gaps.push({
        dimension: 'geography',
        finding:
          'No source in this set studies an Indian population. Applicability to Nirog Bhoomi\'s primary audience is unestablished.',
        severity: 'high',
      });
    }

    if (dimensions.includes('population') && c.distinct_populations <= 1 && c.total > 2) {
      gaps.push({
        dimension: 'population',
        finding:
          'The held evidence covers only one described population. Findings may not generalize beyond it.',
        severity: 'medium',
      });
    }

    if (c.with_study_metadata < c.total / 2) {
      gaps.push({
        dimension: 'metadata',
        finding: `Only ${c.with_study_metadata} of ${c.total} sources have extracted study metadata, so design and sample size cannot be compared across the set.`,
        severity: 'medium',
      });
    }

    if (dimensions.includes('outcomes') && c.larger_samples === 0 && c.total > 0) {
      gaps.push({
        dimension: 'outcomes',
        finding:
          'No source reports a sample of 200 or more participants. Effect estimates from this evidence base will be imprecise.',
        severity: 'medium',
      });
    }

    return {
      topic: input.topic,
      source_count: c.total,
      approved_only: approvedOnly,
      coverage: c,
      gaps,
      note:
        gaps.length === 0
          ? 'No structural gaps were detected across the assessed dimensions.'
          : 'These gaps are derived from the metadata held on the matched sources. A gap may reflect missing metadata rather than missing research.',
    };
  });
}

/** Truncates a passage for display without cutting mid-word. */
export function excerptFor(text: string, maxLength = 500): string {
  return truncate(text, maxLength);
}
