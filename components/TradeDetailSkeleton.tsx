function SkeletonBlock({ className = "" }: { className?: string }) {
  return (
    <div className={`animate-pulse rounded-lg bg-slate-700/60 ${className}`} />
  );
}

export function EnrichmentSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="animate-pulse space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonBlock key={i} className={`h-4 ${i === 0 ? "w-3/4" : "w-1/2"}`} />
      ))}
    </div>
  );
}

export default function TradeDetailSkeleton() {
  return (
    <main className="mx-auto min-h-screen max-w-4xl px-4 py-8 sm:px-6">
      <SkeletonBlock className="mb-6 h-4 w-36" />
      <div className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
        <SkeletonBlock className="mb-4 h-6 w-40" />
        <div className="grid gap-6 sm:grid-cols-2">
          <SkeletonBlock className="h-36" />
          <SkeletonBlock className="h-36" />
        </div>
      </div>
      <div className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
        <SkeletonBlock className="mb-4 h-6 w-56" />
        <SkeletonBlock className="mb-3 h-4 w-full" />
        <SkeletonBlock className="mb-3 h-4 w-5/6" />
        <SkeletonBlock className="h-4 w-2/3" />
      </div>
      <div className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
        <SkeletonBlock className="mb-4 h-6 w-48" />
        <SkeletonBlock className="h-32 w-full" />
      </div>
    </main>
  );
}
