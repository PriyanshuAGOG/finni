'use server';

import { revalidatePath } from 'next/cache';
import { requireSessionContext } from '../lib/session';
import { ingestUrl } from '../../services/ingestion';
import { isApiError } from '../../lib/errors';

export interface AddSourceState {
  error: string | null;
  success: string | null;
  duplicateSourceId?: string;
}

export async function addSourceAction(
  _prev: AddSourceState,
  formData: FormData,
): Promise<AddSourceState> {
  const ctx = await requireSessionContext();
  const url = String(formData.get('url') ?? '').trim();
  if (!url) return { error: 'Enter a URL.', success: null };

  try {
    const result = await ingestUrl(ctx, { url });
    revalidatePath('/inbox');
    revalidatePath('/library');
    return { error: null, success: result.message };
  } catch (err) {
    if (isApiError(err) && err.code === 'DUPLICATE_SOURCE') {
      const duplicates = (err.details as { duplicates?: Array<{ source_id: string }> })?.duplicates;
      return {
        error: `${err.message} It's already in the library.`,
        success: null,
        duplicateSourceId: duplicates?.[0]?.source_id,
      };
    }
    return { error: isApiError(err) ? err.message : 'The URL could not be added.', success: null };
  }
}
