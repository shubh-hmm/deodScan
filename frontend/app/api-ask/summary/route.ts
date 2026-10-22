// Instant answers for the Ask panel: the dashboard's own rule-written summary for a period. No AI is involved and nothing is spent.
import { API_BASE, apiHeaders } from '@/lib/api-base';

const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const RANGES = new Set(['1h', '6h', '24h', '7d', '30d', 'all']);

export async function GET(req: Request) {
  const range = new URL(req.url).searchParams.get('range') ?? '';
  if (!RANGES.has(range)) return Response.json({ error: 'Unknown period.' }, { status: 400, headers });
  try {
    const res = await fetch(`${API_BASE}/api/summary?range=${range}`, { cache: 'no-store', headers: apiHeaders(), signal: AbortSignal.timeout(30_000) });
    return new Response(res.body, { status: res.status, headers });
  } catch {
    return Response.json({ error: 'The backend is not running (start npm run dev in the backend folder)' }, { status: 503, headers });
  }
}
