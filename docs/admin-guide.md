# Administrator Guide

## Organization and product name

The deployment's display name lives in `organizations.settings.product_name`, editable via SQL today (`UPDATE organizations SET settings = settings || '{"product_name": "New Name"}' WHERE id = ...`) — a dedicated Settings UI field is a natural next addition to `src/app/(dashboard)/settings/page.tsx`.

## Roles and permissions

Six system roles ship by default (`src/domain/permissions.ts`, `SYSTEM_ROLES`): Administrator, Research Manager, Researcher, Clinical Reviewer, Content Team Member, Viewer. Each is a bundle of individual permissions stored in `roles.permissions` (JSONB) — editable per-organization without a code change. A single user can also receive a per-user permission override (`user_permission_overrides`) to grant or revoke one permission without creating a bespoke role.

## Knowledge taxonomy

The active source taxonomy is intentionally fixed to four categories:

1. **Movement, Exercise and Yoga**
2. **Lifestyle**
3. **Food**
4. **Miscellaneous**

Every source is assigned exactly one category automatically from its title and content. `Miscellaneous` is the fallback when none of the first three clearly fits. The application does not create new knowledge categories through AI or the Custom GPT.

## Research Inbox

A successfully saved source is available immediately in the Research Inbox, Library, search, synthesis and Custom GPT retrieval. Processing and enrichment continue in the background, but there is no source approval queue. Source writes and subsequent enrichment remain audit logged per record and organization-wide.

## Custom GPT and API integrations

See `docs/gpt-setup-guide.md` for the full walkthrough. In brief: `createApiClient` issues a scoped credential that always acts as one specific, real user — there is no "GPT identity" independent of a real account, so every GPT-originated write is attributable to a person. `revokeApiClient` is critical-risk and requires confirmation; the plaintext key is shown exactly once at creation.

## Retention and backups

See the "Backup recommendations" section of `docs/deployment.md`. `audit_logs`, `source_versions`, and `action_confirmations` are intentionally append-only/never garbage-collected by the application — plan storage accordingly.

## Operations visibility

`GET /api/v1/admin/queue-health` (requires `audit.read`) reports job counts by status, the oldest queued job, the most recent failures, and 30-day AI spend. The Home dashboard surfaces failed processing jobs and recent source activity directly.

## Permanent deletion

`permanentlyDeleteSource` only operates on an already-archived source, requires `source.delete_permanent` (administrator-only by default), and requires a confirmation whose phrase must be typed back exactly. Archiving (reversible) should be the default action in nearly every case — permanent deletion exists for genuine legal/compliance removal requests, not routine cleanup.
