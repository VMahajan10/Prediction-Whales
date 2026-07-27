interface ReviewLoadErrorProps {
  title: string;
  message: string;
}

export default function ReviewLoadError({ title, message }: ReviewLoadErrorProps) {
  return (
    <main className="mx-auto min-h-screen max-w-2xl px-4 py-8">
      <p className="pulse-label mb-2">X Post Review</p>
      <div className="rounded-pulse border border-red-500/40 bg-red-500/10 p-6">
        <h1 className="text-xl font-bold text-red-300">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-pulse-muted">{message}</p>
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
