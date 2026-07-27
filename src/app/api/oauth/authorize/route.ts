import { getSessionContext } from '../../../lib/session';
import { withoutOrg } from '../../../../lib/db';
import { createAuthorizationCode } from '../../../../services/auth';
import { isScope } from '../../../../domain/permissions';

// A GET route handler with no dynamic-API usage can be evaluated once at
// build time in the App Router; this one needs a live session and
// database lookup on every call, so it must never be treated as static.
export const dynamic = 'force-dynamic';

/**
 * OAuth 2.0 authorization endpoint (with PKCE).
 *
 * A first-party dashboard session is the only accepted proof of identity
 * here -- there is deliberately no separate "GPT login." The user
 * authenticates as themselves once, in their own browser, and the
 * resulting token can only ever act with their own permissions.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const clientId = url.searchParams.get('client_id');
  const redirectUri = url.searchParams.get('redirect_uri');
  const state = url.searchParams.get('state');
  const scopeParam = url.searchParams.get('scope') ?? '';
  const codeChallenge = url.searchParams.get('code_challenge') ?? undefined;
  const codeChallengeMethod = url.searchParams.get('code_challenge_method') ?? undefined;
  const responseType = url.searchParams.get('response_type');

  if (!clientId || !redirectUri || responseType !== 'code') {
    return errorPage('invalid_request', 'client_id, redirect_uri and response_type=code are required.');
  }

  const client = await withoutOrg((sql) =>
    sql.one<{ id: string; redirect_uris: string[]; allowed_scopes: string[] }>(
      `SELECT id, redirect_uris, allowed_scopes FROM oauth_clients
       WHERE client_id = $1 AND status = 'active'`,
      [clientId],
    ),
  );
  if (!client) return errorPage('unauthorized_client', 'Unknown or inactive client_id.');
  if (!client.redirect_uris.includes(redirectUri)) {
    return errorPage('invalid_request', 'redirect_uri does not match a registered URI for this client.');
  }

  const requested = scopeParam.split(/\s+/).filter(Boolean);
  const scopes = requested.filter((s) => isScope(s) && client.allowed_scopes.includes(s));
  if (requested.length > 0 && scopes.length !== requested.length) {
    return errorPage(
      'invalid_scope',
      'One or more requested scopes are not permitted for this client.',
    );
  }

  const ctx = await getSessionContext();
  if (!ctx) {
    // Not signed in yet: send the user to the dashboard sign-in page and
    // bounce back to this exact authorize URL afterward.
    const signIn = new URL('/sign-in', url.origin);
    signIn.searchParams.set('next', `${url.pathname}${url.search}`);
    return Response.redirect(signIn.toString(), 302);
  }

  const code = await createAuthorizationCode({
    organizationId: ctx.organizationId,
    oauthClientId: client.id,
    userId: ctx.userId,
    redirectUri,
    scopes: (scopes.length > 0 ? scopes : client.allowed_scopes.filter(isScope)).filter(isScope),
    codeChallenge,
    codeChallengeMethod,
  });

  const redirect = new URL(redirectUri);
  redirect.searchParams.set('code', code);
  if (state) redirect.searchParams.set('state', state);
  return Response.redirect(redirect.toString(), 302);
}

function errorPage(error: string, description: string): Response {
  return new Response(
    `<!doctype html><html><body style="font-family: system-ui; padding: 2rem;">
       <h1>Authorization error</h1>
       <p><strong>${error}</strong>: ${description}</p>
     </body></html>`,
    { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}
