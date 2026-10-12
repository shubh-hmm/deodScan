'use client';

import { useEffect, useState } from 'react';
import { Wordmark } from '@/components/brand';
import { BrandMark } from '@/components/icons';
import { OWNER_NAME, QUOTES } from '@/lib/site';

/**
 * Welcome block shown while the dashboard loads: greeting, a short quote and an indeterminate progress bar.
 * The quote is picked after mount (random in the browser) so the server HTML and the first client render match.
 */
export function GreetingBlock() {
  const [quote, setQuote] = useState<string | null>(null);
  useEffect(() => {
    setQuote(QUOTES[Math.floor(Math.random() * QUOTES.length)] ?? null);
  }, []);

  return (
    <div className="mx-auto flex max-w-xl flex-col items-center px-6 text-center" role="status" aria-live="polite">
      <div className="greet-logo"><BrandMark size={56} /></div>
      <Wordmark className="mt-4 text-2xl" />
      <p className="mt-7 text-sm font-medium tracking-wide text-muted">Welcome back,</p>
      <h1 className="font-brand mt-2 bg-gradient-to-r from-white via-white to-[#f2b4ec] bg-clip-text text-3xl font-semibold tracking-tight text-transparent sm:text-4xl">
        {OWNER_NAME}
      </h1>
      <p className="mt-5 min-h-[3.25rem] max-w-md text-[15px] italic leading-relaxed text-ink-2 transition-opacity duration-500" style={{ opacity: quote ? 1 : 0 }}>
        {quote ? <>“{quote}”</> : ' '}
      </p>
      <div className="progress mt-7" aria-hidden="true"><span /></div>
      <p className="mt-3 text-xs text-muted">Loading your dashboard…</p>
    </div>
  );
}
