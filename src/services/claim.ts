import { withOrg, type Sql } from '../lib/db';
import type { ActorContext } from '../lib/context';
import { requirePermission } from '../lib/context';
import { conflict, invalidInput, notFound, versionConflict } from '../lib/errors';
import { truncate } from '../lib/text';
import { analyzeContradictions } from '../ai/pipeline';
import { chunkLocator } from '../extraction/chunk';
import { recordAudit } from './audit';
import { guardConfirmation } from './confirmation';

export interface Claim {
  id: string;
  canonical_text: string;
  simplified_text: string | null;
  claim_type: string;
  topic: string | null;
  population: string | null;
  intervention: string | null;
  comparator: string | null;
  outcome: string | null;
  timeframe: string | null;
  context: string | null;
  units: string | null;
  quantitative_value: string | null;
  confidence: string | null;
  evidence_status: string;
  clinical_review_status: string;
  safety_relevance: string;
  safety_notes: string[];
  human_notes: string | null;
  status: string;
  version: number;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  dashboard_url?: string;
}

const CLAIM_FIELDS = [
  'id', 'canonical_text', 'simplified_text', 'claim_type', 'topic', 'population',
  'intervention', 'comparator', 'outcome', 'timeframe', 'context', 'units',
  'quantitative_value', 'confidence', 'evidence_status', 'clinical_review_status',
  'safety_relevance', 'safety_notes', 'human_notes', 'status', 'version',
  'reviewed_by', 'reviewed_at', 'created_at', 'updated_at',
];
const CLAIM_COLUMNS = CLAIM_FIELDS.join(', ');

function withUrl(claim: Claim): Claim {
  return { ...claim, dashboard_url: `/claims/${claim.id}` };
}

/** A claim is treated as settled once a clinical reviewer has signed off. */
function isApproved(claim: { clinical_review_status: string; evidence_status: string }): boolean {
  return (
    claim.clinical_review_status === 'reviewed' ||
    claim.clinical_review_status === 'approved'
  );
}

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

export async function searchClaims(
  ctx: ActorContext,
  input: {
    query?: string;
    evidenceStatus?: string[];
    clinicalReviewStatus?: string[];
    population?: string | null;
    intervention?: string | null;
    outcome?: string | null;
    categoryIds?: string[];
    collectionIds?: string[];
    safetyRelevantOnly?: boolean;
    contradictedOnly?: boolean;
    limit?: number;
  },
): Promise<Array<Claim & { supporting_count: number; contradicting_count: number }>> {
  requirePermission(ctx, 'claim.read');

  return withOrg(ctx.organizationId, async (sql) => {
    const params: unknown[] = [];
    const add = (v: unknown) => `$${params.push(v)}`;
    const where = [`c.status = 'active'`];

    if (input.query) {
      where.push(
        `(c.search_vector @@ plainto_tsquery('english', ${add(input.query)})
          OR lower(c.canonical_text) % lower(${add(input.query)}))`,
      );
    }
    if (input.evidenceStatus?.length) {
      where.push(`c.evidence_status = ANY(${add(input.evidenceStatus)}::evidence_status[])`);
    }
    if (input.clinicalReviewStatus?.length) {
      where.push(`c.clinical_review_status = ANY(${add(input.clinicalReviewStatus)}::text[])`);
    }
    if (input.population) where.push(`c.population ILIKE ${add(`%${input.population}%`)}`);
    if (input.intervention) where.push(`c.intervention ILIKE ${add(`%${input.intervention}%`)}`);
    if (input.outcome) where.push(`c.outcome ILIKE ${add(`%${input.outcome}%`)}`);
    if (input.safetyRelevantOnly) where.push(`c.safety_relevance != 'none'`);
    if (input.categoryIds?.length) {
      where.push(
        `EXISTS (SELECT 1 FROM claim_categories cc WHERE cc.claim_id = c.id AND cc.category_id = ANY(${add(input.categoryIds)}::uuid[]))`,
      );
    }
    if (input.collectionIds?.length) {
      where.push(
        `EXISTS (SELECT 1 FROM claim_evidence ce
                 JOIN collection_sources cs ON cs.source_id = ce.source_id
                 WHERE ce.claim_id = c.id AND cs.collection_id = ANY(${add(input.collectionIds)}::uuid[]))`,
      );
    }
    // Claims with evidence pointing both ways are the ones a reviewer
    // most needs to find, so this is a first-class filter.
    if (input.contradictedOnly) {
      where.push(
        `EXISTS (SELECT 1 FROM claim_evidence ce WHERE ce.claim_id = c.id AND ce.relationship = 'contradicts')`,
      );
    }

    const orderBy = input.query
      ? `ts_rank_cd(c.search_vector, plainto_tsquery('english', ${add(input.query)})) DESC`
      : 'c.updated_at DESC';

    return sql.query<Claim & { supporting_count: number; contradicting_count: number }>(
      `SELECT ${CLAIM_FIELDS.map((f) => `c.${f}`).join(', ')},
              (SELECT count(*) FROM claim_evidence ce WHERE ce.claim_id = c.id AND ce.relationship = 'supports')::int AS supporting_count,
              (SELECT count(*) FROM claim_evidence ce WHERE ce.claim_id = c.id AND ce.relationship = 'contradicts')::int AS contradicting_count
       FROM claims c
       WHERE ${where.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT ${add(Math.min(input.limit ?? 25, 100))}`,
      params,
    ).then((rows) => rows.map((r) => ({ ...withUrl(r), supporting_count: r.supporting_count, contradicting_count: r.contradicting_count })));
  });
}

