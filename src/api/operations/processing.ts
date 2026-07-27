import { z } from 'zod';
import { defineOperation } from '../registry';
import { getProcessingJob, listProcessingJobs, retryProcessingJob } from '../../services/processing';

export const getProcessingJobOperation = defineOperation({
  operationId: 'getProcessingJob',
  method: 'GET',
  path: '/processing-jobs/{jobId}',
  summary: 'Check the status of a processing job',
  description:
    'Returns a processing job\'s stage, progress, warnings and errors, plus every job in the same source\'s pipeline. Use this to report ingestion progress rather than assuming enrichment has finished. This operation does not modify anything.',
  tags: ['processing'],
  permission: 'source.read',
  scopes: ['source.read'],
  riskLevel: 'low',
  input: z.object({ jobId: z.string().uuid() }),
  handler: (input, { ctx }) => getProcessingJob(ctx, input.jobId),
});

export const listProcessingJobsOperation = defineOperation({
  operationId: 'listProcessingJobs',
  method: 'GET',
  path: '/processing-jobs',
  summary: 'List processing jobs, including failures',
  description: 'Lists processing jobs filtered by status, type, source or date. This operation does not modify anything.',
  tags: ['processing'],
  permission: 'source.read',
  scopes: ['source.read'],
  riskLevel: 'low',
  input: z.object({
    status: z.array(z.string()).optional(),
    job_type: z.string().optional(),
    source_id: z.string().uuid().optional(),
    created_after: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }),
  handler: (input, { ctx }) =>
    listProcessingJobs(ctx, {
      status: input.status,
      jobType: input.job_type,
      sourceId: input.source_id,
      createdAfter: input.created_after,
      limit: input.limit,
    }),
});

export const retryProcessingJobOperation = defineOperation({
  operationId: 'retryProcessingJob',
  method: 'POST',
  path: '/processing-jobs/{jobId}/retry',
  summary: 'Retry a failed or dead-lettered processing job',
  description:
    'Requeues a failed job from scratch. Cannot retry a job that is currently running or already completed. This operation writes.',
  tags: ['processing'],
  permission: 'source.reprocess',
  scopes: ['source.write'],
  riskLevel: 'low',
  input: z.object({ jobId: z.string().uuid() }),
  handler: (input, { ctx }) => retryProcessingJob(ctx, input.jobId),
});
