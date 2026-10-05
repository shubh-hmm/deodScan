import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { api, meta, type Meta } from '@/lib/api';
import { fmtTime } from '@/lib/format';
import { BrandMark, Icons } from '@/components/icons';
import { MobileNav, SideNav } from '@/components/nav-links';
import { PriceTicker, type PriceData } from '@/components/price-ticker';
import { Splash } from '@/components/splash';

export const metadata: Metadata = {
  title: 'DEOD On-Chain Monitor',
  description: 'Read-only DEOD flow monitoring on BNB Chain: MEXC, Toobit and PancakeSwap V2/V3.',
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
        <Splash />
        <div className="flex min-h-screen">
          <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-line bg-sidebar/95 backdrop-blur md:flex">
            <Link href="/" className="flex items-center gap-3 border-b border-line px-4 py-4">
              <BrandMark />
              <div className="leading-tight">
                <div className="text-sm font-semibold tracking-tight">DEOD Monitor</div>
                <div className="text-[11px] text-muted">BNB Chain · on-chain</div>
              </div>
            </Link>
            <div className="mx-3 mt-3 flex items-center gap-2.5 rounded-xl border border-line bg-surface-2/50 px-3 py-2.5">
              <span className="badge-icon cyan !h-8 !w-8">{Icons.chain}</span>
              <div className="min-w-0 leading-tight">
                <div className="whitespace-nowrap text-[13px] font-semibold">BNB Chain</div>
                <div className="whitespace-nowrap text-[11px] text-muted">Read-only monitor</div>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto"><SideNav /></div>
            <div className="m-3 rounded-xl border border-line bg-surface-2/60 px-3 py-2.5 text-[11px] leading-snug text-muted">
              <div className="flex items-center gap-1.5 font-semibold uppercase tracking-wide">
                <span className="h-1.5 w-1.5 rounded-full bg-s3" />Data through
              </div>
              <div className="num mt-1 text-xs text-ink">{m?.dataThrough ? `${fmtTime(m.dataThrough)} UTC` : 'n/a'}</div>
              <div className="mt-1">Synced once per completed UTC day.</div>
            </div>
          </aside>
          <div className="min-w-0 flex-1">
            <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-page/70 px-4 py-3 backdrop-blur-md md:px-6">
              <PriceTicker initial={price} />
              <form action="/search" className="relative ml-auto w-full max-w-md sm:w-80">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">{Icons.search}</span>
                <input name="q" placeholder="Search wallet or transaction hash" className="w-full !rounded-xl !border-line-strong !bg-surface/90 !py-2 !pl-9" aria-label="Search" />
              </form>
            </header>
            <MobileNav />
            <main className="mx-auto max-w-[1600px] px-4 py-6 md:px-6">{children}</main>
            <footer className="mx-auto max-w-[1600px] border-t border-line px-4 py-5 text-xs leading-relaxed text-muted md:px-6">
              Read-only analytics · On-chain data: Dune (BNB Chain), synced to PostgreSQL · Times in UTC ·
              Live price: <a className="link" href="https://www.coingecko.com/en/coins/decentrawood" target="_blank" rel="noreferrer">CoinGecko</a>{' '}
              (market price, separate from the on-chain data).
            </footer>
          </div>
        </div>
      </body>
    </html>
  );
}
