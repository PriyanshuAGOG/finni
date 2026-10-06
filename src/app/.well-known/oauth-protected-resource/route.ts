import { getEnv } from '../../../lib/env';
import { SCOPES } from '../../../domain/permissions';

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) for the deployment as
 * a whole. The MCP endpoint's own resource document
 * (/.well-known/oauth-protected-resource/mcp) is what MCP clients
 * actually follow from the 401 WWW-Authenticate header; this one exists
 * so a client that only knows the deployment's root can still discover
 * the authorization server.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const base = getEnv().APP_BASE_URL;

  return Response.json({
    resource: base,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: SCOPES,
  });
}
