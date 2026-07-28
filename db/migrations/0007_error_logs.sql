-- =====================================================================
-- Nirog Bhoomi Research OS -- 0007 error logs
-- Central capture point for both server-side (API/worker) and client-side
-- (dashboard React) errors, so a failure is diagnosable from the database
-- instead of living only in a Vercel log line nobody was watching.
-- =====================================================================

CREATE TYPE error_log_origin AS ENUM ('api_server', 'dashboard_client', 'worker');
CREATE TYPE error_log_severity AS ENUM ('warning', 'error', 'fatal');

-- Errors can occur before an organization or user is known (a request
-- that never authenticated, a client error on the sign-in page), so both
-- are nullable. This table is deliberately left without row-level
-- security, on the same footing as rate_limit_counters and sessions
-- documented in 0004_rls.sql: it is written from error-handling paths
-- that must never themselves fail because RLS context wasn't set, and is
-- read only through listErrorLogs, which filters by organization_id in
-- application code and requires audit.read.
CREATE TABLE error_logs (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id   UUID REFERENCES organizations(id) ON DELETE CASCADE,
  -- SET NULL rather than RESTRICT/CASCADE: an error record, and who later
  -- resolved it, should survive the acting user's account being removed.
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  origin            error_log_origin NOT NULL,
  severity          error_log_severity NOT NULL DEFAULT 'error',
  source_interface  source_interface,
  message           TEXT NOT NULL,
  stack             TEXT,
  component_stack   TEXT,
  request_id        TEXT,
  operation_id      TEXT,
  error_code        TEXT,
  path              TEXT,
  method            TEXT,
  status_code       INTEGER,
  url               TEXT,
  user_agent        TEXT,
  context           JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved          BOOLEAN NOT NULL DEFAULT false,
  resolved_at       TIMESTAMPTZ,
  resolved_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  resolution_note   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX error_logs_org_created_idx ON error_logs (organization_id, created_at DESC);
CREATE INDEX error_logs_unresolved_idx ON error_logs (organization_id, resolved, created_at DESC) WHERE resolved = false;
CREATE INDEX error_logs_severity_idx ON error_logs (severity, created_at DESC);
CREATE INDEX error_logs_request_id_idx ON error_logs (request_id) WHERE request_id IS NOT NULL;