export async function getClaim(
  ctx: ActorContext,
  claimId: string,
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'claim.read');

  return withOrg(ctx.organizationId, async (sql) => {
    const claim = await sql.one<Claim>(`SELECT ${CLAIM_COLUMNS} FROM claims WHERE id = $1`, [
      claimId,
    ]);
    if (!claim) throw notFound('claim', claimId);

    const evidence = await sql.query<{
      id: string;
      relationship: string;
      evidence_excerpt: string | null;
      page_number: number | null;
      section_reference: string | null;
      locator: string | null;
      evidence_strength: string | null;
      verified_at: string | null;
      source_id: string;
      source_title: string;
      source_type: string;
      publication_date: string | null;
      review_status: string;
      publisher: string | null;
    }>(
      `SELECT ce.id, ce.relationship::text, ce.evidence_excerpt, ce.page_number,
              ce.section_reference, ce.locator, ce.evidence_strength, ce.verified_at,
              s.id AS source_id, s.title AS source_title, s.source_type::text,
              s.publication_date, s.review_status::text, s.publisher
       FROM claim_evidence ce
       JOIN sources s ON s.id = ce.source_id
       WHERE ce.claim_id = $1 AND s.status != 'deleted'
       ORDER BY ce.relationship, s.publication_date DESC NULLS LAST`,
      [claimId],
    );

    const group = (relationship: string) =>
      evidence
        .filter((e) => e.relationship === relationship)
        .map((e) => ({
          evidence_id: e.id,
          source_id: e.source_id,
          title: e.source_title,
          source_type: e.source_type,
          publisher: e.publisher,
          publication_date: e.publication_date,
          review_status: e.review_status,
          excerpt: e.evidence_excerpt,
          locator: e.locator ?? chunkLocator({ pageNumber: e.page_number }),
          evidence_strength: e.evidence_strength,
          verified: Boolean(e.verified_at),
          dashboard_url: `/library/${e.source_id}`,
        }));

    const [related, annotations, activity, categories] = await Promise.all([
      sql.query(
        `SELECT cr.relation, cr.note, c.id, c.canonical_text, c.evidence_status
         FROM claim_relations cr JOIN claims c ON c.id = cr.to_claim_id
         WHERE cr.from_claim_id = $1 AND c.status = 'active'`,
        [claimId],
      ),
      sql.query(
        `SELECT a.id, a.annotation_type, a.body, a.created_at, u.full_name AS author_name
         FROM annotations a JOIN users u ON u.id = a.user_id
         WHERE a.claim_id = $1 AND a.archived_at IS NULL ORDER BY a.created_at DESC`,
        [claimId],
      ),
      sql.query(
        `SELECT a.id, a.action, a.changed_fields, a.source_interface, a.created_at,
                u.full_name AS actor_name
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
         WHERE a.resource_type = 'claim' AND a.resource_id = $1
         ORDER BY a.created_at DESC LIMIT 50`,
        [claimId],
      ),
      sql.query(
        `SELECT c.id, c.name FROM claim_categories cc JOIN categories c ON c.id = cc.category_id
         WHERE cc.claim_id = $1`,
        [claimId],
      ),
    ]);

    const supporting = group('supports');
    const contradicting = group('contradicts');

    return {
      ...withUrl(claim),
      categories,
      supporting_evidence: supporting,
      contradicting_evidence: contradicting,
      qualifying_evidence: group('qualifies'),
      contextualizing_evidence: group('contextualizes'),
      replication_evidence: [...group('replicates'), ...group('fails_to_replicate')],
      evidence_counts: {
        supporting: supporting.length,
        contradicting: contradicting.length,
        total: evidence.length,
      },
      // The timeline is what shows whether the picture has changed over
      // time -- a claim supported in 2012 and contradicted since is a
      // different situation from one consistently supported.
      evidence_timeline: evidence
        .filter((e) => e.publication_date)
        .map((e) => ({
          date: e.publication_date,
          relationship: e.relationship,
          source_id: e.source_id,
          title: e.source_title,
        }))
        .sort((a, b) => String(a.date).localeCompare(String(b.date))),
      related_claims: related,
      annotations,
      activity,
    };
  });
}

