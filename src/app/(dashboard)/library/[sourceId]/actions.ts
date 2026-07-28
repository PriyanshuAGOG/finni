'use server';

import { revalidatePath } from 'next/cache';
import { requireSessionContext } from '../../../lib/session';
import { archiveSource } from '../../../../services/source';
import { requestConfirmation, confirmAction } from '../../../../services/confirmation';

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
