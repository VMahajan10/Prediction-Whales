"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import BookmarkTraderButton from "@/components/BookmarkTraderButton";
import PlatformFilterToggle from "@/components/PlatformFilterToggle";
import { formatEvPercent } from "@/lib/crossMarketEvDisplay";
import { useLiveFeedPlatform } from "@/lib/LiveFeedPlatformContext";
import { liveFeedPlatformLabel } from "@/lib/liveFeedMerge";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { pipelineEvKeyForWhale } from "@/lib/pipelineEvClient";
import { usePipelineEvForWhales } from "@/lib/usePipelineEvIndex";
import {
  stashKalshiTradeForNavigation,
  stashTradeForNavigation,
  whaleTradeToKalshiFeedTrade,
} from "@/lib/tradeNavigationStore";
import type { WhaleTrade } from "@/lib/whaleTrades";
import { inferMarketCategory } from "@/lib/marketCategory";

const TOP_WHALE_COUNT = 10;

interface WhaleTrackerProps {
  whales: WhaleTrade[];
  connected: boolean;
  kalshiOk: boolean;
  soundEnabled: boolean;
  onToggleSound: () => void;
}

function secondsAgo(detectedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - detectedAt) / 1000));
}

function traderLabel(trade: WhaleTrade): string {
  if (trade.proxyWallet) {
    return `${trade.proxyWallet.slice(0, 6)}…${trade.proxyWallet.slice(-4)}`;
  }
  if (trade.source === "kalshi") return "Anonymous";
  return "Whale trader";
}

function traderInitials(trade: WhaleTrade): string {
  if (trade.proxyWallet) return trade.proxyWallet.slice(2, 4).toUpperCase();
  return trade.source === "kalshi" ? "K" : "W";
}

function formatStake(size: number): string {
  return `$${Math.round(size).toLocaleString("en-US")}`;
}

function resolveAvgEvDisplay(
  pipelineData: PipelineTradeEv | null | undefined,
  pipelineLoading: boolean,
  hasLookupKey: boolean
): { value: string; valueClass: string; loading: boolean } {
  if (!hasLookupKey) {
    return { value: "N/A", valueClass: "text-pulse-label", loading: false };
  }

  if (hasLookupKey && pipelineData == null && pipelineLoading) {
    return {
      value: "Calculating…",
      valueClass:
        "text-[10px] font-semibold uppercase tracking-wide text-pulse-muted animate-pulse",
      loading: true,
    };
  }

  if (!pipelineData) {
    return { value: "—", valueClass: "text-pulse-label", loading: false };
  }

  const netEvPercent = pipelineData.netEvPercent;
  if (
    pipelineData.status === "ok" &&
    netEvPercent !== null &&
    netEvPercent !== undefined
  ) {
    const displayPercent = Object.is(netEvPercent, -0) ? 0 : netEvPercent;
    return {
      value: formatEvPercent(displayPercent),
      valueClass:
        displayPercent > 0
          ? "text-pulse-yes"
          : displayPercent < -0.05
            ? "text-pulse-no"
            : "text-pulse-label",
      loading: false,
    };
  }

  if (pipelineData.status === "unmapped") {
    return { value: "—", valueClass: "text-pulse-label", loading: false };
  }

  return { value: "—", valueClass: "text-pulse-label", loading: false };
}

function AvgEvStatCell({
  avgEv,
}: {
  avgEv: ReturnType<typeof resolveAvgEvDisplay>;
}) {
  return (
    <div className="rounded-lg bg-pulse-surface px-3 py-2.5">
      <p className="pulse-label text-pulse-label">Avg. EV</p>
      {avgEv.loading ? (
        <span
          className={`mt-1 inline-flex rounded border border-pulse-border bg-pulse-card px-2 py-0.5 ${avgEv.valueClass}`}
        >
          {avgEv.value}
        </span>
      ) : (
        <p className={`mt-1 text-sm font-bold ${avgEv.valueClass}`}>
          {avgEv.value}
        </p>
      )}
    </div>
  );
}

function StatCell({
  label,
  value,
  valueClass = "text-white",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg bg-pulse-surface px-3 py-2.5">
      <p className="pulse-label text-pulse-label">{label}</p>
      <p className={`mt-1 text-sm font-bold ${valueClass}`}>{value}</p>
    </div>
  );
}

