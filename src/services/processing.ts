import { withOrg, withoutOrg, type Sql } from '../lib/db';
import type { ActorContext } from '../lib/context';
import { requirePermission } from '../lib/context';
import { conflict, notFound } from '../lib/errors';
import { recordAudit } from './audit';

export type JobType =
  | 'ingest_source'
  | 'extract'
  | 'classify'
  | 'summarize'
  | 'study_metadata'
  | 'claims'
  | 'embeddings'
  | 'evidence_assessment'
  | 'research_job'
  | 'brief_generation'
  | 'content_generation'
  | 'content_check';

/**
 * The ordered stages of source enrichment.
 *
 * Each stage is enqueued as its own job so a failure in, say, claim
 * extraction does not discard a successful extraction and summary. Stages
 * can be re-run individually from the source's Processing tab.
 */
export const ENRICHMENT_STAGES: JobType[] = [
  'extract',
  'summarize',
  'classify',
  'study_metadata',
  'claims',
  'embeddings',
  'evidence_assessment',
];

export interface ProcessingJob {
  id: string;
  organization_id: string;
  source_id: string | null;
  research_job_id: string | null;
  brief_id: string | null;
  job_type: string;
  status: string;
  priority: number;
  attempt_count: number;
  max_attempts: number;
  progress: string;
  current_stage: string | null;
  stage_states: Record<string, unknown>;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  warnings: string[];
  error_code: string | null;
  error_message: string | null;
  /** The user who requested the work, so enrichment is attributable. */
  created_by: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueInput {
  jobType: JobType;
  sourceId?: string | null;
  researchJobId?: string | null;
  briefId?: string | null;
  input?: Record<string, unknown>;
  priority?: number;
  /**
   * When set, an identical job that is still queued or running will not
   * be enqueued again. This is what makes "reprocess" safe to click twice.
   */
  dedupeKey?: string | null;
  runAfter?: Date;
}

export async function enqueue(
  sql: Sql,
  ctx: ActorContext,
  input: EnqueueInput,
): Promise<{ id: string; deduped: boolean }> {
  if (input.dedupeKey) {
    const existing = await sql.one<{ id: string }>(
      `SELECT id FROM processing_jobs
       WHERE dedupe_key = $1 AND status IN ('queued','running')`,
      [input.dedupeKey],
    );
    if (existing) return { id: existing.id, deduped: true };
  }

  const row = await sql.one<{ id: string }>(
    `INSERT INTO processing_jobs (
       organization_id, source_id, research_job_id, brief_id, job_type,
       priority, input, dedupe_key, run_after, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      ctx.organizationId,
      input.sourceId ?? null,
      input.researchJobId ?? null,
      input.briefId ?? null,
      input.jobType,
      input.priority ?? 100,
      JSON.stringify(input.input ?? {}),
      input.dedupeKey ?? null,
      input.runAfter ?? new Date(),
      ctx.actorType === 'worker' ? null : ctx.userId,
    ],
  );

  return { id: row!.id, deduped: false };
}

export async function enqueueStandalone(
  ctx: ActorContext,
  input: EnqueueInput,
): Promise<{ id: string; deduped: boolean }> {
  return withOrg(ctx.organizationId, (sql) => enqueue(sql, ctx, input));
}

// ---------------------------------------------------------------------
// Worker queue operations
// ---------------------------------------------------------------------

/**
 * Claims the next runnable job.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes several workers safe to run
 * against one queue: each transaction takes a different row instead of
 * blocking on the same one.
 */
export async function claimNextJob(workerId: string): Promise<ProcessingJob | null> {
  return withoutOrg(async (sql) => {
    const rows = await sql.query<ProcessingJob>(
      `UPDATE processing_jobs
       SET status = 'running', locked_by = $1, locked_at = now(),
           started_at = coalesce(started_at, now()),
           attempt_count = attempt_count + 1, updated_at = now()
       WHERE id = (
         SELECT id FROM processing_jobs
         WHERE status = 'queued' AND run_after <= now()
         ORDER BY priority ASC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [workerId],
    );
    return rows[0] ?? null;
  });
}

/**
 * Returns jobs whose worker died mid-run to the queue. Without this a
 * crashed worker's jobs would sit in `running` forever.
 */
