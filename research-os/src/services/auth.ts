import { withOrg, withoutOrg } from '../lib/db';
import {
  generateCredential,
  hashPassword,
  sha256,
  verifyPassword,
} from '../lib/crypto';
import { getEnv } from '../lib/env';
import { ApiError, notFound, unauthenticated } from '../lib/errors';
import type { ActorContext, SourceInterface } from '../lib/context';
import { requirePermission } from '../lib/context';
import { isPermission, isScope, type Permission, type Scope } from '../domain/permissions';
import { recordAudit } from './audit';

export interface AuthenticatedIdentity {
  organizationId: string;
  userId: string;
  userName: string;
  email: string;
  apiClientId?: string;
  scopes: Scope[] | null;
  permissions: Permission[];
}

// ---------------------------------------------------------------------
// Effective permissions
// ---------------------------------------------------------------------

/**
 * Resolves a user's permissions from their roles, then applies per-user
 * overrides. An explicit revocation always wins over a role grant, so a
 * single user can be restricted without inventing a new role.
 */
export async function resolvePermissions(
  organizationId: string,
  userId: string,
): Promise<Permission[]> {
  return withOrg(organizationId, async (sql) => {
    const roleRows = await sql.query<{ permissions: string[] }>(
      `SELECT r.permissions
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1`,
      [userId],
    );

    const granted = new Set<string>();
    for (const row of roleRows) {
      for (const permission of row.permissions ?? []) granted.add(permission);
    }

    const overrides = await sql.query<{ permission: string; granted: boolean }>(
      `SELECT permission, granted FROM user_permission_overrides WHERE user_id = $1`,
      [userId],
    );
    for (const override of overrides) {
      if (override.granted) granted.add(override.permission);
      else granted.delete(override.permission);
    }

    return [...granted].filter(isPermission);
  });
}

// ---------------------------------------------------------------------
// Password sessions (dashboard)
// ---------------------------------------------------------------------

export async function signIn(
  email: string,
  password: string,
  meta: { ipAddress?: string; userAgent?: string } = {},
): Promise<{ token: string; expiresAt: Date; identity: AuthenticatedIdentity }> {
  const env = getEnv();

  // A plain SELECT against `users` cannot see any rows here: RLS requires
  // an organization context, and finding that context is exactly what
  // this lookup is for. auth_find_user_by_email is the narrow, audited
  // escape hatch for this one pre-authentication case (see migration
  // 0005) -- everywhere else, org-scoped queries are used as normal.
  const user = await withoutOrg((sql) =>
    sql.one<{
      id: string;
      organization_id: string;
      full_name: string;
      email: string;
      password_hash: string | null;
      status: string;
    }>(`SELECT * FROM auth_find_user_by_email($1)`, [email]),
  );

  // The same message and a comparable amount of work either way, so the
  // response does not reveal whether an address is registered.
  const failure = () => unauthenticated('Email or password is incorrect.');
  if (!user || !user.password_hash) {
    hashPassword(password);
    throw failure();
  }
  if (!verifyPassword(password, user.password_hash)) throw failure();
  if (user.status !== 'active') {
    throw new ApiError('FORBIDDEN', `This account is ${user.status}.`, {
      suggestedAction: 'Ask an administrator to reactivate the account.',
    });
  }

  const credential = generateCredential('nbses');
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 3_600_000);

  await withoutOrg((sql) =>
    sql.query(
      `INSERT INTO sessions (user_id, token_hash, ip_address, user_agent, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [user.id, credential.hash, meta.ipAddress ?? null, meta.userAgent ?? null, expiresAt],
    ),
  );

  const permissions = await resolvePermissions(user.organization_id, user.id);

  await withOrg(user.organization_id, (sql) =>
    recordAudit(
      sql,
      {
        organizationId: user.organization_id,
        userId: user.id,
        actorType: 'user',
        sourceInterface: 'dashboard',
        permissions: new Set(permissions),
        scopes: null,
        requestId: 'signin',
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
      { action: 'auth.signed_in', resourceType: 'user', resourceId: user.id },
    ),
  );

  return {
    token: credential.plaintext,
    expiresAt,
    identity: {
      organizationId: user.organization_id,
      userId: user.id,
      userName: user.full_name,
      email: user.email,
      scopes: null,
      permissions,
    },
  };
}

export async function signOut(token: string): Promise<void> {
  await withoutOrg((sql) =>
    sql.query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1`, [sha256(token)]),
  );
}

