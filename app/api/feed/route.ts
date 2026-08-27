import { NextResponse } from "next/server";
import { publicApiErrorMessage } from "@/lib/apiError";
import {
  collectPolymarketFeedCandidates,
  enrichPolymarketFeedTradesWithIdentity,
  filterTranslatablePolymarketFeedTrades,
  qualifyWalletsForFeed,
} from "@/lib/feedQualificationServer";
import {
  meetsProductFeedEvThreshold,
  resolvePolymarketTradeNotionalUsd,
} from "@/lib/feedQualification";
import { collectKalshiFeedCandidates } from "@/lib/feed/kalshiFeedCandidatesServer";
import { FeedRouteTimer } from "@/lib/feed/feedRouteTiming";
import {
  fetchFallbackFeedTrades,
  recordFeedTradeHistory,
} from "@/lib/feed/feedTradeHistory";
import { fetchWhaleBackfill } from "@/lib/polymarket";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function loadKalshiFeedCandidates() {
  try {
    return await collectKalshiFeedCandidates();
  } catch (kalshiErr) {
    console.warn(
      "[api/feed] Kalshi candidate fetch failed:",
      kalshiErr instanceof Error ? kalshiErr.message : kalshiErr
    );
    return [];
  }
}

/** Credibility-qualified product feed — Polymarket whales + transient Kalshi candidates. */
export async function GET() {
  const timer = new FeedRouteTimer();

  const [kalshiTrades, trades] = await Promise.all([
    loadKalshiFeedCandidates(),
    fetchWhaleBackfill(),
  ]);
  timer.mark("venuesFetched");

  try {
    const walletAddresses = trades
      .map((trade) => trade.proxyWallet?.trim().toLowerCase())
      .filter((wallet): wallet is string => Boolean(wallet));
    const walletQualifications = await qualifyWalletsForFeed(walletAddresses);
    timer.mark("walletQualification");

    const candidates = await collectPolymarketFeedCandidates(trades, {
      walletQualifications,
    });
    timer.mark("polymarketCandidates");

    const translatable = filterTranslatablePolymarketFeedTrades(candidates);
    timer.mark("marketTranslation");

    const enriched = await enrichPolymarketFeedTradesWithIdentity(translatable, {
      walletQualifications,
    });
    timer.mark("identityEnrichment");

    const qualified = enriched.filter((trade) =>
      meetsProductFeedEvThreshold(trade.netEvPercent)
    );
    timer.mark("merge");

    void recordFeedTradeHistory(
      qualified.map((trade) => ({
        id: trade.id,
        transactionHash: trade.transactionHash,
        proxyWallet: trade.proxyWallet,
        title: trade.title,
        timestamp: trade.timestamp,
        stakeAmountUsd: resolvePolymarketTradeNotionalUsd(trade),
        averageEvPercent: trade.averageEv ?? trade.netEvPercent!,
        payload: trade,
      })),
      { walletQualifications }
    );

    const timing = timer.breakdown();
    logger.debugForPath("/api/feed", "[api/feed] timing", timing);

    if (qualified.length > 0) {
      return NextResponse.json({
        trades: qualified,
        kalshiTrades,
        source: "live",
        timing,
      });
    }

    const fallback = await fetchFallbackFeedTrades<(typeof enriched)[number]>();
    timer.mark("feedHistoryFallback");
    logger.debugForPath("/api/feed", "[api/feed] timing", timer.breakdown());

    if (fallback.length > 0) {
      return NextResponse.json({
        trades: fallback,
        kalshiTrades,
        source: "history",
        timing: timer.breakdown(),
      });
    }

    return NextResponse.json({
      trades: qualified,
      kalshiTrades,
      source: "live",
      timing: timer.breakdown(),
    });
  } catch (error) {
    const message = publicApiErrorMessage(error, "Failed to fetch product feed");
    console.error("[api/feed]", error, timer.breakdown());
    return NextResponse.json(
      { trades: [], kalshiTrades, error: message, timing: timer.breakdown() },
      { status: 500 }
    );
  }
}
