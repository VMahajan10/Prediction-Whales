"use client";

import Link from "next/link";
import BookmarkTraderButton from "@/components/BookmarkTraderButton";
import TraderProfileHistory from "@/components/TraderProfileHistory";
import WhaleTrackRecord from "@/components/WhaleTrackRecord";
import { walletLabel } from "@/lib/bookmarkedTraders";
import { useBookmarkedTraders } from "@/lib/useBookmarkedTraders";
import { useWhaleTrackRecord } from "@/lib/useWhaleTrackRecord";

function isValidWallet(wallet: string): boolean {
  return /^0x[a-f0-9]{40}$/i.test(wallet);
}

export default function TraderHistoryPage({
  params,
}: {
  params: { wallet: string };
}) {
  const wallet = decodeURIComponent(params.wallet).toLowerCase();
  const { isBookmarked } = useBookmarkedTraders();
  const record = useWhaleTrackRecord(wallet);
  const valid = isValidWallet(wallet);

  if (!valid) {
    return (
      <main className="mx-auto min-h-screen max-w-5xl px-4 py-8 sm:px-6">
        <Link
          href="/following"
          className="mb-6 inline-block text-sm text-pulse-muted hover:text-white"
        >
          ← Back to Following
        </Link>
        <p className="text-red-400">Invalid wallet address.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen max-w-5xl px-4 py-8 sm:px-6">
      <Link
        href={`/traders/${encodeURIComponent(wallet)}`}
        className="mb-6 inline-block text-sm text-pulse-muted transition-colors hover:text-white"
      >
        ← Trader summary
      </Link>

      <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-pulse-accent">
              In-depth profile
            </p>
            <h1 className="mt-1 text-2xl font-bold text-white">
              {walletLabel(wallet)}
            </h1>
            <p className="mt-1 break-all font-mono text-xs text-slate-500">
              {wallet}
            </p>
            {isBookmarked(wallet) && (
              <p className="mt-2 text-sm text-amber-300">
                ⭐ You&apos;re following this trader
              </p>
            )}
          </div>
          <BookmarkTraderButton wallet={wallet} size="md" />
        </div>
        <div className="mt-4 flex flex-wrap gap-4 text-sm">
          <a
            href={`https://polygonscan.com/address/${wallet}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-pulse-accent hover:underline"
          >
            Polygonscan →
          </a>
          <Link
            href="/following"
            className="text-slate-400 hover:text-white hover:underline"
          >
            Following list
          </Link>
        </div>
      </section>

      <WhaleTrackRecord
        proxyWallet={wallet}
        entryPrice={0.5}
        currentPrice={null}
        betSize={0}
        externalRecord={record}
      />

      <TraderProfileHistory record={record} />
    </main>
  );
}
