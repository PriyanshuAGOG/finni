import { randomUUID } from 'node:crypto';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { authenticateRequest } from '../../api/handler';
import { registerOperations } from '../../api/operations';
import { createMcpServer } from '../../mcp/server';
import { getEnv } from '../../lib/env';

registerOperations();

// Every request needs a live database and per-request auth context; a
// fresh MCP server+transport pair is built per call (stateless mode), so
// nothing here is cacheable or prerenderable at build time.
export const dynamic = 'force-dynamic';

/**
 * The MCP endpoint replacing the retired Custom GPT Actions integration.
 * Accepts exactly the same credentials as /api/v1 -- a dashboard session
 * cookie, an OAuth access token (`nbat_...`), or an API key (`nbgpt_...`)
 * -- via the Authorization: Bearer header, and executes every tool call
 * through the same runOperation() path as the REST API (src/mcp/server.ts).
 */
async function handle(request: Request): Promise<Response> {
  const requestId = request.headers.get('x-request-id') ?? `req_${randomUUID().replace(/-/g, '')}`;

  const ctx = await authenticateRequest(request, requestId);
  if (!ctx) return unauthorized(request, requestId);

  const server = createMcpServer(ctx, request, requestId);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(request);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;

/**
 * Points an OAuth-aware MCP client at the protected-resource metadata
 * document (RFC 9728) so it can discover how to obtain a token, per the
 * MCP auth spec's `WWW-Authenticate` convention. A client sending an API
 * key instead just ignores this.
 */
function unauthorized(request: Request, requestId: string): Response {
  const resourceMetadataUrl = new URL('/.well-known/oauth-protected-resource/mcp', getEnv().APP_BASE_URL);
  return new Response(
    JSON.stringify({
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Authentication is required to use this MCP server.',
        request_id: requestId,
      },
    }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-request-id': requestId,
        'www-authenticate': `Bearer resource_metadata="${resourceMetadataUrl.toString()}"`,
      },
    },
  );
}
