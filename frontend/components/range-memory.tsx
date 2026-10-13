'use client';

import { Suspense, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { RANGE_COOKIE, encodeRange, pickRange } from '@/lib/saved-range';

/** Whenever the address holds a time period (the user picked one), remember it in a cookie so every other page starts on it. */
function Remember() {
  const params = useSearchParams();
  useEffect(() => {
    const picked = pickRange({ range: params.get('range'), from: params.get('from'), to: params.get('to') });
    if (!picked) return;
    try {
      document.cookie = `${RANGE_COOKIE}=${encodeURIComponent(encodeRange(picked))}; path=/; max-age=31536000; SameSite=Lax`;
    } catch { /* cookies blocked: the period then simply is not remembered */ }
  }, [params]);
  return null;
}

// useSearchParams needs a Suspense boundary so it cannot hold up the rest of the page.
export function RangeMemory() {
  return <Suspense fallback={null}><Remember /></Suspense>;
}
