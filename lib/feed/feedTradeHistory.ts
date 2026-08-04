import "server-only";

import { and, desc, gte, lt, sql } from "drizzle-orm";
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

export {
  buildFeedTradeRow,
  FALLBACK_LIMIT,
  isRecordableFeedTrade,
  type FeedTradeHistoryInput,
} from "@/lib/feed/feedTradeHistoryCore";

/** History older than this is pruned; the feed is a recency product. */
const RETENTION_MS = 24 * 60 * 60 * 1000;

/** Best-effort — the feed response must never fail because history write failed. */
export async function recordFeedTradeHistory(
  trades: FeedTradeHistoryInput[]
): Promise<void> {
  if (!isDatabaseEnabled()) return;
  const rows = trades.filter(isRecordableFeedTrade).map(buildFeedTradeRow);
  if (rows.length === 0) return;

  try {
    await getDb()
      .insert(feedTrades)
      .values(rows)
      .onConflictDoUpdate({
        target: feedTrades.tradeId,
        set: {
          stakeAmount: sql`excluded.stake_amount`,
          averageEv: sql`excluded.average_ev`,
          payload: sql`excluded.payload`,
          updatedAt: sql`now()`,
        },
      });

    await getDb()
      .delete(feedTrades)
      .where(lt(feedTrades.tradedAt, new Date(Date.now() - RETENTION_MS)));
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
      .select({ payload: feedTrades.payload })
      .from(feedTrades)
      .where(
        and(
          gte(feedTrades.stakeAmount, MIN_PRODUCT_FEED_STAKE_USD),
          gte(feedTrades.averageEv, MIN_FEED_TRADE_EV_PCT)
        )
      )
      .orderBy(desc(feedTrades.tradedAt))
      .limit(limit);

    return rows.map((row) => row.payload as T);
  } catch (error) {
    console.error(
      "[feedTradeHistory] fallback read failed",
      error instanceof Error ? error.message : error
    );
    return [];
  }
}
