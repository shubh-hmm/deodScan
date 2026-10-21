'use server';

import { createHash, timingSafeEqual } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, SESSION_DAYS, authConfigured, createSession, safeNext } from '@/lib/auth';

export interface LoginState { error?: string }

// Brute-force guard: 5 wrong passwords from one address, or 20 from anywhere, lock sign-in for 15 minutes. It lives in memory, so
// it resets when the server restarts; the real protection is a long password.
const LOCK_MS = 15 * 60_000;
const attempts = new Map<string, { fails: number; until: number }>();
const LIMITS = { ip: 5, any: 20 } as const;

const sha = (s: string) => createHash('sha256').update(s).digest();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function lockedFor(key: string, now: number): number {
  const a = attempts.get(key);
  return a && a.until > now ? Math.ceil((a.until - now) / 60_000) : 0;
}
function fail(key: string, limit: number, now: number) {
  const a = attempts.get(key) ?? { fails: 0, until: 0 };
  a.fails += 1;
  if (a.fails >= limit) { a.fails = 0; a.until = now + LOCK_MS; }
  attempts.set(key, a);
}

export async function login(_prev: LoginState, form: FormData): Promise<LoginState> {
  if (!authConfigured()) return { error: 'Sign-in is not set up yet. Add ADMIN_PASSWORD and AUTH_SECRET to frontend/.env.local and restart the dashboard.' };
  const h = await headers();
  const ip = `ip:${(h.get('x-forwarded-for') ?? '').split(',')[0]?.trim() || 'local'}`;
  const now = Date.now();
  const wait = Math.max(lockedFor(ip, now), lockedFor('any', now));
  if (wait) return { error: `Too many wrong passwords. Try again in ${wait} min.` };

  const given = String(form.get('password') ?? '');
  if (!timingSafeEqual(sha(given), sha(process.env.ADMIN_PASSWORD!))) {
    fail(ip, LIMITS.ip, now); fail('any', LIMITS.any, now);
    await sleep(800);
    return { error: 'Wrong password.' };
  }
  attempts.delete(ip);
  (await cookies()).set(SESSION_COOKIE, await createSession(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: h.get('x-forwarded-proto') === 'https',
    path: '/',
    maxAge: SESSION_DAYS * 86_400,
  });
  redirect(safeNext(form.get('next')));
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/login');
}
