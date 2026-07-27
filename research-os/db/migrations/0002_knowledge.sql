-- =====================================================================
-- Nirog Bhoomi Research OS -- 0002 knowledge domain
-- Sources, versions, contributors, taxonomy, collections, claims,
-- evidence, study metadata, annotations, embeddings.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------

CREATE TYPE source_type AS ENUM (
  'web_article', 'research_paper', 'systematic_review', 'meta_analysis',
  'randomized_controlled_trial', 'cohort_study', 'case_control_study',
  'cross_sectional_study', 'case_report', 'clinical_guideline',
  'government_report', 'policy_document', 'book', 'book_chapter',
  'internal_document', 'uploaded_pdf', 'uploaded_document', 'video',
  'podcast', 'social_post', 'newsletter', 'dataset', 'manual_note', 'other'
);

CREATE TYPE review_status AS ENUM (
  'unreviewed', 'needs_review', 'in_review', 'approved',
  'approved_with_conditions', 'rejected', 'disputed', 'superseded'
);

CREATE TYPE processing_status AS ENUM (
  'queued', 'fetching', 'extracting', 'classifying', 'embedding',
  'enriching', 'completed', 'completed_with_warnings', 'failed',
  'requires_manual_input'
);

CREATE TYPE visibility_level AS ENUM (
  'private', 'restricted', 'organization', 'selected_collections'
);

CREATE TYPE duplicate_status AS ENUM (
  'none', 'exact_duplicate', 'canonical_url_duplicate', 'doi_duplicate',
  'file_duplicate', 'near_duplicate', 'updated_version', 'syndicated_copy',
  'translation', 'derivative', 'resolved_keep_both', 'resolved_merged'
);

CREATE TYPE assignment_source AS ENUM ('human', 'ai', 'import', 'rule', 'custom_gpt');

CREATE TYPE evidence_status AS ENUM (
  'supported', 'likely_supported', 'mixed', 'contested', 'contradicted',
  'insufficient_evidence', 'outdated', 'retracted_source_dependency', 'unreviewed'
);

CREATE TYPE evidence_relationship AS ENUM (
  'supports', 'contradicts', 'qualifies', 'contextualizes', 'cites',
  'replicates', 'fails_to_replicate'
);

CREATE TYPE annotation_type AS ENUM (
  'note', 'highlight', 'important_statistic', 'question', 'correction',
  'safety_warning', 'contradiction', 'content_idea', 'review_request',
  'limitation', 'interpretation'
);

CREATE TYPE collection_type AS ENUM (
  'manual', 'smart', 'research_project', 'content_project', 'clinical_topic',
  'programme', 'campaign', 'competitor_research', 'patient_education'
);

CREATE TYPE lifecycle_status AS ENUM ('active', 'archived', 'merged', 'deleted');

-- ---------------------------------------------------------------------
-- Sources
-- ---------------------------------------------------------------------

