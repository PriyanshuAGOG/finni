-- =====================================================================
-- Nirog Bhoomi Research OS -- 0001 foundation
-- Organizations, users, roles, permissions, audit, confirmations,
-- API clients, idempotency.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------

CREATE TYPE user_status AS ENUM ('invited', 'active', 'suspended', 'deactivated');

CREATE TYPE actor_type AS ENUM ('user', 'api_client', 'system', 'worker');

CREATE TYPE source_interface AS ENUM (
  'dashboard', 'custom_gpt', 'internal_assistant', 'api', 'import', 'worker', 'automation'
);

CREATE TYPE risk_level AS ENUM ('low', 'medium', 'high', 'critical');

CREATE TYPE confirmation_status AS ENUM ('pending', 'confirmed', 'used', 'expired', 'cancelled');

CREATE TYPE api_client_type AS ENUM (
  'custom_gpt', 'browser_extension', 'internal_app', 'automation', 'external_partner'
);

-- ---------------------------------------------------------------------
-- Organizations
-- ---------------------------------------------------------------------

CREATE TABLE organizations (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  logo_url       TEXT,
  timezone       TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  default_language TEXT NOT NULL DEFAULT 'en',
  -- product_name lives in settings so the deployment can be re-branded
  -- from the admin settings screen without a code change.
  settings       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------

CREATE TABLE users (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  auth_user_id     TEXT UNIQUE,
  full_name        TEXT NOT NULL,
  email            TEXT NOT NULL,
  password_hash    TEXT,
  avatar_url       TEXT,
  job_title        TEXT,
  status           user_status NOT NULL DEFAULT 'active',
  preferences      JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_active_at   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_org_email_key ON users (organization_id, lower(email));
CREATE INDEX users_org_idx ON users (organization_id);

CREATE TABLE sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,
  ip_address      TEXT,
  user_agent      TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ---------------------------------------------------------------------
-- Roles and permissions
-- ---------------------------------------------------------------------

CREATE TABLE roles (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  slug             TEXT NOT NULL,
  description      TEXT,
  is_system_role   BOOLEAN NOT NULL DEFAULT false,
  -- Individual permissions are stored so a role can be edited later
  -- without a migration; the role label is never the authority.
  permissions      JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug)
);

CREATE TABLE user_roles (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id      UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  assigned_by  UUID REFERENCES users(id),
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

-- Direct per-user permission grants/revocations layered on top of roles.
CREATE TABLE user_permission_overrides (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission  TEXT NOT NULL,
  granted     BOOLEAN NOT NULL,
  assigned_by UUID REFERENCES users(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission)
);

-- ---------------------------------------------------------------------
-- API clients (Custom GPT prototype credential, extension, automations)
-- ---------------------------------------------------------------------

CREATE TABLE api_clients (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  client_type      api_client_type NOT NULL,
  -- Only a hash is ever stored. The plaintext key is shown once at creation.
  credential_hash  TEXT NOT NULL UNIQUE,
  credential_prefix TEXT NOT NULL,
  scopes           JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- The constrained identity this credential acts as.
  acts_as_user_id  UUID REFERENCES users(id),
  status           TEXT NOT NULL DEFAULT 'active',
  last_used_at     TIMESTAMPTZ,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ,
  revoked_at       TIMESTAMPTZ
);

CREATE INDEX api_clients_org_idx ON api_clients (organization_id);

-- OAuth 2.0 support for user-specific Custom GPT access.
CREATE TABLE oauth_clients (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id       TEXT NOT NULL UNIQUE,
  client_secret_hash TEXT NOT NULL,
  name            TEXT NOT NULL,
  redirect_uris   JSONB NOT NULL DEFAULT '[]'::jsonb,
  allowed_scopes  JSONB NOT NULL DEFAULT '[]'::jsonb,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE oauth_authorization_codes (
  code_hash             TEXT PRIMARY KEY,
  oauth_client_id       UUID NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri          TEXT NOT NULL,
  scopes                JSONB NOT NULL DEFAULT '[]'::jsonb,
  code_challenge        TEXT,
  code_challenge_method TEXT,
  expires_at            TIMESTAMPTZ NOT NULL,
  used_at               TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE oauth_tokens (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oauth_client_id    UUID NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token_hash  TEXT UNIQUE,
  refresh_token_hash TEXT UNIQUE,
  scopes             JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at         TIMESTAMPTZ NOT NULL,
  refresh_expires_at TIMESTAMPTZ,
  revoked_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX oauth_tokens_user_idx ON oauth_tokens (user_id);

-- ---------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------

CREATE TABLE audit_logs (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id       UUID REFERENCES users(id),
  actor_api_client_id UUID REFERENCES api_clients(id),
  actor_type          actor_type NOT NULL,
  action              TEXT NOT NULL,
  resource_type       TEXT NOT NULL,
  resource_id         UUID,
  parent_audit_id     UUID REFERENCES audit_logs(id),
  request_id          TEXT,
  source_interface    source_interface NOT NULL,
  previous_state      JSONB,
  new_state           JSONB,
  changed_fields      JSONB,
  ip_address          TEXT,
  user_agent          TEXT,
  confirmation_id     UUID,
  status              TEXT NOT NULL DEFAULT 'success',
  error_code          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_org_created_idx ON audit_logs (organization_id, created_at DESC);
CREATE INDEX audit_logs_resource_idx ON audit_logs (resource_type, resource_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX audit_logs_interface_idx ON audit_logs (organization_id, source_interface, created_at DESC);

-- ---------------------------------------------------------------------
-- Action confirmations (server-issued, not conversational)
-- ---------------------------------------------------------------------

CREATE TABLE action_confirmations (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_client_id       UUID REFERENCES api_clients(id),
  action_type         TEXT NOT NULL,
  resource_type       TEXT NOT NULL,
  resource_ids        JSONB NOT NULL DEFAULT '[]'::jsonb,
  action_payload_hash TEXT NOT NULL,
  summary             TEXT NOT NULL,
  required_phrase     TEXT NOT NULL,
  risk_level          risk_level NOT NULL,
  status              confirmation_status NOT NULL DEFAULT 'pending',
  expires_at          TIMESTAMPTZ NOT NULL,
  confirmed_at        TIMESTAMPTZ,
  used_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX action_confirmations_user_idx ON action_confirmations (user_id, created_at DESC);

-- ---------------------------------------------------------------------
-- Idempotency
-- ---------------------------------------------------------------------

CREATE TABLE idempotency_keys (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_key        TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  operation_id     TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  response_status  INTEGER,
  response_body    JSONB,
  state            TEXT NOT NULL DEFAULT 'in_progress',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  UNIQUE (organization_id, actor_key, idempotency_key)
);

CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

-- ---------------------------------------------------------------------
-- Rate limiting (fixed-window counters)
-- ---------------------------------------------------------------------

CREATE TABLE rate_limit_counters (
  bucket_key    TEXT NOT NULL,
  window_start  TIMESTAMPTZ NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, window_start)
);

-- ---------------------------------------------------------------------
-- Integrations
-- ---------------------------------------------------------------------

CREATE TABLE integrations (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integration_type      TEXT NOT NULL,
  name                  TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active',
  encrypted_credentials TEXT,
  configuration         JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_used_at          TIMESTAMPTZ,
  created_by            UUID REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
