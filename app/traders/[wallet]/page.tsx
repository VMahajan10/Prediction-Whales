"use client";

import Link from "next/link";
import BookmarkTraderButton from "@/components/BookmarkTraderButton";
import WhaleTrackRecord from "@/components/WhaleTrackRecord";
import { walletLabel } from "@/lib/bookmarkedTraders";
import { useBookmarkedTraders } from "@/lib/useBookmarkedTraders";

function isValidWallet(wallet: string): boolean {
  return /^0x[a-f0-9]{40}$/i.test(wallet);
}

export default function TraderProfilePage({
  params,
}: {
  params: { wallet: string };
}) {
  const wallet = decodeURIComponent(params.wallet).toLowerCase();
  const { isBookmarked } = useBookmarkedTraders();
  const valid = isValidWallet(wallet);

  if (!valid) {
    return (
      <main className="mx-auto min-h-screen max-w-4xl px-4 py-8 sm:px-6">
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
    <main className="mx-auto min-h-screen max-w-4xl px-4 py-8 sm:px-6">
      <Link
        href="/following"
        className="mb-6 inline-block text-sm text-pulse-muted transition-colors hover:text-white"
      >
        ← Back to Following
      </Link>

      <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-white">
              🐋 Polymarket Trader
            </h1>
            <p className="mt-1 font-mono text-lg text-white">
              {walletLabel(wallet)}
            </p>
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
        <div className="mt-4 flex flex-wrap gap-4">
          <Link
            href={`/traders/${encodeURIComponent(wallet)}/history`}
            className="inline-flex items-center rounded-lg border border-pulse-accent/40 bg-pulse-accent/10 px-4 py-2 text-sm font-medium text-pulse-accent transition-colors hover:bg-pulse-accent/20"
          >
            View full trade history →
          </Link>
          <a
            href={`https://polygonscan.com/address/${wallet}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center py-2 text-sm text-slate-400 hover:text-white hover:underline"
          >
            Polygonscan →
          </a>
        </div>
      </section>

      <WhaleTrackRecord
        proxyWallet={wallet}
        entryPrice={0.5}
        currentPrice={null}
        betSize={0}
      />
    </main>
  );
}
