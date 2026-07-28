import { z } from 'zod';
import { defineOperation } from '../registry';
import { effectivePermissions } from '../../lib/context';
import { searchKnowledge } from '../../services/search';
import {
  compareSources,
  findEvidence,
  findKnowledgeGaps,
  synthesizeKnowledge,
} from '../../services/synthesis';
import { withOrg } from '../../lib/db';

const reviewStatus = z.enum([
  'unreviewed', 'needs_review', 'in_review', 'approved',
  'approved_with_conditions', 'rejected', 'disputed', 'superseded',
]);

const evidenceStatus = z.enum([
  'supported', 'likely_supported', 'mixed', 'contested', 'contradicted',
  'insufficient_evidence', 'outdated', 'retracted_source_dependency', 'unreviewed',
]);

const SearchFiltersSchema = z
  .object({
    review_status: z.array(reviewStatus).optional(),
    source_types: z.array(z.string()).optional(),
    study_designs: z.array(z.string()).optional(),
    categories: z.array(z.string().uuid()).optional(),
    tags: z.array(z.string().uuid()).optional(),
    collection_ids: z.array(z.string().uuid()).optional(),
    source_ids: z.array(z.string().uuid()).optional(),
    authors: z.array(z.string()).optional(),
    publishers: z.array(z.string()).optional(),
    published_after: z.string().nullish(),
    published_before: z.string().nullish(),
    population: z.string().nullish(),
    intervention: z.string().nullish(),
    comparator: z.string().nullish(),
    outcome: z.string().nullish(),
    country: z.string().nullish(),
    language: z.string().nullish(),
    evidence_status: z.array(evidenceStatus).optional(),
  })
  .partial()
  .optional();

export const getCurrentUser = defineOperation({
  operationId: 'getCurrentUser',
  method: 'GET',
  path: '/me',
  summary: 'Get the authenticated user, their roles and their effective permissions',
  description: `Returns the identity this connection acts as, together with roles, granted scopes, effective permissions and preferences.

Use this when identity or permissions matter to what you are about to do -- for example before offering to approve a source or merge categories. Do not assume a permission the user has not been shown to hold, and do not use this to work around a FORBIDDEN response.

This operation does not modify anything.`,
  gptDescription:
    "Returns this connection's identity, roles, granted scopes and effective permissions. Use before assuming a permission the user hasn't been shown to hold. Does not modify anything.",
  tags: ['profile'],
  scopes: ['profile.read'],
  riskLevel: 'low',
  input: z.object({}),
  handler: async (_input, { ctx }) => {
    const details = await withOrg(ctx.organizationId, async (sql) => {
      const user = await sql.one<Record<string, unknown>>(
        `SELECT id, full_name, email, job_title, preferences, last_active_at FROM users WHERE id = $1`,
        [ctx.userId],
      );
      const roles = await sql.query<{ name: string; slug: string }>(
        `SELECT r.name, r.slug FROM user_roles ur JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = $1`,
        [ctx.userId],
      );
      const org = await sql.one<Record<string, unknown>>(
        `SELECT id, name, slug, timezone, default_language, settings
         FROM organizations WHERE id = $1`,
        [ctx.organizationId],
      );
      return { user, roles, org };
    });

    const preferences = (details.user?.preferences ?? {}) as Record<string, unknown>;

    return {
      user_id: ctx.userId,
      name: details.user?.full_name ?? ctx.userName,
      email: details.user?.email,
      job_title: details.user?.job_title,
      organization: {
        id: details.org?.id,
        name: details.org?.name,
        product_name:
          (details.org?.settings as Record<string, unknown>)?.product_name ??
          'Nirog Bhoomi Research OS',
        timezone: details.org?.timezone,
      },
      roles: details.roles,
      granted_scopes: ctx.scopes ? [...ctx.scopes] : 'first_party_session',
      effective_permissions: effectivePermissions(ctx),
      acting_via: ctx.sourceInterface,
      preferred_citation_style: preferences.citation_style ?? 'numbered',
      default_research_mode: preferences.research_mode ?? 'library_first',
    };
  },
});

