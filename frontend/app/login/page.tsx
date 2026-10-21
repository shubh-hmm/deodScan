import type { Metadata } from 'next';
import { BrandMark } from '@/components/icons';
import { Wordmark } from '@/components/brand';
import { safeNext } from '@/lib/auth';
import { LoginForm } from '@/app/login/login-form';

export const metadata: Metadata = { title: 'Sign in · DEODScan', robots: { index: false, follow: false } };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-7 shadow-xl">
        <div className="flex items-center gap-3">
          <BrandMark />
          <Wordmark className="text-[20px] leading-none" />
        </div>
        <h1 className="mt-6 text-lg font-semibold">Private dashboard</h1>
        <p className="mt-1 text-sm text-muted">Sign in as Bimal Pradhan to continue.</p>
        <LoginForm next={next} />
      </div>
    </main>
  );
}
