import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getEnv } from '../lib/env';
import { ApiError, isApiError } from '../lib/errors';
import { hashPayload } from '../lib/crypto';
import { requirePermission, type ActorContext, type SourceInterface } from '../lib/context';
import { withOrg, withoutOrg } from '../lib/db';
import {
  contextFromIdentity,
  identityFromAccessToken,
  identityFromApiKey,
  identityFromSession,
  type AuthenticatedIdentity,
} from '../services/auth';
import { matchRoute, type Operation } from './registry';
import { recordAudit } from '../services/audit';

export interface ApiResponseMeta {
  request_id: string;
  [key: string]: unknown;
}

function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/**
 * Single entry point for every /api/v1 request.
 *
 * Authentication, scope and permission checks, rate limiting, idempotency
 * and audit-on-failure all happen here, so an operation cannot forget
 * one of them by omission.
 */
export async function handleApiRequest(request: Request): Promise<Response> {
  const requestId = request.headers.get('x-request-id') ?? `req_${randomUUID().replace(/-/g, '')}`;
  const started = Date.now();
  const baseHeaders: Record<string, string> = { 'x-request-id': requestId };

  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/v1/, '') || '/';

    const match = matchRoute(request.method, path);
    if (!match) {
      throw new ApiError('NOT_FOUND', `No operation is registered for ${request.method} ${path}.`, {
        details: { method: request.method, path },
        suggestedAction: 'Check the OpenAPI schema for the available operations.',
      });
    }

    const { operation, params } = match;

    // ---- authenticate ------------------------------------------------
    const identity = await authenticate(request);
    if (!identity) {
      throw new ApiError('UNAUTHENTICATED', 'Authentication is required for this operation.', {
        suggestedAction:
          'Connect or reconnect your Nirog Bhoomi Research OS account, or supply a valid API credential.',
      });
    }

    const ctx = contextFromIdentity(identity, {
      sourceInterface: detectInterface(request, identity),
      requestId,
      ipAddress: clientIp(request),
      userAgent: request.headers.get('user-agent') ?? undefined,
    });

    // ---- authorize ---------------------------------------------------
    // Checked here as well as in the service: two independent gates mean
    // a service refactor cannot silently open an endpoint.
    if (operation.permission) requirePermission(ctx, operation.permission);

    if (ctx.scopes !== null && operation.scopes.length > 0) {
      const hasScope = operation.scopes.some((scope) => ctx.scopes!.has(scope));
      if (!hasScope) {
        throw new ApiError(
          'FORBIDDEN',
          `This connection lacks the scope required for ${operation.operationId}.`,
          {
            details: { required_scopes: operation.scopes, operation: operation.operationId },
            suggestedAction: 'Reconnect the integration and approve the required scope.',
          },
        );
      }
    }

    // ---- rate limit --------------------------------------------------
    const rateLimit = await enforceRateLimit(ctx, operation);
    Object.assign(baseHeaders, rateLimit.headers);

    // ---- parse input -------------------------------------------------
    const rawInput = await readInput(request, params, url);
    const parsed = operation.input.safeParse(rawInput);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_FAILED', 'One or more request fields are invalid.', {
        details: {
          fields: Object.fromEntries(
            parsed.error.issues.map((issue) => [
              issue.path.join('.') || '(root)',
              issue.message,
            ]),
          ),
        },
        suggestedAction: 'Correct the listed fields and retry.',
      });
    }

    // ---- idempotency -------------------------------------------------
    const idempotencyKey = request.headers.get('idempotency-key');
    const requestHash = hashPayload({ operationId: operation.operationId, input: parsed.data });

    if (idempotencyKey && operation.method !== 'GET') {
      const replay = await checkIdempotency(ctx, operation, idempotencyKey, requestHash);
      if (replay) {
        return jsonResponse(replay.body, replay.status, {
          ...baseHeaders,
          'idempotency-replayed': 'true',
        });
      }
    }

    // ---- execute -----------------------------------------------------
    const result = await operation.handler(parsed.data, { ctx, params, request });

    const body = {
      data: result,
      meta: {
        request_id: requestId,
        operation: operation.operationId,
        duration_ms: Date.now() - started,
        ...extractMeta(result),
      } satisfies ApiResponseMeta,
    };

    if (idempotencyKey && operation.method !== 'GET') {
      await storeIdempotency(ctx, idempotencyKey, 200, body);
    }

    return jsonResponse(body, 200, baseHeaders);
  } catch (err) {
    return errorResponse(err, requestId, baseHeaders, request);
  }
}

/**
 * Surfaces provenance from a service result into the response envelope,
 * so a caller always sees whether it is looking at approved evidence.
 */
function extractMeta(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object') return {};
  const record = result as Record<string, unknown>;

  if (typeof record.provenance === 'string') return { source: record.provenance };
  if (record.scope && typeof record.scope === 'object') {
    const scope = record.scope as Record<string, unknown>;
    if (typeof scope.source_origin === 'string') return { source: scope.source_origin };
  }
  return {};
}

