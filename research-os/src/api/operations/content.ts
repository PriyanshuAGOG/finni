import { z } from 'zod';
import { defineOperation } from '../registry';
import { CONTENT_TYPES, generateContent, getGeneratedContent, regenerateContentSection, updateGeneratedContent, validateContentCitations } from '../../services/content';

const citationStyle = z.enum([
  'internal', 'numbered', 'apa', 'vancouver', 'harvard', 'url_list', 'doi_list', 'bibtex', 'ris',
]);

export const generateEvidenceBasedContentOperation = defineOperation({
  operationId: 'generateEvidenceBasedContent',
  method: 'POST',
  path: '/content/generate',
  summary: 'Draft content from library sources with citations',
  description: `Drafts content (blog article, patient guide, FAQ, video script, social post, newsletter, training notes, presentation outline, or research summary) built from cited library passages.

Defaults to approved sources only (source_policy approved_only). Using approved_preferred or any_internal includes unreviewed material and the response will flag it; do not publish that as approved Nirog Bhoomi guidance without review.

Every factual statement in the body carries a citation marker verified against the retrieval context; anything the model could not support is returned separately as unsupported_claims rather than left uncited in the body. Health-facing content requires review by a qualified reviewer before publication -- always say so.

This operation writes and creates a content record.`,
  tags: ['content'],
  permission: 'content.generate',
  scopes: ['content.generate'],
  riskLevel: 'low',
  idempotent: true,
  input: z.object({
    title: z.string().min(1),
    content_type: z.enum(CONTENT_TYPES),
    audience: z.string().optional(),
    instructions: z.string().nullish(),
    target_length: z.coerce.number().int().positive().optional(),
    source_policy: z.enum(['approved_only', 'approved_preferred', 'any_internal']).optional(),
    source_ids: z.array(z.string().uuid()).optional(),
    collection_ids: z.array(z.string().uuid()).optional(),
    citation_style: citationStyle.optional(),
    include_safety_notes: z.boolean().optional(),
    brand_guidance: z.string().nullish(),
    prohibited_claims: z.array(z.string()).optional(),
  }),
  handler: (input, { ctx }) =>
    generateContent(ctx, {
      title: input.title,
      contentType: input.content_type,
      audience: input.audience,
      instructions: input.instructions,
      targetLength: input.target_length,
      sourcePolicy: input.source_policy,
      sourceIds: input.source_ids,
      collectionIds: input.collection_ids,
      citationStyle: input.citation_style,
      includeSafetyNotes: input.include_safety_notes,
      brandGuidance: input.brand_guidance,
      prohibitedClaims: input.prohibited_claims,
    }),
});

export const getGeneratedContentOperation = defineOperation({
  operationId: 'getGeneratedContent',
  method: 'GET',
  path: '/content/{contentId}',
  summary: 'Get a generated content record with its citation mapping',
  description: 'Returns a content draft with its full citation mapping back to sources. This operation does not modify anything.',
  tags: ['content'],
  permission: 'content.generate',
  scopes: ['content.generate'],
  riskLevel: 'low',
  input: z.object({ contentId: z.string().uuid() }),
  handler: (input, { ctx }) => getGeneratedContent(ctx, input.contentId),
});

export const updateGeneratedContentOperation = defineOperation({
  operationId: 'updateGeneratedContent',
  method: 'PATCH',
  path: '/content/{contentId}',
  summary: 'Edit or approve generated content',
  description: 'Updates a content draft\'s title, body, audience or status. Setting status to approved requires content.approve. This operation writes.',
  tags: ['content'],
  permission: 'content.generate',
  scopes: ['content.generate'],
  riskLevel: 'medium',
  input: z.object({
    contentId: z.string().uuid(),
    title: z.string().optional(),
    body: z.string().optional(),
    status: z.string().optional(),
    audience: z.string().optional(),
  }),
  handler: (input, { ctx }) => {
    const { contentId, ...updates } = input;
    return updateGeneratedContent(ctx, contentId, updates);
  },
});

export const regenerateContentSectionOperation = defineOperation({
  operationId: 'regenerateContentSection',
  method: 'POST',
  path: '/content/{contentId}/regenerate-section',
  summary: 'Regenerate one section of a content draft',
  description: 'Redrafts a single named section using the content\'s already-cited sources, replacing that section only. This operation writes.',
  tags: ['content'],
  permission: 'content.generate',
  scopes: ['content.generate'],
  riskLevel: 'medium',
  input: z.object({
    contentId: z.string().uuid(),
    heading: z.string().min(1),
    instructions: z.string().optional(),
  }),
  handler: (input, { ctx }) =>
    regenerateContentSection(ctx, input.contentId, {
      heading: input.heading,
      instructions: input.instructions,
    }),
});

export const validateContentCitationsOperation = defineOperation({
  operationId: 'validateContentCitations',
  method: 'POST',
  path: '/content/{contentId}/validate',
  summary: 'Check a content draft\'s statements against its cited sources',
  description: `Independently re-checks each cited statement in a content draft against the text of the passage it cites, and flags any factual statement carrying no citation at all.

Returns supported, weakly supported and unsupported statements, citation marker mismatches, and safety review flags including absolute or guaranteeing language. Use this before recommending that content be published, and always surface unsupported or weakly supported statements to the user.

This operation does not modify anything.`,
  tags: ['content'],
  permission: 'content.generate',
  scopes: ['content.generate'],
  riskLevel: 'low',
  input: z.object({ contentId: z.string().uuid() }),
  handler: (input, { ctx }) => validateContentCitations(ctx, input.contentId),
});
