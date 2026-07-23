"use client";

import { useEffect, useMemo, useState } from "react";
import type { TradeSummary } from "@/lib/polymarket";
import { getCachedWhaleTrade } from "@/lib/whaleCache";
import { useBookmarkedTraders } from "@/lib/useBookmarkedTraders";
import { useResolvedWallet } from "@/lib/useResolvedWallet";

interface BookmarkTraderButtonProps {
  wallet?: string;
  txHash?: string;
  assetId?: string;
  /** Stable bookmark id when no on-chain wallet exists (e.g. Kalshi trades). */
  bookmarkKey?: string;
  /** Display label stored with the bookmark entry */
  label?: string;
  /** When wallet is not yet known, resolve from this trade */
  trade?: TradeSummary | null;
  size?: "sm" | "md";
  className?: string;
}

function StarIcon({ filled }: { filled: boolean }) {
  if (filled) {
    return (
      <svg
        viewBox="0 0 24 24"
        className="h-full w-full fill-pulse-accent text-pulse-accent"
        aria-hidden
      >
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 24 24"
      className="h-full w-full fill-none stroke-current stroke-2"
      aria-hidden
    >
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </svg>
  );
}

export default function BookmarkTraderButton({
  wallet: walletProp,
  txHash,
  assetId,
  bookmarkKey,
  label,
  trade,
  size = "md",
  className = "",
}: BookmarkTraderButtonProps) {
  const { isBookmarked, toggle } = useBookmarkedTraders();
  const cachedWallet = txHash
    ? getCachedWhaleTrade(txHash)?.proxyWallet
    : undefined;
  const tradeForResolution = useMemo(() => {
    if (bookmarkKey || walletProp || cachedWallet) return null;
    if (trade) return trade;
    if (txHash) {
      return {
        transactionHash: txHash,
        assetId,
      } as TradeSummary;
    }
    return null;
  }, [bookmarkKey, walletProp, cachedWallet, trade, txHash, assetId]);

  const { resolvedWallet, walletResolutionFailed } =
    useResolvedWallet(tradeForResolution);
  const effectiveWallet = (
    bookmarkKey ??
    walletProp ??
    trade?.proxyWallet ??
    cachedWallet ??
    resolvedWallet
  )?.toLowerCase();

  const [pending, setPending] = useState(false);
  const bookmarked = effectiveWallet ? isBookmarked(effectiveWallet) : false;
  const resolving = !bookmarkKey && !effectiveWallet && !walletResolutionFailed;
  const disabled = !effectiveWallet || pending;

  useEffect(() => {
    if (effectiveWallet) setPending(false);
  }, [effectiveWallet]);

  const dimension = size === "sm" ? "h-7 w-7" : "h-9 w-9";
  const title = bookmarked
    ? "Remove bookmark"
    : resolving
      ? "Resolving wallet…"
      : walletResolutionFailed
        ? "Wallet unavailable — cannot bookmark"
        : "Bookmark this trader";

  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={bookmarked}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!effectiveWallet) return;
        setPending(true);
        toggle({
          wallet: effectiveWallet,
          txHash,
          label,
        });
        setPending(false);
      }}
      className={`inline-flex shrink-0 items-center justify-center rounded-lg border transition-colors ${
        disabled && !resolving
          ? "cursor-not-allowed border-pulse-border text-pulse-label"
          : bookmarked
            ? "border-pulse-accent/50 bg-pulse-accent/10 text-pulse-accent hover:bg-pulse-accent/20"
            : "border-pulse-border bg-pulse-card text-pulse-muted hover:border-pulse-accent/50 hover:text-pulse-accent"
      } ${dimension} ${className}`}
    >
      <span
        className={`${size === "sm" ? "h-4 w-4" : "h-5 w-5"} ${
          resolving ? "animate-pulse opacity-60" : ""
        }`}
      >
        <StarIcon filled={bookmarked} />
      </span>
    </button>
  );
}
