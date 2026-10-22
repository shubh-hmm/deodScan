// "Ask DEODScan AI" proxy: the browser talks to the web origin (which requires sign-in); the API and the OpenAI key stay server-side only.
// The period the person last picked (remembered in a cookie) is passed along as the default for questions that name no period.
import { cookies } from 'next/headers';
import { API_BASE, apiHeaders } from '@/lib/api-base';
import { RANGE_COOKIE, decodeRange } from '@/lib/saved-range';

const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const down = () => Response.json({ error: 'The backend is not running (start npm run dev in the backend folder)' }, { status: 503, headers });

export async function GET() {
  try {
    const res = await fetch(`${API_BASE}/api/ask/status`, { cache: 'no-store', headers: apiHeaders(), signal: AbortSignal.timeout(15_000) });
    return new Response(res.body, { status: res.status, headers });
  } catch {
    return down();
  }
}

export async function POST(req: Request) {
  let question = '';
  try {
    const body = (await req.json()) as { question?: unknown };
    question = typeof body.question === 'string' ? body.question : '';
  } catch {
    return Response.json({ error: 'Please type a question.' }, { status: 400, headers });
  }
  const saved = decodeRange((await cookies()).get(RANGE_COOKIE)?.value);
  const defaultRange = saved && saved.range !== 'custom' ? saved.range : undefined;
  try {
    const res = await fetch(`${API_BASE}/api/ask`, {
      method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(150_000),
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ question, ...(defaultRange ? { defaultRange } : {}) }),
    });
    return new Response(res.body, { status: res.status, headers });
  } catch {
    return Response.json({ error: 'No answer came back in time. Please try again.' }, { status: 504, headers });
  }
}
