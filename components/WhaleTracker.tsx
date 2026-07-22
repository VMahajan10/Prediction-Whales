"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import BookmarkTraderButton from "@/components/BookmarkTraderButton";
import PlatformFilterToggle from "@/components/PlatformFilterToggle";
import { useLiveFeedPlatform } from "@/lib/LiveFeedPlatformContext";
import { liveFeedPlatformLabel } from "@/lib/liveFeedMerge";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { pipelineEvKeyForWhale, resolvePipelineEvForWhale } from "@/lib/pipelineEvClient";
import { usePipelineEvForWhales } from "@/lib/usePipelineEvIndex";
import {
  stashKalshiTradeForNavigation,
  stashTradeForNavigation,
  whaleTradeToKalshiFeedTrade,
} from "@/lib/tradeNavigationStore";
import type { WhaleTrade } from "@/lib/whaleTrades";
import { inferMarketCategory } from "@/lib/marketCategory";
import { formatEvPercent } from "@/lib/crossMarketEvDisplay";
import {
  coalesceDisplayEvPercent,
  hasAuthoritativePipelineEv,
  pipelineEvTone,
  resolveDetailPanelDisplayEv,
} from "@/lib/evPipeline/tradeEvRecord";

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

function getWhaleTradeDetailHref(trade: WhaleTrade): string | null {
  if (trade.source === "kalshi") {
    return trade.ticker != null
      ? `/trades/kalshi/${encodeURIComponent(trade.id)}?ticker=${encodeURIComponent(trade.ticker)}`
      : `/trades/kalshi/${encodeURIComponent(trade.id)}`;
  }

  const tradeKey = trade.transactionHash || trade.id;
  return tradeKey ? `/trades/${encodeURIComponent(tradeKey)}` : null;
}

function stashTradeForDetailNavigation(trade: WhaleTrade): void {
  if (trade.source === "kalshi") {
    const feedTrade = whaleTradeToKalshiFeedTrade(trade);
    if (feedTrade) stashKalshiTradeForNavigation(feedTrade);
    return;
  }

  stashTradeForNavigation(trade);
}

function precomputedEvPercent(
  trade: WhaleTrade,
  pipelineData: PipelineTradeEv | null | undefined,
  hasLookupKey: boolean
): { netEvPercent: number; lowConfidence: boolean } | null {
  const fromPipeline = resolveDetailPanelDisplayEv(pipelineData, trade.price);
  if (fromPipeline) {
    return {
      netEvPercent: fromPipeline.netEvPercent,
      lowConfidence: fromPipeline.lowConfidence,
    };
  }

  if (hasLookupKey && !pipelineData) {
    return null;
  }

  const fromTrade = coalesceDisplayEvPercent({
    netEvPercent: trade.netEvPercent ?? null,
    grossEvPercent: trade.grossEvPercent ?? null,
    averageEv: trade.averageEv ?? null,
  });
  if (fromTrade != null) {
    return { netEvPercent: fromTrade, lowConfidence: false };
  }

  return null;
}

function formatEvPercentDisplay(
  netEvPercent: number,
  lowConfidence = false
): {
  value: string;
  valueClass: string;
} {
  const formatted = formatEvPercent(netEvPercent);
  const value = lowConfidence ? `~${formatted}` : formatted;
  const { positive, negative } = pipelineEvTone(netEvPercent);
  const valueClass = positive
    ? "text-emerald-500 font-semibold"
    : negative
      ? "text-rose-500 font-semibold"
      : "text-pulse-label";

  return { value, valueClass };
}

function resolveAvgEvDisplay(
  trade: WhaleTrade,
  pipelineData: PipelineTradeEv | null | undefined,
  hasLookupKey: boolean,
  pipelineLoading = false
): { value: string; valueClass: string; lowConfidence: boolean } {
  if (!hasLookupKey) {
    return { value: "N/A", valueClass: "text-pulse-label", lowConfidence: false };
  }

  if (pipelineData?.status === "unmapped") {
    return { value: "—", valueClass: "text-pulse-label", lowConfidence: false };
  }

  if (
    pipelineLoading &&
    !hasAuthoritativePipelineEv(pipelineData) &&
    !resolveDetailPanelDisplayEv(pipelineData, trade.price)
  ) {
    return {
      value: "…",
      valueClass: "text-zinc-500 animate-pulse",
      lowConfidence: false,
    };
  }

  const ev = precomputedEvPercent(trade, pipelineData, hasLookupKey);
  if (ev != null) {
    return {
      ...formatEvPercentDisplay(ev.netEvPercent, ev.lowConfidence),
      lowConfidence: ev.lowConfidence,
    };
  }

  return { value: "—", valueClass: "text-pulse-label", lowConfidence: false };
}

function AvgEvStatCell({
  avgEv,
}: {
  avgEv: ReturnType<typeof resolveAvgEvDisplay>;
}) {
  return (
    <div className="rounded-lg bg-pulse-surface px-3 py-2.5">
      <p className="pulse-label text-pulse-label">Avg. EV</p>
      <p className={`mt-1 text-sm font-bold ${avgEv.valueClass}`}>
        {avgEv.value}
        {avgEv.lowConfidence ? (
          <span className="ml-1 text-[9px] font-semibold uppercase text-amber-400/90">
            est
          </span>
        ) : null}
      </p>
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
  const router = useRouter();
  const ageSec = secondsAgo(trade.detectedAt, now);
  const isKalshi = trade.source === "kalshi";
  const isBuy = isKalshi ? trade.outcome === "Yes" : trade.side === "BUY";
  const category = inferMarketCategory(trade.title);
  const platform = isKalshi ? "Kalshi" : "Polymarket";
  const lookupKey = pipelineEvKeyForWhale(trade);
  const detailHref = getWhaleTradeDetailHref(trade);

  const avgEv = resolveAvgEvDisplay(
    trade,
    pipelineData,
    lookupKey != null,
    pipelineLoading
  );

  const navigateToDetail = () => {
    if (!detailHref) return;
    stashTradeForDetailNavigation(trade);
    router.push(detailHref);
  };

  const cardInner = (
    <article
      className={`pulse-card p-4 transition-colors ${
        detailHref
          ? "cursor-pointer hover:border-pulse-accent/40 hover:bg-pulse-surface/40"
          : ""
      }`}
      onClick={detailHref ? navigateToDetail : undefined}
      onKeyDown={
        detailHref
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                navigateToDetail();
              }
            }
          : undefined
      }
      role={detailHref ? "link" : undefined}
      tabIndex={detailHref ? 0 : undefined}
    >
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
        <div onClick={(event) => event.stopPropagation()}>
          <BookmarkTraderButton
            wallet={trade.proxyWallet}
            txHash={trade.transactionHash}
            assetId={trade.assetId}
            trade={trade}
            size="sm"
          />
        </div>
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

      {detailHref ? (
        <div
          className="mt-3 border-t border-pulse-border/60 pt-3"
          onClick={(event) => event.stopPropagation()}
        >
          <Link
            href={detailHref}
            onClick={() => stashTradeForDetailNavigation(trade)}
            className="text-[11px] font-semibold uppercase tracking-wide text-pulse-accent hover:text-white"
          >
            View trade details →
          </Link>
        </div>
      ) : null}
    </article>
  );

  return <li>{cardInner}</li>;
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
  const { index: pipelineEvIndex, loading: pipelineLoading } =
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
                pipelineData={resolvePipelineEvForWhale(pipelineEvIndex, trade)}
                pipelineLoading={pipelineLoading}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}
