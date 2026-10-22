'use client';

import { useState } from 'react';

/** Copies a block of text to the clipboard, and says so. */
export function CopyText({ text, label = 'Copy summary' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('done');
    } catch {
      setState('failed');                                                              // clipboard blocked (e.g. a non-secure address)
    }
    setTimeout(() => setState('idle'), 2500);
  }
  return (
    <button type="button" className="link text-xs" onClick={() => void copy()} aria-live="polite">
      {state === 'done' ? 'Copied' : state === 'failed' ? 'Could not copy' : label}
    </button>
  );
}
