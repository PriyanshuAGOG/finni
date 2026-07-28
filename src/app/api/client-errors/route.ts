import { z } from 'zod';
import { getSessionContext } from '../../lib/session';
import { logError } from '../../../services/errors';

export const dynamic = 'force-dynamic';

const ClientErrorInput = z.object({
  message: z.string().min(1).max(2000),
  stack: z.string().optional(),
  componentStack: z.string().optional(),
  url: z.string().optional(),
  kind: z.enum(['react_render', 'window_error', 'unhandled_rejection']).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Receives errors caught in the browser -- a React render error boundary,
 * or a `window.onerror`/`unhandledrejection` listener -- and stores them
 * next to server-side errors in the same error_logs table, so a dashboard
 * bug is diagnosable from one place instead of only a user's screenshot.
 *
 * Deliberately outside the /api/v1 operation registry: this is not a
 * Custom GPT action and does not need scopes, just a best-effort identity
 * from the session cookie when one exists.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json().catch(() => null);
    const parsed = ClientErrorInput.safeParse(body);
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: 'invalid client error payload' }), { status: 400 });
    }

    const ctx = await getSessionContext().catch(() => null);

    await logError({
      origin: 'dashboard_client',
      severity: 'fatal',
      message: parsed.data.message,
      stack: parsed.data.stack,
      componentStack: parsed.data.componentStack,
      organizationId: ctx?.organizationId,
      userId: ctx?.userId,
      sourceInterface: 'dashboard',
      requestId: ctx?.requestId,
      url: parsed.data.url,
      userAgent: request.headers.get('user-agent') ?? undefined,
      context: { kind: parsed.data.kind ?? 'react_render', ...parsed.data.context },
    });

    return new Response(null, { status: 204 });
  } catch {
    // A failure to log a client error must not itself surface as a
    // second error to a user who is already looking at a broken page.
    return new Response(null, { status: 204 });
  }
}
