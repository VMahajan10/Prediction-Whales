"use client";

import Link from "next/link";
import { useMemo } from "react";
import BookmarkTraderButton from "@/components/BookmarkTraderButton";
import { LiveFeedPlatformProvider } from "@/lib/LiveFeedPlatformContext";
import { getCachedWhaleTrade } from "@/lib/whaleCache";
import { formatTradeTimeLocal } from "@/lib/time";
import { stashTradeForNavigation } from "@/lib/tradeNavigationStore";
import {
  getBookmarkedWalletSet,
  type BookmarkedTrader,
} from "@/lib/bookmarkedTraders";
import { useBookmarkedTraders } from "@/lib/useBookmarkedTraders";
import { useWhaleFeed } from "@/lib/useWhaleFeed";
import type { WhaleTrade } from "@/lib/whaleTrades";

function walletForWhale(trade: WhaleTrade): string | undefined {
  return (
    trade.proxyWallet?.toLowerCase() ??
    getCachedWhaleTrade(trade.transactionHash)?.proxyWallet?.toLowerCase()
  );
}

function formatSize(size: number): string {
  return `$${Math.round(size).toLocaleString("en-US")}`;
}

function BookmarkedTraderRow({
  trader,
  onRemove,
}: {
  trader: BookmarkedTrader;
  onRemove: (wallet: string) => void;
}) {
  return (
    <li className="rounded-xl border border-pulse-border bg-pulse-card/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-base font-semibold text-white">
            {trader.label}
          </p>
          <p className="mt-0.5 break-all font-mono text-xs text-slate-500">
            {trader.wallet}
          </p>
          <p className="mt-2 text-xs text-slate-500">
            Saved {new Date(trader.bookmarkedAt).toLocaleDateString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <BookmarkTraderButton wallet={trader.wallet} size="sm" />
          <button
            type="button"
            onClick={() => onRemove(trader.wallet)}
            className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-red-500/50 hover:text-red-300"
          >
            Remove
          </button>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        <Link
          href={`/traders/${encodeURIComponent(trader.wallet)}`}
          className="text-sm font-medium text-pulse-accent hover:underline"
        >
          Track record summary →
        </Link>
        <Link
          href={`/traders/${encodeURIComponent(trader.wallet)}/history`}
          className="text-sm text-slate-300 hover:text-white hover:underline"
        >
          In-depth profile →
        </Link>
        {trader.lastSeenTxHash && (
          <Link
            href={`/whales/${encodeURIComponent(trader.lastSeenTxHash)}`}
            className="text-sm text-slate-400 hover:text-white hover:underline"
          >
            Latest whale trade →
          </Link>
        )}
      </div>
    </li>
  );
}

function BookmarkedActivityRow({ trade }: { trade: WhaleTrade }) {
  return (
    <li>
      <Link
        href={`/whales/${encodeURIComponent(trade.transactionHash)}`}
        onClick={() => stashTradeForNavigation(trade)}
        className="block rounded-lg border border-pulse-border bg-slate-800/60 px-3 py-2 transition-colors hover:bg-slate-700"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="min-w-0 flex-1 text-sm font-medium text-white">
            {trade.title.length > 60
              ? `${trade.title.slice(0, 60)}…`
              : trade.title}
          </p>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
              trade.side === "BUY"
                ? "bg-pulse-yes/20 text-pulse-yes"
                : "bg-red-500/20 text-red-400"
            }`}
          >
            {trade.side}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-pulse-muted">
          <span className="font-semibold text-white">
            {formatSize(trade.usdNotional)}
          </span>
          <span>{trade.outcome}</span>
          <span>{(trade.price * 100).toFixed(1)}¢</span>
          <span>{formatTradeTimeLocal(trade.timestamp)}</span>
        </div>
      </Link>
    </li>
  );
}

function FollowingContent() {
  const { bookmarks, unbookmark } = useBookmarkedTraders();
  const { whales } = useWhaleFeed();

  const bookmarkSet = useMemo(() => getBookmarkedWalletSet(), [bookmarks]);

  const bookmarkedActivity = useMemo(() => {
    return whales
      .filter((t) => t.source === "polymarket")
      .filter((t) => {
        const wallet = walletForWhale(t);
        return wallet != null && bookmarkSet.has(wallet);
      })
      .slice(0, 15);
  }, [whales, bookmarkSet]);

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-8 sm:px-6">
      <Link
        href="/"
        className="mb-6 inline-block text-sm text-pulse-muted transition-colors hover:text-white"
      >
        ← Back to Dashboard
      </Link>

      <header className="mb-8">
        <h1 className="text-2xl font-bold text-white">⭐ Following</h1>
        <p className="mt-1 text-sm text-pulse-muted">
          Bookmarked Polymarket traders — saved on this device only
        </p>
      </header>

      <section className="mb-10">
        <h2 className="mb-4 text-lg font-semibold text-white">
          Bookmarked Traders
        </h2>
        {bookmarks.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-600 bg-slate-800/40 px-6 py-10 text-center">
            <p className="text-4xl">⭐</p>
            <p className="mt-3 text-sm text-slate-300">
              No bookmarked traders yet — star a whale to follow them
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Use the star on Polymarket rows in the Whale Tracker or on a whale
              detail page
            </p>
            <Link
              href="/"
              className="mt-4 inline-block text-sm text-pulse-accent hover:underline"
            >
              Go to Whale Tracker →
            </Link>
          </div>
        ) : (
          <ul className="space-y-3">
            {bookmarks.map((trader) => (
              <BookmarkedTraderRow
                key={trader.wallet}
                trader={trader}
                onRemove={unbookmark}
              />
            ))}
          </ul>
        )}
      </section>

      {bookmarks.length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-semibold text-white">
            Recent Activity
          </h2>
          <p className="mb-4 text-xs text-slate-500">
            Live whale trades (≥$500) from traders you follow
          </p>
          {bookmarkedActivity.length === 0 ? (
            <p className="rounded-xl border border-pulse-border bg-pulse-card/40 px-4 py-6 text-sm text-slate-400">
              No recent whale trades from bookmarked traders yet. Activity appears
              here when they trade and their wallet is linked.
            </p>
          ) : (
            <ul className="space-y-2">
              {bookmarkedActivity.map((trade) => (
                <BookmarkedActivityRow
                  key={trade.transactionHash || trade.id}
                  trade={trade}
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}

export default function FollowingPage() {
  return (
    <LiveFeedPlatformProvider>
      <FollowingContent />
    </LiveFeedPlatformProvider>
  );
}
