-- =====================================================================
-- Nirog Bhoomi Research OS -- 0003 workflows
-- Processing jobs, research jobs, briefs, generated content, saved searches.
-- =====================================================================

CREATE TYPE job_status AS ENUM (
  'queued', 'running', 'completed', 'completed_with_warnings',
  'failed', 'cancelled', 'dead_letter'
);

-- ---------------------------------------------------------------------
-- Processing jobs -- the durable queue backing the ingestion pipeline.
-- Postgres is the queue: SKIP LOCKED gives at-most-once delivery per
-- worker without adding Redis to the operational surface of a small team.
-- ---------------------------------------------------------------------

CREATE TABLE processing_jobs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_id       UUID REFERENCES sources(id) ON DELETE CASCADE,
  research_job_id UUID,
  brief_id        UUID,
  job_type        TEXT NOT NULL,
  status          job_status NOT NULL DEFAULT 'queued',
  priority        INTEGER NOT NULL DEFAULT 100,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  progress        NUMERIC(4,3) NOT NULL DEFAULT 0,
  current_stage   TEXT,
  -- Stage-level status so a failure can be retried from the stage that
  -- broke rather than re-running the whole pipeline.
  stage_states    JSONB NOT NULL DEFAULT '{}'::jsonb,
  input           JSONB NOT NULL DEFAULT '{}'::jsonb,
  output          JSONB NOT NULL DEFAULT '{}'::jsonb,
  warnings        JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_code      TEXT,
  error_message   TEXT,
  -- Idempotency guard: a job with the same dedupe key will not be
  -- enqueued twice while an earlier one is still pending.
  dedupe_key      TEXT,
  locked_by       TEXT,
  locked_at       TIMESTAMPTZ,
  run_after       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX processing_jobs_claim_idx
  ON processing_jobs (status, run_after, priority)
  WHERE status IN ('queued', 'running');
CREATE INDEX processing_jobs_source_idx ON processing_jobs (source_id, created_at DESC);
CREATE INDEX processing_jobs_org_status_idx ON processing_jobs (organization_id, status, created_at DESC);
CREATE UNIQUE INDEX processing_jobs_dedupe_idx
  ON processing_jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');

-- ---------------------------------------------------------------------
-- Research jobs
-- ---------------------------------------------------------------------