CREATE TABLE sources (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title                  TEXT NOT NULL,
  subtitle               TEXT,
  source_type            source_type NOT NULL DEFAULT 'other',
  canonical_url          TEXT,
  submitted_url          TEXT,
  doi                    TEXT,
  pmid                   TEXT,
  isbn                   TEXT,
  external_identifier    TEXT,
  author_text            TEXT,
  publisher              TEXT,
  journal                TEXT,
  publication_date       DATE,
  publication_year       INTEGER,
  accessed_at            TIMESTAMPTZ,
  language               TEXT,
  country                TEXT,
  abstract               TEXT,
  extracted_text         TEXT,
  normalized_text        TEXT,
  word_count             INTEGER,
  reading_time_minutes   INTEGER,
  original_file_path     TEXT,
  snapshot_file_path     TEXT,
  thumbnail_url          TEXT,
  favicon_url            TEXT,
  status                 lifecycle_status NOT NULL DEFAULT 'active',
  review_status          review_status NOT NULL DEFAULT 'unreviewed',
  processing_status      processing_status NOT NULL DEFAULT 'queued',
  visibility             visibility_level NOT NULL DEFAULT 'organization',
  duplicate_status       duplicate_status NOT NULL DEFAULT 'none',
  duplicate_of_source_id UUID REFERENCES sources(id),
  supersedes_source_id   UUID REFERENCES sources(id),
  superseded_by_source_id UUID REFERENCES sources(id),
  retraction_status      TEXT NOT NULL DEFAULT 'none',
  retraction_reason      TEXT,
  extraction_confidence  NUMERIC(4,3),
  source_authority_rating TEXT,
  evidence_summary       TEXT,
  ai_summary_one_line    TEXT,
  ai_summary_short       TEXT,
  ai_summary_detailed    TEXT,
  -- Human summaries are never overwritten by the AI pipeline.
  human_summary          TEXT,
  key_findings           JSONB NOT NULL DEFAULT '[]'::jsonb,
  practical_implications JSONB NOT NULL DEFAULT '[]'::jsonb,
  limitations            JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_notes           JSONB NOT NULL DEFAULT '[]'::jsonb,
  review_questions       JSONB NOT NULL DEFAULT '[]'::jsonb,
  conflicts_of_interest  TEXT,
  funding_information    TEXT,
  copyright_notes        TEXT,
  license_information    TEXT,
  -- Fields locked by a reviewer cannot be changed by AI or by users
  -- lacking source.lock_fields.
  locked_fields          JSONB NOT NULL DEFAULT '[]'::jsonb,
  added_via              source_interface NOT NULL DEFAULT 'dashboard',
  added_by               UUID REFERENCES users(id),
  approved_by            UUID REFERENCES users(id),
  approved_at            TIMESTAMPTZ,
  rejected_by            UUID REFERENCES users(id),
  rejected_at            TIMESTAMPTZ,
  rejection_reason       TEXT,
  review_conditions      JSONB NOT NULL DEFAULT '[]'::jsonb,
  assigned_reviewer_id   UUID REFERENCES users(id),
  last_verified_at       TIMESTAMPTZ,
  last_content_check_at  TIMESTAMPTZ,
  content_hash           TEXT,
  normalized_content_hash TEXT,
  simhash                BIGINT,
  version                INTEGER NOT NULL DEFAULT 1,
  metadata               JSONB NOT NULL DEFAULT '{}'::jsonb,
  search_vector          TSVECTOR,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             UUID REFERENCES users(id),
  updated_by             UUID REFERENCES users(id),
  archived_at            TIMESTAMPTZ,
  archived_by            UUID REFERENCES users(id)
);

CREATE INDEX sources_org_idx              ON sources (organization_id);
CREATE INDEX sources_org_status_idx       ON sources (organization_id, status, review_status);
CREATE INDEX sources_org_processing_idx   ON sources (organization_id, processing_status);
CREATE INDEX sources_org_type_idx         ON sources (organization_id, source_type);
CREATE INDEX sources_canonical_url_idx    ON sources (organization_id, canonical_url);
CREATE INDEX sources_doi_idx              ON sources (organization_id, lower(doi)) WHERE doi IS NOT NULL;
CREATE INDEX sources_pmid_idx             ON sources (organization_id, pmid) WHERE pmid IS NOT NULL;
CREATE INDEX sources_pubdate_idx          ON sources (organization_id, publication_date DESC NULLS LAST);
CREATE INDEX sources_content_hash_idx     ON sources (organization_id, content_hash);
CREATE INDEX sources_norm_hash_idx        ON sources (organization_id, normalized_content_hash);
CREATE INDEX sources_title_trgm_idx       ON sources USING gin (lower(title) gin_trgm_ops);
CREATE INDEX sources_search_vector_idx    ON sources USING gin (search_vector);
CREATE INDEX sources_reviewer_idx         ON sources (assigned_reviewer_id) WHERE assigned_reviewer_id IS NOT NULL;

