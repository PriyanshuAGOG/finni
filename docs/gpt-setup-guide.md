# Custom GPT Setup Guide

This walks through connecting the Nirog Bhoomi Research Assistant Custom GPT to a running deployment of the Research OS.

## 1. Prerequisites

- The application deployed and reachable at a public HTTPS URL (see `docs/deployment.md`).
- `npm run openapi:generate` run against that deployment's operation registry, producing `openapi/gpt-actions.yaml`.
- At least one organization, one administrator user, and (for the OAuth path) one OAuth client row.

## 2. Choose an authentication path

### Path A — OAuth 2.0 (recommended for anything beyond a personal prototype)

Each person using the GPT authenticates as themselves; the GPT can only do what their own account can do.

1. Create an OAuth client:
   ```sql
   INSERT INTO oauth_clients (organization_id, client_id, client_secret_hash, name, redirect_uris, allowed_scopes)
   VALUES (
     '<org-id>',
     'nirog-research-gpt',
     encode(digest('<a-strong-random-secret>', 'sha256'), 'hex'),
     'Nirog Bhoomi Research Assistant',
     '["https://chat.openai.com/aip/oauth/callback"]',
     '["profile.read","knowledge.read","source.read","source.write","source.review","collection.read","collection.write","taxonomy.read","taxonomy.write","claim.read","claim.write","claim.review","annotation.read","annotation.write","research.run","brief.read","brief.write","content.generate","audit.read"]'
   );
   ```
   (Omit `admin.integrations` unless the GPT should be able to manage other integrations — it generally shouldn't.)
2. The `/oauth/authorize`, `/oauth/token` and `/oauth/revoke` endpoints are already implemented (`src/app/api/oauth/{authorize,token,revoke}/route.ts`), backed by the OAuth2 + PKCE flow in `src/services/auth.ts`. `/oauth/authorize` requires an existing dashboard session — a user signs in as themselves once, and the resulting token can only ever act with their own permissions.
3. In the GPT editor → **Configure** → **Actions** → **Authentication**: choose **OAuth**, set the Client ID / Secret from step 1, Authorization URL `https://<your-domain>/oauth/authorize`, Token URL `https://<your-domain>/oauth/token`, and the scope list from step 1.

### Path B — API key prototype (fastest to stand up; internal use only)

A single credential acts as one pre-authorized, constrained user. Do not use this for anything the GPT should perform "as" different people, and never grant it `admin.integrations`, `source.delete_permanent`, or other critical-risk scopes.

1. Sign in to the dashboard as an administrator.
2. Call `createApiClient` (via the dashboard's Settings screen, or directly):
   ```
   POST /api/v1/admin/api-clients
   {
     "name": "Custom GPT (prototype)",
     "client_type": "custom_gpt",
     "scopes": ["knowledge.read","source.read","source.write","collection.read","collection.write",
                "taxonomy.read","taxonomy.write","claim.read","claim.write","annotation.read",
                "annotation.write","research.run","brief.read","brief.write","content.generate"],
     "acts_as_user_id": "<a real, permission-appropriate user id>"
   }
   ```
3. The response's `api_key` is shown exactly once — store it securely.
4. In the GPT editor → **Actions** → **Authentication**: choose **API Key**, Auth Type **Bearer**, and paste the key.

## 3. Import the Action schema

1. Import by URL (`https://<your-deployment>/gpt-actions.yaml`) or paste the contents of `openapi/gpt-actions.yaml` directly.
2. Verify the servers block points at your deployment, not `localhost`.

ChatGPT's Actions editor caps a single GPT at **30 operations**. The registry has 109; `openapi/gpt-actions.yaml` ships a curated 30-operation subset (search, save, taxonomy, collections, claims, review, briefs, content, confirmations — every tool `docs/gpt-instructions.md` names by ID, plus the minimum extra reads/writes needed for a full research workflow). Admin operations (team, integrations, audit browsing) stay dashboard-only regardless of the cap.

To change which 30 are included, edit `CORE_GPT_ACTIONS` in `scripts/generate-openapi.ts` and re-run `npm run openapi:generate` — it fails loudly if the curated set exceeds 30 or references an operationId that doesn't exist. To cover more ground than one GPT allows, create a second Custom GPT pointed at a different curated set (e.g. a "Review & Admin" GPT) rather than trying to fit everything into one.

## 4. Paste the instructions

Paste the contents of `docs/gpt-instructions.md` (below the `---`) into **Instructions**. Add the conversation starters listed at the end of that file.

## 5. Test in GPT Preview before rollout

Work through each of these before sharing the GPT with the team:

- [ ] `getCurrentUser` — confirm it returns the expected identity, roles and permissions.
- [ ] `searchKnowledge` — ask a question the seed data covers (e.g. "what do we know about post-meal walking?"); confirm results and citations look right.
- [ ] `ingestUrl` on a real article URL — confirm it reports `needs_review`, not approved.
- [ ] `ingestUrl` again on the **same** URL — confirm it reports the duplicate rather than creating a second copy.
- [ ] `createCategory` for a name close to an existing one — confirm it surfaces the near-duplicate instead of silently creating it.
- [ ] `archiveSource` — confirm the GPT walks through `requestActionConfirmation` → shows you the summary → `confirmAction` → retries, rather than archiving in one step.
- [ ] Ask "what did you just do?" — confirm `getMyActionHistory` reflects the actions above.
- [ ] Attempt an action requiring a permission the connected account lacks — confirm a clear `FORBIDDEN` explanation, not a silent workaround.

## 6. Scope reference

See `docs/api-scope-matrix.md` for the full scope-to-permission mapping, and `docs/action-risk-matrix.md` for which operations require confirmation.

## 7. Rotating or revoking access

- OAuth: revoke a single user's access by POSTing to `/oauth/revoke` with `token=<access_or_refresh_token>` (RFC 7009 — either token type works, the endpoint matches whichever hash exists). To cut off every user of the integration at once, expire the `oauth_clients` row's status instead.
- API key prototype: call `revokeApiClient` (critical risk, requires administrator confirmation). Issue a new key with `createApiClient` if the integration is still needed — the old key cannot be recovered or reactivated.
