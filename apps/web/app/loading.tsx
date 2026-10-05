import { GreetingBlock } from '@/components/greeting';

/** Shown in the main area while a page loads: the welcome greeting, then placeholders where the content will appear. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="py-8"><GreetingBlock /></div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton h-[104px]" />)}
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <div className="skeleton h-72 xl:col-span-2" />
        <div className="skeleton h-72" />
      </div>
    </div>
  );
}