// ---------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------

export async function createClaim(
  ctx: ActorContext,
  input: {
    canonicalText: string;
    simplifiedText?: string | null;
    claimType?: string;
    topic?: string | null;
    population?: string | null;
    intervention?: string | null;
    comparator?: string | null;
    outcome?: string | null;
    timeframe?: string | null;
    context?: string | null;
    units?: string | null;
    quantitativeValue?: string | null;
    safetyRelevance?: string;
    categoryIds?: string[];
    sourceEvidence?: Array<{
      sourceId: string;
      relationship: string;
      passageId?: string | null;
      excerpt?: string | null;
      locator?: string | null;
      evidenceStrength?: string | null;
    }>;
  },
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'claim.create');

  const text = input.canonicalText?.trim();
  if (!text) throw invalidInput('Claim text is required.');
  if (text.length < 15) {
    throw invalidInput('A claim must be a complete proposition, not a fragment.', {
      supplied_length: text.length,
    });
  }

  const claimId = await withOrg(ctx.organizationId, async (sql) => {
    const row = await sql.one<Claim>(
      `INSERT INTO claims (
         organization_id, canonical_text, simplified_text, claim_type, topic,
         population, intervention, comparator, outcome, timeframe, context,
         units, quantitative_value, safety_relevance, created_by, created_via, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::source_interface,$15)
       RETURNING ${CLAIM_COLUMNS}`,
      [
        ctx.organizationId,
        text,
        input.simplifiedText ?? null,
        input.claimType ?? 'finding',
        input.topic ?? null,
        input.population ?? null,
        input.intervention ?? null,
        input.comparator ?? null,
        input.outcome ?? null,
        input.timeframe ?? null,
        input.context ?? null,
        input.units ?? null,
        input.quantitativeValue ?? null,
        input.safetyRelevance ?? 'none',
        ctx.userId,
        ctx.sourceInterface,
      ],
    );

    const newClaimId = row!.id;

    if (input.categoryIds?.length) {
      for (const categoryId of input.categoryIds) {
        await sql.query(
          `INSERT INTO claim_categories (claim_id, category_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [newClaimId, categoryId],
        );
      }
    }

    const attached: string[] = [];
    for (const evidence of input.sourceEvidence ?? []) {
      await attachEvidence(sql, ctx, newClaimId, evidence);
      attached.push(evidence.sourceId);
    }

    if (attached.length > 0) await recomputeEvidenceStatus(sql, newClaimId);

    await recordAudit(sql, ctx, {
      action: 'claim.created',
      resourceType: 'claim',
      resourceId: newClaimId,
      newState: {
        canonical_text: truncate(text, 300),
        population: input.population ?? null,
        intervention: input.intervention ?? null,
        outcome: input.outcome ?? null,
        evidence_source_ids: attached,
      },
    });

    // getClaim opens its own connection and transaction; calling it here,
    // before this transaction commits, would not see the row just
    // inserted. It is called after withOrg returns instead.
    return newClaimId;
  });

  return getClaim(ctx, claimId);
}

export async function updateClaim(
  ctx: ActorContext,
  claimId: string,
  updates: Record<string, unknown>,
  options: { expectedVersion?: number; confirmationId?: string | null } = {},
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'claim.update');

  const EDITABLE = new Set([
    'canonical_text', 'simplified_text', 'claim_type', 'topic', 'population',
    'intervention', 'comparator', 'outcome', 'timeframe', 'context', 'units',
    'quantitative_value', 'human_notes', 'safety_relevance',
  ]);

  const rejected = Object.keys(updates).filter((f) => !EDITABLE.has(f));
  if (rejected.length > 0) {
    throw invalidInput(`These fields cannot be updated here: ${rejected.join(', ')}.`, {
      rejected_fields: rejected,
      note: 'Evidence status and clinical review status change through reviewClaim.',
    });
  }

  await withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<Claim>(
      `SELECT ${CLAIM_COLUMNS} FROM claims WHERE id = $1 FOR UPDATE`,
      [claimId],
    );
    if (!existing) throw notFound('claim', claimId);
    if (existing.status !== 'active') throw conflict(`This claim is ${existing.status}.`);
    if (options.expectedVersion !== undefined && options.expectedVersion !== existing.version) {
      throw versionConflict('claim', existing.version);
    }

    // Editing a claim a clinician has signed off on, or one flagged as
    // safety-relevant, needs the same explicit confirmation as a
    // destructive action -- the downstream content depends on it.
    const approved = isApproved(existing);
    const confirmationId = await guardConfirmation(sql, ctx, {
      actionType: 'updateClaim',
      resourceType: 'claim',
      resourceIds: [claimId],
      actionPayload: updates,
      humanSummary: `Change ${Object.keys(updates).join(', ')} on the ${approved ? 'clinically reviewed' : ''} claim "${truncate(existing.canonical_text, 100)}".`,
      confirmationId: options.confirmationId,
      riskContext: {
        targetApproved: approved,
        safetyRelevant: existing.safety_relevance !== 'none',
      },
    });

    if (approved && !ctx.permissions.has('claim.review')) {
      throw conflict(
        'This claim has been clinically reviewed. Changing it requires the claim.review permission.',
        { clinical_review_status: existing.clinical_review_status },
      );
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
    if (sets.length === 0) return;

    // Materially changing an approved claim sends it back for review
    // rather than leaving the old sign-off attached to new wording.
    if (approved) {
      sets.push(`clinical_review_status = 'needs_re_review'`);
    }
    sets.push(`updated_by = ${add(ctx.userId)}`, 'updated_at = now()', 'version = version + 1');

    await sql.query(
      `UPDATE claims SET ${sets.join(', ')} WHERE id = ${add(claimId)}`,
      params,
    );

    await recordAudit(sql, ctx, {
      action: 'claim.updated',
      resourceType: 'claim',
      resourceId: claimId,
      previousState: previous,
      newState: updates,
      confirmationId,
    });
  });

  return getClaim(ctx, claimId);
}

async function attachEvidence(
  sql: Sql,
  ctx: ActorContext,
  claimId: string,
  input: {
    sourceId: string;
    relationship: string;
    passageId?: string | null;
    excerpt?: string | null;
    locator?: string | null;
    evidenceStrength?: string | null;
    pageNumber?: number | null;
  },
): Promise<{ id: string }> {
  const source = await sql.one<{ id: string; title: string; review_status: string }>(
    `SELECT id, title, review_status FROM sources WHERE id = $1 AND status = 'active'`,
    [input.sourceId],
  );
  if (!source) throw notFound('source', input.sourceId);

  let excerpt = input.excerpt ?? null;
  let locator = input.locator ?? null;
  let pageNumber = input.pageNumber ?? null;

  // When a passage is named, the excerpt and locator are taken from the
  // stored chunk rather than from the caller, so a citation always points
  // at text that genuinely exists in the source.
  if (input.passageId) {
    const chunk = await sql.one<{
      chunk_text: string;
      page_number: number | null;
      heading_path: string | null;
      chunk_index: number;
      start_offset: number | null;
      source_id: string;
    }>(`SELECT * FROM embedding_chunks WHERE id = $1`, [input.passageId]);

    if (!chunk) throw notFound('passage', input.passageId);
    if (chunk.source_id !== input.sourceId) {
      throw invalidInput('The supplied passage belongs to a different source.', {
        passage_source_id: chunk.source_id,
        supplied_source_id: input.sourceId,
      });
    }

    excerpt = truncate(chunk.chunk_text, 2000);
    pageNumber = chunk.page_number;
    locator = chunkLocator({
      pageNumber: chunk.page_number,
      headingPath: chunk.heading_path,
      chunkIndex: chunk.chunk_index,
      startOffset: chunk.start_offset,
    });
  }

  const row = await sql.one<{ id: string }>(
    `INSERT INTO claim_evidence (
       organization_id, claim_id, source_id, relationship, evidence_excerpt,
       page_number, locator, chunk_id, evidence_strength, created_by
     ) VALUES ($1,$2,$3,$4::evidence_relationship,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (claim_id, source_id, relationship, locator) DO UPDATE
       SET evidence_excerpt = EXCLUDED.evidence_excerpt,
           evidence_strength = EXCLUDED.evidence_strength
     RETURNING id`,
    [
      ctx.organizationId,
      claimId,
      input.sourceId,
      input.relationship,
      excerpt,
      pageNumber,
      locator,
      input.passageId ?? null,
      input.evidenceStrength ?? null,
      ctx.userId,
    ],
  );

  return row!;
}

export async function addClaimEvidence(
  ctx: ActorContext,
  claimId: string,
  input: {
    sourceId: string;
    relationship: string;
    passageId?: string | null;
    excerpt?: string | null;
    locator?: string | null;
    evidenceStrength?: string | null;
  },
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'claim.update');

  await withOrg(ctx.organizationId, async (sql) => {
    const claim = await sql.one<Claim>(`SELECT ${CLAIM_COLUMNS} FROM claims WHERE id = $1`, [
      claimId,
    ]);
    if (!claim) throw notFound('claim', claimId);
    if (claim.status !== 'active') throw conflict(`This claim is ${claim.status}.`);

    const evidence = await attachEvidence(sql, ctx, claimId, input);
    await recomputeEvidenceStatus(sql, claimId);

    await recordAudit(sql, ctx, {
      action: 'claim.evidence_added',
      resourceType: 'claim',
      resourceId: claimId,
      newState: {
        evidence_id: evidence.id,
        source_id: input.sourceId,
        relationship: input.relationship,
      },
    });
  });

  return getClaim(ctx, claimId);
}

export async function removeClaimEvidence(
  ctx: ActorContext,
  claimId: string,
  evidenceId: string,
  confirmationId?: string | null,
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'claim.update');

  await withOrg(ctx.organizationId, async (sql) => {
    const claim = await sql.one<Claim>(
      `SELECT ${CLAIM_COLUMNS} FROM claims WHERE id = $1 FOR UPDATE`,
      [claimId],
    );
    if (!claim) throw notFound('claim', claimId);

    const evidence = await sql.one<{ id: string; source_id: string; relationship: string }>(
      `SELECT id, source_id, relationship::text FROM claim_evidence WHERE id = $1 AND claim_id = $2`,
      [evidenceId, claimId],
    );
    if (!evidence) throw notFound('claim evidence', evidenceId);

    const usedConfirmation = await guardConfirmation(sql, ctx, {
      actionType: 'removeClaimEvidence',
      resourceType: 'claim_evidence',
      resourceIds: [evidenceId],
      actionPayload: { claim_id: claimId },
      humanSummary: `Remove ${evidence.relationship} evidence from the claim "${truncate(claim.canonical_text, 100)}".`,
      confirmationId,
      riskContext: { targetApproved: isApproved(claim) },
    });

    await sql.query(`DELETE FROM claim_evidence WHERE id = $1`, [evidenceId]);
    await recomputeEvidenceStatus(sql, claimId);

    await recordAudit(sql, ctx, {
      action: 'claim.evidence_removed',
      resourceType: 'claim',
      resourceId: claimId,
      previousState: { evidence_id: evidenceId, source_id: evidence.source_id, relationship: evidence.relationship },
      newState: null,
      confirmationId: usedConfirmation,
    });
  });

  return getClaim(ctx, claimId);
}

export async function reviewClaim(
  ctx: ActorContext,
  claimId: string,
  input: {
    evidenceStatus: string;
    clinicalReviewStatus?: string;
    rationale: string;
    safetyNotes?: string[];
    safetyRelevance?: string;
    expectedVersion?: number;
  },
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'claim.review');

  if (!input.rationale?.trim()) {
    throw invalidInput('A rationale is required when reviewing a claim.', {
      required_field: 'rationale',
    });
  }

  await withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<Claim>(
      `SELECT ${CLAIM_COLUMNS} FROM claims WHERE id = $1 FOR UPDATE`,
      [claimId],
    );
    if (!existing) throw notFound('claim', claimId);
    if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
      throw versionConflict('claim', existing.version);
    }

    await sql.query(
      `UPDATE claims
       SET evidence_status = $1::evidence_status,
           clinical_review_status = $2,
           safety_notes = $3::jsonb,
           safety_relevance = coalesce($4, safety_relevance),
           human_notes = CASE WHEN human_notes IS NULL OR human_notes = '' THEN $5
                              ELSE human_notes || E'\n\n' || $5 END,
           reviewed_by = $6, reviewed_at = now(), last_verified_at = now(),
           updated_by = $6, updated_at = now(), version = version + 1
       WHERE id = $7`,
      [
        input.evidenceStatus,
        input.clinicalReviewStatus ?? 'reviewed',
        JSON.stringify(input.safetyNotes ?? existing.safety_notes ?? []),
        input.safetyRelevance ?? null,
        `[${new Date().toISOString().slice(0, 10)} review] ${input.rationale.trim()}`,
        ctx.userId,
        claimId,
      ],
    );

    await recordAudit(sql, ctx, {
      action: 'claim.reviewed',
      resourceType: 'claim',
      resourceId: claimId,
      previousState: {
        evidence_status: existing.evidence_status,
        clinical_review_status: existing.clinical_review_status,
      },
      newState: {
        evidence_status: input.evidenceStatus,
        clinical_review_status: input.clinicalReviewStatus ?? 'reviewed',
        rationale: input.rationale,
      },
    });
  });

  return getClaim(ctx, claimId);
}

export async function archiveClaim(
  ctx: ActorContext,
  claimId: string,
  confirmationId?: string | null,
): Promise<Claim> {
  requirePermission(ctx, 'claim.archive');

  return withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<Claim>(
      `SELECT ${CLAIM_COLUMNS} FROM claims WHERE id = $1 FOR UPDATE`,
      [claimId],
    );
    if (!existing) throw notFound('claim', claimId);
    if (existing.status !== 'active') throw conflict(`This claim is already ${existing.status}.`);

    const usedConfirmation = await guardConfirmation(sql, ctx, {
      actionType: 'archiveClaim',
      resourceType: 'claim',
      resourceIds: [claimId],
      actionPayload: {},
      humanSummary: `Archive the claim "${truncate(existing.canonical_text, 100)}". Its evidence links are kept and it can be restored.`,
      confirmationId,
      riskContext: { targetApproved: isApproved(existing) },
    });

    const row = await sql.one<Claim>(
      `UPDATE claims SET status = 'archived', archived_at = now(), archived_by = $1,
              updated_at = now(), version = version + 1
       WHERE id = $2 RETURNING ${CLAIM_COLUMNS}`,
      [ctx.userId, claimId],
    );

    await recordAudit(sql, ctx, {
      action: 'claim.archived',
      resourceType: 'claim',
      resourceId: claimId,
      previousState: { status: 'active' },
      newState: { status: 'archived' },
      confirmationId: usedConfirmation,
    });

    return withUrl(row!);
  });
}

export async function restoreClaim(ctx: ActorContext, claimId: string): Promise<Claim> {
  requirePermission(ctx, 'claim.update');

  return withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<Claim>(`SELECT ${CLAIM_COLUMNS} FROM claims WHERE id = $1`, [
      claimId,
    ]);
    if (!existing) throw notFound('claim', claimId);
    if (existing.status === 'active') throw conflict('This claim is already active.');

    const row = await sql.one<Claim>(
      `UPDATE claims SET status = 'active', archived_at = NULL, archived_by = NULL,
              updated_at = now(), version = version + 1
       WHERE id = $1 RETURNING ${CLAIM_COLUMNS}`,
      [claimId],
    );

    await recordAudit(sql, ctx, {
      action: 'claim.restored',
      resourceType: 'claim',
      resourceId: claimId,
      previousState: { status: existing.status },
      newState: { status: 'active' },
    });

    return withUrl(row!);
  });
}

/**
 * Derives an evidence status from the attached evidence.
 *
 * This only ever moves an *unreviewed* claim. Once a human has set a
 * status, adding a source must not silently overturn their judgement --
 * the claim is flagged for re-review instead.
 */
export async function recomputeEvidenceStatus(sql: Sql, claimId: string): Promise<string> {
  const claim = await sql.one<{ evidence_status: string; clinical_review_status: string }>(
    `SELECT evidence_status::text, clinical_review_status FROM claims WHERE id = $1`,
    [claimId],
  );
  if (!claim) return 'unreviewed';

  const counts = await sql.one<{
    supports: number;
    contradicts: number;
    qualifies: number;
    retracted: number;
  }>(
    `SELECT
       count(*) FILTER (WHERE ce.relationship = 'supports')::int AS supports,
       count(*) FILTER (WHERE ce.relationship = 'contradicts')::int AS contradicts,
       count(*) FILTER (WHERE ce.relationship = 'qualifies')::int AS qualifies,
       count(*) FILTER (WHERE s.retraction_status NOT IN ('none',''))::int AS retracted
     FROM claim_evidence ce JOIN sources s ON s.id = ce.source_id
     WHERE ce.claim_id = $1 AND s.status = 'active'`,
    [claimId],
  );

  const supports = counts?.supports ?? 0;
  const contradicts = counts?.contradicts ?? 0;
  const retracted = counts?.retracted ?? 0;

  let derived: string;
  if (retracted > 0 && supports <= retracted) derived = 'retracted_source_dependency';
  else if (supports === 0 && contradicts === 0) derived = 'unreviewed';
  else if (contradicts === 0 && supports >= 3) derived = 'supported';
  else if (contradicts === 0 && supports >= 1) derived = 'likely_supported';
  else if (supports === 0 && contradicts >= 1) derived = 'contradicted';
  else if (contradicts > supports) derived = 'contested';
  else derived = 'mixed';

  const humanReviewed = claim.clinical_review_status !== 'not_reviewed';

  if (humanReviewed) {
    // A reviewer's decision stands. If the derived picture has changed,
    // that is a signal to re-review, not a licence to overwrite them.
    if (derived !== claim.evidence_status) {
      await sql.query(
        `UPDATE claims SET clinical_review_status = 'needs_re_review', updated_at = now()
         WHERE id = $1 AND clinical_review_status != 'needs_re_review'`,
        [claimId],
      );
    }
    return claim.evidence_status;
  }

  await sql.query(
    `UPDATE claims SET evidence_status = $1::evidence_status, updated_at = now() WHERE id = $2`,
    [derived, claimId],
  );
  return derived;
}

/**
 * Compares a claim against others that share its subject matter and asks
 * the model to classify each relationship. Results are suggestions for a
 * reviewer; nothing is written to the claim's status.
 */
export async function analyzeClaimConflicts(
  ctx: ActorContext,
  claimId: string,
  options: { limit?: number } = {},
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'claim.read');

  const { claim, candidates } = await withOrg(ctx.organizationId, async (sql) => {
    const claim = await sql.one<Claim>(`SELECT ${CLAIM_COLUMNS} FROM claims WHERE id = $1`, [
      claimId,
    ]);
    if (!claim) throw notFound('claim', claimId);

    const candidates = await sql.query<{
      id: string;
      canonical_text: string;
      population: string | null;
      intervention: string | null;
      outcome: string | null;
      evidence_status: string;
    }>(
      `SELECT id, canonical_text, population, intervention, outcome, evidence_status::text
       FROM claims
       WHERE status = 'active' AND id != $1
         AND (search_vector @@ plainto_tsquery('english', $2)
              OR (intervention IS NOT NULL AND intervention = $3)
              OR (outcome IS NOT NULL AND outcome = $4))
       ORDER BY ts_rank_cd(search_vector, plainto_tsquery('english', $2)) DESC
       LIMIT $5`,
      [
        claimId,
        claim.canonical_text,
        claim.intervention,
        claim.outcome,
        Math.min(options.limit ?? 10, 25),
      ],
    );

    return { claim, candidates };
  });

  if (candidates.length === 0) {
    return {
      claim_id: claimId,
      assessments: [],
      note: 'No other claims in the library address a similar intervention or outcome, so no comparison was possible.',
    };
  }

  const analysis = await analyzeContradictions(
    { organizationId: ctx.organizationId, requestId: ctx.requestId, userId: ctx.userId },
    {
      subjectText: claim.canonical_text,
      subjectContext: {
        population: claim.population,
        intervention: claim.intervention,
        comparator: claim.comparator,
        outcome: claim.outcome,
        timeframe: claim.timeframe,
      },
      targets: candidates.map((c) => ({
        claim_id: c.id,
        text: c.canonical_text,
        context: {
          population: c.population,
          intervention: c.intervention,
          outcome: c.outcome,
        },
      })),
    },
  );

  return {
    claim_id: claimId,
    claim_text: claim.canonical_text,
    assessments: analysis.assessments.map((a) => ({
      ...a,
      other_claim_text: candidates.find((c) => c.id === a.other_claim_id)?.canonical_text ?? null,
      dashboard_url: a.other_claim_id ? `/claims/${a.other_claim_id}` : null,
    })),
    note: 'These are suggestions for a reviewer. No claim status was changed. A difference in population, dose, endpoint or follow-up is not a contradiction.',
  };
}
