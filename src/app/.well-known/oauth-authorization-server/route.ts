import { getEnv } from '../../../lib/env';
import { SCOPES } from '../../../domain/permissions';

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414). This deployment is
 * its own authorization server -- /api/oauth/{authorize,token,revoke},
 * already implemented for the retired Custom GPT Actions integration
 * (src/services/auth.ts) -- so an MCP client that discovers this document
 * via the resource metadata's `authorization_servers` entry can drive the
 * same PKCE authorization-code flow without any manual configuration.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const base = getEnv().APP_BASE_URL;

  return Response.json({
    issuer: base,
    authorization_endpoint: `${base}/api/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    revocation_endpoint: `${base}/api/oauth/revoke`,
    registration_endpoint: `${base}/api/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    scopes_supported: SCOPES,
  });
}
