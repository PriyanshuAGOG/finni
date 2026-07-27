# Nirog Bhoomi Research OS

An AI-native research knowledge management platform: turn every source the Nirog Bhoomi team finds into structured, searchable, reviewable, citation-ready organizational knowledge — through a dashboard, an internal AI assistant, and a Custom GPT that share one database, one permission model, and one audit trail.

## What this is

- A **complete application**, not a mockup: real Postgres schema with row-level security, a real ingestion pipeline (URL/PDF/DOI/PMID/YouTube/manual), a real Postgres-backed job queue and worker, real hybrid search (full-text + semantic + identifier + taxonomy + evidence-weighted ranking), a real AI abstraction layer (works fully offline via a deterministic provider, or with Anthropic/OpenAI), a versioned API with 100+ operations, a generated OpenAPI 3.1 spec for Custom GPT Actions, and a functional Next.js dashboard — all wired together and tested against a live database, not stubbed.
- **One domain model.** The dashboard, the API (and therefore the Custom GPT), and the worker all call the same service functions in `src/services/*.ts`. There is no separate, weaker path for GPT-originated writes.
- **Source-first, human-governed.** AI proposes (summaries, classifications, extracted claims, evidence assessments); humans decide (approve, reject, lock a field, override a claim's status). Nothing is born approved.

See `docs/architecture.md` for diagrams, `docs/admin-guide.md` / `docs/user-guide.md` for how to operate it, and `docs/gpt-setup-guide.md` to connect the Custom GPT.

## Quickstart (local development)

Requires Node 20+, PostgreSQL 15+ with `pgvector` and `pg_trgm` available.

```bash
npm install
cp .env.example .env
# edit .env: set DATABASE_URL / MIGRATION_DATABASE_URL for your local Postgres,
# and ENCRYPTION_KEY (openssl rand -hex 32). AI_PROVIDER=deterministic needs no key.

npm run db:migrate      # applies db/migrations/*.sql
npm run db:seed         # realistic sample data (Nirog Bhoomi taxonomy, sources, claims, briefs)

npm run dev              # dashboard + API at http://localhost:3000
npm run worker           # in a second terminal: runs the enrichment pipeline
```

Sign in at `/sign-in` with `admin@nirogbhoomi.dev` / `DevPassword123!` (or any of the other seeded role accounts — see the seed script's console output).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server (dashboard + `/api/v1/*`) |
| `npm run build` / `npm run start` | Production build / serve |
| `npm run worker` | Runs the enrichment/research/job-queue worker |
| `npm run db:migrate` | Applies pending migrations (tracked in `schema_migrations`) |
| `npm run db:reset` | **Local only** — drops and recreates the schema |
| `npm run db:seed` | Loads sample Nirog Bhoomi data (org, roles, taxonomy, sources, claims, briefs) |
| `npm run openapi:generate` | Regenerates `openapi/full.yaml` and `openapi/gpt-actions.yaml` from the live operation registry |
| `npm run docs:generate` | Regenerates `docs/action-risk-matrix.md` and `docs/api-scope-matrix.md` from the same registry |
| `npm run eval:retrieval` | Runs the retrieval evaluation suite against seeded data |
| `npm run test` | Unit + integration tests (needs a reachable Postgres) |
| `npm run typecheck` | `tsc --noEmit` |

## Project layout

```
db/migrations/        Versioned SQL migrations (schema, RLS, auth-lookup functions)
src/lib/               Env validation, db access (RLS-aware), crypto, errors, permission context
src/domain/            Permissions, scopes, and the action-risk matrix (single source of truth)
src/services/          Domain services: source, ingestion, collection, taxonomy, claim,
                        annotation, search, synthesis, research, brief, content, processing,
                        confirmation, audit, auth
src/ai/                Provider abstraction (Anthropic/OpenAI/deterministic), enrichment pipeline
src/extraction/        URL fetch (SSRF-guarded), HTML/PDF/YouTube extraction, chunking, external search
src/worker/            Job queue handlers and the worker process
src/api/                Operation registry + HTTP handler; every /api/v1 route is one entry here
src/api/operations/    ~100 operation definitions (schema, permission, risk, description) —
                        the OpenAPI spec and the GPT Actions schema are generated from these
src/app/                Next.js dashboard (App Router) and API route entry point
tests/unit/             Fast, no-database tests
tests/integration/      Tests against a real (isolated, self-cleaning) Postgres organization
scripts/                migrate, seed, reset, generate-openapi, generate-docs, eval-retrieval, smoke
openapi/                Generated OpenAPI 3.1 specs
docs/                   Architecture, deployment, admin/user guides, GPT setup, risk/scope matrices
```

## Deliverables checklist

Everything the build spec asked for, and where to find it:

- Complete source code, schema, migrations, seed script — see layout above.
- Frontend, backend, worker, auth, permissions, ingestion, AI enrichment, search/retrieval, dashboard assistant, versioned API — all implemented and exercised by `tests/integration/*` against a live database.
- OpenAPI 3.1 schema, Custom GPT instructions, conversation starters, API auth setup guide — `openapi/gpt-actions.yaml`, `docs/gpt-instructions.md`, `docs/gpt-setup-guide.md`.
- Environment variable template, local dev instructions, production deployment guide — `.env.example`, this file, `docs/deployment.md`.
- Testing suite, retrieval evaluation suite — `tests/`, `scripts/eval-retrieval.ts`.
- Admin and user documentation — `docs/admin-guide.md`, `docs/user-guide.md`.
- Architecture, data-flow, and entity-relationship diagrams — `docs/architecture.md` (Mermaid).
- Action-risk matrix and API scope matrix — generated, not hand-maintained: `docs/action-risk-matrix.md`, `docs/api-scope-matrix.md`.

## Honest scope notes

This was built as a single, large implementation pass, tested end to end against a live database (schema → services → API → worker → dashboard → Custom GPT schema), not a set of disconnected mockups. A few things are deliberately smaller than a multi-quarter team effort would produce, and are called out rather than glossed over:

- The **dashboard UI** covers every primary screen (Home, Research Inbox, Library + source detail with all tabs, Collections, Categories, Claims, Search/Assistant, Briefs, Content Studio, Activity, Settings) functionally, backed by the real API — but is intentionally light on visual polish, drag-and-drop, and some secondary flows (e.g. bulk-select UI in table views) that the API already supports but the UI doesn't yet expose a control for.
- **File uploads** work end to end for PDF/text via the API; local disk storage is implemented, S3 wiring is scaffolded (`STORAGE_DRIVER=s3` env vars) but not connected to an actual upload handler.
- The **deterministic AI provider** (default, no API key) does real extractive/heuristic analysis — not canned responses — so the whole pipeline runs and is testable offline. Enrichment and synthesis *quality* is naturally better with a real provider (`AI_PROVIDER=anthropic`); `scripts/eval-retrieval.ts` reports this gap honestly rather than hiding it.
- **Browser extension** and **Slack/email/WhatsApp ingestion** are named as future integrations in the schema (`integrations` table, `source_interface` enum) and permission model but have no client implementation, matching how the spec describes them ("future").
