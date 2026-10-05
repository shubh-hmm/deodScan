// CSV export proxy: the browser downloads from the web origin; the API stays server-side only.
const BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';

const ALLOWED = [/^activity$/, /^flows$/, /^swaps$/, /^wallets\/top$/, /^wallets\/0x[0-9a-fA-F]{40}\/activity\.csv$/];

export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const path = (await params).path.join('/');
  if (!ALLOWED.some((re) => re.test(path))) return new Response('not found', { status: 404 });
  const qs = new URL(req.url).searchParams;
  if (!path.endsWith('.csv')) qs.set('format', 'csv');
  const res = await fetch(`${BASE}/api/${path}?${qs}`, { cache: 'no-store' });
  return new Response(res.body, {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type') ?? 'text/csv',
      'content-disposition': res.headers.get('content-disposition') ?? 'attachment',
    },
  });
}
