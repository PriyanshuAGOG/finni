import type { z } from 'zod';
import type { ActorContext } from '../lib/context';
import type { Permission, Scope } from '../domain/permissions';
import type { RiskLevel } from '../domain/risk';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface OperationContext {
  ctx: ActorContext;
  /** Path parameters, already matched against the route template. */
  params: Record<string, string>;
  /** Raw request, for the few operations that need headers or a body stream. */
  request: Request;
}

export interface Operation<TInput extends z.ZodTypeAny = z.ZodTypeAny> {
  /**
   * Stable identifier. This is the name the Custom GPT calls, so it is
   * part of the public contract and must not be renamed casually after
   * deployment -- a rename silently breaks every configured GPT.
   */
  operationId: string;
  method: HttpMethod;
  /** Route template relative to /api/v1, e.g. `/sources/{sourceId}`. */
  path: string;
  summary: string;
  /**
   * Full description for the GPT. It must say what the operation does,
   * when to use it, what it does NOT do, whether it writes, and whether
   * confirmation may be required.
   */
  description: string;
  /**
   * Shorter description used only in gpt-actions.yaml, when set.
   * ChatGPT's Actions editor caps an operation description at 300
   * characters; `description` above is written for full.yaml and the
   * rest of the docs and is routinely longer than that. Required
   * (enforced by the generator) for every operation in
   * scripts/generate-openapi.ts's CORE_GPT_ACTIONS whose `description`
   * exceeds 300 characters.
   */
  gptDescription?: string;
  tags: string[];
  /** Permission required. Enforced by the handler, not by the service alone. */
  permission?: Permission;
  /** Scopes that can unlock this operation for a token-based caller. */
  scopes: Scope[];
  riskLevel: RiskLevel;
  /** Whether a server-issued confirmation may be demanded at runtime. */
  mayRequireConfirmation?: boolean;
  input: TInput;
  /** Documents the response shape in the OpenAPI schema. */
  output?: z.ZodTypeAny;
  /** Recommends `Idempotency-Key` on this operation in the schema. */
  idempotent?: boolean;
  /** Excluded from the GPT-facing schema (still reachable over the API). */
  internalOnly?: boolean;
  examples?: {
    request?: Record<string, unknown>;
    response?: Record<string, unknown>;
  };
  handler: (input: z.infer<TInput>, context: OperationContext) => Promise<unknown>;
}

const registry = new Map<string, Operation>();

export function defineOperation<TInput extends z.ZodTypeAny>(
  operation: Operation<TInput>,
): Operation<TInput> {
  if (registry.has(operation.operationId)) {
    throw new Error(`Duplicate operationId: ${operation.operationId}`);
  }
  registry.set(operation.operationId, operation as unknown as Operation);
  return operation;
}

export function registerAll(operations: Operation[]): void {
  for (const operation of operations) {
    if (registry.has(operation.operationId)) {
      throw new Error(`Duplicate operationId: ${operation.operationId}`);
    }
    registry.set(operation.operationId, operation);
  }
}

export function allOperations(): Operation[] {
  return [...registry.values()];
}

export function getOperation(operationId: string): Operation | undefined {
  return registry.get(operationId);
}

export function clearRegistry(): void {
  registry.clear();
}

// ---------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------

export interface RouteMatch {
  operation: Operation;
  params: Record<string, string>;
}

/**
 * Matches a request path against the registered route templates.
 *
 * Static segments win over parameterised ones, so `/sources/ingest-url`
 * cannot be swallowed by `/sources/{sourceId}` regardless of the order in
 * which operations were registered.
 */
export function matchRoute(method: string, path: string): RouteMatch | null {
  const requestSegments = path.split('/').filter(Boolean);
  const candidates: Array<{ match: RouteMatch; specificity: number }> = [];

  for (const operation of registry.values()) {
    if (operation.method !== method) continue;

    const templateSegments = operation.path.split('/').filter(Boolean);
    if (templateSegments.length !== requestSegments.length) continue;

    const params: Record<string, string> = {};
    let specificity = 0;
    let matched = true;

    for (const [index, template] of templateSegments.entries()) {
      const actual = requestSegments[index];
      if (template.startsWith('{') && template.endsWith('}')) {
        params[template.slice(1, -1)] = decodeURIComponent(actual);
      } else if (template === actual) {
        specificity += 1;
      } else {
        matched = false;
        break;
      }
    }

    if (matched) candidates.push({ match: { operation, params }, specificity });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.specificity - a.specificity);
  return candidates[0].match;
}

/** Every path registered, for diagnostics and the OpenAPI parity test. */
export function routeTable(): Array<{ method: string; path: string; operationId: string }> {
  return allOperations()
    .map((o) => ({ method: o.method, path: o.path, operationId: o.operationId }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}