export const searchKnowledgeOperation = defineOperation({
  operationId: 'searchKnowledge',
  method: 'POST',
  path: '/knowledge/search',
  summary: 'Search the internal library with natural language and structured filters',
  description: `Searches Nirog Bhoomi's own sources, claims, collections, annotations and briefs using hybrid retrieval (full-text, semantic, identifier, taxonomy and evidence-weighted ranking).

Use this whenever the user asks what the organization already knows, asks you to find saved research, or asks a substantive topic question that the library may cover. Always search before synthesizing, unless you already hold specific source ids.

This returns retrieval results with matched passages and locators. It does NOT write an answer -- use synthesizeKnowledge for that. It does NOT search the web; use previewExternalResearch or startResearchJob for external discovery.

Every result states its origin (internal_approved, internal_unreviewed or internal_archived). Never describe an unreviewed result as approved organizational evidence. This operation does not modify anything.`,
  gptDescription:
    'Hybrid search (full-text, semantic, taxonomy, evidence-weighted) over internal sources, claims, collections and briefs. Search before synthesizing. Returns passages with locators, never web results. Every result states origin (approved/unreviewed/archived) -- never call unreviewed approved.',
  tags: ['knowledge'],
  permission: 'knowledge.read',
  scopes: ['knowledge.read'],
  riskLevel: 'low',
  input: z.object({
    query: z.string().min(1).describe('The natural-language question or search terms.'),
    mode: z
      .enum(['library_only', 'library_first', 'web_discovery', 'evidence_review'])
      .optional()
      .describe('library_only restricts to approved internal sources by default.'),
    entity_types: z
      .array(z.enum(['sources', 'claims', 'collections', 'annotations', 'briefs']))
      .optional()
      .describe('Which record types to search. Defaults to sources.'),
    filters: SearchFiltersSchema,
    limit: z.coerce.number().int().min(1).max(50).optional(),
    include_passages: z.boolean().optional().describe('Return matching passages with locators.'),
    include_unreviewed: z
      .boolean()
      .optional()
      .describe('Include sources that have not been approved. They are labelled as such.'),
    include_archived: z.boolean().optional(),
    explain_ranking: z.boolean().optional().describe('Return the per-signal score breakdown.'),
  }),
  examples: {
    request: {
      query: 'What evidence do we have on post-meal walking and glucose?',
      mode: 'library_only',
      entity_types: ['sources', 'claims'],
      filters: { review_status: ['approved'] },
      limit: 20,
      include_passages: true,
    },
  },
  handler: (input, { ctx }) =>
    searchKnowledge(ctx, {
      query: input.query,
      mode: input.mode,
      entityTypes: input.entity_types,
      filters: {
        reviewStatus: input.filters?.review_status,
        sourceTypes: input.filters?.source_types,
        studyDesigns: input.filters?.study_designs,
        categoryIds: input.filters?.categories,
        tagIds: input.filters?.tags,
        collectionIds: input.filters?.collection_ids,
        sourceIds: input.filters?.source_ids,
        authors: input.filters?.authors,
        publishers: input.filters?.publishers,
        publishedAfter: input.filters?.published_after,
        publishedBefore: input.filters?.published_before,
        population: input.filters?.population,
        intervention: input.filters?.intervention,
        comparator: input.filters?.comparator,
        outcome: input.filters?.outcome,
        country: input.filters?.country,
        language: input.filters?.language,
        evidenceStatus: input.filters?.evidence_status,
      },
      limit: input.limit,
      includePassages: input.include_passages,
      includeUnreviewed: input.include_unreviewed,
      includeArchived: input.include_archived,
      explainRanking: input.explain_ranking,
    }),
});

export const synthesizeKnowledgeOperation = defineOperation({
  operationId: 'synthesizeKnowledge',
  method: 'POST',
  path: '/knowledge/synthesize',
  summary: 'Generate a cited answer from internal sources only',
  description: `Produces an evidence-backed answer built strictly from Nirog Bhoomi's own sources, with a citation for every factual statement.

Use this when the user wants an answer rather than a list of results -- a cited overview, a comparison across retrieved evidence, or a summary of contradictions and limitations. Search first unless you already know which source ids to use.

The service rejects any citation the model produced that is not in the retrieval context, so citations returned here always correspond to real passages. Statements whose citations were all invalid are dropped rather than shown uncited.

Defaults to approved sources only. Setting approved_only to false includes unreviewed material, which must then be described as unreviewed in your answer. This operation does not use the web and does not modify anything.`,
  gptDescription:
    'Produces a cited answer built only from internal sources; citations not matching a real retrieved passage are stripped. Search first unless you already hold source ids. Defaults to approved sources only; unreviewed material must be labeled as such if included.',
  tags: ['knowledge'],
  permission: 'knowledge.read',
  scopes: ['knowledge.read'],
  riskLevel: 'low',
  input: z.object({
    question: z.string().min(1),
    mode: z.enum(['library_only', 'library_first', 'evidence_review']).optional(),
    source_ids: z.array(z.string().uuid()).optional().describe('Restrict to these sources.'),
    collection_ids: z.array(z.string().uuid()).optional(),
    approved_only: z.boolean().optional().describe('Defaults to true.'),
    include_contradictions: z.boolean().optional(),
    include_limitations: z.boolean().optional(),
    include_safety_notes: z.boolean().optional(),
    citation_style: z
      .enum(['internal', 'numbered', 'apa', 'vancouver', 'harvard', 'url_list', 'doi_list', 'bibtex', 'ris'])
      .optional(),
    audience: z.string().optional(),
    max_sources: z.coerce.number().int().min(1).max(30).optional(),
  }),
  handler: (input, { ctx }) =>
    synthesizeKnowledge(ctx, {
      question: input.question,
      mode: input.mode,
      sourceIds: input.source_ids,
      collectionIds: input.collection_ids,
      approvedOnly: input.approved_only,
      includeContradictions: input.include_contradictions,
      includeLimitations: input.include_limitations,
      includeSafetyNotes: input.include_safety_notes,
      citationStyle: input.citation_style,
      audience: input.audience,
      maxSources: input.max_sources,
    }),
});

