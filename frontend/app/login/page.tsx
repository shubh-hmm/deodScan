import type { Metadata } from 'next';
import { BrandMark } from '@/components/icons';
import { Wordmark } from '@/components/brand';
import { safeNext } from '@/lib/auth';
import { OWNER_NAME } from '@/lib/site';
import { LoginCard, LoginForm } from '@/app/login/login-form';

export const metadata: Metadata = { title: 'Sign in · DEODScan', robots: { index: false, follow: false } };

const POINTS = [
  ['Exchange flows', 'DEOD deposits and withdrawals across the exchanges you track'],
  ['DEX swaps', 'Every buy and sell, with price and USD value'],
  ['Verified on-chain data', 'Synced once per finished UTC day and cross-checked against the chain'],
] as const;

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  return (
    <main className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      {/* Left: brand panel. Decorative only: the line chart is an illustration, not data. */}
      <section className="login-hero hidden flex-col justify-between p-12 lg:flex" aria-hidden="true">
        <div className="orb a" /><div className="orb b" /><div className="orb c" />
        <div className="relative z-10 flex items-center gap-3">
          <BrandMark size={34} />
          <Wordmark className="text-[22px] leading-none" />
        </div>
        <div className="relative z-10 max-w-lg">
          <h2 className="font-brand hero-item text-[34px] font-semibold leading-[1.15] tracking-tight" style={{ animationDelay: '0.1s' }}>
            Every DEOD move,<br /><span className="brand-grad">in one place.</span>
          </h2>
          <svg viewBox="0 0 520 130" className="hero-item mt-8 w-full max-w-md" style={{ animationDelay: '0.25s' }} fill="none" strokeLinecap="round" strokeLinejoin="round">
            <path className="hero-line" d="M4 98 C 50 96, 70 60, 112 66 S 176 112, 222 84 S 290 22, 338 40 S 410 96, 454 52 S 500 14, 516 20" stroke="#8b6cff" strokeWidth="3" />
            <path className="hero-line second" d="M4 112 C 60 108, 84 90, 130 96 S 200 118, 250 100 S 320 70, 372 84 S 450 112, 516 90" stroke="#e155d6" strokeWidth="2" />
          </svg>
          <ul className="mt-8 space-y-4">
            {POINTS.map(([title, text], i) => (
              <li key={title} className="hero-item flex gap-3" style={{ animationDelay: `${0.4 + i * 0.12}s` }}>
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" />
                <span><span className="block text-sm font-semibold text-ink">{title}</span><span className="block text-[13px] leading-snug text-muted">{text}</span></span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative z-10 text-xs text-muted">BNB Chain · read-only monitor</p>
      </section>

      {/* Right: the sign-in card */}
      <section className="flex items-center justify-center px-5 py-10">
        <div className="w-full max-w-[420px]">
          <div className="mb-7 flex items-center justify-center gap-2.5 lg:hidden">
            <BrandMark size={30} />
            <Wordmark className="text-xl leading-none" />
          </div>
          <LoginCard>
            <p className="text-sm text-muted">Welcome back,</p>
            <h1 className="font-brand mt-1 text-[26px] font-semibold leading-tight tracking-tight">{OWNER_NAME}</h1>
            <p className="mt-2 text-sm text-muted">This dashboard is private. Enter your password to continue.</p>
            <LoginForm next={next} />
          </LoginCard>
          <p className="mt-5 flex items-center justify-center gap-2 text-center text-xs text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-good" />Private · signed session · expires after 30 days
          </p>
        </div>
      </section>
    </main>
  );
}
