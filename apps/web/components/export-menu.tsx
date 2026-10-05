'use client';

import { useEffect, useRef, useState } from 'react';
import { Icons } from '@/components/icons';

export interface ExportItem { href: string; title: string; hint: string }

/** "Export CSV" button that opens a small menu of the available exports. Closes on a click outside, on Escape, or after choosing one. */
export function ExportMenu({ items }: { items: ExportItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button type="button" className="btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {Icons.download} Export CSV <span aria-hidden="true" className="text-[10px] opacity-80">▾</span>
      </button>
      {open && (
        <div role="menu" className="card absolute right-0 top-[calc(100%+8px)] z-30 w-80 p-1.5">
          {items.map((it) => (
            <a key={it.href} role="menuitem" href={it.href} onClick={() => setOpen(false)} className="block rounded-lg px-3 py-2.5 hover:bg-surface-2">
              <div className="text-[13px] font-semibold text-ink">{it.title}</div>
              <div className="mt-0.5 text-xs leading-snug text-muted">{it.hint}</div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