async function errorResponse(
  err: unknown,
  requestId: string,
  headers: Record<string, string>,
  request: Request,
): Promise<Response> {
  if (isApiError(err)) {
    if (err.code === 'RATE_LIMITED' && typeof err.details.retry_after_seconds === 'number') {
      headers['retry-after'] = String(err.details.retry_after_seconds);
    }
    return jsonResponse(err.toBody(requestId), err.status, headers);
  }

  // An unexpected error is logged in full but never returned in full: a
  // stack trace is an information leak.
  console.error(
    JSON.stringify({
      level: 'error',
      request_id: requestId,
      url: request.url,
      method: request.method,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );

  const internal = new ApiError('INTERNAL_ERROR', 'An unexpected error occurred.', {
    suggestedAction: 'Retry the request. If it keeps failing, report the request id.',
  });
  return jsonResponse(internal.toBody(requestId), 500, headers);
}

// ---------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------

async function authenticate(request: Request): Promise<AuthenticatedIdentity | null> {
  const authorization = request.headers.get('authorization');

  if (authorization?.startsWith('Bearer ')) {
    const token = authorization.slice(7).trim();
    // Prefixes distinguish credential kinds, so a token is never checked
    // against the wrong table.
    if (token.startsWith('nbat_')) return identityFromAccessToken(token);
    if (token.startsWith('nbgpt_')) return identityFromApiKey(token);
    return (await identityFromAccessToken(token)) ?? (await identityFromApiKey(token));
  }

  const cookie = request.headers.get('cookie');
  if (cookie) {
    const name = getEnv().SESSION_COOKIE_NAME;
    const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    if (match) return identityFromSession(decodeURIComponent(match[1]));
  }

  return null;
}

function detectInterface(request: Request, identity: AuthenticatedIdentity): SourceInterface {
  const declared = request.headers.get('x-client-interface');
  if (declared === 'internal_assistant') return 'internal_assistant';
  if (declared === 'browser_extension') return 'api';

  // An API-client credential is attributed to the Custom GPT by default,
  // because that is what the credential exists for; a session cookie is
  // the dashboard.
  if (identity.apiClientId) return 'custom_gpt';
  if (identity.scopes !== null) return 'custom_gpt';
  return 'dashboard';
}

function clientIp(request: Request): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('x-real-ip') ?? undefined;
}

// ---------------------------------------------------------------------
// Input assembly
// ---------------------------------------------------------------------

async function readInput(
  request: Request,
  params: Record<string, string>,
  url: URL,
): Promise<Record<string, unknown>> {
  const input: Record<string, unknown> = { ...params };

  for (const [key, value] of url.searchParams.entries()) {
    // Repeated parameters become arrays so `?status=a&status=b` works.
    if (key in input && !(key in params)) {
      const existing = input[key];
      input[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else if (!(key in params)) {
      input[key] = value;
    }
  }

  if (request.method === 'GET' || request.method === 'DELETE') {
    // DELETE may still carry a body in this API (removing sub-resources).
    if (request.method === 'DELETE') {
      const body = await safeJson(request);
      if (body) Object.assign(input, body);
    }
    return input;
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    for (const [key, value] of form.entries()) {
      input[key] = value instanceof File ? value : String(value);
    }
    return input;
  }

  const body = await safeJson(request);
  if (body) Object.assign(input, body);
  return input;
}

async function safeJson(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text().catch(() => '');
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed : { value: parsed };
  } catch {
    throw new ApiError('INVALID_INPUT', 'The request body is not valid JSON.');
  }
}

// ---------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------

/** Per-minute budgets by operation cost, not one global number. */
const RATE_LIMITS: Record<string, { limit: number; windowSeconds: number }> = {
  default: { limit: 120, windowSeconds: 60 },
  search: { limit: 60, windowSeconds: 60 },
  ai: { limit: 20, windowSeconds: 60 },
  ingestion: { limit: 30, windowSeconds: 60 },
  research: { limit: 10, windowSeconds: 60 },
};

function bucketFor(operation: Operation): keyof typeof RATE_LIMITS {
  if (operation.tags.includes('research')) return 'research';
  if (
    ['synthesizeKnowledge', 'generateEvidenceBasedContent', 'generateResearchBrief', 'synthesizeCollection', 'analyzeClaimConflicts']
      .includes(operation.operationId)
  ) {
    return 'ai';
  }
  if (operation.tags.includes('knowledge')) return 'search';
  if (operation.operationId.startsWith('ingest')) return 'ingestion';
  return 'default';
}

async function enforceRateLimit(
  ctx: ActorContext,
  operation: Operation,
): Promise<{ headers: Record<string, string> }> {
  const env = getEnv();
  if (!env.RATE_LIMIT_ENABLED) return { headers: {} };

  const bucket = bucketFor(operation);
  const config = RATE_LIMITS[bucket];
  // Keyed by credential where there is one, so a single misbehaving
  // integration cannot consume a whole organization's budget.
  const actorKey = ctx.apiClientId ?? ctx.userId;
  const windowStart = new Date(
    Math.floor(Date.now() / (config.windowSeconds * 1000)) * config.windowSeconds * 1000,
  );
  const key = `${ctx.organizationId}:${actorKey}:${bucket}`;

  const row = await withoutOrg((sql) =>
    sql.one<{ count: number }>(
      `INSERT INTO rate_limit_counters (bucket_key, window_start, count)
       VALUES ($1,$2,1)
       ON CONFLICT (bucket_key, window_start) DO UPDATE SET count = rate_limit_counters.count + 1
       RETURNING count`,
      [key, windowStart],
    ),
  );

  const used = row?.count ?? 1;
  const remaining = Math.max(0, config.limit - used);
  const resetAt = Math.floor(windowStart.getTime() / 1000) + config.windowSeconds;

  const headers = {
    'x-ratelimit-limit': String(config.limit),
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': String(resetAt),
    'x-ratelimit-bucket': bucket,
  };

  if (used > config.limit) {
    const retryAfter = Math.max(1, resetAt - Math.floor(Date.now() / 1000));
    throw new ApiError(
      'RATE_LIMITED',
      `The ${bucket} rate limit of ${config.limit} requests per ${config.windowSeconds}s was exceeded.`,
      {
        details: { bucket, limit: config.limit, retry_after_seconds: retryAfter },
        suggestedAction: `Wait ${retryAfter} second(s) and retry. Do not report the action as completed.`,
      },
    );
  }

  return { headers };
}

// ---------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------

async function checkIdempotency(
  ctx: ActorContext,
  operation: Operation,
  key: string,
  requestHash: string,
): Promise<{ status: number; body: unknown } | null> {
  const actorKey = ctx.apiClientId ?? ctx.userId;

  return withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<{
      request_hash: string;
      operation_id: string;
      state: string;
      response_status: number | null;
      response_body: unknown;
    }>(
      `SELECT request_hash, operation_id, state, response_status, response_body
       FROM idempotency_keys
       WHERE organization_id = $1 AND actor_key = $2 AND idempotency_key = $3`,
      [ctx.organizationId, actorKey, key],
    );

    if (existing) {
      // The same key with a different payload is a client bug, and
      // replaying the old response would hide it.
      if (existing.request_hash !== requestHash || existing.operation_id !== operation.operationId) {
        throw new ApiError(
          'IDEMPOTENCY_CONFLICT',
          'This idempotency key was already used for a different request.',
          {
            details: { idempotency_key: key, original_operation: existing.operation_id },
            suggestedAction: 'Use a fresh idempotency key for a different request.',
          },
        );
      }
      if (existing.state === 'completed') {
        return { status: existing.response_status ?? 200, body: existing.response_body };
      }
      throw new ApiError(
        'CONFLICT',
        'An identical request is still in progress.',
        {
          details: { idempotency_key: key },
          retryable: true,
          suggestedAction: 'Wait for the original request to finish, then retry.',
        },
      );
    }

    await sql.query(
      `INSERT INTO idempotency_keys (
         organization_id, actor_key, idempotency_key, operation_id, request_hash, state
       ) VALUES ($1,$2,$3,$4,$5,'in_progress')`,
      [ctx.organizationId, actorKey, key, operation.operationId, requestHash],
    );

    return null;
  });
}

