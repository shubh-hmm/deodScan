// Watchlist proxy: the browser talks to the web origin (which requires sign-in); the API stays server-side only.
import { API_BASE, apiHeaders } from '@/lib/api-base';

const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const down = () => Response.json({ error: 'The backend is not running (start npm run dev in the backend folder)' }, { status: 503, headers });

async function forward(path: string, init: RequestInit) {
  try {
    const res = await fetch(`${API_BASE}${path}`, { ...init, cache: 'no-store', headers: { ...apiHeaders(), ...(init.body ? { 'content-type': 'application/json' } : {}) } });
    return new Response(res.body, { status: res.status, headers });
  } catch {
    return down();
  }
}

export const GET = () => forward('/api/watchlist', { method: 'GET' });

export async function POST(req: Request) {
  const body = await req.text();
  return forward('/api/watchlist', { method: 'POST', body });
}

export async function DELETE(req: Request) {
  const address = new URL(req.url).searchParams.get('address') ?? '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return Response.json({ error: 'invalid address' }, { status: 400, headers });
  return forward(`/api/watchlist/${address.toLowerCase()}`, { method: 'DELETE' });
}