CREATE TABLE research_jobs (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title                   TEXT NOT NULL,
  research_question       TEXT NOT NULL,
  instructions            TEXT,
  search_scope            TEXT NOT NULL DEFAULT 'combined',
  internal_search_enabled BOOLEAN NOT NULL DEFAULT true,
  external_search_enabled BOOLEAN NOT NULL DEFAULT true,
  date_range              JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_type_filters     JSONB NOT NULL DEFAULT '[]'::jsonb,
  study_design_filters    JSONB NOT NULL DEFAULT '[]'::jsonb,
  population              TEXT,
  intervention            TEXT,
  outcomes                JSONB NOT NULL DEFAULT '[]'::jsonb,
  geography               JSONB NOT NULL DEFAULT '[]'::jsonb,
  inclusion_criteria      JSONB NOT NULL DEFAULT '[]'::jsonb,
  exclusion_criteria      JSONB NOT NULL DEFAULT '[]'::jsonb,
  maximum_candidates      INTEGER NOT NULL DEFAULT 25,
  automatically_ingest_selected BOOLEAN NOT NULL DEFAULT false,
  status                  job_status NOT NULL DEFAULT 'queued',
  progress                NUMERIC(4,3) NOT NULL DEFAULT 0,
  search_queries_used     JSONB NOT NULL DEFAULT '[]'::jsonb,
  requested_by            UUID REFERENCES users(id),
  result_summary          TEXT,
  findings                JSONB NOT NULL DEFAULT '[]'::jsonb,
  gaps                    JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_collection_id   UUID REFERENCES collections(id),
  generated_brief_id      UUID,
  started_at              TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  error                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX research_jobs_org_idx ON research_jobs (organization_id, created_at DESC);

CREATE TABLE research_candidates (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  research_job_id  UUID NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
  url              TEXT,
  title            TEXT NOT NULL,
  publisher        TEXT,
  publication_date DATE,
  source_type      source_type,
  study_design     TEXT,
  population       TEXT,
  snippet          TEXT,
  relevance_reason TEXT,
  relevance_score  NUMERIC(4,3),
  key_limitation   TEXT,
  -- Candidates are external until explicitly ingested and reviewed.
  origin           TEXT NOT NULL DEFAULT 'external_web',
  duplicate_status duplicate_status NOT NULL DEFAULT 'none',
  existing_source_id UUID REFERENCES sources(id),
  decision         TEXT NOT NULL DEFAULT 'pending',
  decision_reason  TEXT,
  decided_by       UUID REFERENCES users(id),
  decided_at       TIMESTAMPTZ,
  ingested_source_id UUID REFERENCES sources(id),
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX research_candidates_job_idx ON research_candidates (research_job_id, decision);

-- ---------------------------------------------------------------------
-- Research briefs
-- ---------------------------------------------------------------------

CREATE TABLE research_briefs (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title                  TEXT NOT NULL,
  brief_type             TEXT NOT NULL DEFAULT 'evidence_review',
  research_question      TEXT,
  scope                  TEXT,
  audience               TEXT NOT NULL DEFAULT 'internal_research',
  status                 TEXT NOT NULL DEFAULT 'draft',
  content                JSONB NOT NULL DEFAULT '{}'::jsonb,
  executive_summary      TEXT,
  methodology            TEXT,
  findings               TEXT,
  conflicting_evidence   TEXT,
  limitations            TEXT,
  recommendations        TEXT,
  safety_notes           TEXT,
  source_selection_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  citation_style         TEXT NOT NULL DEFAULT 'numbered',
  approved_only          BOOLEAN NOT NULL DEFAULT true,
  generated_by           TEXT,
  reviewed_by            UUID REFERENCES users(id),
  approved_by            UUID REFERENCES users(id),
  approved_at            TIMESTAMPTZ,
  version                INTEGER NOT NULL DEFAULT 1,
  created_by             UUID REFERENCES users(id),
  updated_by             UUID REFERENCES users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at            TIMESTAMPTZ,
  archived_by            UUID REFERENCES users(id)
);

CREATE INDEX research_briefs_org_idx ON research_briefs (organization_id, status, created_at DESC);

CREATE TABLE brief_sources (
  brief_id           UUID NOT NULL REFERENCES research_briefs(id) ON DELETE CASCADE,
  source_id          UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  citation_order     INTEGER NOT NULL DEFAULT 0,
  usage_type         TEXT NOT NULL DEFAULT 'primary',
  included_claim_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (brief_id, source_id)
);

CREATE TABLE brief_versions (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  brief_id       UUID NOT NULL REFERENCES research_briefs(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  snapshot       JSONB NOT NULL,
  change_summary TEXT,
  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (brief_id, version_number)
);

-- ---------------------------------------------------------------------
-- Generated content
-- ---------------------------------------------------------------------

CREATE TABLE generated_content (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  content_type     TEXT NOT NULL,
  audience         TEXT,
  instructions     TEXT,
  body             TEXT,
  sections         JSONB NOT NULL DEFAULT '[]'::jsonb,
  status           TEXT NOT NULL DEFAULT 'draft',
  citation_style   TEXT NOT NULL DEFAULT 'numbered',
  source_policy    TEXT NOT NULL DEFAULT 'approved_only',
  brand_guidance   TEXT,
  prohibited_claims JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags     JSONB NOT NULL DEFAULT '[]'::jsonb,
  unsupported_claims JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_by     TEXT,
  approved_by      UUID REFERENCES users(id),
  approved_at      TIMESTAMPTZ,
  version          INTEGER NOT NULL DEFAULT 1,
  created_by       UUID REFERENCES users(id),
  updated_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at      TIMESTAMPTZ
);

CREATE INDEX generated_content_org_idx ON generated_content (organization_id, created_at DESC);

CREATE TABLE generated_content_citations (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  generated_content_id UUID NOT NULL REFERENCES generated_content(id) ON DELETE CASCADE,
  source_id            UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  claim_id             UUID REFERENCES claims(id) ON DELETE SET NULL,
  chunk_id             UUID REFERENCES embedding_chunks(id) ON DELETE SET NULL,
  citation_marker      TEXT NOT NULL,
  locator              TEXT,
  supported_text       TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX generated_content_citations_content_idx
  ON generated_content_citations (generated_content_id);

-- ---------------------------------------------------------------------
-- Saved searches
-- ---------------------------------------------------------------------

CREATE TABLE saved_searches (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  query             TEXT,
  structured_filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  alert_enabled     BOOLEAN NOT NULL DEFAULT false,
  alert_frequency   TEXT,
  last_run_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Observability: AI usage and search telemetry
-- ---------------------------------------------------------------------

CREATE TABLE ai_usage_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  capability      TEXT NOT NULL,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
  latency_ms      INTEGER,
  status          TEXT NOT NULL DEFAULT 'success',
  error_code      TEXT,
  request_id      TEXT,
  source_id       UUID,
  user_id         UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ai_usage_events_org_idx ON ai_usage_events (organization_id, created_at DESC);

CREATE TABLE search_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id),
  query           TEXT,
  mode            TEXT,
  filters         JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_count    INTEGER NOT NULL DEFAULT 0,
  latency_ms      INTEGER,
  source_interface source_interface NOT NULL DEFAULT 'dashboard',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX search_events_org_idx ON search_events (organization_id, created_at DESC);

-- Deferred foreign keys now that the referenced tables exist.
ALTER TABLE processing_jobs
  ADD CONSTRAINT processing_jobs_research_job_fk
  FOREIGN KEY (research_job_id) REFERENCES research_jobs(id) ON DELETE CASCADE;

ALTER TABLE processing_jobs
  ADD CONSTRAINT processing_jobs_brief_fk
  FOREIGN KEY (brief_id) REFERENCES research_briefs(id) ON DELETE CASCADE;

ALTER TABLE research_jobs
  ADD CONSTRAINT research_jobs_brief_fk
  FOREIGN KEY (generated_brief_id) REFERENCES research_briefs(id) ON DELETE SET NULL;

ALTER TABLE claim_evidence
  ADD CONSTRAINT claim_evidence_chunk_fk
  FOREIGN KEY (chunk_id) REFERENCES embedding_chunks(id) ON DELETE SET NULL;

ALTER TABLE annotations
  ADD CONSTRAINT annotations_chunk_fk
  FOREIGN KEY (chunk_id) REFERENCES embedding_chunks(id) ON DELETE SET NULL;