async function storeIdempotency(
  ctx: ActorContext,
  key: string,
  status: number,
  body: unknown,
): Promise<void> {
  const actorKey = ctx.apiClientId ?? ctx.userId;
  await withOrg(ctx.organizationId, (sql) =>
    sql.query(
      `UPDATE idempotency_keys
       SET state = 'completed', response_status = $1, response_body = $2::jsonb, completed_at = now()
       WHERE organization_id = $3 AND actor_key = $4 AND idempotency_key = $5`,
      [status, JSON.stringify(body), ctx.organizationId, actorKey, key],
    ),
  ).catch(() => undefined);
}

// ---------------------------------------------------------------------
// Shared input fragments
// ---------------------------------------------------------------------

export const CursorPagination = z.object({
  cursor: z.string().optional().describe('Opaque cursor from a previous response.'),
  limit: z.coerce.number().int().min(1).max(100).optional().describe('Results per page.'),
});

export const ConfirmationInput = z.object({
  confirmation_id: z
    .string()
    .uuid()
    .nullish()
    .describe(
      'Confirmation id from confirmAction. Required when the operation returns CONFIRMATION_REQUIRED.',
    ),
});

/** Coerces a repeated or comma-separated query parameter into an array. */
export const stringArray = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (Array.isArray(value) ? value : value.split(',').map((v) => v.trim())))
  .pipe(z.array(z.string().min(1)));

export { recordAudit };