export async function identityFromSession(token: string): Promise<AuthenticatedIdentity | null> {
  const row = await withoutOrg((sql) =>
    sql.one<{
      user_id: string;
      organization_id: string;
      full_name: string;
      email: string;
      status: string;
    }>(`SELECT * FROM auth_find_session_user($1)`, [sha256(token)]),
  );
  if (!row || row.status !== 'active') return null;

  // Best-effort activity tracking; never fail a request over it.
  void withOrg(row.organization_id, (sql) =>
    sql.query(`UPDATE users SET last_active_at = now() WHERE id = $1`, [row.user_id]),
  ).catch(() => undefined);

  return {
    organizationId: row.organization_id,
    userId: row.user_id,
    userName: row.full_name,
    email: row.email,
    scopes: null,
    permissions: await resolvePermissions(row.organization_id, row.user_id),
  };
}

// ---------------------------------------------------------------------
// API client credentials (Custom GPT prototype path)
// ---------------------------------------------------------------------

export async function identityFromApiKey(key: string): Promise<AuthenticatedIdentity | null> {
  const row = await withoutOrg((sql) =>
    sql.one<{
      id: string;
      organization_id: string;
      scopes: string[];
      acts_as_user_id: string | null;
      status: string;
      expires_at: string | null;
      revoked_at: string | null;
    }>(`SELECT * FROM auth_find_api_client($1)`, [sha256(key)]),
  );

  if (!row) return null;
  if (row.status !== 'active' || row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;

  // Every API credential acts as a real, constrained user. There is no
  // path by which a key can write without an accountable human identity.
  if (!row.acts_as_user_id) return null;

  const user = await withOrg(row.organization_id, (sql) =>
    sql.one<{ full_name: string; email: string; status: string }>(
      `SELECT full_name, email, status FROM users WHERE id = $1`,
      [row.acts_as_user_id],
    ),
  );
  if (!user || user.status !== 'active') return null;

  void withoutOrg((sql) =>
    sql.query(`UPDATE api_clients SET last_used_at = now() WHERE id = $1`, [row.id]),
  ).catch(() => undefined);

  return {
    organizationId: row.organization_id,
    userId: row.acts_as_user_id,
    userName: user.full_name,
    email: user.email,
    apiClientId: row.id,
    scopes: (row.scopes ?? []).filter(isScope),
    permissions: await resolvePermissions(row.organization_id, row.acts_as_user_id),
  };
}

export async function createApiClient(
  ctx: ActorContext,
  input: {
    name: string;
    clientType: 'custom_gpt' | 'browser_extension' | 'internal_app' | 'automation' | 'external_partner';
    scopes: Scope[];
    actsAsUserId: string;
    expiresAt?: string | null;
  },
): Promise<{ id: string; plaintextKey: string; prefix: string }> {
  requirePermission(ctx, 'integration.manage');

  const credential = generateCredential('nbgpt');

  return withOrg(ctx.organizationId, async (sql) => {
    const target = await sql.one<{ id: string }>(`SELECT id FROM users WHERE id = $1`, [
      input.actsAsUserId,
    ]);
    if (!target) throw notFound('user', input.actsAsUserId);

    const row = await sql.one<{ id: string }>(
      `INSERT INTO api_clients (
         organization_id, name, client_type, credential_hash, credential_prefix,
         scopes, acts_as_user_id, created_by, expires_at
       ) VALUES ($1,$2,$3::api_client_type,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        ctx.organizationId,
        input.name,
        input.clientType,
        credential.hash,
        credential.prefix,
        JSON.stringify(input.scopes),
        input.actsAsUserId,
        ctx.userId,
        input.expiresAt ?? null,
      ],
    );

    await recordAudit(sql, ctx, {
      action: 'api_client.created',
      resourceType: 'api_client',
      resourceId: row!.id,
      newState: {
        name: input.name,
        client_type: input.clientType,
        scopes: input.scopes,
        acts_as_user_id: input.actsAsUserId,
      },
    });

    // The plaintext is returned exactly once and never persisted.
    return { id: row!.id, plaintextKey: credential.plaintext, prefix: credential.prefix };
  });
}

export async function revokeApiClient(ctx: ActorContext, clientId: string): Promise<void> {
  requirePermission(ctx, 'integration.manage');
  await withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<{ id: string; name: string }>(
      `SELECT id, name FROM api_clients WHERE id = $1`,
      [clientId],
    );
    if (!existing) throw notFound('api client', clientId);

    await sql.query(
      `UPDATE api_clients SET status = 'revoked', revoked_at = now() WHERE id = $1`,
      [clientId],
    );
    await recordAudit(sql, ctx, {
      action: 'api_client.revoked',
      resourceType: 'api_client',
      resourceId: clientId,
      previousState: { status: 'active' },
      newState: { status: 'revoked' },
    });
  });
}

// ---------------------------------------------------------------------
// OAuth 2.0 authorization code flow with PKCE
// ---------------------------------------------------------------------

export async function createAuthorizationCode(input: {
  organizationId: string;
  oauthClientId: string;
  userId: string;
  redirectUri: string;
  scopes: Scope[];
  codeChallenge?: string;
  codeChallengeMethod?: string;
}): Promise<string> {
  const credential = generateCredential('nbcode');
  await withoutOrg((sql) =>
    sql.query(
      `INSERT INTO oauth_authorization_codes (
         code_hash, oauth_client_id, user_id, redirect_uri, scopes,
         code_challenge, code_challenge_method, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7, now() + interval '10 minutes')`,
      [
        credential.hash,
        input.oauthClientId,
        input.userId,
        input.redirectUri,
        JSON.stringify(input.scopes),
        input.codeChallenge ?? null,
        input.codeChallengeMethod ?? null,
      ],
    ),
  );
  return credential.plaintext;
}

export async function exchangeAuthorizationCode(input: {
  code: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  codeVerifier?: string;
}): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: Scope[];
}> {
  return withoutOrg(async (sql) => {
    const client = await sql.one<{ id: string; client_secret_hash: string; redirect_uris: string[] }>(
      `SELECT * FROM auth_find_oauth_client($1)`,
      [input.clientId],
    );
    if (!client) throw unauthenticated('Unknown OAuth client.');

    const record = await sql.one<{
      code_hash: string;
      oauth_client_id: string;
      user_id: string;
      redirect_uri: string;
      scopes: string[];
      code_challenge: string | null;
      code_challenge_method: string | null;
      expires_at: string;
      used_at: string | null;
    }>(`SELECT * FROM oauth_authorization_codes WHERE code_hash = $1`, [sha256(input.code)]);

    if (!record) throw unauthenticated('Invalid authorization code.');
    // A code is single-use: replaying one is treated as a compromise
    // signal, and every token already issued from it is revoked.
    if (record.used_at) {
      await sql.query(
        `UPDATE oauth_tokens SET revoked_at = now()
         WHERE oauth_client_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [record.oauth_client_id, record.user_id],
      );
      throw unauthenticated('This authorization code has already been used.');
    }
    if (new Date(record.expires_at).getTime() < Date.now()) {
      throw unauthenticated('This authorization code has expired.');
    }
    if (record.oauth_client_id !== client.id) {
      throw unauthenticated('This code was issued to a different client.');
    }
    if (record.redirect_uri !== input.redirectUri) {
      throw unauthenticated('The redirect URI does not match the authorization request.');
    }

    if (record.code_challenge) {
      if (!input.codeVerifier) throw unauthenticated('A PKCE code verifier is required.');
      const challenge =
        record.code_challenge_method === 'plain'
          ? input.codeVerifier
          : Buffer.from(sha256(input.codeVerifier), 'hex').toString('base64url');
      if (challenge !== record.code_challenge) {
        throw unauthenticated('The PKCE code verifier does not match.');
      }
    } else if (input.clientSecret) {
      if (sha256(input.clientSecret) !== client.client_secret_hash) {
        throw unauthenticated('Invalid client secret.');
      }
    } else {
      throw unauthenticated('Either a client secret or a PKCE verifier is required.');
    }

    await sql.query(
      `UPDATE oauth_authorization_codes SET used_at = now() WHERE code_hash = $1`,
      [record.code_hash],
    );

    const access = generateCredential('nbat');
    const refresh = generateCredential('nbrt');
    const expiresIn = 3600;

    await sql.query(
      `INSERT INTO oauth_tokens (
         oauth_client_id, user_id, access_token_hash, refresh_token_hash,
         scopes, expires_at, refresh_expires_at
       ) VALUES ($1,$2,$3,$4,$5, now() + interval '1 hour', now() + interval '30 days')`,
      [
        client.id,
        record.user_id,
        access.hash,
        refresh.hash,
        JSON.stringify(record.scopes),
      ],
    );

    return {
      accessToken: access.plaintext,
      refreshToken: refresh.plaintext,
      expiresIn,
      scopes: (record.scopes ?? []).filter(isScope),
    };
  });
}

