"use client";

import Link from "next/link";
import type { TradeSummary } from "@/lib/polymarket";
import { formatTradeTimeLocal, getTimeAgo } from "@/lib/time";

const MIN_WHALE_SIZE = 500;
const TOP_WHALE_COUNT = 10;

interface WhaleTrackerProps {
  trades: TradeSummary[];
}

function truncateTitle(title: string, maxLen: number): string {
  if (title.length <= maxLen) return title;
  return `${title.slice(0, maxLen)}…`;
}

function formatWhaleSize(size: number): string {
  return `$${Math.round(size).toLocaleString("en-US")}`;
}

function truncateTxHash(hash: string): string {
  if (hash.length <= 10) return hash;
  return `${hash.slice(0, 6)}...${hash.slice(-4)}`;
}

function filterWhales(trades: TradeSummary[]): TradeSummary[] {
  return trades
    .filter((trade) => trade.size >= MIN_WHALE_SIZE)
    .sort((a, b) => b.size - a.size);
}

export default function WhaleTracker({ trades }: WhaleTrackerProps) {
  const whales = filterWhales(trades);
  const topWhales = whales.slice(0, TOP_WHALE_COUNT);

  return (
    <div className="mb-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-white">🐋 Whale Tracker</h2>
          <p className="text-sm text-pulse-muted">
            Trades ≥ $500 · updates every 15s
          </p>
        </div>
        <span className="rounded-full bg-pulse-accent/20 px-3 py-1 text-sm font-medium text-pulse-accent">
          {whales.length} whales detected
        </span>
      </div>

      <div className="rounded-xl border border-pulse-border bg-pulse-card/40 p-4">
        {topWhales.length === 0 ? (
          <p className="py-4 text-sm text-pulse-muted">
            No whale trades detected (≥ $500)
          </p>
        ) : (
          <ul className="space-y-2">
            {topWhales.map((trade, index) => (
              <li key={trade.transactionHash || index}>
                <Link
                  href={`/whales/${encodeURIComponent(trade.transactionHash)}`}
                  className="block cursor-pointer rounded-lg border border-pulse-border bg-pulse-card/60 px-3 py-2 transition-colors hover:bg-slate-700"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="min-w-0 flex-1 text-sm font-medium text-white">
                      {truncateTitle(trade.title, 50)}
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
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-pulse-muted">
                    <span className="text-white">{trade.outcome}</span>
                    <span className="font-semibold text-white">
                      {formatWhaleSize(trade.size)}
                    </span>
                    <span>{(trade.price * 100).toFixed(1)}¢</span>
                    <span>{formatTradeTimeLocal(trade.timestamp)}</span>
                    <span>{getTimeAgo(trade.timestamp)}</span>
                    <span
                      role="link"
                      tabIndex={0}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        window.open(
                          `https://polygonscan.com/tx/${trade.transactionHash}`,
                          "_blank",
                          "noopener,noreferrer"
                        );
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          window.open(
                            `https://polygonscan.com/tx/${trade.transactionHash}`,
                            "_blank",
                            "noopener,noreferrer"
                          );
                        }
                      }}
                      className="font-mono text-pulse-accent hover:underline"
                    >
                      {truncateTxHash(trade.transactionHash)}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
