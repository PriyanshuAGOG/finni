import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { getEnv } from '../lib/env';
import { closePool, withOrg, withoutOrg } from '../lib/db';
import { ApiError } from '../lib/errors';
import {
  claimNextJob,
  completeJob,
  failJob,
  reclaimStaleJobs,
  type ProcessingJob,
} from '../services/processing';
import { HANDLERS, contextForJob } from './handlers';

const WORKER_ID = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;

function log(level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown> = {}) {
  // Structured single-line JSON so logs are queryable in any collector.
  console.log(
    JSON.stringify({
      level,
      time: new Date().toISOString(),
      worker: WORKER_ID,
      msg: message,
      ...fields,
    }),
  );
}

let shuttingDown = false;
let activeJobs = 0;

async function runJob(job: ProcessingJob): Promise<void> {
  const requestId = `job_${job.id.slice(0, 8)}`;
  const ctx = contextForJob(job, requestId);
  const started = Date.now();

  log('info', 'job started', { job_id: job.id, job_type: job.job_type, source_id: job.source_id });

  const handler = HANDLERS[job.job_type];
  if (!handler) {
    await failJob(job.id, {
      code: 'UNKNOWN_JOB_TYPE',
      message: `No handler is registered for job type "${job.job_type}".`,
      retryable: false,
    });
    log('error', 'no handler for job type', { job_id: job.id, job_type: job.job_type });
    return;
  }

  try {
    const result = await handler(job, ctx);
    await completeJob(job.id, result);

    if (job.source_id) await settleSourceStatus(job.organization_id, job.source_id);

    log('info', 'job completed', {
      job_id: job.id,
      job_type: job.job_type,
      duration_ms: Date.now() - started,
      warnings: result.warnings.length,
    });
  } catch (err) {
    const apiError = err instanceof ApiError ? err : null;
    const { willRetry } = await failJob(job.id, {
      code: apiError?.code ?? 'INTERNAL_ERROR',
      message: err instanceof Error ? err.message : 'Unknown error',
      // Anything not explicitly non-retryable gets another attempt: a
      // transient network or model failure should not need a human.
      retryable: apiError ? apiError.retryable : true,
    });

    if (job.source_id && !willRetry) {
      await markSourceFailed(job.organization_id, job.source_id, job.job_type);
    }

    log(willRetry ? 'warn' : 'error', 'job failed', {
      job_id: job.id,
      job_type: job.job_type,
      error_code: apiError?.code ?? 'INTERNAL_ERROR',
      error: err instanceof Error ? err.message : String(err),
      will_retry: willRetry,
      attempt: job.attempt_count,
    });
  }
}

/**
 * Derives a source's overall processing status from its stage jobs, so
 * the Research Inbox reflects the pipeline rather than the last stage
 * that happened to finish.
 */
async function settleSourceStatus(organizationId: string, sourceId: string): Promise<void> {
  await withOrg(organizationId, async (sql) => {
    const counts = await sql.one<{
      pending: number;
      failed: number;
      warned: number;
      total: number;
    }>(
      `SELECT count(*) FILTER (WHERE status IN ('queued','running'))::int AS pending,
              count(*) FILTER (WHERE status IN ('failed','dead_letter'))::int AS failed,
              count(*) FILTER (WHERE status = 'completed_with_warnings')::int AS warned,
              count(*)::int AS total
       FROM processing_jobs WHERE source_id = $1`,
      [sourceId],
    );

    if (!counts || counts.pending > 0) return;

    const status =
      counts.failed > 0
        ? 'completed_with_warnings'
        : counts.warned > 0
          ? 'completed_with_warnings'
          : 'completed';

    await sql.query(
      `UPDATE sources SET processing_status = $1::processing_status, updated_at = now()
       WHERE id = $2 AND processing_status NOT IN ('completed','failed')`,
      [status, sourceId],
    );
  });
}

async function markSourceFailed(
  organizationId: string,
  sourceId: string,
  stage: string,
): Promise<void> {
  await withOrg(organizationId, async (sql) => {
    const remaining = await sql.one<{ pending: number }>(
      `SELECT count(*) FILTER (WHERE status IN ('queued','running'))::int AS pending
       FROM processing_jobs WHERE source_id = $1`,
      [sourceId],
    );
    // A single failed stage is a partial success, not a failed source:
    // extraction and summary may be perfectly usable without claims.
    if ((remaining?.pending ?? 0) > 0) return;

    const succeeded = await sql.one<{ completed: number }>(
      `SELECT count(*) FILTER (WHERE status IN ('completed','completed_with_warnings'))::int AS completed
       FROM processing_jobs WHERE source_id = $1`,
      [sourceId],
    );

    await sql.query(
      `UPDATE sources
       SET processing_status = $1::processing_status,
           metadata = metadata || jsonb_build_object('last_failed_stage', $2::text),
           updated_at = now()
       WHERE id = $3`,
      [(succeeded?.completed ?? 0) > 0 ? 'completed_with_warnings' : 'failed', stage, sourceId],
    );
  });
}

async function loop(): Promise<void> {
  const env = getEnv();
  const concurrency = env.WORKER_CONCURRENCY;
  const pollInterval = env.WORKER_POLL_INTERVAL_MS;

  log('info', 'worker started', { concurrency, poll_interval_ms: pollInterval });

  // Periodically return jobs abandoned by a dead worker.
  const reclaimTimer = setInterval(() => {
    reclaimStaleJobs()
      .then((count) => {
        if (count > 0) log('warn', 'reclaimed stale jobs', { count });
      })
      .catch((err) => log('error', 'reclaim failed', { error: String(err) }));
  }, 60_000);
  reclaimTimer.unref?.();

  while (!shuttingDown) {
    if (activeJobs >= concurrency) {
      await sleep(50);
      continue;
    }

    let job: ProcessingJob | null = null;
    try {
      job = await claimNextJob(WORKER_ID);
    } catch (err) {
      log('error', 'failed to claim a job', { error: String(err) });
      await sleep(pollInterval * 5);
      continue;
    }

    if (!job) {
      await sleep(pollInterval);
      continue;
    }

    activeJobs += 1;
    void runJob(job)
      .catch((err) => log('error', 'unhandled job error', { error: String(err) }))
      .finally(() => {
        activeJobs -= 1;
      });
  }

  clearInterval(reclaimTimer);

  // Let in-flight work finish before the process exits, so a deploy does
  // not leave half-processed sources behind.
  const deadline = Date.now() + 30_000;
  while (activeJobs > 0 && Date.now() < deadline) await sleep(200);

  log('info', 'worker stopped', { unfinished_jobs: activeJobs });
  await closePool();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1);
    log('info', 'shutdown signal received, draining', { signal });
    shuttingDown = true;
  });
}

/** Liveness probe for the worker process. */
export async function workerHealth(): Promise<{ ok: boolean; queued: number; running: number }> {
  return withoutOrg(async (sql) => {
    const row = await sql.one<{ queued: number; running: number }>(
      `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
              count(*) FILTER (WHERE status = 'running')::int AS running
       FROM processing_jobs`,
    );
    return { ok: true, queued: row?.queued ?? 0, running: row?.running ?? 0 };
  });
}

loop().catch((err) => {
  log('error', 'worker crashed', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
