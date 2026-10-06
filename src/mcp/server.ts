import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { allOperations, getOperation, type Operation } from '../api/registry';
import { runOperation } from '../api/handler';
import { CORE_GPT_ACTIONS } from '../domain/core-gpt-actions';
import { isApiError } from '../lib/errors';
import { logError } from '../services/errors';
import type { ActorContext } from '../lib/context';

/**
 * The same curated subset the legacy OpenAPI Actions schema exposes
 * (src/domain/core-gpt-actions.ts) -- one list of what the assistant can
 * do, shared by both integration surfaces so they can never drift into
 * offering different tools for what the user experiences as one GPT.
 */
export function curatedOperations(): Operation[] {
  return allOperations().filter((op) => CORE_GPT_ACTIONS.has(op.operationId));
}

/**
 * Converts one operation's Zod input schema to the JSON Schema an MCP
 * tool declares. `.refine()`-wrapped schemas (e.g. ingestIdentifier's
 * "doi or pmid required") collapse to their underlying object shape here,
 * the same way they already do in the generated OpenAPI spec -- the
 * refinement itself is still enforced server-side by the real Zod schema
 * inside runOperation, this is only what's advertised for discovery.
 */
function toolInputSchema(operation: Operation): Record<string, unknown> {
  const schema = zodToJsonSchema(operation.input, { target: 'jsonSchema7', $refStrategy: 'none' });
  // zod-to-json-schema can emit a top-level $ref + $defs for some shapes;
  // MCP tool schemas must be a plain inline object schema.
  if (schema && typeof schema === 'object' && 'definitions' in schema) {
    const { definitions, ...rest } = schema as Record<string, unknown>;
    void definitions;
    return rest;
  }
  return schema as Record<string, unknown>;
}

function toolDescription(operation: Operation): string {
  // MCP doesn't impose ChatGPT Actions' old 300-char cap, but a short,
  // precise description is still better tool-use guidance than a long one.
  return operation.gptDescription ?? operation.description;
}

/**
 * Builds one MCP server instance scoped to a single already-authenticated
 * request. A fresh instance per request (rather than one long-lived
 * server) is deliberate: this runs in a stateless serverless function, and
 * each request's tool calls must run as that request's actor, never a
 * previous caller's.
 */
export function createMcpServer(ctx: ActorContext, request: Request, requestId: string): Server {
  const server = new Server(
    { name: 'nirog-bhoomi-research-os', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'An internal research knowledge base for Nirog Bhoomi. Search, save, categorize and cite ' +
        'sources; synthesize evidence; manage claims, collections and research briefs.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: curatedOperations().map((operation) => ({
      name: operation.operationId,
      description: toolDescription(operation),
      inputSchema: toolInputSchema(operation),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (callRequest) => {
    const { name, arguments: args } = callRequest.params;
    const operation = CORE_GPT_ACTIONS.has(name) ? getOperation(name) : undefined;

    if (!operation) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: "${name}". Call tools/list for the available set.` }],
      };
    }

    const started = Date.now();
    try {
      const { body } = await runOperation(operation, (args ?? {}) as Record<string, unknown>, ctx, {
        requestId,
        started,
        request,
      });
      return { content: [{ type: 'text', text: JSON.stringify(body) }] };
    } catch (err) {
      return toToolErrorResult(err, ctx, requestId, operation.operationId, request);
    }
  });

  return server;
}

/**
 * Converts a thrown error into an MCP tool result rather than an HTTP
 * error response -- a failed tool call is still a successful RPC, per
 * the MCP spec, so this never throws back out to the transport. Mirrors
 * handler.ts's errorResponse: the same error_logs policy (5xx and
 * unexpected errors only), the same stable error-code body shape.
 */
async function toToolErrorResult(
  err: unknown,
  ctx: ActorContext,
  requestId: string,
  operationId: string,
  request: Request,
): Promise<{ isError: true; content: Array<{ type: 'text'; text: string }> }> {
  const path = new URL(request.url).pathname;

  if (isApiError(err)) {
    if (err.status >= 500) {
      await logError({
        origin: 'api_server',
        severity: 'error',
        message: err.message,
        stack: err.stack,
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        sourceInterface: ctx.sourceInterface,
        requestId,
        operationId,
        errorCode: err.code,
        path,
        method: 'MCP',
        statusCode: err.status,
      });
    }
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(err.toBody(requestId)) }] };
  }

  console.error(
    JSON.stringify({
      level: 'error',
      request_id: requestId,
      operation_id: operationId,
      transport: 'mcp',
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );

  await logError({
    origin: 'api_server',
    severity: 'fatal',
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    sourceInterface: ctx.sourceInterface,
    requestId,
    operationId,
    path,
    method: 'MCP',
    statusCode: 500,
  });

  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred.',
            request_id: requestId,
          },
        }),
      },
    ],
  };
}
