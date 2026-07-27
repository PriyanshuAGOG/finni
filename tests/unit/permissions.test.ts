import { describe, expect, it } from 'vitest';
import { hasPermission, requirePermission } from '../../src/lib/context';
import type { ActorContext } from '../../src/lib/context';
import { PERMISSIONS, SYSTEM_ROLES, scopesGranting } from '../../src/domain/permissions';
import { isApiError } from '../../src/lib/errors';

function makeCtx(overrides: Partial<ActorContext>): ActorContext {
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    actorType: 'user',
    sourceInterface: 'dashboard',
    permissions: new Set(),
    scopes: null,
    requestId: 'req-1',
    ...overrides,
  };
}

describe('hasPermission', () => {
  it('allows a first-party session with the permission and no scope restriction', () => {
    const ctx = makeCtx({ permissions: new Set(['source.approve']), scopes: null });
    expect(hasPermission(ctx, 'source.approve')).toBe(true);
  });

  it('denies when the user lacks the permission entirely', () => {
    const ctx = makeCtx({ permissions: new Set(['source.read']), scopes: null });
    expect(hasPermission(ctx, 'source.approve')).toBe(false);
  });

  it('denies a scoped token that has the user permission but not a granting scope', () => {
    const ctx = makeCtx({
      permissions: new Set(['source.approve']),
      scopes: new Set(['source.read']),
    });
    expect(hasPermission(ctx, 'source.approve')).toBe(false);
  });

  it('allows a scoped token that has both the permission and a granting scope', () => {
    const ctx = makeCtx({
      permissions: new Set(['source.approve']),
      scopes: new Set(['source.review']),
    });
    expect(hasPermission(ctx, 'source.approve')).toBe(true);
  });

  it('a broadly scoped token still cannot exceed the underlying user permission', () => {
    // The token carries every scope, but the user role only grants read.
    const allScopes = new Set(scopesGranting('source.approve').concat(scopesGranting('source.archive')));
    const ctx = makeCtx({ permissions: new Set(['source.read']), scopes: allScopes });
    expect(hasPermission(ctx, 'source.approve')).toBe(false);
    expect(hasPermission(ctx, 'source.archive')).toBe(false);
  });
});

describe('requirePermission', () => {
  it('throws FORBIDDEN when the permission is missing entirely', () => {
    const ctx = makeCtx({ permissions: new Set() });
    try {
      requirePermission(ctx, 'source.archive');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(isApiError(err)).toBe(true);
      if (isApiError(err)) {
        expect(err.code).toBe('FORBIDDEN');
        expect(err.details.reason).not.toBe('missing_scope');
      }
    }
  });

  it('throws FORBIDDEN with a missing_scope reason when only the scope is absent', () => {
    const ctx = makeCtx({
      permissions: new Set(['source.archive']),
      scopes: new Set(['source.read']),
    });
    try {
      requirePermission(ctx, 'source.archive');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(isApiError(err)).toBe(true);
      if (isApiError(err)) {
        expect(err.details.reason).toBe('missing_scope');
        expect(err.details.required_scopes).toEqual(scopesGranting('source.archive'));
      }
    }
  });

  it('does not throw when the permission is present', () => {
    const ctx = makeCtx({ permissions: new Set(['source.read']) });
    expect(() => requirePermission(ctx, 'source.read')).not.toThrow();
  });
});

describe('system roles', () => {
  it('every role references only real permissions', () => {
    const allPermissions = new Set(PERMISSIONS);
    for (const role of SYSTEM_ROLES) {
      for (const permission of role.permissions) {
        expect(allPermissions.has(permission)).toBe(true);
      }
    }
  });

  it('viewer holds only read permissions', () => {
    const viewer = SYSTEM_ROLES.find((r) => r.slug === 'viewer')!;
    for (const permission of viewer.permissions) {
      expect(permission.endsWith('.read')).toBe(true);
    }
  });

  it('administrator is a superset of every other system role', () => {
    const admin = new Set(SYSTEM_ROLES.find((r) => r.slug === 'administrator')!.permissions);
    for (const role of SYSTEM_ROLES) {
      if (role.slug === 'administrator') continue;
      for (const permission of role.permissions) {
        expect(admin.has(permission)).toBe(true);
      }
    }
  });

  it('content_team cannot review claims', () => {
    const contentTeam = SYSTEM_ROLES.find((r) => r.slug === 'content_team')!;
    expect(contentTeam.permissions).not.toContain('claim.review');
  });
});
