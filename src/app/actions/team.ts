'use server';

import { revalidatePath } from 'next/cache';
import { requireSessionContext } from '../lib/session';
import {
  inviteMember,
  reactivateMember,
  removeMember,
  revokeInvitation,
  updateMember,
} from '../../services/team';
import { isApiError } from '../../lib/errors';

export interface InviteMemberState {
  error: string | null;
  success: string | null;
}

export async function inviteMemberAction(
  _prev: InviteMemberState,
  formData: FormData,
): Promise<InviteMemberState> {
  const ctx = await requireSessionContext();
  const email = String(formData.get('email') ?? '').trim();
  const fullName = String(formData.get('full_name') ?? '').trim();
  const roleSlug = String(formData.get('role_slug') ?? '');

  if (!email || !fullName || !roleSlug) {
    return { error: 'Name, email and role are all required.', success: null };
  }

  try {
    const result = await inviteMember(ctx, { email, fullName, roleSlug });
    revalidatePath('/settings');
    if (result.email_sent) {
      return { error: null, success: `Invitation sent to ${email}.` };
    }
    return {
      error: null,
      success: `Invitation created for ${email}, but the email could not be sent. Share this link directly: ${result.accept_url}`,
    };
  } catch (err) {
    return { error: isApiError(err) ? err.message : 'The invitation could not be created.', success: null };
  }
}

export async function revokeInvitationAction(invitationId: string): Promise<void> {
  const ctx = await requireSessionContext();
  await revokeInvitation(ctx, invitationId);
  revalidatePath('/settings');
}

export interface EditMemberState {
  error: string | null;
  success: string | null;
}

export async function editMemberAction(
  _prev: EditMemberState,
  formData: FormData,
): Promise<EditMemberState> {
  const ctx = await requireSessionContext();
  const userId = String(formData.get('user_id') ?? '');
  const fullName = String(formData.get('full_name') ?? '').trim();
  const roleSlug = String(formData.get('role_slug') ?? '');

  if (!userId) return { error: 'Missing user id.', success: null };

  try {
    await updateMember(ctx, userId, {
      fullName: fullName || undefined,
      roleSlug: roleSlug || undefined,
    });
    revalidatePath('/settings');
    return { error: null, success: 'Saved.' };
  } catch (err) {
    return { error: isApiError(err) ? err.message : 'The member could not be updated.', success: null };
  }
}

export async function removeMemberAction(userId: string): Promise<{ error: string | null }> {
  const ctx = await requireSessionContext();
  try {
    await removeMember(ctx, userId);
    revalidatePath('/settings');
    return { error: null };
  } catch (err) {
    return { error: isApiError(err) ? err.message : 'The member could not be removed.' };
  }
}

export async function reactivateMemberAction(userId: string): Promise<void> {
  const ctx = await requireSessionContext();
  await reactivateMember(ctx, userId);
  revalidatePath('/settings');
}
