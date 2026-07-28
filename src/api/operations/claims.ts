import { z } from 'zod';
import { defineOperation } from '../registry';
import { ConfirmationInput } from '../handler';
import {
  addClaimEvidence,
  analyzeClaimConflicts,
  archiveClaim,
  createClaim,
  getClaim,
  removeClaimEvidence,
  restoreClaim,
  reviewClaim,
  searchClaims,
  updateClaim,
} from '../../services/claim';

const evidenceStatus = z.enum([
  'supported', 'likely_supported', 'mixed', 'contested', 'contradicted',
  'insufficient_evidence', 'outdated', 'retracted_source_dependency', 'unreviewed',
]);

export const searchClaimsOperation = defineOperation({
  operationId: 'searchClaims',
  method: 'POST',
  path: '/claims/search',
  summary: 'Search organizational claims',
  description: `Searches curated claims by text, evidence status, PICO fields, category or collection.

Use this when the user asks what claims exist, which claims are contradicted or unsupported, or wants an overview of a position's status. Use contradicted_only to find claims that most need review.

This operation does not modify anything.`,
  tags: ['claims'],
  permission: 'claim.read',
  scopes: ['claim.read'],
  riskLevel: 'low',
  input: z.object({
    query: z.string().optional(),
    evidence_status: z.array(evidenceStatus).optional(),
    clinical_review_status: z.array(z.string()).optional(),
    population: z.string().nullish(),
    intervention: z.string().nullish(),
    outcome: z.string().nullish(),
    category_ids: z.array(z.string().uuid()).optional(),
    collection_ids: z.array(z.string().uuid()).optional(),
    safety_relevant_only: z.boolean().optional(),
    contradicted_only: z.boolean().optional(),
    approved_only: z.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
  handler: (input, { ctx }) =>
    searchClaims(ctx, {
      query: input.query,
      evidenceStatus: input.evidence_status,
      clinicalReviewStatus: input.clinical_review_status,
      population: input.population,
      intervention: input.intervention,
      outcome: input.outcome,
      categoryIds: input.category_ids,
      collectionIds: input.collection_ids,
      safetyRelevantOnly: input.safety_relevant_only,
      contradictedOnly: input.contradicted_only,
      limit: input.limit,
    }),
});

export const getClaimOperation = defineOperation({
  operationId: 'getClaim',
  method: 'GET',
  path: '/claims/{claimId}',
  summary: 'Get a claim with its supporting, contradicting and qualifying evidence',
  description:
    'Returns a claim\'s full detail: PICO fields, evidence grouped by relationship, an evidence timeline, related claims, annotations and review history. This operation does not modify anything.',
  tags: ['claims'],
  permission: 'claim.read',
  scopes: ['claim.read'],
  riskLevel: 'low',
  input: z.object({ claimId: z.string().uuid() }),
  handler: (input, { ctx }) => getClaim(ctx, input.claimId),
});

export const createClaimOperation = defineOperation({
  operationId: 'createClaim',
  method: 'POST',
  path: '/claims',
  summary: 'Create a claim, optionally with initial evidence',
  description: `Creates one atomic, checkable claim -- a specific proposition, not a general topic. Preserve the source's qualifiers rather than stating the claim more strongly than the evidence supports.

Attach evidence at creation via source_evidence, or add it afterward with addClaimEvidence. When citing a specific passage, pass its passage_id from a prior search so the excerpt and locator are taken from the actual text rather than typed freehand.

Do not create a claim from a source's cited background material, an author's opinion, or a recommendation -- those are not the source's own finding. This operation writes.`,
  gptDescription:
    "Creates one atomic, checkable claim -- not a topic -- preserving the source's own qualifiers. Attach evidence via source_evidence or addClaimEvidence afterward, using a real passage_id, not typed text. Never claim a source's cited background or opinion as its own finding. Writes.",
  tags: ['claims'],
  permission: 'claim.create',
  scopes: ['claim.write'],
  riskLevel: 'low',
  idempotent: true,
  input: z.object({
    canonical_text: z.string().min(15),
    simplified_text: z.string().nullish(),
    claim_type: z.string().optional(),
    topic: z.string().nullish(),
    population: z.string().nullish(),
    intervention: z.string().nullish(),
    comparator: z.string().nullish(),
    outcome: z.string().nullish(),
    timeframe: z.string().nullish(),
    context: z.string().nullish(),
    units: z.string().nullish(),
    quantitative_value: z.string().nullish(),
    safety_relevance: z.string().optional(),
    category_ids: z.array(z.string().uuid()).optional(),
    source_evidence: z
      .array(
        z.object({
          source_id: z.string().uuid(),
          relationship: z.enum([
            'supports', 'contradicts', 'qualifies', 'contextualizes', 'cites',
            'replicates', 'fails_to_replicate',
          ]),
          passage_id: z.string().uuid().nullish(),
          excerpt: z.string().nullish(),
          locator: z.string().nullish(),
        }),
      )
      .optional(),
  }),
  handler: (input, { ctx }) =>
    createClaim(ctx, {
      canonicalText: input.canonical_text,
      simplifiedText: input.simplified_text,
      claimType: input.claim_type,
      topic: input.topic,
      population: input.population,
      intervention: input.intervention,
      comparator: input.comparator,
      outcome: input.outcome,
      timeframe: input.timeframe,
      context: input.context,
      units: input.units,
      quantitativeValue: input.quantitative_value,
      safetyRelevance: input.safety_relevance,
      categoryIds: input.category_ids,
      sourceEvidence: input.source_evidence?.map((e) => ({
        sourceId: e.source_id,
        relationship: e.relationship,
        passageId: e.passage_id,
        excerpt: e.excerpt,
        locator: e.locator,
      })),
    }),
});

export const updateClaimOperation = defineOperation({
  operationId: 'updateClaim',
  method: 'PATCH',
  path: '/claims/{claimId}',
  summary: 'Edit a claim\'s text or PICO fields',
  description: `Updates a claim's wording or PICO fields. Does not change evidence status or clinical review status -- use reviewClaim for that.

Changing an approved or safety-relevant claim requires a server-issued confirmation, because the change may affect content already built on it; a not-yet-reviewed claim can be edited directly. Editing an approved claim also returns it to needs_re_review.

This operation writes.`,
  tags: ['claims'],
  permission: 'claim.update',
  scopes: ['claim.write'],
  riskLevel: 'medium',
  mayRequireConfirmation: true,
  input: ConfirmationInput.extend({
    claimId: z.string().uuid(),
    canonical_text: z.string().optional(),
    simplified_text: z.string().nullish(),
    claim_type: z.string().optional(),
    topic: z.string().nullish(),
    population: z.string().nullish(),
    intervention: z.string().nullish(),
    comparator: z.string().nullish(),
    outcome: z.string().nullish(),
    timeframe: z.string().nullish(),
    context: z.string().nullish(),
    units: z.string().nullish(),
    quantitative_value: z.string().nullish(),
    human_notes: z.string().nullish(),
    safety_relevance: z.string().optional(),
    expected_version: z.coerce.number().int().optional(),
  }),
  handler: (input, { ctx }) => {
    const { claimId, confirmation_id: confirmationId, expected_version: expectedVersion, ...updates } = input;
    const defined = Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined),
    );
    return updateClaim(ctx, claimId, defined, { expectedVersion, confirmationId });
  },
});

