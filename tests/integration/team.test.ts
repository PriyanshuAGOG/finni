import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestOrg, destroyTestOrg, type TestOrg } from './fixtures';
import {
  acceptInvitation,
  inviteMember,
  listMembers,
  listPendingInvitations,
  revokeInvitation,
} from '../../src/services/team';

let org: TestOrg;

beforeAll(async () => {
  org = await createTestOrg('team');
});

afterAll(async () => {
  await destroyTestOrg(org.organizationId);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The console email provider logs the invite link; tests read it back from there. */
function captureInviteToken(logSpy: ReturnType<typeof vi.spyOn>): string {
  const logged = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
  const match = logged.match(/token=([^\s&]+)/);
  if (!match) throw new Error('No invite token found in logged email output.');
  return decodeURIComponent(match[1]);
}

describe('inviting a member', () => {
  it('creates an invited user and emails a link containing the token', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await inviteMember(org.adminCtx, {
      email: 'new.researcher@test.local',
      fullName: 'New Researcher',
      roleSlug: 'researcher',
    });
    // EMAIL_PROVIDER defaults to "console" in tests -- nothing is actually
    // sent, so the link must come back in the response instead.
    expect(result.email_sent).toBe(false);
    expect(result.accept_url).toBeTruthy();
    expect(captureInviteToken(logSpy)).toBeTruthy();

    const members = await listMembers(org.adminCtx);
    const invited = members.find((m) => m.email === 'new.researcher@test.local');
    expect(invited?.status).toBe('invited');
    expect(invited?.roles).toContain('Researcher');
  });

  it('refuses a viewer attempting to invite someone', async () => {
    await expect(
      inviteMember(org.viewerCtx, {
        email: 'blocked@test.local',
        fullName: 'Blocked',
        roleSlug: 'viewer',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses inviting an email that already belongs to an active member', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await inviteMember(org.adminCtx, {
      email: 'will-be-active@test.local',
      fullName: 'Will Be Active',
      roleSlug: 'viewer',
    });
    const token = captureInviteToken(logSpy);
    await acceptInvitation({ token, password: 'a-strong-password-123' });

    await expect(
      inviteMember(org.adminCtx, {
        email: 'will-be-active@test.local',
        fullName: 'Duplicate Attempt',
        roleSlug: 'viewer',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('supersedes a still-pending invitation on re-invite rather than erroring', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const first = await inviteMember(org.adminCtx, {
      email: 're-invite@test.local',
      fullName: 'First Name',
      roleSlug: 'viewer',
    });
    const second = await inviteMember(org.adminCtx, {
      email: 're-invite@test.local',
      fullName: 'Second Name',
      roleSlug: 'researcher',
    });

    expect(second.user_id).toBe(first.user_id);
    expect(second.invitation_id).not.toBe(first.invitation_id);

    const pending = await listPendingInvitations(org.adminCtx);
    const forThisUser = pending.filter((i) => i.email === 're-invite@test.local');
    expect(forThisUser).toHaveLength(1);
    expect(forThisUser[0].role).toBe('Researcher');
  });
});

describe('accepting an invitation', () => {
  it('activates the account and returns a usable session', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await inviteMember(org.adminCtx, {
      email: 'accept.me@test.local',
      fullName: 'Placeholder Name',
      roleSlug: 'researcher',
    });
    const token = captureInviteToken(logSpy);

    const result = await acceptInvitation({
      token,
      password: 'a-strong-password-123',
      fullName: 'Accepted Name',
    });

    expect(result.identity.email).toBe('accept.me@test.local');
    expect(result.identity.userName).toBe('Accepted Name');

    const members = await listMembers(org.adminCtx);
    const activated = members.find((m) => m.email === 'accept.me@test.local');
    expect(activated?.status).toBe('active');
  });

  it('rejects a password shorter than 8 characters', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await inviteMember(org.adminCtx, {
      email: 'short.password@test.local',
      fullName: 'Placeholder',
      roleSlug: 'viewer',
    });
    const token = captureInviteToken(logSpy);

    await expect(acceptInvitation({ token, password: 'short' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('rejects an unknown token', async () => {
    await expect(
      acceptInvitation({ token: 'inv_not-a-real-token', password: 'a-strong-password-123' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects a token that was already accepted', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await inviteMember(org.adminCtx, {
      email: 'reuse.token@test.local',
      fullName: 'Placeholder',
      roleSlug: 'viewer',
    });
    const token = captureInviteToken(logSpy);
    await acceptInvitation({ token, password: 'a-strong-password-123' });

    await expect(acceptInvitation({ token, password: 'a-different-password-456' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

describe('revoking an invitation', () => {
  it('invalidates the token and deactivates the placeholder account', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const invite = await inviteMember(org.adminCtx, {
      email: 'revoke.me@test.local',
      fullName: 'Placeholder',
      roleSlug: 'viewer',
    });
    const token = captureInviteToken(logSpy);

    await revokeInvitation(org.adminCtx, invite.invitation_id);

    const members = await listMembers(org.adminCtx);
    expect(members.find((m) => m.email === 'revoke.me@test.local')?.status).toBe('deactivated');

    await expect(acceptInvitation({ token, password: 'a-strong-password-123' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('refuses to revoke an invitation that was already accepted', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const invite = await inviteMember(org.adminCtx, {
      email: 'already.accepted@test.local',
      fullName: 'Placeholder',
      roleSlug: 'viewer',
    });
    const token = captureInviteToken(logSpy);
    await acceptInvitation({ token, password: 'a-strong-password-123' });

    await expect(revokeInvitation(org.adminCtx, invite.invitation_id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('refuses a viewer attempting to revoke an invitation', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const invite = await inviteMember(org.adminCtx, {
      email: 'protected.invite@test.local',
      fullName: 'Placeholder',
      roleSlug: 'viewer',
    });
    void captureInviteToken(logSpy);

    await expect(revokeInvitation(org.viewerCtx, invite.invitation_id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('listing the roster', () => {
  it('includes the seeded admin and viewer with their roles', async () => {
    const members = await listMembers(org.adminCtx);
    const admin = members.find((m) => m.id === org.adminCtx.userId);
    const viewer = members.find((m) => m.id === org.viewerCtx.userId);
    expect(admin?.roles).toContain('Administrator');
    expect(viewer?.roles).toContain('Viewer');
  });
});
