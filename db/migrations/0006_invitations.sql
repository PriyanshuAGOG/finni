-- =====================================================================
-- Nirog Bhoomi Research OS -- 0006 team invitations
--
-- Inviting someone creates their `users` row immediately, with
-- status='invited' and no password_hash (the enum already anticipated
-- this: 'invited', 'active', 'suspended', 'deactivated'). The invitation
-- itself is a separate row so a re-invite, an expiry, or a revocation
-- doesn't need to mutate or lose the user record it's tied to.
--
-- Accepting an invitation happens before an organization context exists
-- (the invitee isn't signed in yet), so the lookup by token needs the
-- same narrow SECURITY DEFINER escape hatch as migration 0005's
-- authentication lookups -- see that file's header for the reasoning.
-- =====================================================================

CREATE TABLE user_invitations (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by       UUID NOT NULL REFERENCES users(id),
  role_id          UUID NOT NULL REFERENCES roles(id),
  token_hash       TEXT NOT NULL UNIQUE,
  expires_at       TIMESTAMPTZ NOT NULL,
  accepted_at      TIMESTAMPTZ,
  revoked_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX user_invitations_org_idx  ON user_invitations (organization_id);
CREATE INDEX user_invitations_user_idx ON user_invitations (user_id);

ALTER TABLE user_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY user_invitations_org_isolation ON user_invitations
  USING (organization_id = current_org_id())
  WITH CHECK (organization_id = current_org_id());

CREATE OR REPLACE FUNCTION auth_find_invitation_by_token(p_token_hash TEXT)
RETURNS TABLE (
  id UUID, organization_id UUID, user_id UUID, role_id UUID,
  expires_at TIMESTAMPTZ, accepted_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
  user_email TEXT, user_full_name TEXT, user_status TEXT
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT i.id, i.organization_id, i.user_id, i.role_id,
         i.expires_at, i.accepted_at, i.revoked_at,
         u.email, u.full_name, u.status::text
  FROM user_invitations i
  JOIN users u ON u.id = i.user_id
  WHERE i.token_hash = p_token_hash;
$$;

GRANT EXECUTE ON FUNCTION auth_find_invitation_by_token(TEXT) TO PUBLIC;
