"use client";

interface LoadErrorCardProps {
  message: string;
  onRetry: () => void;
}

export default function LoadErrorCard({ message, onRetry }: LoadErrorCardProps) {
  return (
    <div className="mt-8 rounded-xl border border-red-500/40 bg-red-500/10 p-6">
      <p className="font-medium text-red-300">{message}</p>
      <p className="mt-2 text-sm text-slate-400">
        The request timed out or failed. You can try again.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 rounded-lg bg-pulse-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-pulse-accent/90"
      >
        Retry
      </button>
    </div>
  );
}