export async function reclaimStaleJobs(staleAfterMinutes = 15): Promise<number> {
  return withoutOrg(async (sql) => {
    const rows = await sql.query<{ id: string }>(
      `UPDATE processing_jobs
       SET status = CASE WHEN attempt_count >= max_attempts THEN 'dead_letter'::job_status
                         ELSE 'queued'::job_status END,
           locked_by = NULL, locked_at = NULL,
           error_code = CASE WHEN attempt_count >= max_attempts THEN 'WORKER_TIMEOUT' ELSE error_code END,
           error_message = CASE WHEN attempt_count >= max_attempts
                                THEN 'The worker processing this job stopped responding.'
                                ELSE error_message END,
           updated_at = now()
       WHERE status = 'running'
         AND locked_at < now() - ($1 || ' minutes')::interval
       RETURNING id`,
      [String(staleAfterMinutes)],
    );
    return rows.length;
  });
}

export async function markJobProgress(
  jobId: string,
  update: { stage?: string; progress?: number; stageStates?: Record<string, unknown> },
): Promise<void> {
  await withoutOrg((sql) =>
    sql.query(
      `UPDATE processing_jobs
       SET current_stage = coalesce($2, current_stage),
           progress = coalesce($3, progress),
           stage_states = CASE WHEN $4::jsonb IS NULL THEN stage_states
                               ELSE stage_states || $4::jsonb END,
           updated_at = now()
       WHERE id = $1`,
      [
        jobId,
        update.stage ?? null,
        update.progress ?? null,
        update.stageStates ? JSON.stringify(update.stageStates) : null,
      ],
    ),
  );
}

export async function completeJob(
  jobId: string,
  result: { output?: Record<string, unknown>; warnings?: string[] },
): Promise<void> {
  const warnings = result.warnings ?? [];
  await withoutOrg((sql) =>
    sql.query(
      `UPDATE processing_jobs
       SET status = $2::job_status, progress = 1, completed_at = now(),
           output = $3::jsonb, warnings = $4::jsonb,
           locked_by = NULL, locked_at = NULL, updated_at = now()
       WHERE id = $1`,
      [
        jobId,
        warnings.length > 0 ? 'completed_with_warnings' : 'completed',
        JSON.stringify(result.output ?? {}),
        JSON.stringify(warnings),
      ],
    ),
  );
}

/**
 * Records a failure and decides whether to retry.
 *
 * Retries use exponential backoff. A job that exhausts its attempts moves
 * to `dead_letter` rather than being silently dropped, so it stays
 * visible on the operations page for a human to act on.
 */
export async function failJob(
  jobId: string,
  error: { code: string; message: string; retryable: boolean },
): Promise<{ willRetry: boolean }> {
  return withoutOrg(async (sql) => {
    const job = await sql.one<{ attempt_count: number; max_attempts: number }>(
      `SELECT attempt_count, max_attempts FROM processing_jobs WHERE id = $1`,
      [jobId],
    );
    if (!job) return { willRetry: false };

    const willRetry = error.retryable && job.attempt_count < job.max_attempts;
    const backoffSeconds = Math.min(600, 2 ** job.attempt_count * 15);

    await sql.query(
      `UPDATE processing_jobs
       SET status = $2::job_status,
           error_code = $3, error_message = $4,
           run_after = CASE WHEN $5 THEN now() + ($6 || ' seconds')::interval ELSE run_after END,
           completed_at = CASE WHEN $5 THEN NULL ELSE now() END,
           locked_by = NULL, locked_at = NULL, updated_at = now()
       WHERE id = $1`,
      [
        jobId,
        willRetry ? 'queued' : job.attempt_count >= job.max_attempts ? 'dead_letter' : 'failed',
        error.code,
        error.message.slice(0, 2000),
        willRetry,
        String(backoffSeconds),
      ],
    );

    return { willRetry };
  });
}

// ---------------------------------------------------------------------
// API-facing reads and retries
// ---------------------------------------------------------------------

export async function getProcessingJob(
  ctx: ActorContext,
  jobId: string,
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'source.read');

  return withOrg(ctx.organizationId, async (sql) => {
    const job = await sql.one<ProcessingJob>(
      `SELECT * FROM processing_jobs WHERE id = $1 AND organization_id = $2`,
      [jobId, ctx.organizationId],
    );
    if (!job) throw notFound('processing job', jobId);

    // Siblings let a caller report overall pipeline state from one job id.
    const siblings = job.source_id
      ? await sql.query<{ job_type: string; status: string; error_message: string | null }>(
          `SELECT job_type, status, error_message FROM processing_jobs
           WHERE source_id = $1 AND organization_id = $2
           ORDER BY created_at`,
          [job.source_id, ctx.organizationId],
        )
      : [];

    return {
      id: job.id,
      job_type: job.job_type,
      status: job.status,
      current_stage: job.current_stage,
      progress: Number(job.progress),
      attempt_count: job.attempt_count,
      max_attempts: job.max_attempts,
      warnings: job.warnings,
      error_code: job.error_code,
      error_message: job.error_message,
      retryable: job.status === 'failed' || job.status === 'dead_letter',
      source_id: job.source_id,
      research_job_id: job.research_job_id,
      started_at: job.started_at,
      completed_at: job.completed_at,
      created_at: job.created_at,
      pipeline: siblings,
      dashboard_url: job.source_id ? `/library/${job.source_id}?tab=processing` : '/activity',
    };
  });
}

