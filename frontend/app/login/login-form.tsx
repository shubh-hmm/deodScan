'use client';

import { useActionState, useEffect, useRef, useState, type ReactNode } from 'react';
import { login, type LoginState } from '@/app/login/actions';

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
const Lock = () => <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" {...stroke}><rect x="4" y="11" width="16" height="9" rx="2.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;
const Eye = () => <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...stroke}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>;
const EyeOff = () => <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...stroke}><path d="M3 3l18 18" /><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.5 6.6A17 17 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 4.2-.9" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>;
const Alert = () => <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...stroke}><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5h.01" /></svg>;

/** The card: a soft violet spotlight follows the pointer (pure decoration; it is off for reduced motion users via CSS). */
export function LoginCard({ children }: { children: ReactNode }) {
  return (
    <div
      className="login-card p-7 sm:p-8"
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`);
        e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`);
      }}
    >
      {children}
    </div>
  );
}

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const [shake, setShake] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // A wrong password shakes the form once and puts the cursor back in the field with the text selected, ready to retype.
  useEffect(() => {
    if (!state.error) return;
    setShake((n) => n + 1);
    input.current?.focus();
    input.current?.select();
  }, [state]);

  return (
    <form action={action} className="mt-7">
      <input type="hidden" name="next" value={next} />
      <div key={shake} className={shake ? 'shake' : ''}>
        <label className="mb-2 block text-xs font-medium tracking-wide text-muted" htmlFor="password">PASSWORD</label>
        <div className="field">
          <span className="lead"><Lock /></span>
          <input
            ref={input}
            id="password"
            name="password"
            type={show ? 'text' : 'password'}
            autoComplete="current-password"
            autoFocus
            required
            placeholder="Enter your password"
            aria-invalid={!!state.error}
            aria-describedby={state.error ? 'login-error' : undefined}
            onKeyUp={(e) => setCaps(e.getModifierState('CapsLock'))}
            onBlur={() => setCaps(false)}
          />
          <button type="button" className="toggle" onClick={() => setShow((s) => !s)} aria-pressed={show} aria-label={show ? 'Hide password' : 'Show password'}>
            {show ? <EyeOff /> : <Eye />}<span>{show ? 'Hide' : 'Show'}</span>
          </button>
        </div>
      </div>

      <div className="mt-3 min-h-[1.5rem] text-sm" aria-live="polite">
        {state.error ? (
          <p id="login-error" role="alert" className="flex items-start gap-2 text-[#ff9b73]"><span className="mt-0.5"><Alert /></span><span>{state.error}</span></p>
        ) : caps ? (
          <p className="flex items-center gap-2 text-warning"><span><Alert /></span>Caps Lock is on</p>
        ) : null}
      </div>

      <button type="submit" className="btn mt-3 flex w-full items-center justify-center gap-2.5 !py-3 text-[15px]" disabled={pending}>
        {pending ? <><span className="spinner" aria-hidden="true" />Signing in…</> : 'Sign in'}
      </button>
    </form>
  );
}
