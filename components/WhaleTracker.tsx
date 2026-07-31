"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import BookmarkTraderButton from "@/components/BookmarkTraderButton";
import PlatformFilterToggle from "@/components/PlatformFilterToggle";
import WinRatePill from "@/components/WinRatePill";
import { useLiveFeedPlatform } from "@/lib/LiveFeedPlatformContext";
import { liveFeedPlatformLabel } from "@/lib/liveFeedMerge";
import {
  formatWhaleSignedPercent,
  sanitizeWhaleDisplayName,
} from "@/lib/whaleIdentityResolver";
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

function formatStake(size: number): string {
  return `$${Math.round(size).toLocaleString("en-US")}`;
}

function formatResolvedBets(count: number | null | undefined): string {
  if (count == null || !Number.isFinite(count)) return "—";
  return count.toLocaleString("en-US");
}

function resolveFeedWhaleIdentity(trade: WhaleTrade) {
  const wallet = trade.proxyWallet ?? "unknown";
  const identity = trade.whaleIdentity;
  const pseudonym = sanitizeWhaleDisplayName(
    identity?.pseudonym ?? null,
    wallet
  );

  return {
    pseudonym,
    initials: identity?.initials ?? pseudonym.slice(0, 2).toUpperCase(),
    winRate: identity?.winRate ?? null,
    resolvedBetsCount: identity?.resolvedBetsCount ?? null,
    avgEvLabel: formatWhaleSignedPercent(identity?.avgEv ?? null),
    roiLabel: formatWhaleSignedPercent(identity?.roi ?? null),
    avgEvClass:
      identity?.avgEv != null && identity.avgEv >= 0
        ? "text-emerald-500 font-semibold"
        : identity?.avgEv != null
          ? "text-rose-500 font-semibold"
          : "text-pulse-label",
    roiClass:
      identity?.roi != null && identity.roi >= 0
        ? "text-emerald-500 font-semibold"
        : identity?.roi != null
          ? "text-rose-500 font-semibold"
          : "text-pulse-label",
  };
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

function tradeBookmarkKey(trade: WhaleTrade): string | undefined {
  if (trade.source === "kalshi") {
    return `kalshi:${trade.id}`;
  }
  return undefined;
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
}: {
  trade: WhaleTrade;
  now: number;
}) {
  const ageSec = secondsAgo(trade.detectedAt, now);
  const isKalshi = trade.source === "kalshi";
  const isBuy = isKalshi ? trade.outcome === "Yes" : trade.side === "BUY";
  const category = inferMarketCategory(trade.title);
  const platform = isKalshi ? "Kalshi" : "Polymarket";
  const detailHref = getWhaleTradeDetailHref(trade);
  const whale = resolveFeedWhaleIdentity(trade);

  const cardClassName =
    "pulse-card block p-4 transition-colors hover:border-pulse-accent/40 hover:bg-pulse-surface/40";

  const cardBody = (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-pulse-surface px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-pulse-muted">
            {category}
          </span>
          <span className="rounded bg-pulse-surface px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
            {platform}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[11px] font-medium text-pulse-label">
            {ageSec}s
          </span>
          <div
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <BookmarkTraderButton
              bookmarkKey={tradeBookmarkKey(trade)}
              wallet={trade.proxyWallet}
              txHash={trade.transactionHash || undefined}
              assetId={trade.assetId}
              trade={trade}
              label={whale.pseudonym}
              size="sm"
            />
          </div>
        </div>
      </div>

      <h3 className="text-sm font-bold uppercase leading-snug tracking-wide text-white">
        {trade.title}
      </h3>

      <div className="mt-4 flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-pulse-accent/20 text-xs font-bold text-pulse-accent">
          {whale.initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-white">
              {whale.pseudonym}
            </p>
            <WinRatePill winRate={whale.winRate} />
          </div>
          <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-pulse-label">
            {formatResolvedBets(whale.resolvedBetsCount)} resolved bets
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-pulse-muted">
            {trade.marketTranslation?.backingLabel ?? "Backing position"}
          </p>
          {trade.marketTranslation?.exitByLabel ? (
            <p className="mt-1 text-[10px] font-medium uppercase tracking-wide text-pulse-label">
              {trade.marketTranslation.exitByLabel}
            </p>
          ) : null}
        </div>
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
        <StatCell
          label="Avg. EV"
          value={whale.avgEvLabel}
          valueClass={whale.avgEvClass}
        />
        <StatCell
          label="ROI"
          value={whale.roiLabel}
          valueClass={whale.roiClass}
        />
        <StatCell
          label="Resolved"
          value={formatResolvedBets(whale.resolvedBetsCount)}
        />
      </div>

      {detailHref ? (
        <div className="mt-3 border-t border-pulse-border/60 pt-3">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-pulse-accent">
            View trade details →
          </span>
        </div>
      ) : null}
    </>
  );

  return (
    <li>
      {detailHref ? (
        <Link
          href={detailHref}
          onClick={() => stashTradeForDetailNavigation(trade)}
          className={`${cardClassName} cursor-pointer`}
        >
          {cardBody}
        </Link>
      ) : (
        <article className={cardClassName}>{cardBody}</article>
      )}
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
              ? "Watching for qualified whale trades ≥ $500…"
              : "Connecting to live feed…"}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {topWhales.map((trade) => (
            <WhaleFeedCard
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
  );
}
