"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import BookmarkTraderButton from "@/components/BookmarkTraderButton";
import PlatformFilterToggle from "@/components/PlatformFilterToggle";
import { useLiveFeedPlatform } from "@/lib/LiveFeedPlatformContext";
import { liveFeedPlatformLabel } from "@/lib/liveFeedMerge";
import { formatTradeTimeLocal } from "@/lib/time";
import {
  stashKalshiTradeForNavigation,
  stashTradeForNavigation,
  whaleTradeToKalshiFeedTrade,
} from "@/lib/tradeNavigationStore";
import {
  windowProgress,
  windowRemainingSec,
  type WhaleTrade,
} from "@/lib/whaleTrades";

const TOP_WHALE_COUNT = 10;

interface WhaleTrackerProps {
  whales: WhaleTrade[];
  connected: boolean;
  kalshiOk: boolean;
  soundEnabled: boolean;
  onToggleSound: () => void;
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

function secondsAgo(detectedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - detectedAt) / 1000));
}

function SourceBadge({ source }: { source: WhaleTrade["source"] }) {
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

function WhaleRowBody({ trade, now }: { trade: WhaleTrade; now: number }) {
  const ageSec = secondsAgo(trade.detectedAt, now);
  const progress = trade.isLive ? windowProgress(trade.detectedAt, now) : 100;
  const remaining = trade.isLive
    ? windowRemainingSec(trade.detectedAt, now)
    : 0;
  const isKalshi = trade.source === "kalshi";

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <SourceBadge source={trade.source} />
            <p className="min-w-0 flex-1 text-sm font-medium text-white">
              {truncateTitle(trade.title, 50)}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {trade.isLive && (
            <span className="rounded-full bg-green-500/20 px-2 py-0.5 text-xs font-semibold text-green-400">
              LIVE
            </span>
          )}
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
              isKalshi
                ? trade.outcome === "Yes"
                  ? "bg-pulse-yes/20 text-pulse-yes"
                  : "bg-red-500/20 text-red-400"
                : trade.side === "BUY"
                  ? "bg-pulse-yes/20 text-pulse-yes"
                  : "bg-red-500/20 text-red-400"
            }`}
          >
            {isKalshi ? trade.outcome : trade.side}
          </span>
        </div>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-pulse-muted">
        {!isKalshi && <span className="text-white">{trade.outcome}</span>}
        <span className="font-semibold text-white">
          {formatWhaleSize(trade.usdNotional)}
        </span>
        <span>{(trade.price * 100).toFixed(1)}¢</span>
        <span>{formatTradeTimeLocal(trade.timestamp)}</span>
        <span className="text-pulse-accent">detected {ageSec}s ago</span>
        {isKalshi ? (
          <span className="text-slate-500">Anonymous trade</span>
        ) : (
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
        )}
      </div>
      {trade.isLive && remaining > 0 && (
        <div className="mt-2">
          <div className="mb-1 flex justify-between text-[10px] text-slate-500">
            <span>Window closing (est.)</span>
            <span>{remaining}s left</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-slate-700">
            <div
              className="h-full rounded-full bg-gradient-to-r from-green-500 to-yellow-500 transition-all duration-1000"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}
    </>
  );
}

function WhaleRow({ trade, now }: { trade: WhaleTrade; now: number }) {
  const rowClass = `block rounded-lg border px-3 py-2 transition-colors hover:bg-slate-700 ${
    trade.isLive
      ? "border-green-500/30 bg-green-500/5"
      : "border-pulse-border bg-pulse-card/60"
  }`;

  if (trade.source === "kalshi") {
    const feedTrade = whaleTradeToKalshiFeedTrade(trade);
    const href =
      trade.ticker != null
        ? `/trades/kalshi/${encodeURIComponent(trade.id)}?ticker=${encodeURIComponent(trade.ticker)}`
        : `/trades/kalshi/${encodeURIComponent(trade.id)}`;

    return (
      <li>
        <Link
          href={href}
          onClick={() => {
            if (feedTrade) stashKalshiTradeForNavigation(feedTrade);
          }}
          className={`cursor-pointer ${rowClass}`}
        >
          <WhaleRowBody trade={trade} now={now} />
        </Link>
      </li>
    );
  }

  return (
    <li>
      <div className={`flex items-start gap-2 ${rowClass}`}>
        <Link
          href={`/whales/${encodeURIComponent(trade.transactionHash)}`}
          onClick={() => stashTradeForNavigation(trade)}
          className="min-w-0 flex-1 cursor-pointer"
        >
          <WhaleRowBody trade={trade} now={now} />
        </Link>
        <BookmarkTraderButton
          wallet={trade.proxyWallet}
          txHash={trade.transactionHash}
          assetId={trade.assetId}
          trade={trade}
          size="sm"
          className="mt-1"
        />
      </div>
    </li>
  );
}

export default function WhaleTracker({
  whales,
  connected,
  kalshiOk,
  soundEnabled,
  onToggleSound,
}: WhaleTrackerProps) {
  const { platform, setPlatform } = useLiveFeedPlatform();
  const topWhales = whales.slice(0, TOP_WHALE_COUNT);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const pmCount = whales.filter((w) => w.source === "polymarket").length;
  const kalshiCount = whales.filter((w) => w.source === "kalshi").length;

  return (
    <div className="mb-8">
      <div className="mb-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-white">🐋 Whale Tracker</h2>
            <p className="text-sm text-pulse-muted">
              Trades ≥ $500 ·{" "}
              {connected ? (
                <span className="text-green-400">live WebSocket</span>
              ) : (
                <span>connecting…</span>
              )}
              {kalshiOk && platform !== "polymarket" && (
                <span className="text-slate-500"> · +Kalshi poll</span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onToggleSound}
              className="rounded-lg border border-pulse-border bg-slate-800 px-3 py-1 text-xs text-slate-300 transition-colors hover:bg-slate-700"
              title="Toggle whale sound alerts (≥$5k)"
            >
              {soundEnabled ? "🔔 Sound on" : "🔕 Sound off"}
            </button>
            <span className="rounded-full bg-pulse-accent/20 px-3 py-1 text-sm font-medium text-pulse-accent">
              {whales.length} whales
            </span>
          </div>
        </div>
        <PlatformFilterToggle value={platform} onChange={setPlatform} />
      </div>

      <div className="mb-3 text-xs text-slate-500">
        Showing top {topWhales.length} of {whales.length} · {pmCount} PM ·{" "}
        {kalshiCount} Kalshi · {liveFeedPlatformLabel(platform)}
      </div>

      <div className="rounded-xl border border-pulse-border bg-pulse-card/40 p-4">
        {topWhales.length === 0 ? (
          <p className="py-4 text-sm text-pulse-muted">
            {connected || kalshiOk
              ? "Watching for whale trades (≥ $500)…"
              : "Connecting to live feed…"}
          </p>
        ) : (
          <ul className="space-y-2">
            {topWhales.map((trade) => (
              <WhaleRow
                key={
                  trade.source === "kalshi"
                    ? `kalshi:${trade.id}`
                    : trade.transactionHash || trade.id
                }
                trade={trade}
                now={now}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
