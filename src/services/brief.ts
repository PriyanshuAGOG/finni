import { withOrg } from '../lib/db';
import type { ActorContext } from '../lib/context';
import { requirePermission } from '../lib/context';
import { conflict, invalidInput, notFound } from '../lib/errors';
import { truncate } from '../lib/text';
import { generateBriefSections, validateCitations } from '../ai/pipeline';
import { recordAudit } from './audit';
import { APPROVED_REVIEW_STATUSES } from './source';
import { gatherPassages, formatCitation, type CitationStyle } from './synthesis';

export const BRIEF_TYPES = [
  'topic_overview',
  'evidence_review',
  'literature_review',
  'executive_summary',
  'patient_education',
  'clinical_reviewer',
  'content_research',
  'contradiction_analysis',
  'competitor_research',
  'knowledge_gap_analysis',
] as const;

export const BRIEF_SECTIONS = [
  'executive_summary',
  'methodology',
  'findings',
  'contradictions',
  'limitations',
  'recommendations',
  'safety_notes',
] as const;

export interface Brief {
  id: string;
  title: string;
  brief_type: string;
  research_question: string | null;
  scope: string | null;
  audience: string;
  status: string;
  content: Record<string, unknown>;
  executive_summary: string | null;
  methodology: string | null;
  findings: string | null;
  conflicting_evidence: string | null;
  limitations: string | null;
  recommendations: string | null;
  safety_notes: string | null;
  citation_style: string;
  approved_only: boolean;
  version: number;
  created_at: string;
  updated_at: string;
  dashboard_url?: string;
}

const BRIEF_FIELDS = [
  'id', 'title', 'brief_type', 'research_question', 'scope', 'audience', 'status',
  'content', 'executive_summary', 'methodology', 'findings', 'conflicting_evidence',
  'limitations', 'recommendations', 'safety_notes', 'citation_style',
  'approved_only', 'version', 'created_at', 'updated_at',
];
const BRIEF_COLUMNS = BRIEF_FIELDS.join(', ');

function withUrl(brief: Brief): Brief {
  return { ...brief, dashboard_url: `/briefs/${brief.id}` };
}

export async function listBriefs(
  ctx: ActorContext,
  options: { status?: string; briefType?: string; limit?: number } = {},
): Promise<Brief[]> {
  requirePermission(ctx, 'brief.read');

  return withOrg(ctx.organizationId, async (sql) => {
    const params: unknown[] = [];
    const add = (v: unknown) => `$${params.push(v)}`;
    const where = ['archived_at IS NULL'];
    if (options.status) where.push(`status = ${add(options.status)}`);
    if (options.briefType) where.push(`brief_type = ${add(options.briefType)}`);

    const rows = await sql.query<Brief>(
      `SELECT ${BRIEF_COLUMNS} FROM research_briefs
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ${add(Math.min(options.limit ?? 25, 100))}`,
      params,
    );
    return rows.map(withUrl);
  });
}

export async function getBrief(
  ctx: ActorContext,
  briefId: string,
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'brief.read');

  return withOrg(ctx.organizationId, async (sql) => {
    const brief = await sql.one<Brief>(
      `SELECT ${BRIEF_COLUMNS} FROM research_briefs WHERE id = $1`,
      [briefId],
    );
    if (!brief) throw notFound('brief', briefId);

    const sources = await sql.query(
      `SELECT bs.citation_order, bs.usage_type, bs.included_claim_ids,
              s.id, s.title, s.source_type::text, s.publisher, s.journal,
              s.publication_date, s.review_status::text, s.canonical_url, s.doi,
              s.author_text
       FROM brief_sources bs JOIN sources s ON s.id = bs.source_id
       WHERE bs.brief_id = $1
       ORDER BY bs.citation_order`,
      [briefId],
    );

    const versions = await sql.query(
      `SELECT id, version_number, change_summary, created_at
       FROM brief_versions WHERE brief_id = $1 ORDER BY version_number DESC`,
      [briefId],
    );

    return {
      ...withUrl(brief),
      sources: sources.map((s) => ({ ...s, dashboard_url: `/library/${s.id}` })),
      source_count: sources.length,
      unreviewed_source_count: sources.filter(
        (s) => !APPROVED_REVIEW_STATUSES.includes(String(s.review_status)),
      ).length,
      versions,
    };
  });
}

