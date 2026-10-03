// Price proxy: the browser polls the web origin; the API (and CoinGecko behind it) stay server-side.
const BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';

export async function GET() {
  try {
    const res = await fetch(`${BASE}/api/price`, { cache: 'no-store' });
    return new Response(res.body, {
      status: res.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch {
    return Response.json({ error: 'price unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}