export async function identityFromAccessToken(
  token: string,
): Promise<AuthenticatedIdentity | null> {
  const row = await withoutOrg((sql) =>
    sql.one<{
      user_id: string;
      scopes: string[];
      organization_id: string;
      full_name: string;
      email: string;
      status: string;
    }>(`SELECT * FROM auth_find_oauth_token_user($1)`, [sha256(token)]),
  );
  if (!row || row.status !== 'active') return null;

  return {
    organizationId: row.organization_id,
    userId: row.user_id,
    userName: row.full_name,
    email: row.email,
    scopes: (row.scopes ?? []).filter(isScope),
    permissions: await resolvePermissions(row.organization_id, row.user_id),
  };
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  return withoutOrg(async (sql) => {
    const row = await sql.one<{
      id: string;
      oauth_client_id: string;
      user_id: string;
      scopes: string[];
      refresh_expires_at: string | null;
    }>(
      `SELECT id, oauth_client_id, user_id, scopes, refresh_expires_at
       FROM oauth_tokens
       WHERE refresh_token_hash = $1 AND revoked_at IS NULL`,
      [sha256(refreshToken)],
    );
    if (!row) throw unauthenticated('Invalid refresh token.');
    if (row.refresh_expires_at && new Date(row.refresh_expires_at).getTime() < Date.now()) {
      throw unauthenticated('This refresh token has expired.');
    }

    // Rotate on every use so a leaked refresh token has a short life.
    await sql.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE id = $1`, [row.id]);

    const access = generateCredential('nbat');
    const refresh = generateCredential('nbrt');
    await sql.query(
      `INSERT INTO oauth_tokens (
         oauth_client_id, user_id, access_token_hash, refresh_token_hash,
         scopes, expires_at, refresh_expires_at
       ) VALUES ($1,$2,$3,$4,$5, now() + interval '1 hour', now() + interval '30 days')`,
      [row.oauth_client_id, row.user_id, access.hash, refresh.hash, JSON.stringify(row.scopes)],
    );

    return { accessToken: access.plaintext, refreshToken: refresh.plaintext, expiresIn: 3600 };
  });
}

export async function revokeToken(token: string): Promise<void> {
  const hash = sha256(token);
  await withoutOrg((sql) =>
    sql.query(
      `UPDATE oauth_tokens SET revoked_at = now()
       WHERE (access_token_hash = $1 OR refresh_token_hash = $1) AND revoked_at IS NULL`,
      [hash],
    ),
  );
}

// ---------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------

export function contextFromIdentity(
  identity: AuthenticatedIdentity,
  options: { sourceInterface: SourceInterface; requestId: string; ipAddress?: string; userAgent?: string },
): ActorContext {
  return {
    organizationId: identity.organizationId,
    userId: identity.userId,
    userName: identity.userName,
    apiClientId: identity.apiClientId,
    actorType: identity.apiClientId ? 'api_client' : 'user',
    sourceInterface: options.sourceInterface,
    permissions: new Set(identity.permissions),
    scopes: identity.scopes === null ? null : new Set(identity.scopes),
    requestId: options.requestId,
    ipAddress: options.ipAddress,
    userAgent: options.userAgent,
  };
}
