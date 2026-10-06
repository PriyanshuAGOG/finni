import { getEnv } from '../../../../lib/env';
import { SCOPES } from '../../../../domain/permissions';

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP endpoint
 * specifically. An MCP client that gets a 401 from /mcp follows the
 * `resource_metadata` URL in that response's WWW-Authenticate header
 * straight here to learn which authorization server issues tokens for
 * it (see src/app/mcp/route.ts's `unauthorized()`).
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const base = getEnv().APP_BASE_URL;

  return Response.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: SCOPES,
  });
}
