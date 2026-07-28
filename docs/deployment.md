# Deployment Guide

## Architecture

- **Frontend + API gateway** — Next.js App Router (dashboard pages as server components; `/api/v1/*` as the versioned JSON API). Deploy to Vercel or any Node host.
- **Database** — PostgreSQL 15+ with `pgvector` and `pg_trgm`. Deploy on Supabase, RDS, Neon, or self-hosted.
- **Worker** — a long-running Node process (`npm run worker`) polling the `processing_jobs` table. Deploy as a persistent process (Fly.io, Render background worker, ECS task, a VM) — **not** a serverless function, since it needs to poll continuously.
- **File storage** — original document/page snapshots captured during ingestion. `STORAGE_DRIVER=local` (default) writes to disk, fine for local dev only (no persistent disk on a serverless deploy). `STORAGE_DRIVER=appwrite` stores them as files in an Appwrite Storage bucket — see "Object storage (Appwrite)" below. `STORAGE_DRIVER=s3` is defined in the environment schema but has no driver implementation yet.

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

## 2a. Object storage (Appwrite)

This is only for file storage — original ingested documents and page snapshots. The relational data (organizations, sources, claims, the job queue, everything else) stays on Postgres regardless of this setting; Appwrite's document database can't support the row-level-security-based multi-tenancy, cross-table transactions, or the `FOR UPDATE SKIP LOCKED` job queue this app relies on, so it is deliberately scoped to storage only.

