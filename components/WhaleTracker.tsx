"use client";

import { useEffect, useMemo, useState } from "react";
import WhaleFeedCard from "@/components/WhaleFeedCard";
import WhaleFeedCategoryTabs from "@/components/WhaleFeedCategoryTabs";
import WhaleFeedPlatformFilter from "@/components/WhaleFeedPlatformFilter";
import type { LiveFeedPlatform } from "@/lib/liveFeedPlatform";
import { filterFeedByPlatform } from "@/lib/liveFeedMerge";
import {
  matchesWhaleFeedCategory,
  type WhaleFeedCategoryTab,
  whaleFeedCategoryLabel,
} from "@/lib/whaleFeedCategories";
import {
  stashKalshiTradeForNavigation,
  stashTradeForNavigation,
  whaleTradeToKalshiFeedTrade,
} from "@/lib/tradeNavigationStore";
import {
  formatProductFeedStakeLabel,
  MIN_FEED_TRADE_EV_PCT,
} from "@/lib/feedQualification";
import type { WhaleTrade } from "@/lib/whaleTrades";

const TOP_WHALE_COUNT = 20;

interface WhaleTrackerProps {
  whales: WhaleTrade[];
  connected: boolean;
  kalshiOk: boolean;
  backfillLoaded: boolean;
  soundEnabled: boolean;
  onToggleSound: () => void;
}

function getWhaleTradeDetailHref(trade: WhaleTrade): string | null {
  if (trade.source === "kalshi") {
    const base = `/whales/kalshi/${encodeURIComponent(trade.id)}`;
    return trade.ticker != null
      ? `${base}?ticker=${encodeURIComponent(trade.ticker)}`
      : base;
  }

  const tradeKey = trade.transactionHash || trade.id;
  return tradeKey ? `/whales/${encodeURIComponent(tradeKey)}` : null;
}

function stashTradeForDetailNavigation(trade: WhaleTrade): void {
  if (trade.source === "kalshi") {
    const feedTrade = whaleTradeToKalshiFeedTrade(trade);
    if (feedTrade) stashKalshiTradeForNavigation(feedTrade);
    return;
  }

  stashTradeForNavigation(trade);
}

export default function WhaleTracker({
  whales,
  connected,
  kalshiOk,
  backfillLoaded,
  soundEnabled,
  onToggleSound,
}: WhaleTrackerProps) {
  const [categoryTab, setCategoryTab] = useState<WhaleFeedCategoryTab>("all");
  const [platformFilter, setPlatformFilter] = useState<LiveFeedPlatform>("all");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const filteredWhales = useMemo(() => {
    const byPlatform = filterFeedByPlatform(whales, platformFilter);
    return byPlatform.filter((trade) =>
      matchesWhaleFeedCategory(trade, categoryTab, now)
    );
  }, [whales, platformFilter, categoryTab, now]);

  const sortedWhales = useMemo(() => {
    const rows = [...filteredWhales];
    if (categoryTab === "trending") {
      rows.sort((a, b) => b.usdNotional - a.usdNotional);
    }
    return rows.slice(0, TOP_WHALE_COUNT);
  }, [filteredWhales, categoryTab]);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3 px-1">
        <div className="flex items-center gap-2">
          <span className="text-lg" aria-hidden>
            🐋
          </span>
          <h2 className="text-lg font-bold text-white">Whale Feed</h2>
        </div>
        <div className="flex items-center gap-2">
          {connected ? (
            <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-pulse-yes">
              <span className="h-1.5 w-1.5 rounded-full bg-pulse-yes" />
              Live
            </span>
          ) : null}
          <button
            type="button"
            onClick={onToggleSound}
            className="rounded-full border border-pulse-border bg-pulse-card px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-pulse-muted transition-colors hover:text-white"
            aria-label={soundEnabled ? "Mute whale alerts" : "Enable whale alert sounds"}
          >
            {soundEnabled ? "🔊" : "🔇"}
          </button>
        </div>
      </div>

      <WhaleFeedCategoryTabs
        value={categoryTab}
        onChange={setCategoryTab}
        className="mb-3 px-1"
      />

      <WhaleFeedPlatformFilter
        value={platformFilter}
        onChange={setPlatformFilter}
        className="mb-4 px-1"
      />

      <p className="mb-4 px-1 text-[10px] uppercase tracking-wide text-pulse-label">
        {sortedWhales.length} of {filteredWhales.length} ·{" "}
        {whaleFeedCategoryLabel(categoryTab)}
        {platformFilter !== "all"
          ? ` · ${platformFilter === "kalshi" ? "Kalshi" : "Polymarket"}`
          : ""}
      </p>

      {sortedWhales.length === 0 ? (
        <div className="pulse-card rounded-2xl px-4 py-8 text-center">
          <p className="text-sm text-pulse-muted">
            {!backfillLoaded
              ? "Loading recent whale trades…"
              : platformFilter === "kalshi"
                ? kalshiOk
                  ? `Watching for qualified Kalshi flow (+${MIN_FEED_TRADE_EV_PCT}% trade EV · ${formatProductFeedStakeLabel()}). Kalshi is anonymous market flow — live only, no history.`
                  : "Kalshi feed unavailable — retrying…"
                : connected || kalshiOk
                  ? `Watching for qualified whale trades (+${MIN_FEED_TRADE_EV_PCT}% trade EV · ${formatProductFeedStakeLabel()})…`
                  : "Connecting to live feed…"}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {sortedWhales.map((trade) => {
            const detailHref = getWhaleTradeDetailHref(trade);
            return (
              <li key={
                trade.source === "kalshi"
                  ? `kalshi:${trade.id}`
                  : trade.transactionHash || trade.id
              }>
                <WhaleFeedCard
                  trade={trade}
                  now={now}
                  detailHref={detailHref}
                  onNavigate={() => stashTradeForDetailNavigation(trade)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
