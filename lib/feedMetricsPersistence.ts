import "server-only";

import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  feedDailyMetrics,
  feedDailyQualifiedWhales,
  type FeedMetricsVenue,
} from "@/lib/crossmarket/store/schema";
import {
  feedMetricsDayKeyUtc,
  normalizeFeedMetricVenue,
  normalizeFeedMetricWallets,
  type FeedDailyMetricsSnapshot,
  type FeedMetricsPersistInput,
} from "@/lib/feedMetricsCore";

export type {
  FeedDailyMetricsSnapshot,
  FeedMetricsPersistInput,
} from "@/lib/feedMetricsCore";

export interface GetFeedDailyMetricsOptions {
  dayKey?: string;
  venue?: FeedMetricsVenue;
  fromDayKey?: string;
  toDayKey?: string;
}

function buildPersistPayload(input: FeedMetricsPersistInput) {
  const venue = normalizeFeedMetricVenue(input.venue);
  const dayKey = input.dayKey ?? feedMetricsDayKeyUtc();
  const tradesDetected = Math.max(0, input.tradesDetected ?? 0);
  const gatePassedTrades = Math.max(0, input.gatePassedTrades ?? 0);
  const whaleWallets = normalizeFeedMetricWallets(input.whaleWallets);

  return {
    venue,
    dayKey,
    tradesDetected,
    gatePassedTrades,
    whaleWallets,
  };
}

async function refreshDistinctWhaleCount(
  dayKey: string,
  venue: FeedMetricsVenue
): Promise<void> {
  const db = getDb();
  await db
    .update(feedDailyMetrics)
    .set({
      distinctWhales: sql`(
        SELECT COUNT(*)::int
        FROM ${feedDailyQualifiedWhales}
        WHERE ${feedDailyQualifiedWhales.dayKey} = ${dayKey}
          AND ${feedDailyQualifiedWhales.venue} = ${venue}
      )`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(feedDailyMetrics.dayKey, dayKey),
        eq(feedDailyMetrics.venue, venue)
      )
    );
}

/** Atomically increment daily counters and upsert qualified whale membership. */
export async function persistFeedMetricsIncrement(
  input: FeedMetricsPersistInput
): Promise<void> {
  if (!isDatabaseEnabled()) return;

  const {
    venue,
    dayKey,
    tradesDetected,
    gatePassedTrades,
    whaleWallets,
  } = buildPersistPayload(input);

  if (
    tradesDetected === 0 &&
    gatePassedTrades === 0 &&
    whaleWallets.length === 0
  ) {
    return;
  }

  const db = getDb();

  if (tradesDetected > 0 || gatePassedTrades > 0) {
    await db
      .insert(feedDailyMetrics)
      .values({
        dayKey,
        venue,
        tradesDetected,
        gatePassedTrades,
        distinctWhales: 0,
      })
      .onConflictDoUpdate({
        target: [feedDailyMetrics.dayKey, feedDailyMetrics.venue],
        set: {
          tradesDetected: sql`${feedDailyMetrics.tradesDetected} + ${tradesDetected}`,
          gatePassedTrades: sql`${feedDailyMetrics.gatePassedTrades} + ${gatePassedTrades}`,
          updatedAt: sql`now()`,
        },
      });
  } else {
    await db
      .insert(feedDailyMetrics)
      .values({
        dayKey,
        venue,
        tradesDetected: 0,
        gatePassedTrades: 0,
        distinctWhales: 0,
      })
      .onConflictDoNothing({
        target: [feedDailyMetrics.dayKey, feedDailyMetrics.venue],
      });
  }

  if (whaleWallets.length > 0) {
    await db
      .insert(feedDailyQualifiedWhales)
      .values(
        whaleWallets.map((wallet) => ({
          dayKey,
          venue,
          wallet,
        }))
      )
      .onConflictDoNothing({
        target: [
          feedDailyQualifiedWhales.dayKey,
          feedDailyQualifiedWhales.venue,
          feedDailyQualifiedWhales.wallet,
        ],
      });

    await refreshDistinctWhaleCount(dayKey, venue);
  }
}

export async function countDistinctQualifiedWhales(
  dayKey: string,
  venue: FeedMetricsVenue
): Promise<number> {
  if (!isDatabaseEnabled()) return 0;

  const db = getDb();
  const [row] = await db
    .select({
      count: sql<number>`COUNT(*)::int`,
    })
    .from(feedDailyQualifiedWhales)
    .where(
      and(
        eq(feedDailyQualifiedWhales.dayKey, dayKey),
        eq(feedDailyQualifiedWhales.venue, venue)
      )
    );

  return row?.count ?? 0;
}

export async function getFeedDailyMetrics(
  options: GetFeedDailyMetricsOptions = {}
): Promise<FeedDailyMetricsSnapshot[]> {
  if (!isDatabaseEnabled()) return [];

  const db = getDb();
  const filters = [];

  if (options.dayKey) {
    filters.push(eq(feedDailyMetrics.dayKey, options.dayKey));
  }
  if (options.venue) {
    filters.push(eq(feedDailyMetrics.venue, options.venue));
  }
  if (options.fromDayKey) {
    filters.push(gte(feedDailyMetrics.dayKey, options.fromDayKey));
  }
  if (options.toDayKey) {
    filters.push(lte(feedDailyMetrics.dayKey, options.toDayKey));
  }

  const rows = await db
    .select()
    .from(feedDailyMetrics)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(feedDailyMetrics.dayKey), feedDailyMetrics.venue);

  return Promise.all(
    rows.map(async (row) => ({
      dayKey: row.dayKey,
      venue: row.venue as FeedMetricsVenue,
      tradesDetected: row.tradesDetected,
      gatePassedTrades: row.gatePassedTrades,
      distinctWhales: await countDistinctQualifiedWhales(row.dayKey, row.venue as FeedMetricsVenue),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }))
  );
}

export { feedMetricsDayKeyUtc, normalizeFeedMetricWallets };
