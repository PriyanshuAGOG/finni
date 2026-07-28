import { randomUUID } from 'node:crypto';
import { withOrg, withoutOrg } from '../lib/db';
import { generateCredential, hashPassword, sha256 } from '../lib/crypto';
import { getEnv } from '../lib/env';
import { ApiError, conflict, invalidInput, notFound } from '../lib/errors';
import type { ActorContext } from '../lib/context';
import { requirePermission } from '../lib/context';
import { resolvePermissions } from './auth';
import type { AuthenticatedIdentity } from './auth';
import { getEmailProvider } from '../lib/email';
import { recordAudit } from './audit';

export interface TeamMember {
  id: string;
  full_name: string;
  email: string;
  job_title: string | null;
  status: string;
  roles: string[];
  last_active_at: string | null;
}

export async function listMembers(ctx: ActorContext): Promise<TeamMember[]> {
  return withOrg(ctx.organizationId, (sql) =>
    sql.query<TeamMember>(
      `SELECT u.id, u.full_name, u.email, u.job_title, u.status::text, u.last_active_at,
              COALESCE(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       GROUP BY u.id
       ORDER BY u.created_at`,
    ),
  );
}

export interface PendingInvitation {
  id: string;
  email: string;
  full_name: string;
  role: string;
  invited_by_name: string;
  expires_at: string;
  expired: boolean;
  created_at: string;
}

export async function listPendingInvitations(ctx: ActorContext): Promise<PendingInvitation[]> {
  requirePermission(ctx, 'user.manage');
  return withOrg(ctx.organizationId, (sql) =>
    sql.query<PendingInvitation>(
      `SELECT i.id, u.email, u.full_name, r.name AS role, inviter.full_name AS invited_by_name,
              i.expires_at, i.expires_at < now() AS expired, i.created_at
       FROM user_invitations i
       JOIN users u ON u.id = i.user_id
       JOIN roles r ON r.id = i.role_id
       JOIN users inviter ON inviter.id = i.invited_by
       WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL
       ORDER BY i.created_at DESC`,
    ),
  );
}

export interface InviteMemberInput {
  email: string;
  fullName: string;
  roleSlug: string;
  jobTitle?: string | null;
}

export interface InviteMemberResult {
  invitation_id: string;
  user_id: string;
  email: string;
  expires_at: string;
  email_sent: boolean;
  /** Only present when the email could not be sent -- share it manually. */
  accept_url?: string;
  warning?: string;
}

/**
 * Invites someone to the organization. If the email address already
 * belongs to an active member this refuses outright; if it belongs to a
 * still-pending invitation, that invitation is superseded (a fresh token
 * is issued) rather than erroring, so re-sending a lost invite just
 * works.
 */
