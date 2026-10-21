import { NextResponse, type NextRequest } from 'next/server';
import { AUTHED_HEADER, SESSION_COOKIE, verifySession } from '@/lib/auth';

// Runs before every page and every route handler: only a visitor with a valid signed session gets through. Everything else is sent
// to /login (pages) or gets 401 (the /api-* routes the page scripts call). The AUTHED_HEADER is always cleared first, so a browser
// cannot fake it.
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const headers = new Headers(req.headers);
  headers.delete(AUTHED_HEADER);

  if (await verifySession(req.cookies.get(SESSION_COOKIE)?.value)) {
    if (pathname === '/login') return NextResponse.redirect(new URL('/', req.nextUrl));
    headers.set(AUTHED_HEADER, '1');
    return NextResponse.next({ request: { headers } });
  }
  if (pathname === '/login') return NextResponse.next({ request: { headers } });
  if (pathname.startsWith('/api-')) return NextResponse.json({ error: 'Sign in required' }, { status: 401, headers: { 'cache-control': 'no-store' } });

  const to = req.nextUrl.clone();
  to.pathname = '/login';
  to.search = '';
  if (pathname !== '/') to.searchParams.set('next', pathname + req.nextUrl.search);
  return NextResponse.redirect(to);
}

export const config = { matcher: ['/((?!_next/static|_next/image|icon.svg|favicon.ico).*)'] };
