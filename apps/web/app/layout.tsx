import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { api, meta, type Meta } from '@/lib/api';
import { fmtTime } from '@/lib/format';
import { MobileNav, SideNav } from '@/components/nav-links';
import { PriceTicker, type PriceData } from '@/components/price-ticker';

export const metadata: Metadata = {
  title: 'DEOD On-Chain Monitor',
  description: 'Read-only DEOD flow monitoring on BNB Chain: MEXC, BitMart, Toobit and PancakeSwap V2/V3.',
};

/** The header must never take a page down: if the API or CoinGecko is unreachable, render without the value. */
async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [price, m] = await Promise.all([safe(() => api<PriceData>('/api/price')), safe<Meta>(meta)]);

  return (
    <html lang="en">
      <body className="min-h-screen">
        <div className="flex min-h-screen">
          <aside className="sticky top-0 hidden h-screen w-52 shrink-0 flex-col border-r border-line bg-surface md:flex">
            <Link href="/" className="block border-b border-line px-4 py-4">
              <div className="text-sm font-semibold">DEOD Monitor</div>
              <div className="text-xs text-muted">BNB Chain · on-chain only</div>
            </Link>
            <div className="min-h-0 flex-1 overflow-y-auto"><SideNav /></div>
            <div className="border-t border-line px-4 py-3 text-[11px] leading-snug text-muted">
              <div className="uppercase tracking-wide">Data through</div>
              <div className="num text-xs text-ink-2">{m?.dataThrough ? `${fmtTime(m.dataThrough)} UTC` : 'n/a'}</div>
              <div className="mt-1">Synced once per completed UTC day.</div>
            </div>
          </aside>
          <div className="min-w-0 flex-1">
            <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-surface/95 px-4 py-2.5 backdrop-blur md:px-6">
              <PriceTicker initial={price} />
              <form action="/search" className="ml-auto w-full max-w-md sm:w-80">
                <input name="q" placeholder="Search wallet address or transaction hash" className="w-full" aria-label="Search" />
              </form>
            </header>
            <MobileNav />
            <main className="mx-auto max-w-[1600px] px-4 py-5 md:px-6">{children}</main>
            <footer className="mx-auto max-w-[1600px] px-4 pb-6 text-xs text-muted md:px-6">
              Read-only analytics. On-chain data: Dune (BNB Chain), synced to PostgreSQL. Times in UTC.
              Live price: <a className="link" href="https://www.coingecko.com/en/coins/decentrawood" target="_blank" rel="noreferrer">CoinGecko</a>{' '}
              (market price, separate from the on-chain data).
            </footer>
          </div>
        </div>
      </body>
    </html>
  );
}
