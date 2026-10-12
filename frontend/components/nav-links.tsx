'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Icons } from '@/components/icons';

export const NAV: [string, [string, string, ReactNode][]][] = [
  ['Overview', [['/', 'Dashboard', Icons.dashboard]]],
  ['Exchanges', [['/MEXC', 'MEXC', Icons.exchange], ['/Toobit', 'Toobit', Icons.exchange]]],
  ['DEX', [['/PancakeSwap', 'PancakeSwap', Icons.layers]]],
  ['Explore', [['/flows', 'Exchange flows', Icons.activity], ['/swaps', 'Swaps', Icons.swap], ['/wallets', 'Top wallets', Icons.wallets]]],
  ['System', [['/status', 'Sync status', Icons.status]]],
];

function useIsActive() {
  const path = usePathname();
  return (href: string) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`));
}

/** Sidebar navigation with the current page highlighted. */
export function SideNav() {
  const active = useIsActive();
  return (
    <nav className="px-3 py-4 text-[13px]" aria-label="Main">
      {NAV.map(([group, items]) => (
        <div key={group} className="mb-4">
          <div className="px-2.5 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">{group}</div>
          {items.map(([href, label, icon]) => {
            const on = active(href);
            return (
              <Link key={href} href={href} aria-current={on ? 'page' : undefined}
                className={`relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors ${on
                  ? 'bg-gradient-to-r from-[#7a5af0] to-[#5b3fd0] font-medium text-white shadow-[0_6px_16px_-8px_rgba(110,80,230,0.9)]'
                  : 'text-ink-2 hover:bg-surface-2 hover:text-ink'}`}>
                <span className={on ? 'text-white' : 'text-muted'}>{icon}</span>
                {label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/** Mobile navigation: every page, as a horizontally scrollable row. */
export function MobileNav() {
  const active = useIsActive();
  return (
    <nav className="flex gap-1.5 overflow-x-auto border-b border-line bg-surface/80 px-3 py-2 text-[13px] backdrop-blur md:hidden" aria-label="Main">
      {NAV.flatMap(([, items]) => items).map(([href, label, icon]) => {
        const on = active(href);
        return (
          <Link key={href} href={href} aria-current={on ? 'page' : undefined}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 ${on ? 'bg-gradient-to-r from-[#7a5af0] to-[#5b3fd0] font-medium text-white' : 'text-ink-2 hover:bg-surface-2'}`}>
            <span className={on ? 'text-white' : 'text-muted'}>{icon}</span>{label}
          </Link>
        );
      })}
    </nav>
  );
}
