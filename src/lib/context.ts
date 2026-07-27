import { ApiError, forbidden } from './errors';
import type { Permission, Scope } from '../domain/permissions';
import { SCOPE_PERMISSIONS, scopesGranting } from '../domain/permissions';

export type SourceInterface =
  | 'dashboard'
  | 'custom_gpt'
  | 'internal_assistant'
  | 'api'
  | 'import'
  | 'worker'
  | 'automation';

export type ActorType = 'user' | 'api_client' | 'system' | 'worker';

/**
 * Everything a service needs to know about who is acting. Services take
 * this rather than a raw user id so that permission, organization,
 * interface attribution and audit identity travel together and cannot
 * drift apart.
 */
export interface ActorContext {
  organizationId: string;
  /**
   * The human whose authority is being exercised. An API client always
   * acts as some constrained user; there is no user-less write path.
   */
  userId: string;
  userName?: string;
  apiClientId?: string;
  actorType: ActorType;
  sourceInterface: SourceInterface;
  /** Effective permissions after roles and per-user overrides. */
  permissions: Set<Permission>;
  /**
   * Scopes granted to the credential. `null` means a first-party session
   * (the dashboard), which is not scope-limited.
   */
  scopes: Set<Scope> | null;
  requestId: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Authorization is the intersection of two independent checks:
 *
 *   1. does this user hold the permission, and
 *   2. does this credential carry a scope that unlocks it.
 *
 * A broadly-scoped Custom GPT token still cannot exceed what its user
 * could do in the dashboard, and a highly privileged user still cannot
 * use a narrowly scoped token to act outside its grant.
 */
export function hasPermission(ctx: ActorContext, permission: Permission): boolean {
  if (!ctx.permissions.has(permission)) return false;
  if (ctx.scopes === null) return true;
  return scopesGranting(permission).some((scope) => ctx.scopes!.has(scope));
}

export function requirePermission(ctx: ActorContext, permission: Permission): void {
  if (hasPermission(ctx, permission)) return;

  // Distinguish "your account cannot do this" from "this token cannot do
  // this", because the remedies are different.
  if (ctx.permissions.has(permission) && ctx.scopes !== null) {
    throw new ApiError(
      'FORBIDDEN',
      `This connection is not authorized for ${permission}. The required scope was not granted.`,
      {
        details: {
          required_permission: permission,
          required_scopes: scopesGranting(permission),
          reason: 'missing_scope',
        },
        suggestedAction:
          'Reconnect the integration and approve the required scope. Do not retry with a different operation.',
      },
    );
  }
  throw forbidden(permission);
}

export function requireAnyPermission(ctx: ActorContext, permissions: Permission[]): void {
  if (permissions.some((p) => hasPermission(ctx, p))) return;
  throw forbidden(permissions.join(' or '));
}

/** Permissions actually usable by this actor, for the /me endpoint. */
export function effectivePermissions(ctx: ActorContext): Permission[] {
  return [...ctx.permissions].filter((p) => hasPermission(ctx, p)).sort();
}

export function permissionsForScopes(scopes: Scope[]): Permission[] {
  const out = new Set<Permission>();
  for (const scope of scopes) {
    for (const permission of SCOPE_PERMISSIONS[scope] ?? []) out.add(permission);
  }
  return [...out];
}

/** A worker context. Workers act as the system inside one organization. */
export function systemContext(organizationId: string, requestId: string): ActorContext {
  return {
    organizationId,
    userId: '00000000-0000-0000-0000-000000000000',
    actorType: 'worker',
    sourceInterface: 'worker',
    permissions: new Set(),
    scopes: null,
    requestId,
  };
}
