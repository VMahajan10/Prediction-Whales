"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import CrossMarketEvBadge from "@/components/CrossMarketEvBadge";
import AiArbitrageBadge from "@/components/AiArbitrageBadge";
import PipelineEvBadge from "@/components/PipelineEvBadge";
import PlatformFilterToggle from "@/components/PlatformFilterToggle";
import { getTimeAgo } from "@/lib/time";
import type { FeedTrade } from "@/lib/kalshiTrades";
import type { OutcomeBooks } from "@/lib/crossMarketEv";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { useLiveFeedPlatform } from "@/lib/LiveFeedPlatformContext";
import { liveFeedPlatformLabel } from "@/lib/liveFeedMerge";
import { useLiveFeed } from "@/lib/useLiveFeed";
import {
  feedTradeToSummary,
  stashKalshiTradeForNavigation,
  stashTradeForNavigation,
} from "@/lib/tradeNavigationStore";
import { useCrossMarketEvIndex } from "@/lib/useCrossMarketEvIndex";
import { pipelineEvKeyForTrade } from "@/lib/pipelineEvClient";
import { usePipelineEvIndex } from "@/lib/usePipelineEvIndex";
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
  evIndex,
  pipelineEv,
}: {
  trade: FeedTrade;
  isNew: boolean;
  evIndex: Map<string, OutcomeBooks>;
  pipelineEv: PipelineTradeEv | null;
}) {
  const whale = isWhaleNotional(trade.usdNotional);
  const rowClass = `rounded-lg border border-transparent p-2 transition-colors ${
    whale ? "border-l-2 border-l-yellow-500" : ""
  } ${isNew ? "animate-trade-in" : ""}`;

  const inner = (
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <SourceBadge source={trade.source} />
            <PipelineEvBadge ev={pipelineEv} />
            <AiArbitrageBadge
              trade={{
                source: trade.source,
                price: trade.price,
                slug: trade.slug,
                ticker: trade.ticker,
              }}
              index={evIndex}
            />
            <p className="truncate text-sm text-slate-200">{trade.title}</p>
          </div>
          <p className="text-xs text-slate-400">
            {trade.outcome} @ {(Math.round(trade.price * 1000) / 10).toFixed(1)}¢ · $
            {trade.usdNotional.toLocaleString(undefined, {
              maximumFractionDigits: 0,
            })}
          </p>
          <CrossMarketEvBadge
            trade={{
              source: trade.source,
              price: trade.price,
              slug: trade.slug,
              ticker: trade.ticker,
            }}
            index={evIndex}
            compact
            className="mt-0.5 block"
          />
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

  if (trade.source === "kalshi" && trade.traceable && trade.ticker) {
    const href = `/trades/kalshi/${encodeURIComponent(trade.id)}?ticker=${encodeURIComponent(trade.ticker)}`;
    return (
      <Link
        href={href}
        onClick={() => stashKalshiTradeForNavigation(trade)}
        className={`block cursor-pointer hover:border-slate-600 hover:bg-slate-700 ${rowClass}`}
      >
        {inner}
      </Link>
    );
  }

  if (trade.source === "kalshi" && trade.traceable) {
    return (
      <Link
        href={`/trades/kalshi/${encodeURIComponent(trade.id)}`}
        onClick={() => stashKalshiTradeForNavigation(trade)}
        className={`block cursor-pointer hover:border-slate-600 hover:bg-slate-700 ${rowClass}`}
      >
        {inner}
      </Link>
    );
  }

  if (trade.traceable && trade.transactionHash) {
    const summary = feedTradeToSummary(trade);
    return (
      <Link
        href={`/trades/${encodeURIComponent(trade.transactionHash)}`}
        onClick={() => {
          if (summary) stashTradeForNavigation(summary);
        }}
        className={`block cursor-pointer hover:border-slate-600 hover:bg-slate-700 ${rowClass}`}
      >
        {inner}
      </Link>
    );
  }

  return <div className={rowClass}>{inner}</div>;
}

export default function TradesFeed() {
  const { platform, setPlatform } = useLiveFeedPlatform();
  const { trades, polymarketConnected, kalshiOk } = useLiveFeed(platform);
  const { index: evIndex } = useCrossMarketEvIndex();
  const { index: pipelineEvIndex } = usePipelineEvIndex(trades);
  const [newTradeKeys, setNewTradeKeys] = useState<Set<string>>(new Set());
  const prevLatestKey = useRef<string | null>(null);

  const handlePlatformChange = (next: typeof platform) => {
    setPlatform(next);
    prevLatestKey.current = null;
    setNewTradeKeys(new Set());
  };

  const whales = trades.filter((t) => isWhaleNotional(t.usdNotional));
  const platformLabel = liveFeedPlatformLabel(platform);

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
      <div className="mb-3 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Live Trades</h2>
          <div className="flex items-center gap-2">
            {polymarketConnected ? (
              <span className="flex items-center gap-1 text-xs text-green-400">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
                </span>
                Live
                {kalshiOk && platform !== "polymarket" && (
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
        <PlatformFilterToggle
          value={platform}
          onChange={handlePlatformChange}
        />
      </div>

      <div className="mb-2 text-xs text-slate-500">
        {trades.length} recent trades · {whales.length} whale
        {whales.length !== 1 ? "s" : ""} · {platformLabel}
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
              evIndex={evIndex}
              pipelineEv={
                pipelineEvKeyForTrade(trade)
                  ? pipelineEvIndex.get(pipelineEvKeyForTrade(trade)!) ?? null
                  : null
              }
            />
          ))
        )}
      </div>
    </div>
  );
}