export async function inviteMember(
  ctx: ActorContext,
  input: InviteMemberInput,
): Promise<InviteMemberResult> {
  requirePermission(ctx, 'user.manage');
  const env = getEnv();
  const email = input.email.trim().toLowerCase();
  if (!email.includes('@')) throw invalidInput('Not a valid email address.', { email: input.email });
  if (!input.fullName.trim()) throw invalidInput('A name is required.');

  const { userId, invitationId, plaintextToken, expiresAt } = await withOrg(
    ctx.organizationId,
    async (sql) => {
      const role = await sql.one<{ id: string }>(`SELECT id FROM roles WHERE slug = $1`, [
        input.roleSlug,
      ]);
      if (!role) throw notFound('role', input.roleSlug);

      const existing = await sql.one<{ id: string; status: string }>(
        `SELECT id, status::text FROM users WHERE lower(email) = $1`,
        [email],
      );

      let userId: string;
      if (existing && existing.status !== 'invited') {
        throw conflict('A member with this email already exists in this organization.', {
          email,
          status: existing.status,
        });
      } else if (existing) {
        // Re-invite: reuse the user row, supersede any prior invitation.
        userId = existing.id;
        await sql.query(
          `UPDATE users SET full_name = $1, job_title = $2 WHERE id = $3`,
          [input.fullName.trim(), input.jobTitle ?? null, userId],
        );
        await sql.query(
          `UPDATE user_invitations SET revoked_at = now()
           WHERE user_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
          [userId],
        );
        await sql.query(`DELETE FROM user_roles WHERE user_id = $1`, [userId]);
      } else {
        userId = randomUUID();
        await sql.query(
          `INSERT INTO users (id, organization_id, full_name, email, job_title, status)
           VALUES ($1,$2,$3,$4,$5,'invited')`,
          [userId, ctx.organizationId, input.fullName.trim(), email, input.jobTitle ?? null],
        );
      }

      await sql.query(`INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES ($1,$2,$3)`, [
        userId,
        role.id,
        ctx.userId,
      ]);

      const credential = generateCredential('inv');
      const expiresAt = new Date(Date.now() + env.INVITATION_TTL_HOURS * 3_600_000);
      const invitationRow = await sql.one<{ id: string }>(
        `INSERT INTO user_invitations (organization_id, user_id, invited_by, role_id, token_hash, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [ctx.organizationId, userId, ctx.userId, role.id, credential.hash, expiresAt],
      );

      await recordAudit(sql, ctx, {
        action: 'user.invited',
        resourceType: 'user',
        resourceId: userId,
        newState: { email, role: input.roleSlug, status: 'invited' },
      });

      return {
        userId,
        invitationId: invitationRow!.id,
        plaintextToken: credential.plaintext,
        expiresAt,
      };
    },
  );

  const acceptUrl = new URL('/accept-invite', env.APP_BASE_URL);
  acceptUrl.searchParams.set('token', plaintextToken);

  // EMAIL_PROVIDER=console (the default -- no email account required) never
  // throws; it just logs. Treating that as "sent" would hide the link from
  // the one place the inviter could actually get it, so "sent" here means
  // "handed to a real delivery provider without it erroring," not merely
  // "the call didn't throw."
  let emailSent = false;
  let warning: string | undefined;
  if (env.EMAIL_PROVIDER === 'resend') {
    try {
      await getEmailProvider().send({
        to: email,
        subject: `You're invited to Nirog Bhoomi Research OS`,
        html: `<p>${escapeHtml(ctx.userName ?? 'A teammate')} invited you to join Nirog Bhoomi Research OS.</p>
               <p><a href="${acceptUrl.toString()}">Accept the invitation</a></p>
               <p>This link expires ${expiresAt.toUTCString()}.</p>`,
        text: `${ctx.userName ?? 'A teammate'} invited you to join Nirog Bhoomi Research OS.\n\nAccept: ${acceptUrl.toString()}\n\nThis link expires ${expiresAt.toUTCString()}.`,
      });
      emailSent = true;
    } catch (err) {
      warning = `The invitation email could not be sent (${err instanceof Error ? err.message : 'unknown error'}). Share the link below directly instead.`;
    }
  } else {
    await getEmailProvider().send({
      to: email,
      subject: `You're invited to Nirog Bhoomi Research OS`,
      html: '',
      text: `${ctx.userName ?? 'A teammate'} invited you to join Nirog Bhoomi Research OS.\n\nAccept: ${acceptUrl.toString()}`,
    });
    warning = 'EMAIL_PROVIDER is not configured to actually send email -- share the link below directly.';
  }

  return {
    invitation_id: invitationId,
    user_id: userId,
    email,
    expires_at: expiresAt.toISOString(),
    email_sent: emailSent,
    ...(emailSent ? {} : { accept_url: acceptUrl.toString() }),
    ...(warning ? { warning } : {}),
  };
}

export async function revokeInvitation(ctx: ActorContext, invitationId: string): Promise<void> {
  requirePermission(ctx, 'user.manage');
  await withOrg(ctx.organizationId, async (sql) => {
    const invitation = await sql.one<{ id: string; user_id: string; accepted_at: string | null }>(
      `SELECT id, user_id, accepted_at FROM user_invitations WHERE id = $1`,
      [invitationId],
    );
    if (!invitation) throw notFound('invitation', invitationId);
    if (invitation.accepted_at) {
      throw conflict('This invitation was already accepted; remove the member instead.');
    }

    await sql.query(`UPDATE user_invitations SET revoked_at = now() WHERE id = $1`, [invitationId]);
    // The user row only exists for this invitation until it's accepted --
    // deactivating it means a copy of the link that leaked can't be used
    // even though the invitation row's revoked_at would already block it.
    await sql.query(
      `UPDATE users SET status = 'deactivated' WHERE id = $1 AND status = 'invited'`,
      [invitation.user_id],
    );

    await recordAudit(sql, ctx, {
      action: 'user.invitation_revoked',
      resourceType: 'user',
      resourceId: invitation.user_id,
    });
  });
}

export interface UpdateMemberInput {
  fullName?: string;
  jobTitle?: string | null;
  roleSlug?: string;
}

/** Edits a member's name/title and, optionally, replaces their role. */
export async function updateMember(
  ctx: ActorContext,
  userId: string,
  input: UpdateMemberInput,
): Promise<void> {
  requirePermission(ctx, 'user.manage');
  await withOrg(ctx.organizationId, async (sql) => {
    const target = await sql.one<{ id: string; full_name: string }>(
      `SELECT id, full_name FROM users WHERE id = $1`,
      [userId],
    );
    if (!target) throw notFound('user', userId);

    if (input.fullName !== undefined || input.jobTitle !== undefined) {
      await sql.query(
        `UPDATE users SET full_name = COALESCE($1, full_name), job_title = $2 WHERE id = $3`,
        [input.fullName?.trim() || null, input.jobTitle ?? null, userId],
      );
    }

    if (input.roleSlug) {
      const role = await sql.one<{ id: string }>(`SELECT id FROM roles WHERE slug = $1`, [
        input.roleSlug,
      ]);
      if (!role) throw notFound('role', input.roleSlug);
      await sql.query(`DELETE FROM user_roles WHERE user_id = $1`, [userId]);
      await sql.query(`INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES ($1,$2,$3)`, [
        userId,
        role.id,
        ctx.userId,
      ]);
    }

    await recordAudit(sql, ctx, {
      action: 'user.updated',
      resourceType: 'user',
      resourceId: userId,
      previousState: { full_name: target.full_name },
      newState: { full_name: input.fullName, job_title: input.jobTitle, role: input.roleSlug },
    });
  });
}

/**
 * Deactivates a member -- reversible (an administrator can flip status
 * back to 'active'), unlike a hard delete. The row is kept because
 * audit_logs, source_versions and similar accountability records
 * reference it; deleting it would either cascade-destroy that history
 * or leave it pointing at nothing.
 */
export async function removeMember(ctx: ActorContext, userId: string): Promise<void> {
  requirePermission(ctx, 'user.manage');
  if (userId === ctx.userId) {
    throw invalidInput('You cannot remove your own account.');
  }

  await withOrg(ctx.organizationId, async (sql) => {
    const target = await sql.one<{ id: string; status: string }>(
      `SELECT id, status::text FROM users WHERE id = $1`,
      [userId],
    );
    if (!target) throw notFound('user', userId);

    const isAdmin = await sql.one<{ user_id: string }>(
      `SELECT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND r.slug = 'administrator'`,
      [userId],
    );
    if (isAdmin) {
      const otherActiveAdmins = await sql.one<{ count: string }>(
        `SELECT count(*)::text FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         JOIN users u ON u.id = ur.user_id
         WHERE r.slug = 'administrator' AND u.status = 'active' AND u.id != $1`,
        [userId],
      );
      if (Number(otherActiveAdmins?.count ?? '0') === 0) {
        throw conflict('This is the last active administrator and cannot be removed.');
      }
    }

    await sql.query(`UPDATE users SET status = 'deactivated' WHERE id = $1`, [userId]);
    await sql.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1`, [userId]);

    await recordAudit(sql, ctx, {
      action: 'user.removed',
      resourceType: 'user',
      resourceId: userId,
      previousState: { status: target.status },
      newState: { status: 'deactivated' },
    });
  });
}

/** Restores a deactivated or suspended member to active. */
export async function reactivateMember(ctx: ActorContext, userId: string): Promise<void> {
  requirePermission(ctx, 'user.manage');
  await withOrg(ctx.organizationId, async (sql) => {
    const target = await sql.one<{ id: string; status: string }>(
      `SELECT id, status::text FROM users WHERE id = $1`,
      [userId],
    );
    if (!target) throw notFound('user', userId);
    if (target.status === 'invited') {
      throw conflict('This account has not accepted its invitation yet.');
    }

    await sql.query(`UPDATE users SET status = 'active' WHERE id = $1`, [userId]);
    await recordAudit(sql, ctx, {
      action: 'user.reactivated',
      resourceType: 'user',
      resourceId: userId,
      previousState: { status: target.status },
      newState: { status: 'active' },
    });
  });
}

export interface AcceptInvitationInput {
  token: string;
  password: string;
  fullName?: string;
}

/** Mirrors signIn's return shape so the caller can set the session cookie identically. */
export async function acceptInvitation(
  input: AcceptInvitationInput,
  meta: { ipAddress?: string; userAgent?: string } = {},
): Promise<{ token: string; expiresAt: Date; identity: AuthenticatedIdentity }> {
  if (input.password.length < 8) {
    throw invalidInput('Password must be at least 8 characters.');
  }

  const invitation = await withoutOrg((sql) =>
    sql.one<{
      id: string;
      organization_id: string;
      user_id: string;
      role_id: string;
      expires_at: string;
      accepted_at: string | null;
      revoked_at: string | null;
      user_email: string;
      user_full_name: string;
      user_status: string;
    }>(`SELECT * FROM auth_find_invitation_by_token($1)`, [sha256(input.token)]),
  );

  const invalid = () => new ApiError('INVALID_INPUT', 'This invitation link is invalid or has expired.');
  if (!invitation) throw invalid();
  if (invitation.revoked_at) throw invalid();
  if (invitation.accepted_at) throw invalid();
  if (new Date(invitation.expires_at).getTime() < Date.now()) throw invalid();
  if (invitation.user_status !== 'invited') throw invalid();

  const passwordHash = hashPassword(input.password);
  const fullName = input.fullName?.trim() || invitation.user_full_name;

  await withOrg(invitation.organization_id, async (sql) => {
    await sql.query(
      `UPDATE users SET password_hash = $1, full_name = $2, status = 'active' WHERE id = $3`,
      [passwordHash, fullName, invitation.user_id],
    );
    await sql.query(`UPDATE user_invitations SET accepted_at = now() WHERE id = $1`, [invitation.id]);
  });

  const credential = generateCredential('nbses');
  const env = getEnv();
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 3_600_000);
  await withoutOrg((sql) =>
    sql.query(
      `INSERT INTO sessions (user_id, token_hash, ip_address, user_agent, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [invitation.user_id, credential.hash, meta.ipAddress ?? null, meta.userAgent ?? null, expiresAt],
    ),
  );

  const permissions = await resolvePermissions(invitation.organization_id, invitation.user_id);

  await withOrg(invitation.organization_id, (sql) =>
    recordAudit(
      sql,
      {
        organizationId: invitation.organization_id,
        userId: invitation.user_id,
        actorType: 'user',
        sourceInterface: 'dashboard',
        permissions: new Set(permissions),
        scopes: null,
        requestId: `invite-accept-${randomUUID().slice(0, 8)}`,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
      { action: 'auth.invitation_accepted', resourceType: 'user', resourceId: invitation.user_id },
    ),
  );

  return {
    token: credential.plaintext,
    expiresAt,
    identity: {
      organizationId: invitation.organization_id,
      userId: invitation.user_id,
      userName: fullName,
      email: invitation.user_email,
      scopes: null,
      permissions,
    },
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
