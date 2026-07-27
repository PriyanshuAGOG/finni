import { withOrg } from '../lib/db';
import type { ActorContext } from '../lib/context';
import { requirePermission } from '../lib/context';
import { conflict, invalidInput, notFound } from '../lib/errors';
import { getEnv } from '../lib/env';
import { jaccardSimilarity, tokenize, truncate } from '../lib/text';
import { draftContent, validateCitations } from '../ai/pipeline';
import { recordAudit } from './audit';
import { APPROVED_REVIEW_STATUSES } from './source';
import { searchKnowledge } from './search';
import { gatherPassages, formatCitation, type CitationStyle } from './synthesis';

export const CONTENT_TYPES = [
  'blog_article',
  'patient_guide',
  'faq',
  'video_script',
  'social_post',
  'carousel_copy',
  'newsletter',
  'training_notes',
  'presentation_outline',
  'research_summary',
] as const;

export type SourcePolicy = 'approved_only' | 'approved_preferred' | 'any_internal';

export interface GenerateContentInput {
  title: string;
  contentType: string;
  audience?: string;
  instructions?: string | null;
  targetLength?: number;
  sourcePolicy?: SourcePolicy;
  sourceIds?: string[];
  collectionIds?: string[];
  citationStyle?: CitationStyle;
  includeSafetyNotes?: boolean;
  brandGuidance?: string | null;
  prohibitedClaims?: string[];
}

/**
 * Drafts content from library sources, keeping a citation for every
 * factual statement.
 *
 * Health-facing content defaults to approved sources only. Anything the
 * model could not tie back to a supplied passage is separated out as an
 * unsupported claim rather than published inside the body.
 */
export async function generateContent(
  ctx: ActorContext,
  input: GenerateContentInput,
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'content.generate');

  const title = input.title?.trim();
  if (!title) throw invalidInput('A content title is required.');

  const policy = input.sourcePolicy ?? 'approved_only';
  const approvedOnly = policy === 'approved_only';

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
      query: `${title}${input.instructions ? ` ${input.instructions}` : ''}`,
      entityTypes: ['sources'],
      filters: approvedOnly ? { reviewStatus: APPROVED_REVIEW_STATUSES } : {},
      limit: 12,
      includeUnreviewed: !approvedOnly,
      includePassages: false,
    });
    sourceIds = search.results.map((r) => r.id);
  }

  if (sourceIds.length === 0) {
    throw conflict(
      approvedOnly
        ? 'No approved sources are available for this topic, so no evidence-backed content can be drafted. Approve relevant sources first, or change the source policy deliberately.'
        : 'No sources are available for this topic.',
      { source_policy: policy, title },
    );
  }

  const { passages, sources } = await gatherPassages(ctx, {
    question: `${title} ${input.instructions ?? ''}`.trim(),
    sourceIds: sourceIds.slice(0, getEnv().MAX_SYNTHESIS_SOURCES),
    approvedOnly,
    passagesPerSource: 3,
  });

  if (passages.length === 0) {
    throw conflict(
      'The selected sources have no retrievable passages yet. Wait for processing to finish before generating content from them.',
      { source_count: sourceIds.length },
    );
  }

  const draft = await draftContent(
    { organizationId: ctx.organizationId, requestId: ctx.requestId, userId: ctx.userId },
    {
      title,
      contentType: input.contentType,
      audience: input.audience ?? 'general_public',
      instructions: input.instructions ?? undefined,
      targetLength: input.targetLength,
      brandGuidance: input.brandGuidance ?? undefined,
      prohibitedClaims: input.prohibitedClaims ?? [],
      passages,
    },
  );

  const availableMarkers = passages.map((p) => p.marker);
  const available = new Set(availableMarkers);
  const { invalid } = validateCitations(
    draft.sections.flatMap((s) => s.citation_markers),
    availableMarkers,
  );

  const clean = (text: string) =>
    text.replace(/\[(\d+)\]/g, (match) => (available.has(match) ? match : ''));

  const sections = draft.sections.map((section) => ({
    heading: section.heading,
    body: clean(section.body),
    citation_markers: section.citation_markers.filter((m) => available.has(m)),
  }));

  const body = sections.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n');

  // Independent check: a sentence carrying a factual assertion but no
  // marker is flagged even when the model did not report it.
  const uncited = findUncitedAssertions(body);

  const safetyFlags = [...draft.safety_flags];
  if (!approvedOnly) {
    const unreviewed = sources.filter(
      (s) => !APPROVED_REVIEW_STATUSES.includes(s.review_status),
    ).length;
    if (unreviewed > 0) {
      safetyFlags.push(
        `${unreviewed} of the ${sources.length} sources used are unreviewed. This draft must not be published as approved Nirog Bhoomi guidance without review.`,
      );
    }
  }
  if (input.prohibitedClaims?.length) {
    const violations = findProhibitedClaims(body, input.prohibitedClaims);
    for (const violation of violations) {
      safetyFlags.push(`Possible prohibited claim detected: "${violation}"`);
    }
  }

  return withOrg(ctx.organizationId, async (sql) => {
    const row = await sql.one<{ id: string }>(
      `INSERT INTO generated_content (
         organization_id, title, content_type, audience, instructions, body,
         sections, citation_style, source_policy, brand_guidance,
         prohibited_claims, safety_flags, unsupported_claims, generated_by,
         created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
       RETURNING id`,
      [
        ctx.organizationId,
        draft.title || title,
        input.contentType,
        input.audience ?? 'general_public',
        input.instructions ?? null,
        body,
        JSON.stringify(sections),
        input.citationStyle ?? 'numbered',
        policy,
        input.brandGuidance ?? null,
        JSON.stringify(input.prohibitedClaims ?? []),
        JSON.stringify(safetyFlags),
        JSON.stringify([...draft.unsupported_claims, ...uncited]),
        `ai:${ctx.requestId}`,
        ctx.userId,
      ],
    );

    const contentId = row!.id;

    for (const source of sources) {
      await sql.query(
        `INSERT INTO generated_content_citations (
           generated_content_id, source_id, citation_marker, locator
         ) VALUES ($1,$2,$3,$4)`,
        [
          contentId,
          source.id,
          source.marker,
          passages.find((p) => p.source_id === source.id)?.locator ?? null,
        ],
      );
    }

    await recordAudit(sql, ctx, {
      action: 'content.generated',
      resourceType: 'generated_content',
      resourceId: contentId,
      newState: {
        title: draft.title || title,
        content_type: input.contentType,
        source_policy: policy,
        source_count: sources.length,
        unsupported_claim_count: draft.unsupported_claims.length + uncited.length,
      },
    });

    return {
      id: contentId,
      title: draft.title || title,
      content_type: input.contentType,
      status: 'draft',
      body,
      sections,
      citation_mapping: sources.map((source) => ({
        marker: source.marker,
        source_id: source.id,
        title: source.title,
        review_status: source.review_status,
        formatted: formatCitation(source, input.citationStyle ?? 'numbered', source.marker),
        dashboard_url: `/library/${source.id}`,
      })),
      sources_used: sources.length,
      unsupported_claims: [...draft.unsupported_claims, ...uncited],
      rejected_citations: invalid,
      safety_flags: safetyFlags,
      source_policy: policy,
      dashboard_url: `/content/${contentId}`,
      note: 'This is a draft. Health-facing content must be reviewed by a qualified reviewer before publication.',
    };
  });
}

