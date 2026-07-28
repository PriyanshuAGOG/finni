import { z } from 'zod';
import { defineOperation } from '../registry';
import { inviteMember, listMembers, listPendingInvitations, revokeInvitation } from '../../services/team';

export const listMembersOperation = defineOperation({
  operationId: 'listMembers',
  method: 'GET',
  path: '/team/members',
  summary: 'List everyone in the organization (dashboard team roster)',
  description:
    'Returns every user in the organization with their roles and status (active, invited, suspended, deactivated). This operation does not modify anything.',
  tags: ['admin'],
  scopes: [],
  riskLevel: 'low',
  internalOnly: true,
  input: z.object({}),
  handler: async (_input, { ctx }) => ({ members: await listMembers(ctx) }),
});

export const listPendingInvitationsOperation = defineOperation({
  operationId: 'listPendingInvitations',
  method: 'GET',
  path: '/team/invitations',
  summary: 'List invitations that have not yet been accepted (administrators)',
  description:
    'Returns pending invitations with who sent them and whether they have expired. Requires user.manage. This operation does not modify anything.',
  tags: ['admin'],
  permission: 'user.manage',
  scopes: [],
  riskLevel: 'low',
  internalOnly: true,
  input: z.object({}),
  handler: async (_input, { ctx }) => ({ invitations: await listPendingInvitations(ctx) }),
});

export const inviteMemberOperation = defineOperation({
  operationId: 'inviteMember',
  method: 'POST',
  path: '/team/invitations',
  summary: 'Invite someone to the organization by email (administrators)',
  description: `Creates an account for the given email (status "invited") and emails them a link to set a password and activate it. Re-inviting an address that already has a pending invitation supersedes it with a fresh link rather than erroring; an address that already belongs to an active member is refused.

Requires user.manage. If the email could not be sent, the response includes the invitation link directly so it can be shared manually -- report that to the caller rather than treating it as success.`,
  tags: ['admin'],
  permission: 'user.manage',
  scopes: [],
  riskLevel: 'medium',
  internalOnly: true,
  input: z.object({
    email: z.string().email(),
    full_name: z.string().min(1),
    role_slug: z.string().min(1),
    job_title: z.string().nullish(),
  }),
  handler: async (input, { ctx }) =>
    inviteMember(ctx, {
      email: input.email,
      fullName: input.full_name,
      roleSlug: input.role_slug,
      jobTitle: input.job_title,
    }),
});

export const revokeInvitationOperation = defineOperation({
  operationId: 'revokeInvitation',
  method: 'POST',
  path: '/team/invitations/{invitationId}/revoke',
  summary: 'Revoke a pending invitation (administrators)',
  description:
    'Invalidates an invitation link before it is accepted and deactivates the placeholder account it created. Requires user.manage. Refuses if the invitation was already accepted -- remove the member instead in that case.',
  tags: ['admin'],
  permission: 'user.manage',
  scopes: [],
  riskLevel: 'medium',
  internalOnly: true,
  input: z.object({ invitationId: z.string().uuid() }),
  handler: async (input, { ctx }) => {
    await revokeInvitation(ctx, input.invitationId);
    return { id: input.invitationId, status: 'revoked' };
  },
});
