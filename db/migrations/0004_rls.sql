-- =====================================================================
-- Nirog Bhoomi Research OS -- 0004 row-level security
--
-- Organization isolation is enforced in two independent places:
--   1. Every service query filters on organization_id.
--   2. These policies, which reject cross-organization rows even if a
--      query in (1) is ever written incorrectly.
--
-- The application connects as a non-superuser role and sets
-- `app.current_organization_id` per checked-out connection. A missing
-- setting yields no rows rather than all rows, so a bug fails closed.
-- =====================================================================

CREATE OR REPLACE FUNCTION current_org_id() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.current_organization_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

-- Applies the standard organization policy to a table that has an
-- organization_id column.
CREATE OR REPLACE FUNCTION apply_org_rls(target_table TEXT) RETURNS void AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target_table);
  EXECUTE format(
    'CREATE POLICY %I ON %I USING (organization_id = current_org_id()) '
    'WITH CHECK (organization_id = current_org_id())',
    target_table || '_org_isolation', target_table);
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'roles', 'api_clients', 'oauth_clients', 'audit_logs',
    'action_confirmations', 'idempotency_keys', 'integrations',
    'sources', 'source_versions', 'contributors', 'categories', 'tags',
    'collections', 'study_metadata', 'evidence_assessments', 'claims',
    'claim_evidence', 'annotations', 'embedding_chunks',
    'research_jobs', 'research_candidates',
    'research_briefs', 'generated_content', 'saved_searches',
    'ai_usage_events', 'search_events'
  ] LOOP
    PERFORM apply_org_rls(t);
  END LOOP;
END $$;

-- Join tables inherit isolation through their parent row.
ALTER TABLE source_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY source_categories_org_isolation ON source_categories
  USING (EXISTS (SELECT 1 FROM sources s WHERE s.id = source_id AND s.organization_id = current_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM sources s WHERE s.id = source_id AND s.organization_id = current_org_id()));

ALTER TABLE source_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_tags FORCE ROW LEVEL SECURITY;
CREATE POLICY source_tags_org_isolation ON source_tags
  USING (EXISTS (SELECT 1 FROM sources s WHERE s.id = source_id AND s.organization_id = current_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM sources s WHERE s.id = source_id AND s.organization_id = current_org_id()));

ALTER TABLE collection_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY collection_sources_org_isolation ON collection_sources
  USING (EXISTS (SELECT 1 FROM collections c WHERE c.id = collection_id AND c.organization_id = current_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM collections c WHERE c.id = collection_id AND c.organization_id = current_org_id()));

ALTER TABLE source_contributors ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_contributors FORCE ROW LEVEL SECURITY;
CREATE POLICY source_contributors_org_isolation ON source_contributors
  USING (EXISTS (SELECT 1 FROM sources s WHERE s.id = source_id AND s.organization_id = current_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM sources s WHERE s.id = source_id AND s.organization_id = current_org_id()));

ALTER TABLE brief_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE brief_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY brief_sources_org_isolation ON brief_sources
  USING (EXISTS (SELECT 1 FROM research_briefs b WHERE b.id = brief_id AND b.organization_id = current_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM research_briefs b WHERE b.id = brief_id AND b.organization_id = current_org_id()));

ALTER TABLE generated_content_citations ENABLE ROW LEVEL SECURITY;
ALTER TABLE generated_content_citations FORCE ROW LEVEL SECURITY;
CREATE POLICY generated_content_citations_org_isolation ON generated_content_citations
  USING (EXISTS (SELECT 1 FROM generated_content g WHERE g.id = generated_content_id AND g.organization_id = current_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM generated_content g WHERE g.id = generated_content_id AND g.organization_id = current_org_id()));

ALTER TABLE claim_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY claim_categories_org_isolation ON claim_categories
  USING (EXISTS (SELECT 1 FROM claims c WHERE c.id = claim_id AND c.organization_id = current_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM claims c WHERE c.id = claim_id AND c.organization_id = current_org_id()));

ALTER TABLE claim_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_relations FORCE ROW LEVEL SECURITY;
CREATE POLICY claim_relations_org_isolation ON claim_relations
  USING (EXISTS (SELECT 1 FROM claims c WHERE c.id = from_claim_id AND c.organization_id = current_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM claims c WHERE c.id = from_claim_id AND c.organization_id = current_org_id()));

ALTER TABLE brief_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE brief_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY brief_versions_org_isolation ON brief_versions
  USING (EXISTS (SELECT 1 FROM research_briefs b WHERE b.id = brief_id AND b.organization_id = current_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM research_briefs b WHERE b.id = brief_id AND b.organization_id = current_org_id()));

ALTER TABLE smart_collection_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE smart_collection_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY smart_collection_rules_org_isolation ON smart_collection_rules
  USING (EXISTS (SELECT 1 FROM collections c WHERE c.id = collection_id AND c.organization_id = current_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM collections c WHERE c.id = collection_id AND c.organization_id = current_org_id()));

-- User-scoped tables reached through the owning user's organization.
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY user_roles_org_isolation ON user_roles
  USING (EXISTS (SELECT 1 FROM users u WHERE u.id = user_id AND u.organization_id = current_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = user_id AND u.organization_id = current_org_id()));

ALTER TABLE user_permission_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_permission_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY user_permission_overrides_org_isolation ON user_permission_overrides
  USING (EXISTS (SELECT 1 FROM users u WHERE u.id = user_id AND u.organization_id = current_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = user_id AND u.organization_id = current_org_id()));

-- Tables consulted before an organization context exists keep RLS off and
-- are reached only through narrowly scoped service functions:
--
--   organizations, sessions, oauth_authorization_codes, oauth_tokens,
--   rate_limit_counters
--     -- read during authentication, before an organization is known.
--
--   processing_jobs
--     -- the worker polls this table across every organization by design.
--     Each job row carries organization_id, and the worker sets that
--     organization as its context before touching any other table, so
--     every downstream read and write is still policy-checked.
