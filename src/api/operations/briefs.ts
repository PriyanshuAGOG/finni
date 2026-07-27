import { z } from 'zod';
import { defineOperation } from '../registry';
import {
  BRIEF_SECTIONS,
  BRIEF_TYPES,
  approveBrief,
  createBrief,
  exportBrief,
  generateBrief,
  getBrief,
  listBriefs,
  submitBriefForReview,
  updateBrief,
  updateBriefSources,
} from '../../services/brief';

const citationStyle = z.enum([
  'internal', 'numbered', 'apa', 'vancouver', 'harvard', 'url_list', 'doi_list', 'bibtex', 'ris',
]);

export const listResearchBriefsOperation = defineOperation({
  operationId: 'listResearchBriefs',
  method: 'GET',
  path: '/briefs',
  summary: 'List research briefs',
  description: 'Lists briefs, optionally filtered by status or type. This operation does not modify anything.',
  tags: ['briefs'],
  permission: 'brief.read',
  scopes: ['brief.read'],
  riskLevel: 'low',
  input: z.object({
    status: z.string().optional(),
    brief_type: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
  handler: (input, { ctx }) =>
    listBriefs(ctx, { status: input.status, briefType: input.brief_type, limit: input.limit }),
});

export const getResearchBriefOperation = defineOperation({
  operationId: 'getResearchBrief',
  method: 'GET',
  path: '/briefs/{briefId}',
  summary: 'Get a brief with its sources and version history',
  description: 'Returns a brief\'s content, attached sources and version history. This operation does not modify anything.',
  tags: ['briefs'],
  permission: 'brief.read',
  scopes: ['brief.read'],
  riskLevel: 'low',
  input: z.object({ briefId: z.string().uuid() }),
  handler: (input, { ctx }) => getBrief(ctx, input.briefId),
});

export const createResearchBriefOperation = defineOperation({
  operationId: 'createResearchBrief',
  method: 'POST',
  path: '/briefs',
  summary: 'Create a research brief and attach its source set',
  description: `Creates a brief record and resolves its evidence base from the given source_ids and/or collection_ids, filtered by approved_only. The source set is fixed at creation so the brief has a stable evidence base.

This does not write any brief text -- call generateResearchBrief afterward to draft the sections. This operation writes.`,
  tags: ['briefs'],
  permission: 'brief.create',
  scopes: ['brief.write'],
  riskLevel: 'low',
  idempotent: true,
  input: z.object({
    title: z.string().min(1),
    brief_type: z.enum(BRIEF_TYPES).optional(),
    research_question: z.string().nullish(),
    audience: z.string().optional(),
    source_ids: z.array(z.string().uuid()).optional(),
    collection_ids: z.array(z.string().uuid()).optional(),
    approved_only: z.boolean().optional(),
    include_contradictions: z.boolean().optional(),
    include_limitations: z.boolean().optional(),
    citation_style: citationStyle.optional(),
  }),
  handler: (input, { ctx }) =>
    createBrief(ctx, {
      title: input.title,
      briefType: input.brief_type,
      researchQuestion: input.research_question,
      audience: input.audience,
      sourceIds: input.source_ids,
      collectionIds: input.collection_ids,
      approvedOnly: input.approved_only,
      includeContradictions: input.include_contradictions,
      includeLimitations: input.include_limitations,
      citationStyle: input.citation_style,
    }),
});

export const generateResearchBriefOperation = defineOperation({
  operationId: 'generateResearchBrief',
  method: 'POST',
  path: '/briefs/{briefId}/generate',
  summary: 'Draft or regenerate a brief\'s sections from its sources',
  description: `Generates the requested sections (executive_summary, methodology, findings, contradictions, limitations, recommendations, safety_notes) from the brief's attached sources. Every factual statement is cited; a citation the model invented is stripped rather than kept.

A previous version is saved before overwriting. Cannot run on an approved brief -- editing an approved brief needs a new version via createResearchBrief.

This operation writes.`,
  tags: ['briefs'],
  permission: 'brief.update',
  scopes: ['brief.write'],
  riskLevel: 'low',
  input: z.object({
    briefId: z.string().uuid(),
    sections: z.array(z.enum(BRIEF_SECTIONS)).optional(),
  }),
  handler: (input, { ctx }) => generateBrief(ctx, input.briefId, { sections: input.sections }),
});

export const updateResearchBriefOperation = defineOperation({
  operationId: 'updateResearchBrief',
  method: 'PATCH',
  path: '/briefs/{briefId}',
  summary: 'Edit a brief\'s content or metadata directly',
  description: 'Updates a brief\'s title, question, or written sections directly. Editing an approved brief requires brief.approve. This operation writes.',
  tags: ['briefs'],
  permission: 'brief.update',
  scopes: ['brief.write'],
  riskLevel: 'medium',
  input: z.object({
    briefId: z.string().uuid(),
    title: z.string().optional(),
    research_question: z.string().nullish(),
    scope: z.string().nullish(),
    audience: z.string().optional(),
    executive_summary: z.string().nullish(),
    methodology: z.string().nullish(),
    findings: z.string().nullish(),
    conflicting_evidence: z.string().nullish(),
    limitations: z.string().nullish(),
    recommendations: z.string().nullish(),
    safety_notes: z.string().nullish(),
    citation_style: citationStyle.optional(),
    brief_type: z.enum(BRIEF_TYPES).optional(),
  }),
  handler: (input, { ctx }) => {
    const { briefId, ...updates } = input;
    const defined = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
    return updateBrief(ctx, briefId, defined);
  },
});

export const updateBriefSourcesOperation = defineOperation({
  operationId: 'updateBriefSources',
  method: 'POST',
  path: '/briefs/{briefId}/sources',
  summary: 'Add or remove sources from a brief\'s evidence base',
  description: 'Adds or removes sources from a brief\'s evidence base, respecting its approved_only setting. This operation writes.',
  tags: ['briefs'],
  permission: 'brief.update',
  scopes: ['brief.write'],
  riskLevel: 'medium',
  input: z.object({
    briefId: z.string().uuid(),
    add_source_ids: z.array(z.string().uuid()).optional(),
    remove_source_ids: z.array(z.string().uuid()).optional(),
  }),
  handler: (input, { ctx }) =>
    updateBriefSources(ctx, input.briefId, {
      addSourceIds: input.add_source_ids,
      removeSourceIds: input.remove_source_ids,
    }),
});

export const submitBriefForReviewOperation = defineOperation({
  operationId: 'submitBriefForReview',
  method: 'POST',
  path: '/briefs/{briefId}/submit-review',
  summary: 'Submit a draft brief for review',
  description: 'Moves a draft brief to in_review. Requires the brief to have content already. This operation writes.',
  tags: ['briefs'],
  permission: 'brief.update',
  scopes: ['brief.write'],
  riskLevel: 'medium',
  input: z.object({ briefId: z.string().uuid(), reviewer_id: z.string().uuid().nullish() }),
  handler: (input, { ctx }) => submitBriefForReview(ctx, input.briefId, input.reviewer_id),
});

export const approveResearchBriefOperation = defineOperation({
  operationId: 'approveResearchBrief',
  method: 'POST',
  path: '/briefs/{briefId}/approve',
  summary: 'Approve a brief',
  description: 'Marks a brief approved. Requires brief.approve. This operation writes.',
  tags: ['briefs'],
  permission: 'brief.approve',
  scopes: ['brief.write'],
  riskLevel: 'medium',
  input: z.object({ briefId: z.string().uuid(), note: z.string().optional() }),
  handler: (input, { ctx }) => approveBrief(ctx, input.briefId, input.note),
});

export const exportBriefOperation = defineOperation({
  operationId: 'exportResearchBrief',
  method: 'GET',
  path: '/briefs/{briefId}/export',
  summary: 'Export a brief as Markdown',
  description:
    'Renders a brief as a Markdown document with a numbered source list, suitable for download or pasting elsewhere. This operation does not modify anything.',
  tags: ['briefs'],
  permission: 'brief.read',
  scopes: ['brief.read'],
  riskLevel: 'low',
  input: z.object({ briefId: z.string().uuid() }),
  handler: (input, { ctx }) => exportBrief(ctx, input.briefId),
});
