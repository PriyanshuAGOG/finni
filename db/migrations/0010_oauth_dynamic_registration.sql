-- =====================================================================
-- Nirog Bhoomi Research OS -- 0010 OAuth dynamic client registration
--
-- Adds RFC 7591 Dynamic Client Registration support for MCP clients
-- (e.g. ChatGPT) that self-register instead of a human pasting a
-- Client ID/Secret into a form.
--
-- Also fixes a latent bug this uncovered in /api/oauth/authorize: it
-- read `oauth_clients` with a raw SELECT under `withoutOrg`, which
-- (correctly) returns zero rows under RLS once `app.current_organization_id`
-- is unset -- there is no organization context yet at that point in the
-- OAuth flow, by design (see 0005's comment). `exchangeAuthorizationCode`
-- already goes through `auth_find_oauth_client()` for this same table;
-- the authorize endpoint should have too. This migration extends that
-- function with the one extra column (`allowed_scopes`) the authorize
-- endpoint needs that the token endpoint didn't.
-- =====================================================================

DROP FUNCTION IF EXISTS auth_find_oauth_client(TEXT);

CREATE FUNCTION auth_find_oauth_client(p_client_id TEXT)
RETURNS TABLE (id UUID, client_secret_hash TEXT, redirect_uris JSONB, allowed_scopes JSONB)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT id, client_secret_hash, redirect_uris, allowed_scopes
  FROM oauth_clients
  WHERE client_id = p_client_id AND status = 'active';
$$;

GRANT EXECUTE ON FUNCTION auth_find_oauth_client(TEXT) TO PUBLIC;

-- Self-registration runs before any organization context exists (the
-- client isn't acting as anyone yet -- the resulting row is bookkeeping,
-- not a security boundary; see src/app/api/oauth/register/route.ts), so
-- it needs the same RLS-bypass treatment as the lookup functions above,
-- plus an actual INSERT.
CREATE OR REPLACE FUNCTION oauth_register_client(
  p_organization_id UUID,
  p_client_id TEXT,
  p_client_secret_hash TEXT,
  p_name TEXT,
  p_redirect_uris JSONB,
  p_allowed_scopes JSONB
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id UUID;
  v_count INT;
BEGIN
  SELECT count(*) INTO v_count FROM oauth_clients WHERE organization_id = p_organization_id;
  IF v_count >= 100 THEN
    RAISE EXCEPTION 'too_many_clients' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO oauth_clients (organization_id, client_id, client_secret_hash, name, redirect_uris, allowed_scopes)
  VALUES (p_organization_id, p_client_id, p_client_secret_hash, p_name, p_redirect_uris, p_allowed_scopes)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION oauth_register_client(UUID, TEXT, TEXT, TEXT, JSONB, JSONB) TO PUBLIC;