export async function createBrief(
  ctx: ActorContext,
  input: {
    title: string;
    briefType?: string;
    researchQuestion?: string | null;
    scope?: string | null;
    audience?: string;
    sourceIds?: string[];
    collectionIds?: string[];
    approvedOnly?: boolean;
    includeContradictions?: boolean;
    includeLimitations?: boolean;
    citationStyle?: CitationStyle;
  },
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'brief.create');

  const title = input.title?.trim();
  if (!title) throw invalidInput('A brief title is required.');

  const approvedOnly = input.approvedOnly ?? true;

  return withOrg(ctx.organizationId, async (sql) => {
    const row = await sql.one<Brief>(
      `INSERT INTO research_briefs (
         organization_id, title, brief_type, research_question, scope, audience,
         citation_style, approved_only, source_selection_rules, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
       RETURNING ${BRIEF_COLUMNS}`,
      [
        ctx.organizationId,
        title,
        input.briefType ?? 'evidence_review',
        input.researchQuestion ?? null,
        input.scope ?? null,
        input.audience ?? 'internal_research',
        input.citationStyle ?? 'numbered',
        approvedOnly,
        JSON.stringify({
          approved_only: approvedOnly,
          collection_ids: input.collectionIds ?? [],
          include_contradictions: input.includeContradictions ?? true,
          include_limitations: input.includeLimitations ?? true,
        }),
        ctx.userId,
      ],
    );

    const briefId = row!.id;

    // Sources are resolved once, at creation, so the brief has a stable
    // evidence base that later library changes do not silently alter.
    const sourceIds = new Set(input.sourceIds ?? []);
    if (input.collectionIds?.length) {
      const fromCollections = await sql.query<{ source_id: string }>(
        `SELECT DISTINCT cs.source_id
         FROM collection_sources cs JOIN sources s ON s.id = cs.source_id
         WHERE cs.collection_id = ANY($1::uuid[]) AND s.status = 'active'`,
        [input.collectionIds],
      );
      for (const record of fromCollections) sourceIds.add(record.source_id);
    }

    const eligible = await sql.query<{ id: string }>(
      `SELECT id FROM sources
       WHERE id = ANY($1::uuid[]) AND status = 'active'
         AND ($2 = false OR review_status = ANY($3::review_status[]))
       ORDER BY publication_date DESC NULLS LAST`,
      [[...sourceIds], approvedOnly, APPROVED_REVIEW_STATUSES],
    );

    const excludedCount = sourceIds.size - eligible.length;

    for (const [index, source] of eligible.entries()) {
      await sql.query(
        `INSERT INTO brief_sources (brief_id, source_id, citation_order, usage_type)
         VALUES ($1,$2,$3,'primary') ON CONFLICT DO NOTHING`,
        [briefId, source.id, index + 1],
      );
    }

    await recordAudit(sql, ctx, {
      action: 'brief.created',
      resourceType: 'research_brief',
      resourceId: briefId,
      newState: {
        title,
        brief_type: input.briefType ?? 'evidence_review',
        source_count: eligible.length,
        approved_only: approvedOnly,
      },
    });

    return {
      ...withUrl(row!),
      source_count: eligible.length,
      excluded_source_count: excludedCount,
      note:
        excludedCount > 0
          ? `${excludedCount} requested source(s) were excluded because the brief is set to approved sources only.`
          : undefined,
    };
  });
}

