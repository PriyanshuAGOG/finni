# Administrator Guide

## Organization and product name

The deployment's display name lives in `organizations.settings.product_name`, editable via SQL today (`UPDATE organizations SET settings = settings || '{"product_name": "New Name"}' WHERE id = ...`) — a dedicated Settings UI field is a natural next addition to `src/app/(dashboard)/settings/page.tsx`.

## Roles and permissions

Six system roles ship by default (`src/domain/permissions.ts`, `SYSTEM_ROLES`): Administrator, Research Manager, Researcher, Clinical Reviewer, Content Team Member, Viewer. Each is a bundle of individual permissions stored in `roles.permissions` (JSONB) — editable per-organization without a code change. A single user can also receive a per-user permission override (`user_permission_overrides`) to grant or revoke one permission without creating a bespoke role.

## Taxonomy governance

- `taxonomy.create` / `taxonomy.update` / `taxonomy.merge` / `taxonomy.archive` are separate permissions — a researcher can typically create but not merge.
- Duplicate categories are actively resisted: `findSimilarCategories` runs before every creation, sibling names are protected by a partial unique database index (not just an application check), and a merge preserves the old name as a synonym so future classification still resolves correctly.
- `organizations.settings.allow_ai_category_creation` (default `false`) controls whether the classification worker stage may propose new categories at all — even when enabled, proposals are recorded as review-request annotations, never auto-created.

## Reviewing the Research Inbox

Sources enter the library `needs_review` and never self-promote to `approved`. A source cannot be approved while it is still processing (`completed` or `completed_with_warnings` required). Rejecting a source requires a reason; conditional approval requires at least one stated condition. All three transitions, plus every other write, produce an audit-log entry queryable per-record (`getResourceActivity`) or organization-wide (`listAuditEvents`, requires `audit.read`).

## Custom GPT and API integrations

See `docs/gpt-setup-guide.md` for the full walkthrough. In brief: `createApiClient` issues a scoped credential that always acts as one specific, real user — there is no "GPT identity" independent of a real account, so every GPT-originated write is attributable to a person. `revokeApiClient` is critical-risk and requires confirmation; the plaintext key is shown exactly once at creation.

## Retention and backups

See the "Backup recommendations" section of `docs/deployment.md`. `audit_logs`, `source_versions`, and `action_confirmations` are intentionally append-only/never garbage-collected by the application — plan storage accordingly.

## Operations visibility

`GET /api/v1/admin/queue-health` (requires `audit.read`) reports job counts by status, the oldest queued job, the most recent failures, and 30-day AI spend. The Home dashboard surfaces failed jobs and stale review assignments directly.

## Permanent deletion

`permanentlyDeleteSource` only operates on an already-archived source, requires `source.delete_permanent` (administrator-only by default), and requires a confirmation whose phrase must be typed back exactly. Archiving (reversible) should be the default action in nearly every case — permanent deletion exists for genuine legal/compliance removal requests, not routine cleanup.
