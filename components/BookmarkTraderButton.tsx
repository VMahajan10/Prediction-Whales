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
        className="h-full w-full fill-amber-400 text-amber-400"
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
  trade,
  size = "md",
  className = "",
}: BookmarkTraderButtonProps) {
  const { isBookmarked, toggle } = useBookmarkedTraders();
  const cachedWallet = txHash
    ? getCachedWhaleTrade(txHash)?.proxyWallet
    : undefined;
  const tradeForResolution = useMemo(() => {
    if (walletProp || cachedWallet) return null;
    if (trade) return trade;
    if (txHash) {
      return {
        transactionHash: txHash,
        assetId,
      } as TradeSummary;
    }
    return null;
  }, [walletProp, cachedWallet, trade, txHash, assetId]);

  const { resolvedWallet, walletResolutionFailed } =
    useResolvedWallet(tradeForResolution);
  const effectiveWallet = (
    walletProp ??
    trade?.proxyWallet ??
    cachedWallet ??
    resolvedWallet
  )?.toLowerCase();

  const [pending, setPending] = useState(false);
  const bookmarked = effectiveWallet ? isBookmarked(effectiveWallet) : false;
  const resolving = !effectiveWallet && !walletResolutionFailed;
  const disabled = !effectiveWallet;

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
      disabled={disabled || pending}
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
        });
        setPending(false);
      }}
      className={`inline-flex shrink-0 items-center justify-center rounded-lg border transition-colors ${
        disabled
          ? "cursor-not-allowed border-slate-700/60 text-slate-600"
          : bookmarked
            ? "border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
            : "border-slate-600 bg-slate-800/80 text-slate-400 hover:border-amber-500/40 hover:text-amber-300"
      } ${dimension} ${className}`}
    >
      {resolving ? (
        <span className="h-3.5 w-3.5 animate-pulse rounded-full bg-slate-600" />
      ) : (
        <span className={size === "sm" ? "h-4 w-4" : "h-5 w-5"}>
          <StarIcon filled={bookmarked} />
        </span>
      )}
    </button>
  );
}
