export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="skeleton mb-5 h-7 w-64" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton h-[88px]" />)}
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        <div className="skeleton h-72 xl:col-span-2" />
        <div className="skeleton h-72 xl:col-span-3" />
      </div>
    </div>
  );
}
