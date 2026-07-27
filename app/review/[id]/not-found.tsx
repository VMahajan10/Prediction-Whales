export default function ReviewNotFound() {
  return (
    <main className="mx-auto min-h-screen max-w-2xl px-4 py-8">
      <p className="pulse-label mb-2">X Post Review</p>
      <div className="rounded-pulse border border-pulse-border bg-pulse-card p-6">
        <h1 className="text-xl font-bold text-white">Review not found</h1>
        <p className="mt-2 text-sm leading-relaxed text-pulse-muted">
          This queue item does not exist, may have expired, or the link is
          invalid.
        </p>
        <a
          href="/"
          className="mt-5 inline-block text-sm font-semibold text-pulse-accent hover:underline"
        >
          Back to feed
        </a>
      </div>
    </main>
  );
}
