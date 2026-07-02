"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import BookmarkTraderButton from "@/components/BookmarkTraderButton";
import PlatformFilterToggle from "@/components/PlatformFilterToggle";
import { useLiveFeedPlatform } from "@/lib/LiveFeedPlatformContext";
import { liveFeedPlatformLabel } from "@/lib/liveFeedMerge";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { normalizeIncomingTradePrice } from "@/lib/evPipeline/tradeEvRecord";
import { pipelineEvKeyForWhale } from "@/lib/pipelineEvClient";
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
  isPairedPipelineTrade,
  TradeArbitrageSection,
} from "@/components/ArbitrageBoxSpreadMatrix";

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

function parseExecutionPrice(raw: unknown): number | null {
  if (raw == null) return null;

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    const centsMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*¢$/);
    if (centsMatch) {
      const cents = parseFloat(centsMatch[1]);
      if (Number.isFinite(cents) && cents > 0) return cents / 100;
    }
  }

  return normalizeIncomingTradePrice(raw) ?? null;
}

function whaleExecutionPrice(trade: WhaleTrade): number | null {
  return parseExecutionPrice(trade.price);
}

function pipelineMidsMissing(
  pipelineData: PipelineTradeEv
): boolean {
  const ext = pipelineData as PipelineTradeEv & {
    pmMid?: unknown;
    kalshiMid?: unknown;
  };
  return ext.pmMid === undefined || ext.kalshiMid === undefined;
}

function shouldUseLocalEvFallback(pipelineData: PipelineTradeEv): boolean {
  return (
    pipelineData.netEvPercent === 0 ||
    pipelineData.netEvPercent == null ||
    pipelineMidsMissing(pipelineData)
  );
}

function formatEvPercentDisplay(netEvPercent: number): {
  value: string;
  valueClass: string;
  loading: false;
} {
  const normalized = Object.is(netEvPercent, -0) ? 0 : netEvPercent;
  const isPositive = normalized > 0;
  const formatted = `${isPositive ? "+" : ""}${normalized.toFixed(1)}%`;
  const valueClass = isPositive
    ? "text-emerald-500 font-semibold"
    : normalized < 0
      ? "text-rose-500 font-semibold"
      : "text-pulse-label";

  return { value: formatted, valueClass, loading: false };
}

