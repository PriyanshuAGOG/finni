import { NextResponse, type NextRequest } from 'next/server';

/**
 * Redirects unauthenticated dashboard requests to sign-in.
 *
 * This is a fast, cookie-presence check only -- it does not validate the
 * session (that requires a database round trip, which middleware should
 * avoid). Every page under the (dashboard) group still calls
 * requireSessionContext(), which does the real check and is the actual
 * security boundary; this middleware only improves the redirect UX.
 */
const PUBLIC_PATHS = ['/sign-in', '/api', '/_next', '/favicon.ico'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const hasCookie = request.cookies.has(process.env.SESSION_COOKIE_NAME ?? 'nbros_session');
  if (!hasCookie) {
    const url = request.nextUrl.clone();
    url.pathname = '/sign-in';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
