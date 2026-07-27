import { exchangeAuthorizationCode, refreshAccessToken } from '../../../../services/auth';
import { ApiError, isApiError } from '../../../../lib/errors';

/**
 * OAuth 2.0 token endpoint. Supports the authorization_code grant (with
 * PKCE or a client secret) and refresh_token rotation. Errors follow the
 * standard OAuth error-body shape (`error`, `error_description`) rather
 * than this application's own error envelope, since this endpoint is
 * consumed by the GPT platform's OAuth client, not by our own API clients.
 */
export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get('content-type') ?? '';
  let params: URLSearchParams;

  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => ({}));
    params = new URLSearchParams(body as Record<string, string>);
  } else {
    params = new URLSearchParams(await request.text());
  }

  const grantType = params.get('grant_type');

  try {
    if (grantType === 'authorization_code') {
      const code = params.get('code');
      const clientId = params.get('client_id');
      const redirectUri = params.get('redirect_uri');
      if (!code || !clientId || !redirectUri) {
        return oauthError('invalid_request', 'code, client_id and redirect_uri are required.');
      }

      const result = await exchangeAuthorizationCode({
        code,
        clientId,
        clientSecret: params.get('client_secret') ?? undefined,
        redirectUri,
        codeVerifier: params.get('code_verifier') ?? undefined,
      });

      return json({
        access_token: result.accessToken,
        token_type: 'Bearer',
        expires_in: result.expiresIn,
        refresh_token: result.refreshToken,
        scope: result.scopes.join(' '),
      });
    }

    if (grantType === 'refresh_token') {
      const refreshToken = params.get('refresh_token');
      if (!refreshToken) return oauthError('invalid_request', 'refresh_token is required.');

      const result = await refreshAccessToken(refreshToken);
      return json({
        access_token: result.accessToken,
        token_type: 'Bearer',
        expires_in: result.expiresIn,
        refresh_token: result.refreshToken,
      });
    }

    return oauthError('unsupported_grant_type', `grant_type "${grantType}" is not supported.`);
  } catch (err) {
    if (isApiError(err)) {
      return oauthError(mapErrorCode(err), err.message);
    }
    return oauthError('server_error', 'An unexpected error occurred.');
  }
}

function mapErrorCode(err: ApiError): string {
  if (err.code === 'UNAUTHENTICATED') return 'invalid_grant';
  if (err.code === 'INVALID_INPUT') return 'invalid_request';
  return 'server_error';
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function oauthError(error: string, description: string): Response {
  return json({ error, error_description: description }, 400);
}
