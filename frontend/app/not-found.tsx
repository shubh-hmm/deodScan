import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto mt-16 max-w-md rounded-2xl border border-line bg-surface p-8 text-center">
      <div className="text-5xl font-semibold tracking-tight text-ink">404</div>
      <h1 className="mt-3 text-lg font-semibold">This page does not exist</h1>
      <p className="mt-2 text-sm text-ink-2">
        The exchange or address you asked for is not monitored here. The dashboard covers MEXC, Toobit, XT, BingX, Poloniex, WEEX and PancakeSwap V2/V3.
      </p>
      <Link href="/" className="btn mt-5">Back to the dashboard</Link>
    </div>
  );
}
