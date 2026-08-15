import "server-only";

import { and, desc, gte, sql } from "drizzle-orm";
import {
  MIN_FEED_TRADE_EV_PCT,
  MIN_PRODUCT_FEED_STAKE_USD,
} from "@/lib/feedQualification";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { feedTrades } from "@/lib/crossmarket/store/schema";
import {
  buildFeedTradeRow,
  FALLBACK_LIMIT,
  isRecordableFeedTrade,
  type FeedTradeHistoryInput,
} from "@/lib/feed/feedTradeHistoryCore";
import { qualifyWalletsForFeed } from "@/lib/feedQualificationServer";

export {
  buildFeedTradeRow,
  FALLBACK_LIMIT,
  isRecordableFeedTrade,
  type FeedTradeHistoryInput,
} from "@/lib/feed/feedTradeHistoryCore";

async function filterRecordableByTraderCredibility(
  trades: FeedTradeHistoryInput[]
): Promise<FeedTradeHistoryInput[]> {
  const wallets = trades
    .map((trade) => trade.proxyWallet?.trim().toLowerCase())
    .filter((wallet): wallet is string => Boolean(wallet));

  if (wallets.length === 0) return [];

  const qualifications = await qualifyWalletsForFeed(wallets);

  return trades.filter((trade) => {
    const wallet = trade.proxyWallet?.trim().toLowerCase();
    if (!wallet) return false;
    return qualifications[wallet]?.qualified === true;
  });
}

/** Best-effort — the feed response must never fail because history write failed. */
export async function recordFeedTradeHistory(
  trades: FeedTradeHistoryInput[]
): Promise<void> {
  if (!isDatabaseEnabled()) return;
  const recordable = trades.filter(isRecordableFeedTrade);
  if (recordable.length === 0) return;

  const credible = await filterRecordableByTraderCredibility(recordable);
  if (credible.length === 0) return;

  const { categorizeMarket } = await import("@/lib/categorizer");

  const rows = await Promise.all(
    credible.map(async (trade) => {
      const payload =
        trade.payload && typeof trade.payload === "object"
          ? (trade.payload as Record<string, unknown>)
          : null;
      const eventSlug =
        typeof payload?.eventSlug === "string"
          ? payload.eventSlug
          : typeof payload?.slug === "string"
            ? payload.slug
            : undefined;

      const category =
        trade.category ??
        (await categorizeMarket(trade.title, eventSlug, {
          backfillDb: true,
          marketKey: eventSlug,
        }));

      return buildFeedTradeRow({ ...trade, category });
    })
  );

  try {
    await getDb()
      .insert(feedTrades)
      .values(rows)
      .onConflictDoUpdate({
        target: feedTrades.tradeId,
        set: {
          stakeAmount: sql`excluded.stake_amount`,
          averageEv: sql`excluded.average_ev`,
          category: sql`excluded.category`,
          payload: sql`excluded.payload`,
          updatedAt: sql`now()`,
        },
      });
  } catch (error) {
    console.error(
      "[feedTradeHistory] write failed",
      error instanceof Error ? error.message : error
    );
  }
}

/** Latest qualifying product-feed history, replayed in the live candidate shape. */
export async function fetchFallbackFeedTrades<T>(
  limit = FALLBACK_LIMIT
): Promise<T[]> {
  if (!isDatabaseEnabled()) return [];

  try {
    const rows = await getDb()
      .select({
        payload: feedTrades.payload,
        proxyWallet: feedTrades.proxyWallet,
      })
      .from(feedTrades)
      .where(
        and(
          gte(feedTrades.stakeAmount, MIN_PRODUCT_FEED_STAKE_USD),
          gte(feedTrades.averageEv, MIN_FEED_TRADE_EV_PCT)
        )
      )
      .orderBy(desc(feedTrades.tradedAt))
      .limit(limit * 3);

    const wallets = rows
      .map((row) => row.proxyWallet?.trim().toLowerCase())
      .filter((wallet): wallet is string => Boolean(wallet));
    const qualifications = await qualifyWalletsForFeed(wallets);

    const payloads: T[] = [];
    for (const row of rows) {
      const wallet = row.proxyWallet?.trim().toLowerCase();
      if (!wallet || !qualifications[wallet]?.qualified) continue;
      payloads.push(row.payload as T);
      if (payloads.length >= limit) break;
    }

    return payloads;
  } catch (error) {
    console.error(
      "[feedTradeHistory] fallback read failed",
      error instanceof Error ? error.message : error
    );
    return [];
  }
}
