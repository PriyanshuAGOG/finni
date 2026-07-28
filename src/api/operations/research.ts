import { z } from 'zod';
import { defineOperation } from '../registry';
import { ConfirmationInput } from '../handler';
import {
  cancelResearchJob,
  getResearchJob,
  listResearchCandidates,
  listResearchJobs,
  previewExternalResearch,
  previewExternalSource,
  selectResearchCandidates,
  startResearchJob,
} from '../../services/research';

const ResearchSpecFields = {
  title: z.string().optional(),
  research_question: z.string().min(1),
  instructions: z.string().nullish(),
  search_scope: z.enum(['internal', 'external', 'combined']).optional(),
  date_range: z.object({ from: z.string().nullish(), to: z.string().nullish() }).optional(),
  source_types: z.array(z.string()).optional(),
  study_designs: z.array(z.string()).optional(),
  population: z.string().nullish(),
  intervention: z.string().nullish(),
  outcomes: z.array(z.string()).optional(),
  geography: z.array(z.string()).optional(),
  inclusion_criteria: z.array(z.string()).optional(),
  exclusion_criteria: z.array(z.string()).optional(),
  maximum_candidates: z.coerce.number().int().min(1).max(100).optional(),
};

function toSpec(input: Record<string, unknown>) {
  return {
    title: input.title as string | undefined,
    researchQuestion: input.research_question as string,
    instructions: input.instructions as string | null | undefined,
    searchScope: input.search_scope as 'internal' | 'external' | 'combined' | undefined,
    dateRange: input.date_range as { from?: string; to?: string } | undefined,
    sourceTypes: input.source_types as string[] | undefined,
    studyDesigns: input.study_designs as string[] | undefined,
    population: input.population as string | null | undefined,
    intervention: input.intervention as string | null | undefined,
    outcomes: input.outcomes as string[] | undefined,
    geography: input.geography as string[] | undefined,
    inclusionCriteria: input.inclusion_criteria as string[] | undefined,
    exclusionCriteria: input.exclusion_criteria as string[] | undefined,
    maximumCandidates: input.maximum_candidates as number | undefined,
  };
}

export const previewExternalResearchOperation = defineOperation({
  operationId: 'previewExternalResearch',
  method: 'POST',
  path: '/research-jobs/preview',
  summary: 'Search external sources without saving anything',
  description: `Searches PubMed and, if configured, a general web provider for candidate sources matching a research question, and reports what the internal library already holds on the same topic.

Use this for a bounded, quick external look before deciding whether a full research job is warranted, or to show the user candidates before saving any. Nothing is written to the library by this call.

Every candidate is external_web and is explicitly not approved Nirog Bhoomi evidence -- never present a candidate as though it were.`,
  gptDescription:
    'Bounded external search (PubMed + configured web provider) for candidates on a topic, plus what the library already holds. Every candidate is external_web, unreviewed -- never present as approved evidence. Writes nothing.',
  tags: ['research'],
  permission: 'research.run',
  scopes: ['research.run'],
  riskLevel: 'low',
  input: z.object(ResearchSpecFields).omit({ title: true }),
  handler: (input, { ctx }) => previewExternalResearch(ctx, toSpec(input)),
});

export const previewExternalSourceOperation = defineOperation({
  operationId: 'previewExternalSource',
  method: 'POST',
  path: '/research-jobs/source-preview',
  summary: 'Preview one external URL before ingesting it',
  description:
    'Fetches and extracts a single external URL to preview its metadata and duplicate status without saving it. Use this to show the user what ingestUrl would produce before committing. Nothing is saved.',
  tags: ['research'],
  permission: 'research.run',
  scopes: ['research.run'],
  riskLevel: 'low',
  input: z.object({ url: z.string().min(1) }),
  handler: (input, { ctx }) => previewExternalSource(ctx, input.url),
});

export const startResearchJobOperation = defineOperation({
  operationId: 'startResearchJob',
  method: 'POST',
  path: '/research-jobs',
  summary: 'Start an asynchronous, multi-query research job',
  description: `Starts a background research job: expands the question into several search queries, searches internal and/or external sources per search_scope, and records candidates for review. Optionally creates a collection up front.

Use this for a broad or multi-step research request, where several candidate sources need evaluating against inclusion and exclusion criteria, rather than for a single quick lookup (use previewExternalResearch or searchKnowledge for that).

This does not ingest anything by itself unless automatically_ingest_selected is set and candidates are later selected via selectResearchCandidates. Report the job as queued; check getResearchJob for progress rather than assuming completion.

This operation writes and is idempotent when given an Idempotency-Key.`,
  gptDescription:
    'Starts a background research job: expands the question into queries, searches internal/external sources, records candidates for review. Use for broad multi-step research, not a quick lookup. Nothing is ingested unless candidates are later selected. Writes; idempotent with a key.',
  tags: ['research'],
  permission: 'research.run',
  scopes: ['research.run'],
  riskLevel: 'low',
  idempotent: true,
  input: z.object({
    ...ResearchSpecFields,
    create_collection: z.boolean().optional(),
    collection_name: z.string().nullish(),
    automatically_ingest_selected: z.boolean().optional(),
  }),
  handler: (input, { ctx }) =>
    startResearchJob(ctx, {
      ...toSpec(input),
      createCollection: input.create_collection,
      collectionName: input.collection_name,
      automaticallyIngestSelected: input.automatically_ingest_selected,
    }),
});

