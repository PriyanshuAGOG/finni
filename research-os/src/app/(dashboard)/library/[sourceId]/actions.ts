'use server';

import { revalidatePath } from 'next/cache';
import { requireSessionContext } from '../../../lib/session';
import { changeReviewStatus, archiveSource } from '../../../../services/source';
import { requestConfirmation, confirmAction } from '../../../../services/confirmation';

export async function approveSourceAction(sourceId: string): Promise<{ error?: string }> {
  const ctx = await requireSessionContext();
  try {
    await changeReviewStatus(ctx, sourceId, { status: 'approved' });
    revalidatePath(`/library/${sourceId}`);
    return {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to approve.' };
  }
}

export async function rejectSourceAction(sourceId: string, reason: string): Promise<{ error?: string }> {
  const ctx = await requireSessionContext();
  try {
    // Move through in_review first if the source hasn't been touched yet;
    // harmless to attempt when it's already past that state.
    await changeReviewStatus(ctx, sourceId, { status: 'in_review' }).catch(() => undefined);
    await changeReviewStatus(ctx, sourceId, { status: 'rejected', reason });
    revalidatePath(`/library/${sourceId}`);
    return {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to reject.' };
  }
}

/**
 * Archiving goes through the real confirmation flow -- the dashboard is
 * not exempt from the same governance the API enforces on the GPT.
 */
export async function archiveSourceWithConfirmationAction(
  sourceId: string,
  title: string,
): Promise<{ error?: string }> {
  const ctx = await requireSessionContext();
  try {
    const confirmation = await requestConfirmation(ctx, {
      actionType: 'archiveSource',
      resourceType: 'source',
      resourceIds: [sourceId],
      actionPayload: {},
      humanSummary: `Archive "${title}"`,
    });
    await confirmAction(ctx, confirmation.id, confirmation.required_phrase);
    await archiveSource(ctx, sourceId, confirmation.id);
    revalidatePath(`/library/${sourceId}`);
    revalidatePath('/library');
    return {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to archive.' };
  }
}