export async function getGeneratedContent(
  ctx: ActorContext,
  contentId: string,
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'content.generate');

  return withOrg(ctx.organizationId, async (sql) => {
    const content = await sql.one<Record<string, unknown>>(
      `SELECT * FROM generated_content WHERE id = $1`,
      [contentId],
    );
    if (!content) throw notFound('generated content', contentId);

    const citations = await sql.query(
      `SELECT gcc.citation_marker, gcc.locator, gcc.claim_id,
              s.id AS source_id, s.title, s.review_status::text, s.canonical_url,
              s.publisher, s.journal, s.publication_date, s.author_text, s.doi
       FROM generated_content_citations gcc
       JOIN sources s ON s.id = gcc.source_id
       WHERE gcc.generated_content_id = $1
       ORDER BY gcc.citation_marker`,
      [contentId],
    );

    return {
      ...content,
      citations: citations.map((c) => ({ ...c, dashboard_url: `/library/${c.source_id}` })),
      dashboard_url: `/content/${contentId}`,
    };
  });
}

export async function updateGeneratedContent(
  ctx: ActorContext,
  contentId: string,
  updates: { title?: string; body?: string; status?: string; audience?: string },
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'content.generate');

  await withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<Record<string, unknown>>(
      `SELECT * FROM generated_content WHERE id = $1 FOR UPDATE`,
      [contentId],
    );
    if (!existing) throw notFound('generated content', contentId);

    if (updates.status === 'approved' && !ctx.permissions.has('content.approve')) {
      throw conflict('Approving content requires the content.approve permission.', {
        required_permission: 'content.approve',
      });
    }

    const params: unknown[] = [];
    const add = (v: unknown) => `$${params.push(v)}`;
    const sets: string[] = [];
    const previous: Record<string, unknown> = {};

    for (const [field, value] of Object.entries(updates)) {
      if (value === undefined) continue;
      previous[field] = existing[field];
      sets.push(`${field} = ${add(value)}`);
    }
    if (sets.length === 0) return;

    if (updates.status === 'approved') {
      sets.push(`approved_by = ${add(ctx.userId)}`, 'approved_at = now()');
    }
    sets.push(`updated_by = ${add(ctx.userId)}`, 'updated_at = now()', 'version = version + 1');

    await sql.query(
      `UPDATE generated_content SET ${sets.join(', ')} WHERE id = ${add(contentId)}`,
      params,
    );

    await recordAudit(sql, ctx, {
      action: updates.status === 'approved' ? 'content.approved' : 'content.updated',
      resourceType: 'generated_content',
      resourceId: contentId,
      previousState: previous,
      newState: updates as Record<string, unknown>,
    });
  });

  return getGeneratedContent(ctx, contentId);
}