export async function listProcessingJobs(
  ctx: ActorContext,
  query: {
    status?: string[];
    jobType?: string;
    sourceId?: string;
    createdAfter?: string;
    limit?: number;
  } = {},
): Promise<Record<string, unknown>[]> {
  requirePermission(ctx, 'source.read');

  return withOrg(ctx.organizationId, async (sql) => {
    const params: unknown[] = [ctx.organizationId];
    const add = (v: unknown) => `$${params.push(v)}`;
    const where = ['organization_id = $1'];

    if (query.status?.length) where.push(`status = ANY(${add(query.status)}::job_status[])`);
    if (query.jobType) where.push(`job_type = ${add(query.jobType)}`);
    if (query.sourceId) where.push(`source_id = ${add(query.sourceId)}`);
    if (query.createdAfter) where.push(`created_at >= ${add(query.createdAfter)}`);

    return sql.query(
      `SELECT id, job_type, status, current_stage, progress, attempt_count,
              max_attempts, error_code, error_message, warnings, source_id,
              started_at, completed_at, created_at
       FROM processing_jobs
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ${add(Math.min(query.limit ?? 50, 200))}`,
      params,
    );
  });
}

export async function retryProcessingJob(
  ctx: ActorContext,
  jobId: string,
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'source.reprocess');

  return withOrg(ctx.organizationId, async (sql) => {
    const job = await sql.one<ProcessingJob>(
      `SELECT * FROM processing_jobs WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [jobId, ctx.organizationId],
    );
    if (!job) throw notFound('processing job', jobId);
    if (job.status === 'running') {
      throw conflict('This job is already running.', { status: job.status });
    }
    if (job.status === 'completed') {
      throw conflict('This job already completed. Reprocess the source instead.', {
        status: job.status,
      });
    }

    await sql.query(
      `UPDATE processing_jobs
       SET status = 'queued', attempt_count = 0, error_code = NULL,
           error_message = NULL, run_after = now(), completed_at = NULL,
           progress = 0, updated_at = now()
       WHERE id = $1`,
      [jobId],
    );

    await recordAudit(sql, ctx, {
      action: 'processing_job.retried',
      resourceType: 'processing_job',
      resourceId: jobId,
      previousState: { status: job.status, error_code: job.error_code },
      newState: { status: 'queued' },
    });

    return { id: jobId, status: 'queued', job_type: job.job_type };
  });
}

/** Queue health for the administrator operations page. */
export async function queueHealth(ctx: ActorContext): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'audit.read');

  return withOrg(ctx.organizationId, async (sql) => {
    const counts = await sql.query<{ status: string; count: number }>(
      `SELECT status::text, count(*)::int FROM processing_jobs
       WHERE organization_id = $1 GROUP BY status`,
      [ctx.organizationId],
    );

    const oldest = await sql.one<{ created_at: string | null }>(
      `SELECT min(created_at) AS created_at FROM processing_jobs
       WHERE organization_id = $1 AND status = 'queued'`,
      [ctx.organizationId],
    );

    const failures = await sql.query(
      `SELECT id, job_type, error_code, error_message, source_id, updated_at
       FROM processing_jobs
       WHERE organization_id = $1 AND status IN ('failed','dead_letter')
       ORDER BY updated_at DESC LIMIT 20`,
      [ctx.organizationId],
    );

    const cost = await sql.one<{ total: string | null; events: number }>(
      `SELECT sum(estimated_cost_usd)::text AS total, count(*)::int AS events
       FROM ai_usage_events
       WHERE organization_id = $1 AND created_at > now() - interval '30 days'`,
      [ctx.organizationId],
    );

    return {
      counts: Object.fromEntries(counts.map((c) => [c.status, c.count])),
      oldest_queued_at: oldest?.created_at ?? null,
      recent_failures: failures,
      ai_cost_last_30_days_usd: Number(cost?.total ?? 0),
      ai_events_last_30_days: cost?.events ?? 0,
    };
  });
}