export const findEvidenceOperation = defineOperation({
  operationId: 'findEvidence',
  method: 'POST',
  path: '/knowledge/evidence',
  summary: 'Find supporting, contradicting or qualifying evidence for a claim or question',
  description: `Returns evidence relevant to a specific claim or question, separated into evidence that has been curated and reviewed (attached to a claim record) and evidence that is only a retrieval match.

Use this when the user asks whether something is supported, what contradicts it, or wants the exact passages behind a position. The distinction in the response matters: curated claim evidence has been reviewed by a person, passage evidence has not.

This does not create or modify claims. Use createClaim or addClaimEvidence for that.`,
  gptDescription:
    "Finds evidence for a claim/question, separating human-reviewed claim evidence from unreviewed retrieval matches -- say which is which. Does not create or modify claims; use createClaim/addClaimEvidence for that.",
  tags: ['knowledge'],
  permission: 'knowledge.read',
  scopes: ['knowledge.read'],
  riskLevel: 'low',
  input: z.object({
    claim_or_question: z.string().min(1),
    relationship: z.enum(['supporting', 'contradicting', 'qualifying', 'all']).optional(),
    approved_only: z.boolean().optional(),
    collection_ids: z.array(z.string().uuid()).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  }),
  handler: (input, { ctx }) =>
    findEvidence(ctx, {
      claimOrQuestion: input.claim_or_question,
      relationship: input.relationship,
      approvedOnly: input.approved_only,
      collectionIds: input.collection_ids,
      limit: input.limit,
    }),
});

export const compareSourcesOperation = defineOperation({
  operationId: 'compareSources',
  method: 'POST',
  path: '/knowledge/compare',
  summary: 'Compare two to eight sources across methodology dimensions',
  description: `Builds a side-by-side comparison of the selected sources across study design, population, intervention, comparator, duration, outcomes, findings, limitations, funding and conflicts of interest.

Use this when the user asks how studies differ, which is stronger, or why two sources seem to disagree. The response names which sources have no data for each dimension, and flags whether the study metadata was human-verified or only auto-extracted.

Requires between two and eight source ids. This operation does not modify anything.`,
  gptDescription:
    'Side-by-side comparison of 2-8 sources across design, population, intervention, outcomes, funding and conflicts of interest. Flags whether metadata was human-verified or auto-extracted. Does not modify anything.',
  tags: ['knowledge'],
  permission: 'knowledge.read',
  scopes: ['knowledge.read'],
  riskLevel: 'low',
  input: z.object({
    source_ids: z.array(z.string().uuid()).min(2).max(8),
    comparison_dimensions: z.array(z.string()).optional(),
  }),
  handler: (input, { ctx }) =>
    compareSources(ctx, {
      sourceIds: input.source_ids,
      dimensions: input.comparison_dimensions,
    }),
});

export const findKnowledgeGapsOperation = defineOperation({
  operationId: 'findKnowledgeGaps',
  method: 'POST',
  path: '/knowledge/gaps',
  summary: 'Identify what the library is missing on a topic',
  description: `Analyses the library's coverage of a topic and reports structural gaps: missing study designs, absent recent work, no population relevant to Nirog Bhoomi's audience, small samples, or missing study metadata.

Use this when the user asks what research is missing, where the evidence is thin, or what to research next. Note that a reported gap can reflect missing metadata rather than missing research; the response says which.

This operation does not modify anything.`,
  tags: ['knowledge'],
  permission: 'knowledge.read',
  scopes: ['knowledge.read'],
  riskLevel: 'low',
  input: z.object({
    topic: z.string().min(1),
    collection_ids: z.array(z.string().uuid()).optional(),
    approved_only: z.boolean().optional(),
    dimensions: z
      .array(z.enum(['population', 'intervention', 'outcomes', 'geography', 'study_design', 'recency']))
      .optional(),
  }),
  handler: (input, { ctx }) =>
    findKnowledgeGaps(ctx, {
      topic: input.topic,
      collectionIds: input.collection_ids,
      approvedOnly: input.approved_only,
      dimensions: input.dimensions,
    }),
});