1. In the Appwrite Console, create (or use an existing) project and note its **Project ID** and API **Endpoint** (e.g. `https://fra.cloud.appwrite.io/v1`).
2. Project Settings → **API Keys** → create a new key with scopes: `files.read`, `files.write`, `buckets.read`, `buckets.write`. Copy the key immediately — it is shown once.
3. Set in `.env` (or your host's environment variables):
   ```bash
   STORAGE_DRIVER=appwrite
   APPWRITE_ENDPOINT=https://fra.cloud.appwrite.io/v1
   APPWRITE_PROJECT_ID=<your project id>
   APPWRITE_API_KEY=<the key from step 2>
   APPWRITE_BUCKET_ID=research_os_sources   # or any bucket id you prefer
   ```
   `APPWRITE_API_KEY` is a server-side secret: set it as a regular (not `NEXT_PUBLIC_`) environment variable in Vercel Project Settings, never in client code.
4. Provision the bucket once:
   ```bash
   npm run appwrite:provision
   ```
   This creates the bucket if it doesn't already exist and is safe to re-run. No per-file or per-user Appwrite permissions are granted — every read and write is mediated by this app's own API using the server API key, so the bucket only needs to be reachable by that key, not by end users directly.
5. Deploy (or redeploy) with the environment variables from step 3 in place.

If `STORAGE_DRIVER=appwrite` is set without `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID` and `APPWRITE_API_KEY` all present, the app refuses to boot with a clear `Invalid environment configuration` error rather than failing later on the first ingest.

**No local machine to run this from?** `.github/workflows/admin-tasks.yml` runs `db:migrate`, `appwrite:provision` and `bootstrap:admin` on GitHub's own runners — nothing to install or download. One-time setup: repo → **Settings → Secrets and variables → Actions** → add secrets `DATABASE_URL`, `MIGRATION_DATABASE_URL` (the schema-owner connection string — needed for `db-migrate` specifically, since the app's own `DATABASE_URL` role deliberately can't alter its own schema; see step 1 above), `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`, `APPWRITE_API_KEY`, `APPWRITE_BUCKET_ID` (and, for the admin bootstrap, `ORG_NAME`, `ORG_SLUG`, `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`). Then **Actions tab → "Admin tasks" → Run workflow**, pick the task, run — `db-migrate` first, since everything else needs the schema to exist.

## 2b. Email (team invitations)

Inviting a teammate (Settings → Team, or the `inviteMember` operation) emails them a link to set a password and activate their account. `EMAIL_PROVIDER=console` (default) just logs the email server-side instead of sending it — fine for local dev, not for production. For production, set:

```bash
EMAIL_PROVIDER=resend
EMAIL_FROM=Nirog Bhoomi Research OS <you@yourdomain.com>
RESEND_API_KEY=<a Resend API key>
```

Create a free account and API key at resend.com; `EMAIL_FROM` needs a domain verified there (or use their `onboarding@resend.dev` sender for testing). If sending fails for any reason, `inviteMember` doesn't fail the whole request — it returns the invitation link directly in the response so it can be shared manually, and the dashboard surfaces that as the success message instead.

## 3. Deploy the web application

**Vercel**: connect the repo, set the environment variables above in Project Settings, deploy. `next build` runs `tsc` as part of the type-check step, so a broken build fails the deploy rather than shipping.

> **Troubleshooting: "No Output Directory named 'public' found after the Build completed."**
> This means the project isn't being built with Vercel's Next.js framework preset — it's falling back to the static-site builder, which expects a `public/` directory of pre-built HTML. It typically happens when a project was previously configured for a static site (or the Output Directory was manually overridden) before this app existed at the repo root. The repo's `vercel.json` sets `"framework": "nextjs"` to steer this correctly, but a manual override in the dashboard takes precedence over `vercel.json`. If the error persists after redeploying: go to **Project Settings → General → Build & Development Settings**, set **Framework Preset** to **Next.js**, and make sure **Output Directory** has no manual override enabled (leave it on the framework default rather than `public`).

**Other Node hosts**: `npm run build && npm run start` (serves on `PORT`, default 3000).

## 4. Deploy the worker

The worker is a separate long-running process — it is not served by Next.js:

```bash
npm run worker
```

Deploy this as its own service (Fly.io machine, Render background worker, a small ECS task, systemd unit on a VM). It needs the same `DATABASE_URL`, `AI_*`, and `SEARCH_*` variables as the web app. Scale `WORKER_CONCURRENCY` and the number of worker instances together — each instance claims jobs independently via `SKIP LOCKED`, so running several is safe.

## 5. Run migrations and create the first administrator

```bash
npm run db:migrate          # apply schema (idempotent, tracked in schema_migrations)
```

`db:seed` (below) is synthetic demo data for evaluation only — it clears and rebuilds itself on every run, so never point it at a real deployment. For a real deployment, create the organization and first administrator instead:

```bash
ORG_NAME="Your Org Name" ORG_SLUG=your-org-slug \
ADMIN_NAME="Your Name" ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a strong password' \
npm run bootstrap:admin
```

Safe to re-run: with the same `ORG_SLUG` and `ADMIN_EMAIL` it updates the existing admin's name and password rather than erroring, so it doubles as a password reset if you ever need one. Every other teammate should be added afterward via Settings → Team (or `inviteMember`) rather than by running this script again, so each account is properly attributed to whoever invited them.

No local machine handy? Same `.github/workflows/admin-tasks.yml` covers this too — see "No local machine to run this from?" under the Appwrite section above.

```bash
npm run db:seed             # optional: realistic sample data for evaluation/demo only
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
- **Object storage**: source snapshots are the one thing that cannot be regenerated from the database alone. Appwrite Storage keeps file versions on update by default; if a future driver targets S3, enable bucket versioning there too.
- **Retention**: `audit_logs`, `source_versions`, and `action_confirmations` grow without bound by design (they are the accountability trail) — plan storage growth accordingly, or add a retention policy under Settings once that screen is built out, rather than deleting rows manually.

## Production checklist

- [ ] `nirog_app` (or equivalent) is confirmed non-superuser, non-owner (`\du` in psql shows no `Superuser` attribute).
- [ ] `ENCRYPTION_KEY` is set and stored in a secrets manager, not committed.
- [ ] `AI_PROVIDER` is `anthropic` or `openai`, not `deterministic`.
- [ ] At least one administrator account exists with a real password (the seed script's accounts are for development only — do not deploy them to production).
- [ ] The worker process is running and its logs show jobs completing.
- [ ] `npm run test` passes against the target database before each deploy.
- [ ] TLS terminates in front of both the web app and any direct database connections.
