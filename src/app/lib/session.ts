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
 *
 * `cookies()` is called first, before anything that can throw (like env
 * validation). Next.js detects a page needs dynamic (per-request)
 * rendering by watching for a call to a dynamic API such as `cookies()`
 * during the render attempt -- if code throws before that call is
 * reached, Next never sees the signal and treats the exception as a hard
 * static-generation failure instead of "render this at request time."
 * That is what broke the Vercel build when DATABASE_URL wasn't present
 * at build time: env validation ran, threw, and `cookies()` was never
 * reached. Every dashboard page also sets `export const dynamic =
 * 'force-dynamic'` as a second, order-independent guarantee.
 */
export async function getSessionContext(): Promise<ActorContext | null> {
  const cookieStore = await cookies();
  const env = getEnv();
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
