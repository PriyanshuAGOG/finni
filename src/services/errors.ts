import { withoutOrg } from '../lib/db';
import type { ActorContext, SourceInterface } from '../lib/context';
import { requirePermission } from '../lib/context';
import { notFound } from '../lib/errors';

export type ErrorLogOrigin = 'api_server' | 'dashboard_client' | 'worker';
export type ErrorLogSeverity = 'warning' | 'error' | 'fatal';

export interface LogErrorInput {
  origin: ErrorLogOrigin;
  severity: ErrorLogSeverity;
  message: string;
  stack?: string | null;
  componentStack?: string | null;
  organizationId?: string | null;
  userId?: string | null;
  sourceInterface?: SourceInterface | null;
  requestId?: string | null;
  operationId?: string | null;
  errorCode?: string | null;
  path?: string | null;
  method?: string | null;
  statusCode?: number | null;
  url?: string | null;
  userAgent?: string | null;
  context?: Record<string, unknown>;
}

const MAX_TEXT = 8000;
const truncate = (value: string | null | undefined): string | null =>
  value == null ? null : value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}… [truncated]` : value;

/**
 * Records one error so it survives past the current serverless invocation
 * and is reviewable from the dashboard, not just a Vercel log line.
 *
 * Never throws: a bug in error logging must not mask, or replace, the
 * error being logged. Every call site fires this and moves on.
 */
export async function logError(input: LogErrorInput): Promise<void> {
  try {
    await withoutOrg((sql) =>
      sql.query(
        `INSERT INTO error_logs (
           organization_id, user_id, origin, severity, source_interface, message, stack,
           component_stack, request_id, operation_id, error_code, path, method, status_code,
           url, user_agent, context
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)`,
        [
          input.organizationId ?? null,
          input.userId ?? null,
          input.origin,
          input.severity,
          input.sourceInterface ?? null,
          truncate(input.message) ?? '(no message)',
          truncate(input.stack),
          truncate(input.componentStack),
          input.requestId ?? null,
          input.operationId ?? null,
          input.errorCode ?? null,
          input.path ?? null,
          input.method ?? null,
          input.statusCode ?? null,
          input.url ?? null,
          input.userAgent ?? null,
          JSON.stringify(input.context ?? {}),
        ],
      ),
    );
  } catch (loggingErr) {
    // The database itself may be the thing that's down. Fall back to
    // stdout so the failure is still visible in platform logs.
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'failed to persist error_logs row',
        original_message: input.message,
        logging_error: loggingErr instanceof Error ? loggingErr.message : String(loggingErr),
      }),
    );
  }
}

export interface ErrorLogQuery {
  severity?: ErrorLogSeverity;
  origin?: ErrorLogOrigin;
  resolved?: boolean;
  createdAfter?: string;
  cursor?: string;
  limit?: number;
}

export interface ErrorLogRecord {
  id: string;
  origin: ErrorLogOrigin;
  severity: ErrorLogSeverity;
  source_interface: string | null;
  message: string;
  stack: string | null;
  component_stack: string | null;
  request_id: string | null;
  operation_id: string | null;
  error_code: string | null;
  path: string | null;
  method: string | null;
  status_code: number | null;
  url: string | null;
  user_agent: string | null;
  context: Record<string, unknown>;
  resolved: boolean;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  created_at: string;
}

/**
 * Errors are written without an organization context on purpose (a
 * failure can happen before authentication resolves one), so reads are
 * scoped in application code rather than by row-level security: an org's
 * admins see their own organization's errors plus the unattributed ones
 * (failed logins, malformed requests) nobody else could see either.
 */
export async function listErrorLogs(
  ctx: ActorContext,
  query: ErrorLogQuery,
): Promise<{ items: ErrorLogRecord[]; nextCursor: string | null }> {
  requirePermission(ctx, 'audit.read');

  const limit = Math.min(query.limit ?? 25, 100);
  const params: unknown[] = [];
  const where: string[] = ['(organization_id = $1 OR organization_id IS NULL)'];
  params.push(ctx.organizationId);
  const add = (v: unknown) => `$${params.push(v)}`;

  if (query.severity) where.push(`severity = ${add(query.severity)}`);
  if (query.origin) where.push(`origin = ${add(query.origin)}`);
  if (query.resolved !== undefined) where.push(`resolved = ${add(query.resolved)}`);
  if (query.createdAfter) where.push(`created_at >= ${add(query.createdAfter)}`);
  if (query.cursor) {
    const decoded = decodeCursor(query.cursor);
    where.push(`(created_at, id) < (${add(decoded.createdAt)}, ${add(decoded.id)})`);
  }

  const rows = await withoutOrg((sql) =>
    sql.query<ErrorLogRecord & { created_at: string }>(
      `SELECT id, origin, severity, source_interface, message, stack, component_stack,
              request_id, operation_id, error_code, path, method, status_code, url,
              user_agent, context, resolved, resolved_at, resolved_by, resolution_note, created_at
       FROM error_logs
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT ${add(limit + 1)}`,
      params,
    ),
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    items: page,
    nextCursor: hasMore
      ? encodeCursor({ createdAt: page[page.length - 1].created_at, id: page[page.length - 1].id })
      : null,
  };
}

export async function getErrorLog(ctx: ActorContext, id: string): Promise<ErrorLogRecord> {
  requirePermission(ctx, 'audit.read');
  const row = await withoutOrg((sql) =>
    sql.one<ErrorLogRecord>(
      `SELECT id, origin, severity, source_interface, message, stack, component_stack,
              request_id, operation_id, error_code, path, method, status_code, url,
              user_agent, context, resolved, resolved_at, resolved_by, resolution_note, created_at
       FROM error_logs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)`,
      [id, ctx.organizationId],
    ),
  );
  if (!row) throw notFound('error log', id);
  return row;
}

export async function resolveErrorLog(
  ctx: ActorContext,
  id: string,
  note?: string | null,
): Promise<ErrorLogRecord> {
  requirePermission(ctx, 'audit.read');
  const row = await withoutOrg((sql) =>
    sql.one<ErrorLogRecord>(
      `UPDATE error_logs
       SET resolved = true, resolved_at = now(), resolved_by = $1, resolution_note = $2
       WHERE id = $3 AND (organization_id = $4 OR organization_id IS NULL)
       RETURNING id, origin, severity, source_interface, message, stack, component_stack,
                 request_id, operation_id, error_code, path, method, status_code, url,
                 user_agent, context, resolved, resolved_at, resolved_by, resolution_note, created_at`,
      [ctx.userId, note ?? null, id, ctx.organizationId],
    ),
  );
  if (!row) throw notFound('error log', id);
  return row;
}

export async function errorLogCounts(
  ctx: ActorContext,
): Promise<{ unresolved: number; last_24h: number }> {
  requirePermission(ctx, 'audit.read');
  const row = await withoutOrg((sql) =>
    sql.one<{ unresolved: number; last_24h: number }>(
      `SELECT
         count(*) FILTER (WHERE resolved = false)::int AS unresolved,
         count(*) FILTER (WHERE created_at >= now() - interval '24 hours')::int AS last_24h
       FROM error_logs
       WHERE organization_id = $1 OR organization_id IS NULL`,
      [ctx.organizationId],
    ),
  );
  return row ?? { unresolved: 0, last_24h: 0 };
}

function encodeCursor(value: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
      throw new Error('bad shape');
    }
    return parsed;
  } catch {
    throw notFound('cursor');
  }
}
