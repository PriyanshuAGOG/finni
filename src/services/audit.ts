import type { Sql } from '../lib/db';
import { withOrg } from '../lib/db';
import type { ActorContext } from '../lib/context';
import { requirePermission } from '../lib/context';
import { notFound } from '../lib/errors';

export interface AuditEntry {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  previousState?: Record<string, unknown> | null;
  newState?: Record<string, unknown> | null;
  parentAuditId?: string | null;
  confirmationId?: string | null;
  status?: 'success' | 'failure';
  errorCode?: string | null;
}

/**
 * Records one write. Every mutating service calls this inside the same
 * transaction as the change itself, so a committed change always has a
 * committed audit row -- there is no window in which a record has been
 * modified without a trace of who did it.
 */
export async function recordAudit(
  sql: Sql,
  ctx: ActorContext,
  entry: AuditEntry,
): Promise<string> {
  const changedFields = diffFields(entry.previousState, entry.newState);

  const row = await sql.one<{ id: string }>(
    `INSERT INTO audit_logs (
       organization_id, actor_user_id, actor_api_client_id, actor_type,
       action, resource_type, resource_id, parent_audit_id, request_id,
       source_interface, previous_state, new_state, changed_fields,
       ip_address, user_agent, confirmation_id, status, error_code
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING id`,
    [
      ctx.organizationId,
      ctx.actorType === 'worker' ? null : ctx.userId,
      ctx.apiClientId ?? null,
      ctx.actorType,
      entry.action,
      entry.resourceType,
      entry.resourceId ?? null,
      entry.parentAuditId ?? null,
      ctx.requestId,
      ctx.sourceInterface,
      entry.previousState ? JSON.stringify(redact(entry.previousState)) : null,
      entry.newState ? JSON.stringify(redact(entry.newState)) : null,
      JSON.stringify(changedFields),
      ctx.ipAddress ?? null,
      ctx.userAgent ?? null,
      entry.confirmationId ?? null,
      entry.status ?? 'success',
      entry.errorCode ?? null,
    ],
  );
  return row!.id;
}

/** Fields whose values must never be written into an audit row. */
const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'credential_hash',
  'client_secret_hash',
  'access_token_hash',
  'refresh_token_hash',
  'token_hash',
  'encrypted_credentials',
  'api_key',
  'secret',
]);

