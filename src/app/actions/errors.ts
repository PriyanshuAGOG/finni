'use server';

import { revalidatePath } from 'next/cache';
import { requireSessionContext } from '../lib/session';
import { resolveErrorLog } from '../../services/errors';

export async function resolveErrorLogAction(formData: FormData): Promise<void> {
  const ctx = await requireSessionContext();
  const id = String(formData.get('id') ?? '');
  const note = String(formData.get('note') ?? '').trim();
  if (!id) return;

  await resolveErrorLog(ctx, id, note || null);
  revalidatePath('/errors');
}
