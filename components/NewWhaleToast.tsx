"use client";

import Link from "next/link";
import type { WhaleTrade } from "@/lib/whaleTrades";
import { stashTradeForNavigation } from "@/lib/tradeNavigationStore";

interface NewWhaleToastProps {
  whale: WhaleTrade | null;
  onDismiss: () => void;
}

function formatUsd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

export default function NewWhaleToast({ whale, onDismiss }: NewWhaleToastProps) {
  if (!whale) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 max-w-sm animate-slide-up">
      <div className="rounded-xl border border-green-500/40 bg-slate-900/95 p-4 shadow-2xl backdrop-blur">
        <div className="mb-2 flex items-start justify-between gap-2">
          <p className="text-sm font-bold text-green-400">🐋 NEW WHALE</p>
          <button
            type="button"
            onClick={onDismiss}
            className="text-slate-500 hover:text-slate-300"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
        <p className="mb-1 line-clamp-2 text-sm font-medium text-white">
          {whale.title}
        </p>
        <p className="mb-3 text-xs text-slate-400">
          {whale.side} {whale.outcome} · {formatUsd(whale.usdNotional)} ·{" "}
          {(whale.price * 100).toFixed(1)}¢
        </p>
        <Link
          href={`/whales/${encodeURIComponent(whale.transactionHash)}`}
          onClick={() => {
            stashTradeForNavigation(whale);
            onDismiss();
          }}
          className="block w-full rounded-lg bg-green-600 py-2 text-center text-sm font-semibold text-white transition-colors hover:bg-green-500"
        >
          View Whale Trade →
        </Link>
      </div>
    </div>
  );
}