export async function regenerateContentSection(
  ctx: ActorContext,
  contentId: string,
  input: { heading: string; instructions?: string },
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'content.generate');

  const existing = (await getGeneratedContent(ctx, contentId)) as Record<string, unknown>;
  const citations = (existing.citations ?? []) as Array<Record<string, unknown>>;
  const sourceIds = citations.map((c) => String(c.source_id));

  if (sourceIds.length === 0) {
    throw conflict('This content has no cited sources to regenerate from.', { content_id: contentId });
  }

  const { passages } = await gatherPassages(ctx, {
    question: `${existing.title} ${input.heading} ${input.instructions ?? ''}`.trim(),
    sourceIds,
    approvedOnly: existing.source_policy === 'approved_only',
    passagesPerSource: 3,
  });

  const draft = await draftContent(
    { organizationId: ctx.organizationId, requestId: ctx.requestId, userId: ctx.userId },
    {
      title: `${existing.title} — ${input.heading}`,
      contentType: String(existing.content_type),
      audience: String(existing.audience ?? 'general_public'),
      instructions: input.instructions,
      brandGuidance: (existing.brand_guidance as string) ?? undefined,
      prohibitedClaims: (existing.prohibited_claims as string[]) ?? [],
      passages,
    },
  );

  const available = new Set(passages.map((p) => p.marker));
  const clean = (text: string) =>
    text.replace(/\[(\d+)\]/g, (match) => (available.has(match) ? match : ''));

  const sections = (existing.sections as Array<Record<string, unknown>>) ?? [];
  const newBody = clean(draft.sections.map((s) => s.body).join('\n\n'));
  const index = sections.findIndex((s) => s.heading === input.heading);

  if (index >= 0) sections[index] = { ...sections[index], body: newBody };
  else sections.push({ heading: input.heading, body: newBody, citation_markers: [] });

  const body = sections.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n');

  await withOrg(ctx.organizationId, async (sql) => {
    await sql.query(
      `UPDATE generated_content
       SET sections = $1::jsonb, body = $2, updated_by = $3, updated_at = now(),
           version = version + 1
       WHERE id = $4`,
      [JSON.stringify(sections), body, ctx.userId, contentId],
    );

    await recordAudit(sql, ctx, {
      action: 'content.section_regenerated',
      resourceType: 'generated_content',
      resourceId: contentId,
      newState: { heading: input.heading },
    });
  });

  return getGeneratedContent(ctx, contentId);
}

export interface CitationValidation {
  content_id: string;
  supported_statements: Array<{ text: string; markers: string[] }>;
  weakly_supported_statements: Array<{ text: string; markers: string[]; reason: string }>;
  unsupported_statements: string[];
  citation_mismatches: Array<{ marker: string; reason: string }>;
  safety_review_flags: string[];
  summary: { total: number; supported: number; weak: number; unsupported: number };
}

/**
 * Re-checks a draft against the passages it cites.
 *
 * Each cited sentence is compared with the text of the passage behind its
 * marker. A statement whose wording has drifted far from its evidence is
 * flagged as weakly supported -- that is where a hedge quietly becomes a
 * promise.
 */