function resolveAvgEvDisplay(
  pipelineData: PipelineTradeEv | null | undefined,
  pipelineLoading: boolean,
  hasLookupKey: boolean,
  executionPrice: number | null
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

  if (pipelineData.status === "unmapped") {
    return { value: "—", valueClass: "text-pulse-label", loading: false };
  }

  if (pipelineData.status === "ok") {
    const pTrue = pipelineData.pTrue;
    const hasValidPTrue =
      typeof pTrue === "number" && Number.isFinite(pTrue);
    const hasValidExecutionPrice =
      executionPrice != null && Number.isFinite(executionPrice);

    if (
      shouldUseLocalEvFallback(pipelineData) &&
      hasValidPTrue &&
      hasValidExecutionPrice
    ) {
      const localEvPercent = (pTrue - executionPrice) * 100;
      return formatEvPercentDisplay(localEvPercent);
    }

    if (typeof pipelineData.netEvPercent === "number") {
      return formatEvPercentDisplay(pipelineData.netEvPercent);
    }

    if (hasValidPTrue && hasValidExecutionPrice) {
      const localEvPercent = (pTrue - executionPrice) * 100;
      return formatEvPercentDisplay(localEvPercent);
    }
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

function fairVenueLabel(trade: WhaleTrade): string {
  return trade.source === "polymarket" ? "Kalshi" : "Polymarket";
}

function ExpandedEvBreakdown({
  trade,
  pipelineData,
  avgEv,
}: {
  trade: WhaleTrade;
  pipelineData: PipelineTradeEv | null;
  avgEv: ReturnType<typeof resolveAvgEvDisplay>;
}) {
  if (!isPairedPipelineTrade(pipelineData) || avgEv.loading) return null;

  const netEvPercent =
    pipelineData?.netEvPercent ??
    (pipelineData?.pTrue != null && whaleExecutionPrice(trade) != null
      ? (pipelineData.pTrue - whaleExecutionPrice(trade)!) * 100
      : null);

  const evLabel =
    netEvPercent != null && Number.isFinite(netEvPercent)
      ? formatEvPercent(netEvPercent)
      : avgEv.value;

  return (
    <div className="mt-3 rounded-md border border-pulse-border bg-pulse-surface/60 px-3 py-2.5">
      <p className={`text-sm font-semibold ${avgEv.valueClass}`}>{evLabel} EV</p>
      <p className="mt-0.5 text-xs text-zinc-500">
        vs {fairVenueLabel(trade)} price on the same game
      </p>
    </div>
  );
}

function WhaleFeedCard({
  trade,
  now,
  pipelineData,
  pipelineLoading,
  expandedCardId,
  setExpandedCardId,
}: {
  trade: WhaleTrade;
  now: number;
  pipelineData: PipelineTradeEv | null;
  pipelineLoading: boolean;
  expandedCardId: string | null;
  setExpandedCardId: (id: string | null) => void;
}) {
  const ageSec = secondsAgo(trade.detectedAt, now);
  const isKalshi = trade.source === "kalshi";
  const isBuy = isKalshi ? trade.outcome === "Yes" : trade.side === "BUY";
  const category = inferMarketCategory(trade.title);
  const platform = isKalshi ? "Kalshi" : "Polymarket";
  const lookupKey = pipelineEvKeyForWhale(trade);
  const isExpanded = expandedCardId === trade.id;
  const isPaired = isPairedPipelineTrade(pipelineData);

  const executionPrice = whaleExecutionPrice(trade);

  const avgEv = resolveAvgEvDisplay(
    pipelineData,
    pipelineLoading,
    lookupKey != null,
    executionPrice
  );

  const cardInner = (
    <article
      className={`pulse-card cursor-pointer p-4 transition-colors hover:border-pulse-muted ${
        isExpanded ? "border-pulse-accent/50" : ""
      }`}
      onClick={() =>
        setExpandedCardId(isExpanded ? null : trade.id)
      }
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setExpandedCardId(isExpanded ? null : trade.id);
        }
      }}
      role="button"
      tabIndex={0}
      aria-expanded={isExpanded}
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
        {!isKalshi && (
          <div onClick={(event) => event.stopPropagation()}>
            <BookmarkTraderButton
              wallet={trade.proxyWallet}
              txHash={trade.transactionHash}
              assetId={trade.assetId}
              trade={trade}
              size="sm"
            />
          </div>
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

      {isExpanded ? (
        <div onClick={(event) => event.stopPropagation()}>
          {isPaired ? (
            <ExpandedEvBreakdown
              trade={trade}
              pipelineData={pipelineData}
              avgEv={avgEv}
            />
          ) : null}
          <TradeArbitrageSection
            pipelineData={pipelineData}
            pipelineLoading={pipelineLoading}
            tradeLinks={{
              eventSlug: trade.eventSlug,
              slug: trade.slug,
            }}
            className="mt-3"
            enabled={isExpanded}
          />
        </div>
      ) : null}

      <div
        className="mt-3 border-t border-pulse-border/60 pt-3"
        onClick={(event) => event.stopPropagation()}
      >
        <DetailLink trade={trade} />
      </div>
    </article>
  );

  return <li>{cardInner}</li>;
}

function DetailLink({ trade }: { trade: WhaleTrade }) {
  const isKalshi = trade.source === "kalshi";

  if (isKalshi) {
    const feedTrade = whaleTradeToKalshiFeedTrade(trade);
    const href =
      trade.ticker != null
        ? `/trades/kalshi/${encodeURIComponent(trade.id)}?ticker=${encodeURIComponent(trade.ticker)}`
        : `/trades/kalshi/${encodeURIComponent(trade.id)}`;

    return (
      <Link
        href={href}
        onClick={() => {
          if (feedTrade) stashKalshiTradeForNavigation(feedTrade);
        }}
        className="text-[11px] font-semibold uppercase tracking-wide text-pulse-accent hover:text-white"
      >
        View trade details →
      </Link>
    );
  }

  return (
    <Link
      href={`/whales/${encodeURIComponent(trade.transactionHash)}`}
      onClick={() => stashTradeForNavigation(trade)}
      className="text-[11px] font-semibold uppercase tracking-wide text-pulse-accent hover:text-white"
    >
      View trade details →
    </Link>
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
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);

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
                expandedCardId={expandedCardId}
                setExpandedCardId={setExpandedCardId}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}