-- Full-text index maintained by trigger. Title and abstract are weighted
-- above body text so a title match outranks an incidental body mention.
CREATE OR REPLACE FUNCTION sources_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.subtitle, '') || ' ' ||
                                     coalesce(NEW.author_text, '') || ' ' ||
                                     coalesce(NEW.publisher, '') || ' ' ||
                                     coalesce(NEW.journal, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.abstract, '') || ' ' ||
                                     coalesce(NEW.ai_summary_detailed, '') || ' ' ||
                                     coalesce(NEW.human_summary, '')), 'C') ||
    setweight(to_tsvector('english', left(coalesce(NEW.normalized_text, ''), 400000)), 'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sources_search_vector_trigger
  BEFORE INSERT OR UPDATE OF title, subtitle, author_text, publisher, journal,
                             abstract, ai_summary_detailed, human_summary, normalized_text
  ON sources FOR EACH ROW EXECUTE FUNCTION sources_search_vector_update();

-- ---------------------------------------------------------------------
-- Source versions
-- ---------------------------------------------------------------------

CREATE TABLE source_versions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_id         UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  version_number    INTEGER NOT NULL,
  captured_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_hash      TEXT,
  title             TEXT,
  extracted_text    TEXT,
  metadata_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  change_summary    TEXT,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, version_number)
);

CREATE INDEX source_versions_source_idx ON source_versions (source_id, version_number DESC);

-- ---------------------------------------------------------------------
-- Contributors
-- ---------------------------------------------------------------------

CREATE TABLE contributors (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  normalized_name  TEXT NOT NULL,
  affiliation      TEXT,
  orcid            TEXT,
  profile_url      TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, normalized_name)
);

CREATE TABLE source_contributors (
  source_id      UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  contributor_id UUID NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
  role           TEXT NOT NULL DEFAULT 'author',
  order_index    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, contributor_id, role)
);

-- ---------------------------------------------------------------------
-- Categories (hierarchical controlled taxonomy)
-- ---------------------------------------------------------------------

CREATE TABLE categories (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  normalized_name     TEXT NOT NULL,
  slug                TEXT NOT NULL,
  description         TEXT,
  parent_category_id  UUID REFERENCES categories(id),
  status              lifecycle_status NOT NULL DEFAULT 'active',
  color               TEXT,
  icon                TEXT,
  synonyms            JSONB NOT NULL DEFAULT '[]'::jsonb,
  ai_usage_guidance   TEXT,
  merged_into_category_id UUID REFERENCES categories(id),
  position            INTEGER NOT NULL DEFAULT 0,
  created_by          UUID REFERENCES users(id),
  updated_by          UUID REFERENCES users(id),
  approved_by         UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at         TIMESTAMPTZ,
  archived_by         UUID REFERENCES users(id),
  UNIQUE (organization_id, slug)
);

-- Prevents sibling categories whose names normalize identically.
CREATE UNIQUE INDEX categories_sibling_unique_root
  ON categories (organization_id, normalized_name)
  WHERE parent_category_id IS NULL AND status = 'active';

CREATE UNIQUE INDEX categories_sibling_unique_child
  ON categories (organization_id, parent_category_id, normalized_name)
  WHERE parent_category_id IS NOT NULL AND status = 'active';

CREATE INDEX categories_parent_idx ON categories (parent_category_id);
CREATE INDEX categories_name_trgm_idx ON categories USING gin (normalized_name gin_trgm_ops);

-- ---------------------------------------------------------------------
-- Tags
-- ---------------------------------------------------------------------

CREATE TABLE tags (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  normalized_name  TEXT NOT NULL,
  description      TEXT,
  usage_count      INTEGER NOT NULL DEFAULT 0,
  status           lifecycle_status NOT NULL DEFAULT 'active',
  merged_into_tag_id UUID REFERENCES tags(id),
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, normalized_name)
);