export const addClaimEvidenceOperation = defineOperation({
  operationId: 'addClaimEvidence',
  method: 'POST',
  path: '/claims/{claimId}/evidence',
  summary: 'Connect a source as evidence for a claim',
  description: `Attaches a source as supporting, contradicting, qualifying, contextualizing, citing, replicating or failing-to-replicate evidence for a claim.

When passage_id is supplied, the excerpt and locator come from the actual stored passage, not from typed text. This recomputes the claim's evidence status if it has not yet been reviewed by a human; if it has, the claim is flagged for re-review instead of being overridden.

This operation writes.`,
  gptDescription:
    'Attaches a source as supporting/contradicting/qualifying evidence for a claim. With passage_id, excerpt and locator come from the real stored passage. Recomputes evidence status if unreviewed; flags for re-review if already reviewed. Writes.',
  tags: ['claims'],
  permission: 'claim.update',
  scopes: ['claim.write'],
  riskLevel: 'low',
  input: z.object({
    claimId: z.string().uuid(),
    source_id: z.string().uuid(),
    relationship: z.enum([
      'supports', 'contradicts', 'qualifies', 'contextualizes', 'cites',
      'replicates', 'fails_to_replicate',
    ]),
    passage_id: z.string().uuid().nullish(),
    excerpt: z.string().nullish(),
    locator: z.string().nullish(),
    evidence_strength: z.string().nullish(),
  }),
  handler: (input, { ctx }) =>
    addClaimEvidence(ctx, input.claimId, {
      sourceId: input.source_id,
      relationship: input.relationship,
      passageId: input.passage_id,
      excerpt: input.excerpt,
      locator: input.locator,
      evidenceStrength: input.evidence_strength,
    }),
});

