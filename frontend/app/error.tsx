'use client'; // Error boundaries must be Client Components

import { useEffect } from 'react';

export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto mt-16 max-w-md rounded-lg border border-line bg-surface p-6 text-center">
      <h1 className="text-lg font-semibold">This page could not load</h1>
      <p className="mt-2 text-sm text-ink-2">
        The data service did not respond. Nothing is lost: the stored data is unchanged.
      </p>
      <button onClick={() => retry()} className="mt-4 rounded-md border border-line bg-surface-2 px-4 py-1.5 text-sm hover:bg-line">
        Try again
      </button>
    </div>
  );
}
