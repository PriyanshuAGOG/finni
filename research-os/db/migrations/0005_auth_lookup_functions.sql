-- =====================================================================
-- Nirog Bhoomi Research OS -- 0005 authentication lookup functions
--
-- Authentication has to find a row in `users`, `api_clients` or
-- `oauth_clients` before an organization context exists -- that is the
-- whole point of logging in. Those three tables carry the standard
-- organization row-level security policy from migration 0004, so a plain
-- SELECT issued without `app.current_organization_id` set (which is
-- exactly the situation at login) returns no rows.
--
-- The fix is not to drop RLS from these tables -- they hold password
-- hashes and credential metadata, and defense-in-depth against a
-- service-layer bug is the reason RLS exists at all. Instead, each
-- pre-authentication lookup gets a narrow SECURITY DEFINER function that
-- bypasses RLS for exactly one indexed, single-row lookup keyed by a
-- credential the caller must already possess (an email address, a
-- hashed token, a hashed credential, a client id). None of them permit
-- browsing, and none return more than the columns the corresponding
-- service function actually consumes.
-- =====================================================================

CREATE OR REPLACE FUNCTION auth_find_user_by_email(p_email TEXT)
RETURNS TABLE (
  id UUID, organization_id UUID, full_name TEXT, email TEXT,
  password_hash TEXT, status TEXT
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT id, organization_id, full_name, email, password_hash, status::text
  FROM users
  WHERE lower(email) = lower(p_email);
$$;

CREATE OR REPLACE FUNCTION auth_find_session_user(p_token_hash TEXT)
RETURNS TABLE (
  user_id UUID, organization_id UUID, full_name TEXT, email TEXT, status TEXT
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT u.id, u.organization_id, u.full_name, u.email, u.status::text
  FROM sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = p_token_hash
    AND s.revoked_at IS NULL
    AND s.expires_at > now();
$$;

CREATE OR REPLACE FUNCTION auth_find_api_client(p_credential_hash TEXT)
RETURNS TABLE (
  id UUID, organization_id UUID, scopes JSONB, acts_as_user_id UUID,
  status TEXT, expires_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT id, organization_id, scopes, acts_as_user_id, status, expires_at, revoked_at
  FROM api_clients
  WHERE credential_hash = p_credential_hash;
$$;

CREATE OR REPLACE FUNCTION auth_find_oauth_token_user(p_access_token_hash TEXT)
RETURNS TABLE (
  user_id UUID, scopes JSONB, organization_id UUID, full_name TEXT, email TEXT, status TEXT
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT t.user_id, t.scopes, u.organization_id, u.full_name, u.email, u.status::text
  FROM oauth_tokens t
  JOIN users u ON u.id = t.user_id
  WHERE t.access_token_hash = p_access_token_hash
    AND t.revoked_at IS NULL
    AND t.expires_at > now();
$$;

CREATE OR REPLACE FUNCTION auth_find_oauth_client(p_client_id TEXT)
RETURNS TABLE (id UUID, client_secret_hash TEXT, redirect_uris JSONB)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT id, client_secret_hash, redirect_uris
  FROM oauth_clients
  WHERE client_id = p_client_id AND status = 'active';
$$;

-- Executable by any authenticated database role. Safety comes from what
-- each function returns (at most one row, by exact key), not from who is
-- allowed to call it -- the same shape as any login endpoint being
-- reachable pre-authentication.
GRANT EXECUTE ON FUNCTION auth_find_user_by_email(TEXT) TO PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_session_user(TEXT) TO PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_api_client(TEXT) TO PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_oauth_token_user(TEXT) TO PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_oauth_client(TEXT) TO PUBLIC;
