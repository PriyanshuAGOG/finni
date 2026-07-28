'use server';

import { revalidatePath } from 'next/cache';
import { requireSessionContext } from '../lib/session';
import { createApiClient } from '../../services/auth';
import { isApiError } from '../../lib/errors';
import { isScope } from '../../domain/permissions';

export interface CreateApiClientState {
  error: string | null;
  result: { api_key: string; prefix: string } | null;
}

export async function createApiClientAction(
  _prev: CreateApiClientState,
  formData: FormData,
): Promise<CreateApiClientState> {
  const ctx = await requireSessionContext();
  const name = String(formData.get('name') ?? '').trim() || 'Custom GPT';
  const scopes = formData.getAll('scopes').map(String).filter(isScope);

  if (scopes.length === 0) {
    return { error: 'Select at least one scope.', result: null };
  }

  try {
    const result = await createApiClient(ctx, {
      name,
      clientType: 'custom_gpt',
      scopes,
      actsAsUserId: ctx.userId,
    });
    revalidatePath('/settings');
    return { error: null, result: { api_key: result.plaintextKey, prefix: result.prefix } };
  } catch (err) {
    return {
      error: isApiError(err) ? err.message : 'The API key could not be created.',
      result: null,
    };
  }
}
