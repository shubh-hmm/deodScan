/**
 * Shown in the main area while a page loads when switching sections: placeholders only.
 * The welcome greeting is NOT here: it appears once, when the website first opens (components/splash.tsx in the layout).
 */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="skeleton mb-5 h-16 w-72" />
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
