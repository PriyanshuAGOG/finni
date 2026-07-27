# Deployment Guide

## Architecture

- **Frontend + API gateway** — Next.js App Router (dashboard pages as server components; `/api/v1/*` as the versioned JSON API). Deploy to Vercel or any Node host.
- **Database** — PostgreSQL 15+ with `pgvector` and `pg_trgm`. Deploy on Supabase, RDS, Neon, or self-hosted.
- **Worker** — a long-running Node process (`npm run worker`) polling the `processing_jobs` table. Deploy as a persistent process (Fly.io, Render background worker, ECS task, a VM) — **not** a serverless function, since it needs to poll continuously.
- **Object storage** — S3-compatible, for uploaded files and snapshots (only needed once `STORAGE_DRIVER=s3` is wired to actual upload handlers).

There is deliberately no Redis/queue broker: the durable queue is Postgres itself (`processing_jobs`, claimed with `FOR UPDATE SKIP LOCKED`), which is enough at this scale and one fewer moving part to operate.

## 1. Provision PostgreSQL

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
```

Create the application role. It must **not** be a superuser and must **not** own the tables it queries — row-level security is bypassed for superusers and table owners, which would silently disable organization isolation.

```sql
CREATE ROLE nirog_app LOGIN PASSWORD '<strong-password>';
GRANT USAGE ON SCHEMA public TO nirog_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nirog_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nirog_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO nirog_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nirog_app;
```

Run migrations as the schema owner (a superuser or the table-owning role), not as `nirog_app`:

```bash
MIGRATION_DATABASE_URL=postgres://postgres:<pw>@<host>/nirog_research \
DATABASE_URL=postgres://nirog_app:<pw>@<host>/nirog_research \
npm run db:migrate
```

## 2. Configure environment variables

Copy `.env.example`, fill in `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `ENCRYPTION_KEY` (generate with `openssl rand -hex 32`), and an `AI_PROVIDER` (use `anthropic` or `openai` in production — `deterministic` is for local dev and CI only).

## 3. Deploy the web application

**Vercel**: connect the repo, set the environment variables above in Project Settings, deploy. `next build` runs `tsc` as part of the type-check step, so a broken build fails the deploy rather than shipping.

**Other Node hosts**: `npm run build && npm run start` (serves on `PORT`, default 3000).

## 4. Deploy the worker

The worker is a separate long-running process — it is not served by Next.js:

```bash
npm run worker
```

Deploy this as its own service (Fly.io machine, Render background worker, a small ECS task, systemd unit on a VM). It needs the same `DATABASE_URL`, `AI_*`, and `SEARCH_*` variables as the web app. Scale `WORKER_CONCURRENCY` and the number of worker instances together — each instance claims jobs independently via `SKIP LOCKED`, so running several is safe.

## 5. Run migrations and seed data

```bash
npm run db:migrate          # apply schema (idempotent, tracked in schema_migrations)
npm run db:seed             # optional: realistic sample data for evaluation/demo
```

## 6. Generate the OpenAPI spec and docs for this deployment

```bash
npm run openapi:generate     # writes openapi/full.yaml and openapi/gpt-actions.yaml
npm run docs:generate        # writes docs/action-risk-matrix.md and docs/api-scope-matrix.md
```

Re-run these after any change to `src/api/operations/*.ts` — they are generated from the live registry, so they cannot drift from what the API actually does, but only if regenerated after a change.

## 7. Set up the Custom GPT

See `docs/gpt-setup-guide.md`.

## Health checks

- `GET /api/v1/me` (authenticated) — confirms the API, database, and auth path are all working.
- Worker liveness: `workerHealth()` in `src/worker/index.ts` reports queued/running counts; wire it to whatever health-check convention your host expects (an HTTP endpoint, a Fly.io healthcheck script, etc.) — it's exported but not yet bound to a port, since the worker has no HTTP server of its own by design.
- `GET /admin/queue-health` (via the API, `audit.read` permission) — job counts by status, oldest queued job, recent failures, 30-day AI cost.

## Backup recommendations

- **Database**: continuous WAL archiving + daily base backups at minimum (Supabase/RDS/Neon provide this managed). Test restores periodically — an untested backup is not a backup.
- **Object storage**: enable versioning on the bucket if using S3; source snapshots and uploaded files are the one thing that cannot be regenerated from the database alone.
- **Retention**: `audit_logs`, `source_versions`, and `action_confirmations` grow without bound by design (they are the accountability trail) — plan storage growth accordingly, or add a retention policy under Settings once that screen is built out, rather than deleting rows manually.

## Production checklist

- [ ] `nirog_app` (or equivalent) is confirmed non-superuser, non-owner (`\du` in psql shows no `Superuser` attribute).
- [ ] `ENCRYPTION_KEY` is set and stored in a secrets manager, not committed.
- [ ] `AI_PROVIDER` is `anthropic` or `openai`, not `deterministic`.
- [ ] At least one administrator account exists with a real password (the seed script's accounts are for development only — do not deploy them to production).
- [ ] The worker process is running and its logs show jobs completing.
- [ ] `npm run test` passes against the target database before each deploy.
- [ ] TLS terminates in front of both the web app and any direct database connections.
