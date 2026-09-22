-- =====================================================================
-- Runtime database safety hardening.
--
-- The deployed DATABASE_URL may point at Neon's owner role. The application
-- must never execute normal requests or operational scripts with BYPASSRLS.
-- Create a NOLOGIN runtime role and allow the owner session to SET ROLE into
-- it. The application connection layer will do that on checkout.
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nirog_app_runtime') THEN
    CREATE ROLE nirog_app_runtime
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOREPLICATION
      NOBYPASSRLS;
  ELSE
    ALTER ROLE nirog_app_runtime
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOREPLICATION
      NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO nirog_app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nirog_app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nirog_app_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO nirog_app_runtime;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nirog_app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO nirog_app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO nirog_app_runtime;

DO $$
BEGIN
  EXECUTE format('GRANT nirog_app_runtime TO %I', current_user);
END $$;