CREATE INDEX tags_name_trgm_idx ON tags USING gin (normalized_name gin_trgm_ops);

-- ---------------------------------------------------------------------
-- Source taxonomy assignments
-- ---------------------------------------------------------------------

CREATE TABLE source_categories (
  source_id         UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  category_id       UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  assignment_source assignment_source NOT NULL DEFAULT 'human',
  confidence        NUMERIC(4,3),
  approved          BOOLEAN NOT NULL DEFAULT false,
  assigned_by       UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, category_id)
);

CREATE INDEX source_categories_category_idx ON source_categories (category_id);

CREATE TABLE source_tags (
  source_id         UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  tag_id            UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  assignment_source assignment_source NOT NULL DEFAULT 'human',
  confidence        NUMERIC(4,3),
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, tag_id)
);

CREATE INDEX source_tags_tag_idx ON source_tags (tag_id);

-- ---------------------------------------------------------------------
-- Collections
-- ---------------------------------------------------------------------

CREATE TABLE collections (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  normalized_name   TEXT NOT NULL,
  slug              TEXT NOT NULL,
  description       TEXT,
  purpose           TEXT,
  research_question TEXT,
  collection_type   collection_type NOT NULL DEFAULT 'manual',
  visibility        visibility_level NOT NULL DEFAULT 'organization',
  owner_id          UUID REFERENCES users(id),
  status            lifecycle_status NOT NULL DEFAULT 'active',
  cover_image_url   TEXT,
  default_sort      TEXT NOT NULL DEFAULT 'position',
  pinned            BOOLEAN NOT NULL DEFAULT false,
  summary           TEXT,
  key_findings      JSONB NOT NULL DEFAULT '[]'::jsonb,
  contradictions    JSONB NOT NULL DEFAULT '[]'::jsonb,
  knowledge_gaps    JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_status   evidence_status,
  last_reviewed_at  TIMESTAMPTZ,
  version           INTEGER NOT NULL DEFAULT 1,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by        UUID REFERENCES users(id),
  updated_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at       TIMESTAMPTZ,
  archived_by       UUID REFERENCES users(id),
  UNIQUE (organization_id, slug)
);

CREATE INDEX collections_org_status_idx ON collections (organization_id, status);
CREATE INDEX collections_name_trgm_idx ON collections USING gin (normalized_name gin_trgm_ops);

CREATE TABLE collection_sources (
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  source_id     UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  section       TEXT,
  reason_added  TEXT,
  added_by      UUID REFERENCES users(id),
  added_via     source_interface NOT NULL DEFAULT 'dashboard',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, source_id)
);

CREATE INDEX collection_sources_source_idx ON collection_sources (source_id);

