import { NextResponse } from "next/server";
import { publicApiErrorMessage } from "@/lib/apiError";
import {
  collectPolymarketFeedCandidates,
  enrichPolymarketFeedTradesWithIdentity,
  filterTranslatablePolymarketFeedTrades,
} from "@/lib/feedQualificationServer";
import {
  MIN_FEED_TRADE_EV_PCT,
  resolvePolymarketTradeNotionalUsd,
} from "@/lib/feedQualification";
import { collectKalshiFeedCandidates } from "@/lib/feed/kalshiFeedCandidatesServer";
import {
  fetchFallbackFeedTrades,
  recordFeedTradeHistory,
} from "@/lib/feed/feedTradeHistory";
import { fetchWhaleBackfill } from "@/lib/polymarket";

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
  const kalshiTrades = await loadKalshiFeedCandidates();

  try {
    const trades = await fetchWhaleBackfill();
    const candidates = await collectPolymarketFeedCandidates(trades);
    const translatable = filterTranslatablePolymarketFeedTrades(candidates);
    const enriched = await enrichPolymarketFeedTradesWithIdentity(translatable);

    const qualified = enriched.filter(
      (trade) =>
        trade.netEvPercent != null &&
        Number.isFinite(trade.netEvPercent) &&
        trade.netEvPercent >= MIN_FEED_TRADE_EV_PCT
    );

    await recordFeedTradeHistory(
      qualified.map((trade) => ({
        id: trade.id,
        transactionHash: trade.transactionHash,
        proxyWallet: trade.proxyWallet,
        title: trade.title,
        timestamp: trade.timestamp,
        stakeAmountUsd: resolvePolymarketTradeNotionalUsd(trade),
        averageEvPercent: trade.averageEv ?? trade.netEvPercent!,
        payload: trade,
      }))
    );

    if (qualified.length > 0) {
      return NextResponse.json({
        trades: qualified,
        kalshiTrades,
        source: "live",
      });
    }

    const fallback = await fetchFallbackFeedTrades<(typeof enriched)[number]>();
    if (fallback.length > 0) {
      return NextResponse.json({
        trades: fallback,
        kalshiTrades,
        source: "history",
      });
    }

    return NextResponse.json({
      trades: qualified,
      kalshiTrades,
      source: "live",
    });
  } catch (error) {
    const message = publicApiErrorMessage(error, "Failed to fetch product feed");
    console.error("[api/feed]", error);
    return NextResponse.json(
      { trades: [], kalshiTrades, error: message },
      { status: 500 }
    );
  }
}