function WhaleFeedCard({
  trade,
  now,
  pipelineData,
  pipelineLoading,
}: {
  trade: WhaleTrade;
  now: number;
  pipelineData: PipelineTradeEv | null;
  pipelineLoading: boolean;
}) {
  const ageSec = secondsAgo(trade.detectedAt, now);
  const isKalshi = trade.source === "kalshi";
  const isBuy = isKalshi ? trade.outcome === "Yes" : trade.side === "BUY";
  const category = inferMarketCategory(trade.title);
  const platform = isKalshi ? "Kalshi" : "Polymarket";
  const marketId = trade.assetId ?? trade.ticker ?? trade.id;
  const lookupKey = pipelineEvKeyForWhale(trade);

  useEffect(() => {
    console.log("Card Market Data:", marketId, pipelineData);
  }, [marketId, pipelineData]);

  const avgEv = resolveAvgEvDisplay(
    pipelineData,
    pipelineLoading,
    lookupKey != null
  );

  const cardInner = (
    <article className="pulse-card p-4 transition-colors hover:border-pulse-muted">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-pulse-surface px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-pulse-muted">
            {category}
          </span>
          <span className="rounded bg-pulse-surface px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
            {platform}
          </span>
        </div>
        <span className="text-[11px] font-medium text-pulse-label">
          {ageSec}s
        </span>
      </div>

      <h3 className="text-sm font-bold uppercase leading-snug tracking-wide text-white">
        {trade.title}
      </h3>

      <div className="mt-4 flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-pulse-accent/20 text-xs font-bold text-pulse-accent">
          {traderInitials(trade)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">
            {traderLabel(trade)}
          </p>
          {!isKalshi && (
            <p className="text-[10px] font-semibold uppercase tracking-wide text-pulse-yes">
              Whale · ≥$500
            </p>
          )}
        </div>
        {!isKalshi && (
          <BookmarkTraderButton
            wallet={trade.proxyWallet}
            txHash={trade.transactionHash}
            assetId={trade.assetId}
            trade={trade}
            size="sm"
          />
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-pulse-muted">
          Backing {trade.outcome}
        </p>
        <span
          className={`text-[11px] font-bold uppercase tracking-wider ${
            isBuy ? "text-pulse-yes" : "text-pulse-no"
          }`}
        >
          {isKalshi ? trade.outcome : trade.side}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <StatCell
          label="Entry"
          value={`${(trade.price * 100).toFixed(0)}¢`}
        />
        <StatCell label="Now" value={`${(trade.price * 100).toFixed(0)}¢`} />
        <StatCell label="Stake" value={formatStake(trade.usdNotional)} />
        <AvgEvStatCell avgEv={avgEv} />
      </div>
    </article>
  );

  if (isKalshi) {
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
          className="block"
        >
          {cardInner}
        </Link>
      </li>
    );
  }

  return (
    <li>
      <Link
        href={`/whales/${encodeURIComponent(trade.transactionHash)}`}
        onClick={() => stashTradeForNavigation(trade)}
        className="block"
      >
        {cardInner}
      </Link>
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
  const { index: pipelineEvIndex, loading: pipelineEvLoading } =
    usePipelineEvForWhales(topWhales);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3 px-1">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-bold text-white">Whale Feed</h2>
          {connected && (
            <span className="rounded bg-pulse-yes/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-pulse-yes">
              Live
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onToggleSound}
          className="rounded-full border border-pulse-border bg-pulse-card px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-pulse-muted transition-colors hover:text-white"
        >
          {soundEnabled ? "Sound on" : "Sound off"}
        </button>
      </div>

      <PlatformFilterToggle value={platform} onChange={setPlatform} className="mb-4 px-1" />

      <p className="mb-4 px-1 text-[10px] uppercase tracking-wide text-pulse-label">
        {topWhales.length} of {whales.length} · {liveFeedPlatformLabel(platform)}
        {kalshiOk && platform !== "polymarket" ? " · +Kalshi" : ""}
      </p>

      {topWhales.length === 0 ? (
        <div className="pulse-card px-4 py-8 text-center">
          <p className="text-sm text-pulse-muted">
            {connected || kalshiOk
              ? "Watching for whale trades ≥ $500…"
              : "Connecting to live feed…"}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {topWhales.map((trade) => {
            const lookupKey = pipelineEvKeyForWhale(trade);
            return (
              <WhaleFeedCard
                key={
                  trade.source === "kalshi"
                    ? `kalshi:${trade.id}`
                    : trade.transactionHash || trade.id
                }
                trade={trade}
                now={now}
                pipelineLoading={pipelineEvLoading}
                pipelineData={
                  lookupKey ? pipelineEvIndex.get(lookupKey) ?? null : null
                }
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}