export async function generateBrief(
  ctx: ActorContext,
  briefId: string,
  input: { sections?: string[] } = {},
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'brief.update');

  const sections = (input.sections?.length ? input.sections : [...BRIEF_SECTIONS]).filter((s) =>
    (BRIEF_SECTIONS as readonly string[]).includes(s),
  );
  if (sections.length === 0) {
    throw invalidInput('No valid brief sections were requested.', {
      valid_sections: BRIEF_SECTIONS,
    });
  }

  const { brief, sourceIds } = await withOrg(ctx.organizationId, async (sql) => {
    const brief = await sql.one<Brief>(
      `SELECT ${BRIEF_COLUMNS} FROM research_briefs WHERE id = $1`,
      [briefId],
    );
    if (!brief) throw notFound('brief', briefId);
    if (brief.status === 'approved') {
      throw conflict(
        'This brief is approved. Regenerating it would replace approved text; create a new version instead.',
        { status: brief.status },
      );
    }

    const rows = await sql.query<{ source_id: string }>(
      `SELECT source_id FROM brief_sources WHERE brief_id = $1 ORDER BY citation_order`,
      [briefId],
    );
    return { brief, sourceIds: rows.map((r) => r.source_id) };
  });

  if (sourceIds.length === 0) {
    throw conflict('This brief has no sources attached. Add sources before generating it.', {
      brief_id: briefId,
    });
  }

  const { passages, sources } = await gatherPassages(ctx, {
    question: brief.research_question ?? brief.title,
    sourceIds,
    approvedOnly: brief.approved_only,
    passagesPerSource: 4,
  });

  if (passages.length === 0) {
    throw conflict(
      'None of the attached sources have retrievable passages yet. Wait for processing to finish, or reprocess them.',
      { brief_id: briefId, source_count: sourceIds.length },
    );
  }

  const generated = await generateBriefSections(
    { organizationId: ctx.organizationId, requestId: ctx.requestId, userId: ctx.userId },
    {
      researchQuestion: brief.research_question ?? brief.title,
      briefType: brief.brief_type,
      audience: brief.audience,
      sections,
      passages,
    },
  );

  const availableMarkers = passages.map((p) => p.marker);
  const { invalid } = validateCitations(generated.citation_markers, availableMarkers);

  // Any marker the model produced that was not supplied is removed from
  // the stored text, so a fabricated citation never lands in a brief.
  const available = new Set(availableMarkers);
  const clean = (text: string) =>
    text.replace(/\[(\d+)\]/g, (match) => (available.has(match) ? match : ''));

  return withOrg(ctx.organizationId, async (sql) => {
    const previous = await sql.one<Brief>(
      `SELECT ${BRIEF_COLUMNS} FROM research_briefs WHERE id = $1 FOR UPDATE`,
      [briefId],
    );

    const versionRow = await sql.one<{ max: number | null }>(
      `SELECT max(version_number) AS max FROM brief_versions WHERE brief_id = $1`,
      [briefId],
    );
    await sql.query(
      `INSERT INTO brief_versions (brief_id, version_number, snapshot, change_summary, created_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        briefId,
        (versionRow?.max ?? 0) + 1,
        JSON.stringify(previous),
        `Regenerated sections: ${sections.join(', ')}`,
        ctx.userId,
      ],
    );

    const s = generated.sections;
    await sql.query(
      `UPDATE research_briefs
       SET executive_summary = coalesce($1, executive_summary),
           methodology = coalesce($2, methodology),
           findings = coalesce($3, findings),
           conflicting_evidence = coalesce($4, conflicting_evidence),
           limitations = coalesce($5, limitations),
           recommendations = coalesce($6, recommendations),
           safety_notes = coalesce($7, safety_notes),
           content = $8::jsonb,
           generated_by = $9,
           status = CASE WHEN status = 'draft' THEN 'draft' ELSE status END,
           updated_by = $10, updated_at = now(), version = version + 1
       WHERE id = $11`,
      [
        s.executive_summary ? clean(s.executive_summary) : null,
        s.methodology ? clean(s.methodology) : null,
        s.findings ? clean(s.findings) : null,
        s.contradictions ? clean(s.contradictions) : null,
        s.limitations ? clean(s.limitations) : null,
        s.recommendations ? clean(s.recommendations) : null,
        s.safety_notes ? clean(s.safety_notes) : null,
        JSON.stringify({
          sections: Object.fromEntries(
            Object.entries(s).map(([key, value]) => [key, clean(value)]),
          ),
          citation_markers: availableMarkers,
          generated_at: new Date().toISOString(),
        }),
        `ai:${ctx.requestId}`,
        ctx.userId,
        briefId,
      ],
    );

    await recordAudit(sql, ctx, {
      action: 'brief.generated',
      resourceType: 'research_brief',
      resourceId: briefId,
      newState: {
        sections_generated: sections,
        passage_count: passages.length,
        source_count: sources.length,
        rejected_citations: invalid,
      },
    });

    const citations = sources.map((source) => ({
      marker: source.marker,
      source_id: source.id,
      title: source.title,
      review_status: source.review_status,
      formatted: formatCitation(source, (brief.citation_style as CitationStyle) ?? 'numbered', source.marker),
      dashboard_url: `/library/${source.id}`,
    }));

    return {
      brief_id: briefId,
      sections_generated: sections,
      citations,
      scope: {
        source_count: sources.length,
        passage_count: passages.length,
        approved_only: brief.approved_only,
        unreviewed_count: sources.filter(
          (s2) => !APPROVED_REVIEW_STATUSES.includes(s2.review_status),
        ).length,
      },
      rejected_citations: invalid,
      dashboard_url: `/briefs/${briefId}`,
      note: 'The brief is a draft. It has not been reviewed or approved.',
    };
  });
}

export async function updateBrief(
  ctx: ActorContext,
  briefId: string,
  updates: Record<string, unknown>,
): Promise<Brief> {
  requirePermission(ctx, 'brief.update');

  const EDITABLE = new Set([
    'title', 'research_question', 'scope', 'audience', 'executive_summary',
    'methodology', 'findings', 'conflicting_evidence', 'limitations',
    'recommendations', 'safety_notes', 'citation_style', 'brief_type',
  ]);
  const rejected = Object.keys(updates).filter((f) => !EDITABLE.has(f));
  if (rejected.length > 0) {
    throw invalidInput(`These fields cannot be updated here: ${rejected.join(', ')}.`, {
      rejected_fields: rejected,
    });
  }

  return withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<Brief>(
      `SELECT ${BRIEF_COLUMNS} FROM research_briefs WHERE id = $1 FOR UPDATE`,
      [briefId],
    );
    if (!existing) throw notFound('brief', briefId);
    if (existing.status === 'approved' && !ctx.permissions.has('brief.approve')) {
      throw conflict('This brief is approved. Editing it requires the brief.approve permission.', {
        status: existing.status,
      });
    }

    const params: unknown[] = [];
    const add = (v: unknown) => `$${params.push(v)}`;
    const sets: string[] = [];
    const previous: Record<string, unknown> = {};

    for (const [field, value] of Object.entries(updates)) {
      if (value === undefined) continue;
      previous[field] = (existing as unknown as Record<string, unknown>)[field];
      sets.push(`${field} = ${add(value)}`);
    }
    if (sets.length === 0) return withUrl(existing);

    sets.push(`updated_by = ${add(ctx.userId)}`, 'updated_at = now()', 'version = version + 1');

    const row = await sql.one<Brief>(
      `UPDATE research_briefs SET ${sets.join(', ')} WHERE id = ${add(briefId)}
       RETURNING ${BRIEF_COLUMNS}`,
      params,
    );

    await recordAudit(sql, ctx, {
      action: 'brief.updated',
      resourceType: 'research_brief',
      resourceId: briefId,
      previousState: previous,
      newState: updates,
    });

    return withUrl(row!);
  });
}

export async function updateBriefSources(
  ctx: ActorContext,
  briefId: string,
  input: { addSourceIds?: string[]; removeSourceIds?: string[] },
): Promise<{ source_count: number; added: number; removed: number }> {
  requirePermission(ctx, 'brief.update');

  return withOrg(ctx.organizationId, async (sql) => {
    const brief = await sql.one<{ id: string; approved_only: boolean }>(
      `SELECT id, approved_only FROM research_briefs WHERE id = $1`,
      [briefId],
    );
    if (!brief) throw notFound('brief', briefId);

    let added = 0;
    if (input.addSourceIds?.length) {
      const eligible = await sql.query<{ id: string }>(
        `SELECT id FROM sources
         WHERE id = ANY($1::uuid[]) AND status = 'active'
           AND ($2 = false OR review_status = ANY($3::review_status[]))`,
        [input.addSourceIds, brief.approved_only, APPROVED_REVIEW_STATUSES],
      );
      const orderRow = await sql.one<{ max: number | null }>(
        `SELECT max(citation_order) AS max FROM brief_sources WHERE brief_id = $1`,
        [briefId],
      );
      let order = (orderRow?.max ?? 0) + 1;
      for (const source of eligible) {
        const result = await sql.query(
          `INSERT INTO brief_sources (brief_id, source_id, citation_order, usage_type)
           VALUES ($1,$2,$3,'primary') ON CONFLICT DO NOTHING RETURNING source_id`,
          [briefId, source.id, order++],
        );
        added += result.length;
      }
    }

    let removed = 0;
    if (input.removeSourceIds?.length) {
      const result = await sql.query(
        `DELETE FROM brief_sources WHERE brief_id = $1 AND source_id = ANY($2::uuid[])
         RETURNING source_id`,
        [briefId, input.removeSourceIds],
      );
      removed = result.length;
    }

    const count = await sql.one<{ count: number }>(
      `SELECT count(*)::int FROM brief_sources WHERE brief_id = $1`,
      [briefId],
    );

    await recordAudit(sql, ctx, {
      action: 'brief.sources_updated',
      resourceType: 'research_brief',
      resourceId: briefId,
      newState: { added, removed },
    });

    return { source_count: count?.count ?? 0, added, removed };
  });
}

export async function submitBriefForReview(
  ctx: ActorContext,
  briefId: string,
  reviewerId?: string | null,
): Promise<Brief> {
  requirePermission(ctx, 'brief.update');

  return withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<Brief>(
      `SELECT ${BRIEF_COLUMNS} FROM research_briefs WHERE id = $1 FOR UPDATE`,
      [briefId],
    );
    if (!existing) throw notFound('brief', briefId);
    if (existing.status !== 'draft') {
      throw conflict(`This brief is ${existing.status}, not a draft.`, { status: existing.status });
    }
    if (!existing.executive_summary && !existing.findings) {
      throw conflict('This brief has no content yet. Generate or write it before submitting.', {
        brief_id: briefId,
      });
    }

    const row = await sql.one<Brief>(
      `UPDATE research_briefs
       SET status = 'in_review', reviewed_by = $1, updated_by = $2, updated_at = now()
       WHERE id = $3 RETURNING ${BRIEF_COLUMNS}`,
      [reviewerId ?? null, ctx.userId, briefId],
    );

    await recordAudit(sql, ctx, {
      action: 'brief.submitted_for_review',
      resourceType: 'research_brief',
      resourceId: briefId,
      previousState: { status: 'draft' },
      newState: { status: 'in_review', reviewer_id: reviewerId ?? null },
    });

    return withUrl(row!);
  });
}

export async function approveBrief(
  ctx: ActorContext,
  briefId: string,
  note?: string,
): Promise<Brief> {
  requirePermission(ctx, 'brief.approve');

  return withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<Brief>(
      `SELECT ${BRIEF_COLUMNS} FROM research_briefs WHERE id = $1 FOR UPDATE`,
      [briefId],
    );
    if (!existing) throw notFound('brief', briefId);
    if (existing.status === 'approved') throw conflict('This brief is already approved.');

    const row = await sql.one<Brief>(
      `UPDATE research_briefs
       SET status = 'approved', approved_by = $1, approved_at = now(),
           updated_by = $1, updated_at = now(), version = version + 1
       WHERE id = $2 RETURNING ${BRIEF_COLUMNS}`,
      [ctx.userId, briefId],
    );

    await recordAudit(sql, ctx, {
      action: 'brief.approved',
      resourceType: 'research_brief',
      resourceId: briefId,
      previousState: { status: existing.status },
      newState: { status: 'approved', note: note ?? null },
    });

    return withUrl(row!);
  });
}

/** Renders a brief as Markdown for export. */
export async function exportBrief(
  ctx: ActorContext,
  briefId: string,
): Promise<{ filename: string; content: string; format: 'markdown' }> {
  const brief = (await getBrief(ctx, briefId)) as Record<string, unknown>;
  const sources = (brief.sources ?? []) as Array<Record<string, unknown>>;

  const section = (heading: string, body: unknown) =>
    body ? `## ${heading}\n\n${String(body)}\n` : '';

  const content = [
    `# ${brief.title}`,
    '',
    `**Type:** ${brief.brief_type} | **Audience:** ${brief.audience} | **Status:** ${brief.status}`,
    brief.research_question ? `\n**Research question:** ${brief.research_question}` : '',
    brief.approved_only
      ? '\n> Built from approved sources only.'
      : `\n> Includes ${brief.unreviewed_source_count} unreviewed source(s). Not all evidence in this brief has been approved.`,
    '',
    section('Executive summary', brief.executive_summary),
    section('Methodology', brief.methodology),
    section('Findings', brief.findings),
    section('Conflicting evidence', brief.conflicting_evidence),
    section('Limitations', brief.limitations),
    section('Recommendations', brief.recommendations),
    section('Safety notes', brief.safety_notes),
    '## Sources',
    '',
    ...sources.map(
      (source, index) =>
        `${index + 1}. ${source.title} — ${source.publisher ?? source.journal ?? 'no publisher recorded'}${
          source.publication_date ? `, ${String(source.publication_date).slice(0, 4)}` : ''
        }. Review status: ${source.review_status}.${source.canonical_url ? ` ${source.canonical_url}` : ''}`,
    ),
  ]
    .filter((line) => line !== '')
    .join('\n');

  return {
    filename: `${String(brief.title).replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60)}.md`,
    content,
    format: 'markdown',
  };
}
