'use client';

import { useActionState } from 'react';
import { login, type LoginState } from '@/app/login/actions';

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});
  return (
    <form action={action} className="mt-6 space-y-3">
      <input type="hidden" name="next" value={next} />
      <label className="block text-xs text-muted" htmlFor="password">Password</label>
      <input id="password" name="password" type="password" autoComplete="current-password" autoFocus required
        className="w-full !rounded-xl !border-line-strong !bg-surface/90 !py-2.5" />
      {state.error ? <p role="alert" className="text-sm text-s2">{state.error}</p> : null}
      <button type="submit" className="btn w-full justify-center" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
    </form>
  );
}
