// Price proxy: the browser polls the web origin; the API (and CoinGecko behind it) stay server-side.
import { API_BASE, apiHeaders } from '@/lib/api-base';

export async function GET() {
  try {
    const res = await fetch(`${API_BASE}/api/price`, { cache: 'no-store', headers: apiHeaders(), signal: AbortSignal.timeout(10_000) });
    return new Response(res.body, {
      status: res.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch {
    return Response.json({ error: 'price unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}
