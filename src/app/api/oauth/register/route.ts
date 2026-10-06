import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withoutOrg } from '../../../../lib/db';
import { generateCredential } from '../../../../lib/crypto';
import { isScope, SCOPES } from '../../../../domain/permissions';

export const dynamic = 'force-dynamic';

/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591).
 *
 * The MCP auth spec expects a client (ChatGPT, or any other MCP host) to
 * register itself here rather than have a human type a Client ID/Secret
 * into a form -- that manual step is what the legacy Custom GPT Actions
 * flow required (see docs/gpt-setup-guide.md's Appendix), and MCP hosts
 * generally don't offer it. This endpoint is deliberately public: the
 * real security boundary is unchanged -- /oauth/authorize still requires
 * an existing dashboard session, and the resulting token can still only
 * ever do what that signed-in user's own permissions allow, regardless
 * of which scopes the registered client was handed. What DCR adds is
 * only the client_id/redirect_uri bookkeeping an OAuth flow needs.
 */
const RegisterInput = z.object({
  redirect_uris: z.array(z.string().url()).min(1),
  client_name: z.string().trim().min(1).max(200).optional(),
  // OAuth 2.1 (which the MCP auth spec builds on) steers public clients
  // towards PKCE instead of a client secret, so that is the default here.
  token_endpoint_auth_method: z.enum(['none', 'client_secret_post']).default('none'),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  scope: z.string().optional(),
});

export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null);
  const parsed = RegisterInput.safeParse(body);
  if (!parsed.success) {
    return oauthError(
      400,
      'invalid_client_metadata',
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
    );
  }
  const input = parsed.data;

  const requestedScopes = input.scope
    ? input.scope.split(/\s+/).filter(Boolean).filter(isScope)
    : [...SCOPES];

  // Single-tenant deployments (the common case) have exactly one
  // organization; a self-registered client is attached to the oldest
  // one, since oauth_clients.organization_id is bookkeeping only -- the
  // token issued later carries the signed-in user's own organization,
  // not this client row's.
  const org = await withoutOrg((sql) =>
    sql.one<{ id: string }>(`SELECT id FROM organizations ORDER BY created_at ASC LIMIT 1`),
  );
  if (!org) {
    return oauthError(500, 'server_error', 'No organization is configured on this deployment yet.');
  }

  const clientId = `nbmcp_${randomUUID().replace(/-/g, '')}`;
  const isPublic = input.token_endpoint_auth_method === 'none';
  // The column is NOT NULL regardless of auth method; a public client's
  // row gets a secret that is generated but never returned, since a
  // public client authenticates at /oauth/token with a PKCE verifier
  // instead (exchangeAuthorizationCode's "no client secret" branch).
  const credential = generateCredential('nbocs');

  // No organization context exists for this request (it isn't acting as
  // anyone yet), so the insert goes through a SECURITY DEFINER function
  // that bypasses this table's per-organization RLS the same way the
  // pre-authentication lookup functions in db/migrations/0005 do -- see
  // 0010_oauth_dynamic_registration.sql. It also enforces the per-org cap.
  try {
    await withoutOrg((sql) =>
      sql.one(
        `SELECT oauth_register_client($1,$2,$3,$4,$5::jsonb,$6::jsonb) AS id`,
        [
          org.id,
          clientId,
          credential.hash,
          input.client_name ?? 'MCP client (self-registered)',
          JSON.stringify(input.redirect_uris),
          JSON.stringify(requestedScopes),
        ],
      ),
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes('too_many_clients')) {
      return oauthError(400, 'invalid_request', 'Too many registered clients. Revoke unused ones first.');
    }
    throw err;
  }

  return Response.json(
    {
      client_id: clientId,
      ...(isPublic ? {} : { client_secret: credential.plaintext }),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0,
      redirect_uris: input.redirect_uris,
      token_endpoint_auth_method: input.token_endpoint_auth_method,
      grant_types: input.grant_types ?? ['authorization_code', 'refresh_token'],
      response_types: input.response_types ?? ['code'],
      scope: requestedScopes.join(' '),
      ...(input.client_name ? { client_name: input.client_name } : {}),
    },
    { status: 201, headers: { 'cache-control': 'no-store' } },
  );
}

function oauthError(status: number, error: string, description: string): Response {
  return Response.json({ error, error_description: description }, { status, headers: { 'cache-control': 'no-store' } });
}
