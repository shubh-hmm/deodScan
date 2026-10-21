// "Update today" proxy: the browser talks to the web origin; the API (and Dune behind it) stay server-side only.
const BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';

async function forward(method: 'GET' | 'POST') {
  try {
    const res = await fetch(`${BASE}/api/sync/today`, { method, cache: 'no-store' });
    return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch {
    return Response.json({ error: 'The backend is not running (start npm run dev in the backend folder)' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}

export const GET = () => forward('GET');
export const POST = () => forward('POST');