export const removeClaimEvidenceOperation = defineOperation({
  operationId: 'removeClaimEvidence',
  method: 'DELETE',
  path: '/claims/{claimId}/evidence/{evidenceId}',
  summary: 'Remove an evidence relationship from a claim',
  description: `Removes one evidence relationship. Removing evidence from a claim that has been clinically reviewed requires a server-issued confirmation, since it changes the basis of an approved position; evidence on an unreviewed claim can be removed directly.

This operation writes.`,
  tags: ['claims'],
  permission: 'claim.update',
  scopes: ['claim.write'],
  riskLevel: 'medium',
  mayRequireConfirmation: true,
  input: ConfirmationInput.extend({
    claimId: z.string().uuid(),
    evidenceId: z.string().uuid(),
  }),
  handler: (input, { ctx }) =>
    removeClaimEvidence(ctx, input.claimId, input.evidenceId, input.confirmation_id),
});

export const reviewClaimOperation = defineOperation({
  operationId: 'reviewClaim',
  method: 'POST',
  path: '/claims/{claimId}/review',
  summary: 'Record a human review decision on a claim',
  description: `Records a reviewer's decision on a claim's evidence status and clinical review status, with a required rationale.

Use this only when the acting user, holding claim.review, has actually made this determination -- never on your own initiative. This operation writes.`,
  tags: ['claims'],
  permission: 'claim.review',
  scopes: ['claim.review'],
  riskLevel: 'medium',
  input: z.object({
    claimId: z.string().uuid(),
    evidence_status: evidenceStatus,
    clinical_review_status: z.string().optional(),
    rationale: z.string().min(1),
    safety_notes: z.array(z.string()).optional(),
    safety_relevance: z.string().optional(),
    expected_version: z.coerce.number().int().optional(),
  }),
  handler: (input, { ctx }) =>
    reviewClaim(ctx, input.claimId, {
      evidenceStatus: input.evidence_status,
      clinicalReviewStatus: input.clinical_review_status,
      rationale: input.rationale,
      safetyNotes: input.safety_notes,
      safetyRelevance: input.safety_relevance,
      expectedVersion: input.expected_version,
    }),
});

export const analyzeClaimConflictsOperation = defineOperation({
  operationId: 'analyzeClaimConflicts',
  method: 'POST',
  path: '/claims/{claimId}/analyze-conflicts',
  summary: 'Compare a claim against related claims for potential contradictions',
  description: `Compares a claim against other claims covering similar ground and classifies each relationship: true contradiction, different population, different intervention intensity, different outcome, different time horizon, an added qualification, or a methodological disagreement.

These are suggestions for a human reviewer, never a settled verdict, and no claim status is changed by this call. This operation does not modify anything.`,
  gptDescription:
    'Compares a claim against similar claims, classifying each relationship (contradiction, different population/intervention/outcome/timeframe, qualification, methodology disagreement). Suggestions for a human reviewer only, never a verdict. Does not modify anything.',
  tags: ['claims'],
  permission: 'claim.read',
  scopes: ['claim.read'],
  riskLevel: 'low',
  input: z.object({
    claimId: z.string().uuid(),
    limit: z.coerce.number().int().min(1).max(25).optional(),
  }),
  handler: (input, { ctx }) => analyzeClaimConflicts(ctx, input.claimId, { limit: input.limit }),
});

export const archiveClaimOperation = defineOperation({
  operationId: 'archiveClaim',
  method: 'POST',
  path: '/claims/{claimId}/archive',
  summary: 'Archive a claim (reversible)',
  description:
    'Archives a claim. Its evidence links are kept and it can be restored. This is a high-risk action and requires a server-issued confirmation. This operation writes.',
  tags: ['claims'],
  permission: 'claim.archive',
  scopes: ['claim.write'],
  riskLevel: 'high',
  mayRequireConfirmation: true,
  input: ConfirmationInput.extend({ claimId: z.string().uuid() }),
  handler: (input, { ctx }) => archiveClaim(ctx, input.claimId, input.confirmation_id),
});

export const restoreClaimOperation = defineOperation({
  operationId: 'restoreClaim',
  method: 'POST',
  path: '/claims/{claimId}/restore',
  summary: 'Restore an archived claim',
  description: 'Returns an archived claim to active status. This operation writes.',
  tags: ['claims'],
  permission: 'claim.update',
  scopes: ['claim.write'],
  riskLevel: 'medium',
  input: z.object({ claimId: z.string().uuid() }),
  handler: (input, { ctx }) => restoreClaim(ctx, input.claimId),
});
