# Research Assistant Setup Guide (MCP)

OpenAI stopped allowing new Custom GPTs on 2026-09-25 and is retiring them entirely on 2026-12-11, replaced by Apps built on the Model Context Protocol (MCP). A Custom GPT that gets auto-migrated becomes a **skills-only app with no working connection at all** -- Actions do not carry over. This guide covers connecting to the **MCP server at `/mcp`**, which replaces the old OpenAPI Actions integration entirely.

If you are still on an un-migrated Custom GPT and need the legacy Actions setup, see "Appendix: legacy Custom GPT Actions" at the end of this file -- but note it stops working once OpenAI migrates or retires the GPT.

## 0. Connect the MCP server in ChatGPT

1. In ChatGPT: **Settings -> Connectors -> Create -> Add an MCP server** (or, inside an App/GPT editor, **Configure -> Model Context Protocol**).
2. **Server URL**: `https://<your-deployment>/mcp` (not `localhost`, not the `research.nirogbhoomi.com` placeholder -- see the warning in step 3 of the Actions appendix, which applies here too).
3. **Authentication**: choose one --
   - **OAuth** (recommended beyond a personal prototype): ChatGPT discovers the authorization server automatically from `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server` -- no need to paste endpoint URLs by hand. Create an `oauth_clients` row exactly as in Path A of the Appendix (the same OAuth implementation serves both the legacy Actions flow and MCP).
   - **API key**: paste a `nbgpt_...` key from `createApiClient`, exactly as in Path B of the Appendix. Same credential, same scopes, same risk notes.
4. ChatGPT calls `tools/list` on connect and shows the 27 tools from `CORE_GPT_ACTIONS` (`src/domain/core-gpt-actions.ts`) -- the same curated set the old Actions schema exposed, now shared by both surfaces so they can never drift apart. There is no 30-operation cap on MCP, but the set stays curated rather than exposing the full internal registry.
5. Paste `docs/gpt-instructions.md` into the App/GPT's instructions, exactly as before.
6. Work through the Appendix's "Test in GPT Preview" checklist (step 5) using MCP tool calls instead of Actions calls -- the tool names, inputs and outputs are identical.

To change which operations are exposed, edit `CORE_GPT_ACTIONS` in `src/domain/core-gpt-actions.ts` (one list now feeds both `openapi/gpt-actions.yaml` and `/mcp`) and re-run `npm run openapi:generate`.

### If the connection fails

- A 401 with no body reaching ChatGPT at all means the request never arrived -- check the server URL and deployment reachability first (`curl -i https://<your-domain>/mcp`), same as the Actions appendix's step 7.
- A 401 **with** a `WWW-Authenticate: Bearer resource_metadata="..."` header reaching ChatGPT means the server is up but rejected the credential -- check the OAuth client or API key, not the deployment.
- The dashboard's `/errors` page shows every 5xx the MCP endpoint raised, same as for `/api/v1`.

---

# Appendix: legacy Custom GPT Actions

This section is retained for deployments still running an un-migrated Custom GPT. Follow it only if you are not yet on the MCP connector above.

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
2. Verify the servers block points at your actual deployment, not `localhost` and not the `research.nirogbhoomi.com` example domain baked into the repo. `research.nirogbhoomi.com` is a placeholder that has never been a real, DNS-resolving host — if it ends up in the imported schema, every action call fails at the network level with a generic "connection failed" from ChatGPT (a request that never reaches the server at all, so nothing appears in `/errors` or the server logs either). The `/gpt-actions.yaml` route rewrites this placeholder to the actual request origin automatically, so importing by URL from your real deployment (not by pasting a copy of the file that still has the placeholder in it) always produces the right value. If you change your deployment's domain later, re-import (or edit) the Action in the GPT editor — ChatGPT bakes in the servers URL at import time and does not re-fetch it automatically.

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

## 7. If the GPT reports a connection failure

The dashboard's **Errors** page (`/errors`, requires `audit.read`) shows every 5xx the API server actually raised, and every crash caught in the dashboard's own UI, with the stack trace and which operation was involved. Check it first.

If the GPT says something like "connection failed" and nothing shows up in `/errors` for that time, the request never reached the server at all — the API process itself is fine. The two causes seen in practice:

- The Action's servers URL doesn't resolve or isn't reachable (see the warning in step 3 above about the placeholder domain).
- The deployment is down, mid-deploy, or the custom domain's DNS/TLS isn't fully provisioned yet.

Confirm with a plain request from outside ChatGPT, e.g. `curl -i https://<your-domain>/gpt-actions.yaml` — if that hangs or fails to resolve, ChatGPT will fail identically, and the fix is on the hosting/DNS side, not in this codebase.

## 8. Rotating or revoking access

- OAuth: revoke a single user's access by POSTing to `/oauth/revoke` with `token=<access_or_refresh_token>` (RFC 7009 — either token type works, the endpoint matches whichever hash exists). To cut off every user of the integration at once, expire the `oauth_clients` row's status instead.
- API key prototype: call `revokeApiClient` (critical risk, requires administrator confirmation). Issue a new key with `createApiClient` if the integration is still needed — the old key cannot be recovered or reactivated.