CREATE TABLE smart_collection_rules (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  collection_id     UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  rules             JSONB NOT NULL DEFAULT '{}'::jsonb,
  refresh_mode      TEXT NOT NULL DEFAULT 'manual',
  last_refreshed_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Study metadata and evidence assessments
-- ---------------------------------------------------------------------

CREATE TABLE study_metadata (
  source_id               UUID PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  organization_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  study_design            TEXT,
  registration_identifier TEXT,
  sample_size             INTEGER,
  population_description  TEXT,
  inclusion_criteria      JSONB NOT NULL DEFAULT '[]'::jsonb,
  exclusion_criteria      JSONB NOT NULL DEFAULT '[]'::jsonb,
  age_range               TEXT,
  sex_distribution        TEXT,
  geography               TEXT,
  setting                 TEXT,
  intervention            TEXT,
  comparator              TEXT,
  duration                TEXT,
  follow_up_duration      TEXT,
  primary_outcomes        JSONB NOT NULL DEFAULT '[]'::jsonb,
  secondary_outcomes      JSONB NOT NULL DEFAULT '[]'::jsonb,
  effect_sizes            JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence_intervals    JSONB NOT NULL DEFAULT '[]'::jsonb,
  p_values                JSONB NOT NULL DEFAULT '[]'::jsonb,
  attrition_rate          TEXT,
  adverse_events          JSONB NOT NULL DEFAULT '[]'::jsonb,
  statistical_methods     TEXT,
  funding_source          TEXT,
  conflicts_of_interest   TEXT,
  limitations             JSONB NOT NULL DEFAULT '[]'::jsonb,
  risk_of_bias            TEXT,
  pico_population         TEXT,
  pico_intervention       TEXT,
  pico_comparator         TEXT,
  pico_outcomes           JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Per-field confidence from the extraction model.
  field_confidence        JSONB NOT NULL DEFAULT '{}'::jsonb,
  extraction_confidence   NUMERIC(4,3),
  human_verified          BOOLEAN NOT NULL DEFAULT false,
  verified_by             UUID REFERENCES users(id),
  verified_at             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Evidence is deliberately multidimensional; there is no single opaque score.
CREATE TABLE evidence_assessments (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_id                 UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  assessed_by               UUID REFERENCES users(id),
  assessment_type           TEXT NOT NULL DEFAULT 'ai',
  study_design_strength     TEXT,
  source_authority          TEXT,
  sample_adequacy           TEXT,
  directness                TEXT,
  consistency               TEXT,
  precision                 TEXT,
  recency                   TEXT,
  population_relevance      TEXT,
  conflict_of_interest_risk TEXT,
  overall_confidence        TEXT,
  rationale                 TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX evidence_assessments_source_idx ON evidence_assessments (source_id);

-- ---------------------------------------------------------------------
-- Claims and claim evidence
-- ---------------------------------------------------------------------

CREATE TABLE claims (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  canonical_text         TEXT NOT NULL,
  simplified_text        TEXT,
  claim_type             TEXT NOT NULL DEFAULT 'finding',
  topic                  TEXT,
  population             TEXT,
  intervention           TEXT,
  comparator             TEXT,
  outcome                TEXT,
  timeframe              TEXT,
  context                TEXT,
  units                  TEXT,
  quantitative_value     TEXT,
  confidence             NUMERIC(4,3),
  evidence_status        evidence_status NOT NULL DEFAULT 'unreviewed',
  clinical_review_status TEXT NOT NULL DEFAULT 'not_reviewed',
  safety_relevance       TEXT NOT NULL DEFAULT 'none',
  safety_notes           JSONB NOT NULL DEFAULT '[]'::jsonb,
  human_notes            TEXT,
  status                 lifecycle_status NOT NULL DEFAULT 'active',
  version                INTEGER NOT NULL DEFAULT 1,
  search_vector          TSVECTOR,
  created_by             UUID REFERENCES users(id),
  created_via            source_interface NOT NULL DEFAULT 'dashboard',
  updated_by             UUID REFERENCES users(id),
  reviewed_by            UUID REFERENCES users(id),
  reviewed_at            TIMESTAMPTZ,
  last_verified_at       TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at            TIMESTAMPTZ,
  archived_by            UUID REFERENCES users(id)
);

CREATE INDEX claims_org_status_idx ON claims (organization_id, status, evidence_status);
CREATE INDEX claims_search_idx ON claims USING gin (search_vector);
CREATE INDEX claims_text_trgm_idx ON claims USING gin (lower(canonical_text) gin_trgm_ops);

CREATE OR REPLACE FUNCTION claims_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.canonical_text, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.simplified_text, '')), 'B') ||
    setweight(to_tsvector('english',
      concat_ws(' ', NEW.population, NEW.intervention, NEW.comparator,
                     NEW.outcome, NEW.topic, NEW.context)), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claims_search_vector_trigger
  BEFORE INSERT OR UPDATE ON claims
  FOR EACH ROW EXECUTE FUNCTION claims_search_vector_update();

CREATE TABLE claim_evidence (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  claim_id              UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  source_id             UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  relationship          evidence_relationship NOT NULL,
  evidence_excerpt      TEXT,
  page_number           INTEGER,
  section_reference     TEXT,
  locator               TEXT,
  chunk_id              UUID,
  evidence_strength     TEXT,
  extraction_confidence NUMERIC(4,3),
  verified_by           UUID REFERENCES users(id),
  verified_at           TIMESTAMPTZ,
  created_by            UUID REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (claim_id, source_id, relationship, locator)
);

CREATE INDEX claim_evidence_claim_idx ON claim_evidence (claim_id);
CREATE INDEX claim_evidence_source_idx ON claim_evidence (source_id);

CREATE TABLE claim_categories (
  claim_id    UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (claim_id, category_id)
);

CREATE TABLE claim_relations (
  from_claim_id UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  to_claim_id   UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  relation      TEXT NOT NULL,
  note          TEXT,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_claim_id, to_claim_id, relation)
);

