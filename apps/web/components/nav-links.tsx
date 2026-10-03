'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export const NAV: [string, [string, string][]][] = [
  ['Overview', [['/', 'Dashboard']]],
  ['Exchanges', [['/MEXC', 'MEXC'], ['/BitMart', 'BitMart'], ['/Toobit', 'Toobit']]],
  ['DEX', [['/PancakeSwap', 'PancakeSwap']]],
  ['Explore', [['/flows', 'Exchange flows'], ['/swaps', 'Swaps'], ['/wallets', 'Top wallets']]],
  ['System', [['/status', 'Sync status']]],
];

function useIsActive() {
  const path = usePathname();
  return (href: string) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`));
}

/** Sidebar navigation with the current page highlighted. */
export function SideNav() {
  const active = useIsActive();
  return (
    <nav className="px-2 py-3 text-sm" aria-label="Main">
      {NAV.map(([group, items]) => (
        <div key={group} className="mb-3">
          <div className="px-2 pb-1 text-[11px] uppercase tracking-wide text-muted">{group}</div>
          {items.map(([href, label]) => (
            <Link key={href} href={href} aria-current={active(href) ? 'page' : undefined}
              className={`block rounded-md border-l-2 px-2 py-1.5 ${active(href)
                ? 'border-s1 bg-surface-2 font-medium text-ink'
                : 'border-transparent text-ink-2 hover:bg-surface-2 hover:text-ink'}`}>
              {label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}

/** Mobile navigation: every page, as a horizontally scrollable row. */
export function MobileNav() {
  const active = useIsActive();
  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-line bg-surface px-3 py-2 text-sm md:hidden" aria-label="Main">
      {NAV.flatMap(([, items]) => items).map(([href, label]) => (
        <Link key={href} href={href} aria-current={active(href) ? 'page' : undefined}
          className={`shrink-0 rounded-md px-2.5 py-1 ${active(href) ? 'bg-surface-2 font-medium text-ink' : 'text-ink-2 hover:bg-surface-2'}`}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