export const getResearchJobOperation = defineOperation({
  operationId: 'getResearchJob',
  method: 'GET',
  path: '/research-jobs/{researchJobId}',
  summary: 'Get a research job\'s status and candidate counts',
  description:
    'Returns a research job\'s current status, progress and candidate counts by decision. Use this to report progress rather than assuming a job has finished. This operation does not modify anything.',
  tags: ['research'],
  permission: 'research.run',
  scopes: ['research.run'],
  riskLevel: 'low',
  input: z.object({ researchJobId: z.string().uuid() }),
  handler: (input, { ctx }) => getResearchJob(ctx, input.researchJobId),
});

export const listResearchJobsOperation = defineOperation({
  operationId: 'listResearchJobs',
  method: 'GET',
  path: '/research-jobs',
  summary: 'List research jobs',
  description: 'Lists research jobs, optionally filtered by status. This operation does not modify anything.',
  tags: ['research'],
  permission: 'research.run',
  scopes: ['research.run'],
  riskLevel: 'low',
  input: z.object({
    status: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
  handler: (input, { ctx }) => listResearchJobs(ctx, { status: input.status, limit: input.limit }),
});

export const listResearchCandidatesOperation = defineOperation({
  operationId: 'listResearchCandidates',
  method: 'GET',
  path: '/research-jobs/{researchJobId}/candidates',
  summary: 'List a research job\'s candidate sources',
  description:
    'Lists the external candidates a research job found, with relevance, duplicate status and current decision. This operation does not modify anything.',
  tags: ['research'],
  permission: 'research.run',
  scopes: ['research.run'],
  riskLevel: 'low',
  input: z.object({
    researchJobId: z.string().uuid(),
    decision: z.enum(['pending', 'included', 'excluded']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }),
  handler: (input, { ctx }) =>
    listResearchCandidates(ctx, input.researchJobId, { decision: input.decision, limit: input.limit }),
});

export const selectResearchCandidatesOperation = defineOperation({
  operationId: 'selectResearchCandidates',
  method: 'POST',
  path: '/research-jobs/{researchJobId}/candidates/select',
  summary: 'Include or exclude research candidates, optionally ingesting the included ones',
  description: `Marks candidates as included or excluded, with a reason for each exclusion. When ingest_included is true, included candidates are saved to the library via the normal ingestion path and added to the job's collection if one exists.

Do not select and ingest every candidate automatically unless the user has given clear criteria authorizing that. Report duplicates and failures explicitly. Ingested sources are unreviewed, never approved evidence.

This operation writes.`,
  gptDescription:
    "Marks research candidates included/excluded with a reason each. If ingest_included is true, included ones are saved via the normal ingestion path. Never auto-select/ingest everything without explicit user criteria. Writes.",
  tags: ['research'],
  permission: 'research.run',
  scopes: ['research.run', 'source.write'],
  riskLevel: 'low',
  idempotent: true,
  input: z.object({
    researchJobId: z.string().uuid(),
    include_candidate_ids: z.array(z.string().uuid()).optional(),
    exclude: z
      .array(z.object({ candidate_id: z.string().uuid(), reason: z.string().min(1) }))
      .optional(),
    ingest_included: z.boolean().optional(),
    add_to_collection_id: z.string().uuid().nullish(),
  }),
  handler: (input, { ctx }) =>
    selectResearchCandidates(ctx, input.researchJobId, {
      includeCandidateIds: input.include_candidate_ids,
      exclude: input.exclude?.map((e) => ({ candidateId: e.candidate_id, reason: e.reason })),
      ingestIncluded: input.ingest_included,
      addToCollectionId: input.add_to_collection_id,
    }),
});

export const cancelResearchJobOperation = defineOperation({
  operationId: 'cancelResearchJob',
  method: 'POST',
  path: '/research-jobs/{researchJobId}/cancel',
  summary: 'Cancel a running or queued research job',
  description: `Cancels a research job. Candidates already found are kept; only further searching stops.

Cancelling a job that has already produced candidates requires a server-issued confirmation, since it discards work in progress; cancelling one that produced nothing yet may proceed directly.

This operation writes.`,
  tags: ['research'],
  permission: 'research.run',
  scopes: ['research.run'],
  riskLevel: 'medium',
  mayRequireConfirmation: true,
  input: ConfirmationInput.extend({ researchJobId: z.string().uuid() }),
  handler: (input, { ctx }) => cancelResearchJob(ctx, input.researchJobId, input.confirmation_id),
});