-- ---------------------------------------------------------------------
-- Annotations
-- ---------------------------------------------------------------------

CREATE TABLE annotations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_id       UUID REFERENCES sources(id) ON DELETE CASCADE,
  claim_id        UUID REFERENCES claims(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id),
  annotation_type annotation_type NOT NULL DEFAULT 'note',
  body            TEXT,
  selected_text   TEXT,
  start_offset    INTEGER,
  end_offset      INTEGER,
  page_number     INTEGER,
  locator         TEXT,
  chunk_id        UUID,
  visibility      visibility_level NOT NULL DEFAULT 'organization',
  status          TEXT NOT NULL DEFAULT 'open',
  assigned_to     UUID REFERENCES users(id),
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID REFERENCES users(id),
  created_via     source_interface NOT NULL DEFAULT 'dashboard',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at     TIMESTAMPTZ,
  archived_by     UUID REFERENCES users(id),
  CONSTRAINT annotations_target_check CHECK (source_id IS NOT NULL OR claim_id IS NOT NULL)
);

CREATE INDEX annotations_source_idx ON annotations (source_id, created_at DESC);
CREATE INDEX annotations_claim_idx ON annotations (claim_id, created_at DESC);
CREATE INDEX annotations_assigned_idx ON annotations (assigned_to) WHERE assigned_to IS NOT NULL;

-- ---------------------------------------------------------------------
-- Embedding chunks
-- ---------------------------------------------------------------------

CREATE TABLE embedding_chunks (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_id         UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_version_id UUID REFERENCES source_versions(id) ON DELETE SET NULL,
  chunk_index       INTEGER NOT NULL,
  chunk_text        TEXT NOT NULL,
  token_count       INTEGER,
  heading_path      TEXT,
  page_number       INTEGER,
  start_offset      INTEGER,
  end_offset        INTEGER,
  content_type      TEXT NOT NULL DEFAULT 'body',
  -- Dimension is fixed at 768; the AI layer projects provider embeddings
  -- into this space so providers can change without a migration.
  embedding         vector(768),
  search_vector     TSVECTOR,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, chunk_index)
);

CREATE INDEX embedding_chunks_source_idx ON embedding_chunks (source_id);
CREATE INDEX embedding_chunks_org_idx ON embedding_chunks (organization_id);
CREATE INDEX embedding_chunks_fts_idx ON embedding_chunks USING gin (search_vector);

CREATE OR REPLACE FUNCTION embedding_chunks_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', coalesce(NEW.chunk_text, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER embedding_chunks_search_vector_trigger
  BEFORE INSERT OR UPDATE OF chunk_text ON embedding_chunks
  FOR EACH ROW EXECUTE FUNCTION embedding_chunks_search_vector_update();

-- IVFFlat needs training data to be worthwhile. It is created by the
-- `db:index-vectors` maintenance script once the corpus is large enough;
-- below roughly 10k chunks an exact scan is faster and always accurate.
