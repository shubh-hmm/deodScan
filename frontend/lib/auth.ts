// Sign-in for the single admin. The session is a cookie holding an expiry time plus an HMAC of it, signed with AUTH_SECRET, so
// it cannot be forged or extended without the secret. Uses Web Crypto only, so it runs in the proxy and in server code alike.

export const SESSION_COOKIE = 'deod_session';
export const SESSION_DAYS = 30;
/** Set by the proxy on the request (never by the browser) when the visitor has a valid session. */
export const AUTHED_HEADER = 'x-deod-authed';

const enc = new TextEncoder();

function secret(): string | null {
  const s = process.env.AUTH_SECRET;
  return s && s.length >= 32 ? s : null;
}

/** Sign-in works only when both the password and a strong enough signing secret are set; otherwise the site stays locked. */
export const authConfigured = () => !!secret() && !!process.env.ADMIN_PASSWORD;

async function hmac(payload: string, key: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(payload)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSession(now = Date.now()): Promise<string> {
  const key = secret();
  if (!key) throw new Error('AUTH_SECRET is not set (32+ characters)');
  const payload = `v1.${now + SESSION_DAYS * 86_400_000}`;
  return `${payload}.${await hmac(payload, key)}`;
}

export async function verifySession(token: string | undefined, now = Date.now()): Promise<boolean> {
  const key = secret();
  if (!key || !token) return false;
  const [v, exp, sig, ...rest] = token.split('.');
  if (v !== 'v1' || !exp || !sig || rest.length) return false;
  const expires = Number(exp);
  if (!Number.isFinite(expires) || expires <= now) return false;
  return sameText(sig, await hmac(`v1.${exp}`, key));
}

/** Where to go after signing in: only a path on this site, never another address (no open redirect). */
export function safeNext(next: unknown): string {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) && !next.startsWith('/login') && !/[\r\n]/.test(next) ? next : '/';
}
