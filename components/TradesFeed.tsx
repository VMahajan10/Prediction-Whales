"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { getTimeAgo } from "@/lib/time";
import type { FeedTrade } from "@/lib/kalshiTrades";
import { useLiveFeed } from "@/lib/useLiveFeed";
import { isWhaleNotional } from "@/lib/whaleTrades";

function tradeKey(trade: FeedTrade): string {
  return `${trade.source}:${trade.id}`;
}

function SourceBadge({ source }: { source: FeedTrade["source"] }) {
  if (source === "kalshi") {
    return (
      <span className="shrink-0 rounded bg-teal-900/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-teal-300">
        Kalshi
      </span>
    );
  }

  return (
    <span className="shrink-0 rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
      Polymarket
    </span>
  );
}

function TradeRowContent({
  trade,
  isNew,
}: {
  trade: FeedTrade;
  isNew: boolean;
}) {
  const whale = isWhaleNotional(trade.usdNotional);
  const rowClass = `rounded-lg border border-transparent p-2 transition-colors ${
    whale ? "border-l-2 border-l-yellow-500" : ""
  } ${isNew ? "animate-trade-in" : ""}`;

  const inner = (
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <SourceBadge source={trade.source} />
            <p className="truncate text-sm text-slate-200">{trade.title}</p>
          </div>
          <p className="text-xs text-slate-400">
            {trade.outcome} @ {(trade.price * 100).toFixed(1)}¢ · $
            {trade.usdNotional.toLocaleString(undefined, {
              maximumFractionDigits: 0,
            })}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          {trade.source === "polymarket" ? (
            <span
              className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                trade.side === "BUY"
                  ? "bg-green-900 text-green-400"
                  : "bg-red-900 text-red-400"
              }`}
            >
              {trade.side}
            </span>
          ) : (
            <span
              className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                trade.outcome === "Yes"
                  ? "bg-green-900 text-green-400"
                  : "bg-red-900 text-red-400"
              }`}
            >
              {trade.outcome}
            </span>
          )}
          {whale && <span className="text-xs">🐋</span>}
          <span className="text-xs text-slate-500">
            {getTimeAgo(trade.timestamp)}
          </span>
        </div>
      </div>
  );

  if (trade.traceable && trade.transactionHash) {
    return (
      <Link
        href={`/trades/${encodeURIComponent(trade.transactionHash)}`}
        className={`block cursor-pointer hover:border-slate-600 hover:bg-slate-700 ${rowClass}`}
      >
        {inner}
      </Link>
    );
  }

  return <div className={rowClass}>{inner}</div>;
}

export default function TradesFeed() {
  const { trades, polymarketConnected, kalshiOk } = useLiveFeed();
  const [newTradeKeys, setNewTradeKeys] = useState<Set<string>>(new Set());
  const prevLatestKey = useRef<string | null>(null);

  const whales = trades.filter((t) => isWhaleNotional(t.usdNotional));

  useEffect(() => {
    if (trades.length === 0) return;

    const latestKey = tradeKey(trades[0]);
    if (latestKey === prevLatestKey.current) return;
    prevLatestKey.current = latestKey;

    setNewTradeKeys((prev) => {
      const next = new Set(prev);
      next.add(latestKey);
      return next;
    });
    const timer = setTimeout(() => {
      setNewTradeKeys((prev) => {
        const next = new Set(prev);
        next.delete(latestKey);
        return next;
      });
    }, 2000);

    return () => clearTimeout(timer);
  }, [trades]);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Live Trades</h2>
        <div className="flex items-center gap-2">
          {polymarketConnected ? (
            <span className="flex items-center gap-1 text-xs text-green-400">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
              </span>
              Live
              {kalshiOk && (
                <span className="text-slate-500">+Kalshi</span>
              )}
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs text-slate-400">
              <span className="h-2 w-2 rounded-full bg-slate-500" />
              Connecting
            </span>
          )}
        </div>
      </div>

      <div className="mb-2 text-xs text-slate-500">
        {trades.length} recent trades · {whales.length} whale
        {whales.length !== 1 ? "s" : ""}
      </div>

      <div className="max-h-[480px] flex-1 space-y-1 overflow-y-auto">
        {trades.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-500">
            {polymarketConnected ? "Waiting for trades..." : "Connecting..."}
          </div>
        ) : (
          trades.map((trade) => (
            <TradeRowContent
              key={tradeKey(trade)}
              trade={trade}
              isNew={newTradeKeys.has(tradeKey(trade))}
            />
          ))
        )}
      </div>
    </div>
  );
}