export async function validateContentCitations(
  ctx: ActorContext,
  contentId: string,
): Promise<CitationValidation> {
  requirePermission(ctx, 'content.generate');

  const content = (await getGeneratedContent(ctx, contentId)) as Record<string, unknown>;
  const citations = (content.citations ?? []) as Array<Record<string, unknown>>;
  const body = String(content.body ?? '');

  const markerToSource = new Map(
    citations.map((c) => [String(c.citation_marker), String(c.source_id)]),
  );

  const passageTextByMarker = await withOrg(ctx.organizationId, async (sql) => {
    const map = new Map<string, string>();
    for (const [marker, sourceId] of markerToSource) {
      const rows = await sql.query<{ chunk_text: string }>(
        `SELECT chunk_text FROM embedding_chunks WHERE source_id = $1 ORDER BY chunk_index LIMIT 40`,
        [sourceId],
      );
      map.set(marker, rows.map((r) => r.chunk_text).join(' '));
    }
    return map;
  });

  const sentences = body
    .replace(/^##.*$/gm, '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30);

  const supported: Array<{ text: string; markers: string[] }> = [];
  const weak: Array<{ text: string; markers: string[]; reason: string }> = [];
  const unsupported: string[] = [];
  const mismatches: Array<{ marker: string; reason: string }> = [];

  for (const sentence of sentences) {
    const markers = [...sentence.matchAll(/\[(\d+)\]/g)].map((m) => m[0]);

    if (markers.length === 0) {
      if (carriesAssertion(sentence)) unsupported.push(truncate(sentence, 300));
      continue;
    }

    const unknown = markers.filter((m) => !markerToSource.has(m));
    for (const marker of unknown) {
      mismatches.push({ marker, reason: 'This marker does not correspond to any cited source.' });
    }

    const known = markers.filter((m) => markerToSource.has(m));
    if (known.length === 0) {
      unsupported.push(truncate(sentence, 300));
      continue;
    }

    const overlap = Math.max(
      ...known.map((marker) => {
        const passageText = passageTextByMarker.get(marker) ?? '';
        return lexicalSupport(sentence, passageText);
      }),
    );

    if (overlap >= 0.45) supported.push({ text: truncate(sentence, 300), markers: known });
    else {
      weak.push({
        text: truncate(sentence, 300),
        markers: known,
        reason: `Only ${Math.round(overlap * 100)}% of the statement's substantive terms appear in the cited source. Verify the claim against the passage.`,
      });
    }
  }

  const safetyFlags = [...((content.safety_flags as string[]) ?? [])];
  const overclaims = findOverclaims(body);
  for (const phrase of overclaims) {
    safetyFlags.push(
      `Absolute or guaranteeing language detected ("${phrase}"). Health content should preserve the source's hedging.`,
    );
  }
  if (content.source_policy !== 'approved_only') {
    safetyFlags.push(
      'This content was not restricted to approved sources. Confirm the evidence basis before publication.',
    );
  }

  return {
    content_id: contentId,
    supported_statements: supported,
    weakly_supported_statements: weak,
    unsupported_statements: unsupported,
    citation_mismatches: mismatches,
    safety_review_flags: safetyFlags,
    summary: {
      total: supported.length + weak.length + unsupported.length,
      supported: supported.length,
      weak: weak.length,
      unsupported: unsupported.length,
    },
  };
}

// ---------------------------------------------------------------------

/**
 * Finds sentences that assert something factual but carry no citation
 * marker. This runs independently of what the model reported about its
 * own output, because a model that miscounts its citations is exactly the
 * case this needs to catch.
 */
function findUncitedAssertions(body: string): string[] {
  return body
    .replace(/^##.*$/gm, '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30 && !/\[\d+\]/.test(s) && carriesAssertion(s))
    .map((s) => truncate(s, 300));
}

/** Does this sentence assert a fact, as opposed to framing or transition? */
function carriesAssertion(sentence: string): boolean {
  return /\b(reduces?|increases?|improves?|lowers?|causes?|prevents?|treats?|cures?|studies show|research shows|evidence shows|is effective|has been shown|percent|%|\d+\s*(mg|g|kg|minutes|hours))\b/i.test(
    sentence,
  );
}

/** Share of a sentence's substantive terms that appear in its source. */
function lexicalSupport(sentence: string, passageText: string): number {
  const sentenceTerms = new Set(
    tokenize(sentence.replace(/\[\d+\]/g, '')).filter((t) => t.length > 4),
  );
  if (sentenceTerms.size === 0) return jaccardSimilarity(sentence, passageText);

  const passageTerms = new Set(tokenize(passageText));
  let hits = 0;
  for (const term of sentenceTerms) if (passageTerms.has(term)) hits += 1;
  return hits / sentenceTerms.size;
}

const OVERCLAIM_PATTERNS = [
  /\bguarantee[sd]?\b/i,
  /\bcures?\b/i,
  /\bcompletely (?:safe|effective|reverses?)\b/i,
  /\bproven to (?:cure|reverse|eliminate)\b/i,
  /\balways works?\b/i,
  /\bno side effects\b/i,
  /\b100%\s*(?:safe|effective)\b/i,
  /\bmiracle\b/i,
  /\bpermanently (?:cures?|reverses?)\b/i,
];

function findOverclaims(text: string): string[] {
  const found: string[] = [];
  for (const pattern of OVERCLAIM_PATTERNS) {
    const match = text.match(pattern);
    if (match) found.push(match[0]);
  }
  return found;
}

function findProhibitedClaims(text: string, prohibited: string[]): string[] {
  const lower = text.toLowerCase();
  return prohibited.filter((claim) => {
    const needle = claim.toLowerCase().trim();
    if (!needle) return false;
    if (lower.includes(needle)) return true;
    // Catch close paraphrases as well as literal repetition.
    return tokenize(needle).length > 2 && jaccardSimilarity(needle, text) > 0.35;
  });
}
