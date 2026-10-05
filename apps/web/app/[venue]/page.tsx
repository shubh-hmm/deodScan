import { notFound } from 'next/navigation';
import { meta, type SearchParams } from '@/lib/api';
import ExchangePage from './exchange';
import PancakePage from './pancakeswap';

export const dynamic = 'force-dynamic';

// Routes: /MEXC, /Toobit, /PancakeSwap (case-insensitive). Exchange pages exist for every exchange the API reports.
export default async function Venue({ params, searchParams }: { params: Promise<{ venue: string }>; searchParams: SearchParams }) {
  const { venue } = await params;
  const slug = venue.toLowerCase();
  if (slug === 'pancakeswap') return <PancakePage searchParams={searchParams} />;
  const m = await meta();
  const ex = m.exchanges.find((e) => e.slug === slug);
  if (!ex) notFound();
  return <ExchangePage slug={ex.slug} searchParams={searchParams} />;
}
