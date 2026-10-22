// The dashboard summary, loaded when the person clicks "Show summary" (so a closed summary costs nothing). Behind sign-in; the API stays server-side.
import { API_BASE, apiHeaders } from '@/lib/api-base';

const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const RANGES = new Set(['1h', '6h', '24h', '7d', '30d', 'all', 'custom']);
const DAY = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/;

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const range = q.get('range') ?? '24h';
  const from = q.get('from'), to = q.get('to');
  if (!RANGES.has(range) || (from && !DAY.test(from)) || (to && !DAY.test(to)) || (range === 'custom' && !from)) {
    return Response.json({ error: 'That period is not valid.' }, { status: 400, headers });
  }
  const url = new URLSearchParams({ range });
  if (range === 'custom' && from) { url.set('from', from); if (to) url.set('to', to); }
  try {
    const res = await fetch(`${API_BASE}/api/summary?${url}`, { cache: 'no-store', headers: apiHeaders(), signal: AbortSignal.timeout(30_000) });
    return new Response(res.body, { status: res.status, headers });
  } catch {
    return Response.json({ error: 'The summary could not be loaded because the backend is not answering.' }, { status: 503, headers });
  }
}
