import Link from "next/link";

interface FeedEmptyStateProps {
  icon: string;
  title: string;
  description: string;
  actionLabel?: string;
  actionHref?: string;
}

export default function FeedEmptyState({
  icon,
  title,
  description,
  actionLabel,
  actionHref,
}: FeedEmptyStateProps) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-pulse-border bg-pulse-card px-6 py-14 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-pulse-border bg-pulse-surface text-3xl">
        {icon}
      </div>
      <p className="text-base font-bold text-white">{title}</p>
      <p className="mt-2 max-w-xs text-sm leading-relaxed text-pulse-muted">
        {description}
      </p>
      {actionLabel && actionHref ? (
        <Link
          href={actionHref}
          className="mt-6 inline-flex items-center justify-center rounded-xl bg-pulse-accent px-5 py-2.5 text-sm font-bold text-black transition-colors hover:bg-pulse-accent/90"
        >
          {actionLabel}
        </Link>
      ) : null}
    </div>
  );
}
