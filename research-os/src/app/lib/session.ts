import 'server-only';
import { cookies, headers } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { getEnv } from '../../lib/env';
import { contextFromIdentity } from '../../services/auth';
import { identityFromSession } from '../../services/auth';
import type { ActorContext } from '../../lib/context';

/**
 * Resolves the signed-in dashboard user for a server component or action.
 * Returns null rather than throwing, so pages can redirect to sign-in
 * themselves with an appropriate `next` parameter.
 */
export async function getSessionContext(): Promise<ActorContext | null> {
  const env = getEnv();
  const cookieStore = await cookies();
  const token = cookieStore.get(env.SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const identity = await identityFromSession(token);
  if (!identity) return null;

  const headerList = await headers();
  return contextFromIdentity(identity, {
    sourceInterface: 'dashboard',
    requestId: `web_${randomUUID().slice(0, 12)}`,
    ipAddress: headerList.get('x-forwarded-for')?.split(',')[0]?.trim(),
    userAgent: headerList.get('user-agent') ?? undefined,
  });
}

/** Throws a redirect-worthy signal by returning null; callers redirect. */
export async function requireSessionContext(): Promise<ActorContext> {
  const ctx = await getSessionContext();
  if (!ctx) {
    const { redirect } = await import('next/navigation');
    redirect('/sign-in');
  }
  return ctx as ActorContext;
}