function redact(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (SENSITIVE_KEYS.has(key)) {
      out[key] = '[redacted]';
    } else if (typeof value === 'string' && value.length > 4000) {
      // Full extracted article text would bloat the log without adding
      // any accountability the hash does not already provide.
      out[key] = `${value.slice(0, 4000)}… [truncated, ${value.length} chars]`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function diffFields(
  previous?: Record<string, unknown> | null,
  next?: Record<string, unknown> | null,
): string[] {
  if (!previous || !next) return next ? Object.keys(next) : [];
  const changed: string[] = [];
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changed.push(key);
  }
  return changed;
}

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

export interface AuditQuery {
  actorId?: string;
  actorType?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  sourceInterface?: string;
  status?: string;
  createdAfter?: string;
  createdBefore?: string;
  cursor?: string;
  limit?: number;
}

export interface AuditRecord {
  id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  actor_type: string;
  actor_user_id: string | null;
  actor_name: string | null;
  actor_api_client_id: string | null;
  source_interface: string;
  changed_fields: string[];
  previous_state: Record<string, unknown> | null;
  new_state: Record<string, unknown> | null;
  status: string;
  error_code: string | null;
  confirmation_id: string | null;
  request_id: string | null;
  created_at: string;
  summary: string;
}

export async function listAuditEvents(
  ctx: ActorContext,
  query: AuditQuery,
): Promise<{ items: AuditRecord[]; nextCursor: string | null }> {
  requirePermission(ctx, 'audit.read');
  return withOrg(ctx.organizationId, (sql) => queryAudit(sql, query));
}

/**
 * A user may always inspect what was done on their behalf, including by
 * the Custom GPT, without holding the organization-wide audit.read.
 */
export async function listMyActions(
  ctx: ActorContext,
  query: Omit<AuditQuery, 'actorId'>,
): Promise<{ items: AuditRecord[]; nextCursor: string | null }> {
  return withOrg(ctx.organizationId, (sql) =>
    queryAudit(sql, { ...query, actorId: ctx.userId }),
  );
}

export async function getResourceActivity(
  ctx: ActorContext,
  resourceType: string,
  resourceId: string,
  limit = 50,
): Promise<AuditRecord[]> {
  const { items } = await withOrg(ctx.organizationId, (sql) =>
    queryAudit(sql, { resourceType, resourceId, limit }),
  );
  return items;
}

async function queryAudit(
  sql: Sql,
  query: AuditQuery,
): Promise<{ items: AuditRecord[]; nextCursor: string | null }> {
  const limit = Math.min(query.limit ?? 25, 100);
  const params: unknown[] = [];
  const where: string[] = ['1=1'];
  const add = (v: unknown) => `$${params.push(v)}`;

  if (query.actorId) where.push(`a.actor_user_id = ${add(query.actorId)}`);
  if (query.actorType) where.push(`a.actor_type = ${add(query.actorType)}::actor_type`);
  if (query.action) where.push(`a.action = ${add(query.action)}`);
  if (query.resourceType) where.push(`a.resource_type = ${add(query.resourceType)}`);
  if (query.resourceId) where.push(`a.resource_id = ${add(query.resourceId)}`);
  if (query.sourceInterface) {
    where.push(`a.source_interface = ${add(query.sourceInterface)}::source_interface`);
  }
  if (query.status) where.push(`a.status = ${add(query.status)}`);
  if (query.createdAfter) where.push(`a.created_at >= ${add(query.createdAfter)}`);
  if (query.createdBefore) where.push(`a.created_at <= ${add(query.createdBefore)}`);

  // Cursor is (created_at, id) so pagination is stable when many rows
  // share a timestamp.
  if (query.cursor) {
    const decoded = decodeCursor(query.cursor);
    where.push(`(a.created_at, a.id) < (${add(decoded.createdAt)}, ${add(decoded.id)})`);
  }

  const rows = await sql.query<AuditRecord & { created_at: string }>(
    `SELECT a.id, a.action, a.resource_type, a.resource_id, a.actor_type,
            a.actor_user_id, u.full_name AS actor_name, a.actor_api_client_id,
            a.source_interface, a.changed_fields, a.previous_state, a.new_state,
            a.status, a.error_code, a.confirmation_id, a.request_id, a.created_at
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE ${where.join(' AND ')}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT ${add(limit + 1)}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => ({ ...r, summary: summarize(r) })),
    nextCursor: hasMore
      ? encodeCursor({ createdAt: page[page.length - 1].created_at, id: page[page.length - 1].id })
      : null,
  };
}

/** Plain-language rendering, so the activity feed is readable without JSON. */
function summarize(row: {
  action: string;
  resource_type: string;
  actor_name: string | null;
  actor_type: string;
  source_interface: string;
  changed_fields: string[] | null;
  status: string;
}): string {
  const actor =
    row.actor_type === 'worker'
      ? 'The processing worker'
      : row.actor_name ?? 'An unknown actor';
  const via =
    row.source_interface === 'custom_gpt'
      ? ' via the Custom GPT'
      : row.source_interface === 'api'
        ? ' via the API'
        : row.source_interface === 'internal_assistant'
          ? ' via the dashboard assistant'
          : '';
  const verb = row.action.split('.').slice(1).join(' ').replace(/_/g, ' ') || row.action;
  const fields =
    row.changed_fields && row.changed_fields.length > 0 && row.changed_fields.length <= 6
      ? ` (${row.changed_fields.join(', ')})`
      : '';
  const outcome = row.status === 'success' ? '' : ' — failed';
  return `${actor} ${verb} on ${row.resource_type.replace(/_/g, ' ')}${fields}${via}${outcome}.`;
}

export function encodeCursor(value: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } {
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
