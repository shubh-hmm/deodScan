import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'DEOD On-Chain Monitor',
  description: 'Read-only DEOD flow monitoring on BNB Chain: MEXC, BitMart, Toobit and PancakeSwap V2/V3.',
};

const NAV: [string, [string, string][]][] = [
  ['Overview', [['/', 'Dashboard']]],
  ['Exchanges', [['/MEXC', 'MEXC'], ['/BitMart', 'BitMart'], ['/Toobit', 'Toobit']]],
  ['DEX', [['/PancakeSwap', 'PancakeSwap']]],
  ['Explore', [['/flows', 'Exchange flows'], ['/swaps', 'Swaps'], ['/wallets', 'Top wallets']]],
  ['System', [['/status', 'Sync status']]],
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <div className="flex min-h-screen">
          <aside className="hidden w-52 shrink-0 border-r border-line bg-surface md:block">
            <Link href="/" className="block border-b border-line px-4 py-4">
              <div className="text-sm font-semibold">DEOD Monitor</div>
              <div className="text-xs text-muted">BNB Chain · on-chain only</div>
            </Link>
            <nav className="px-2 py-3 text-sm">
              {NAV.map(([group, items]) => (
                <div key={group} className="mb-3">
                  <div className="px-2 pb-1 text-[11px] uppercase tracking-wide text-muted">{group}</div>
                  {items.map(([href, label]) => (
                    <Link key={href} href={href} className="block rounded-md px-2 py-1.5 text-ink-2 hover:bg-surface-2 hover:text-ink">{label}</Link>
                  ))}
                </div>
              ))}
            </nav>
          </aside>
          <div className="min-w-0 flex-1">
            <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5 md:px-6">
              <nav className="flex gap-3 text-sm md:hidden">
                <Link href="/">Dashboard</Link><Link href="/flows">Flows</Link><Link href="/wallets">Wallets</Link>
              </nav>
              <form action="/search" className="ml-auto w-full max-w-md">
                <input name="q" placeholder="Search wallet address or transaction hash" className="w-full" aria-label="Search" />
              </form>
            </header>
            <main className="px-4 py-5 md:px-6">{children}</main>
            <footer className="px-4 pb-6 text-xs text-muted md:px-6">
              Read-only analytics. Data source: Dune (BNB Chain), synced to PostgreSQL. Times in UTC.
            </footer>
          </div>
        </div>
      </body>
    </html>
  );
}
