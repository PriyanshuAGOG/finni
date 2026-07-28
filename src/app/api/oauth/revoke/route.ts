import { revokeToken } from '../../../../services/auth';

// This endpoint is called by the GPT platform's OAuth client on
// disconnect/reconnect, not through a dashboard session -- nothing here
// is cacheable or prerenderable at build time.
export const dynamic = 'force-dynamic';

/**
 * OAuth 2.0 token revocation endpoint (RFC 7009).
 *
 * Revokes an access or refresh token -- whichever hash matches, since a
 * client only ever holds one or the other at a time. Per RFC 7009 this
 * always returns 200 even for an unknown or already-revoked token, so a
 * caller cannot use the response to probe for valid tokens.
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

  const token = params.get('token');
  if (!token) {
    return new Response(
      JSON.stringify({ error: 'invalid_request', error_description: 'token is required.' }),
      { status: 400, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
    );
  }

  await revokeToken(token);

  return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
}
