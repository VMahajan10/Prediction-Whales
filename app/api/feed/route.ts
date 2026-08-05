import { NextResponse } from "next/server";
import {
  collectPolymarketFeedCandidates,
  enrichPolymarketFeedTradesWithIdentity,
  filterTranslatablePolymarketFeedTrades,
} from "@/lib/feedQualificationServer";
import { resolvePolymarketTradeNotionalUsd } from "@/lib/feedQualification";
import { collectKalshiFeedCandidates } from "@/lib/feed/kalshiFeedCandidatesServer";
import {
  fetchFallbackFeedTrades,
  recordFeedTradeHistory,
} from "@/lib/feed/feedTradeHistory";
import { fetchWhaleBackfill } from "@/lib/polymarket";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Credibility-qualified product feed — Polymarket whales only (feed v1 / OQ-2). */
export async function GET() {
  try {
    const trades = await fetchWhaleBackfill();
    const candidates = await collectPolymarketFeedCandidates(trades);
    const translatable = filterTranslatablePolymarketFeedTrades(candidates);
    const enriched = await enrichPolymarketFeedTradesWithIdentity(translatable);

    const renderable = enriched.filter(
      (trade) =>
        trade.netEvPercent != null && Number.isFinite(trade.netEvPercent)
    );

    await recordFeedTradeHistory(
      renderable.map((trade) => ({
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

    if (renderable.length > 0) {
      let kalshiTrades: Awaited<ReturnType<typeof collectKalshiFeedCandidates>> =
        [];
      try {
        kalshiTrades = await collectKalshiFeedCandidates();
      } catch (kalshiErr) {
        console.warn(
          "[api/feed] Kalshi candidate fetch failed:",
          kalshiErr instanceof Error ? kalshiErr.message : kalshiErr
        );
      }
      return NextResponse.json({
        trades: enriched,
        kalshiTrades,
        source: "live",
      });
    }

    const fallback = await fetchFallbackFeedTrades<(typeof enriched)[number]>();
    if (fallback.length > 0) {
      return NextResponse.json({ trades: fallback, source: "history" });
    }

    let kalshiTrades: Awaited<ReturnType<typeof collectKalshiFeedCandidates>> =
      [];
    try {
      kalshiTrades = await collectKalshiFeedCandidates();
    } catch (kalshiErr) {
      console.warn(
        "[api/feed] Kalshi candidate fetch failed:",
        kalshiErr instanceof Error ? kalshiErr.message : kalshiErr
      );
    }

    return NextResponse.json({
      trades: enriched,
      kalshiTrades,
      source: "live",
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch product feed";
    console.error("[api/feed]", message);
    return NextResponse.json({ trades: [], error: message }, { status: 500 });
  }
}
