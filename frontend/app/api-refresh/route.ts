// "Update today" proxy: the browser talks to the web origin; the API (and Dune behind it) stay server-side only.
import { API_BASE, apiHeaders } from '@/lib/api-base';

async function forward(method: 'GET' | 'POST') {
  try {
    const res = await fetch(`${API_BASE}/api/sync/today`, { method, cache: 'no-store', headers: apiHeaders(), signal: AbortSignal.timeout(30_000) });
    return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch {
    return Response.json({ error: 'The backend is not running (start npm run dev in the backend folder)' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}

export const GET = () => forward('GET');
export const POST = () => forward('POST');
