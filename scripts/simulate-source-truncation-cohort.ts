#!/usr/bin/env tsx
/**
 * Simulate source-specific truncation immunity using persisted metadata only.
 * Read-only — no persistence, no live API fetch.
 */
import "../tests/preload-env";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletHistoryCoverage,
} from "@/lib/crossmarket/store/schema";
import {
  computeSourceBoundaryStats,
  resolveIndexedTruncationFlags,
  resolveSourceSpecificTruncationFlags,
} from "@/lib/walletLedger/indexed/indexedCredibility";
import { loadPersistedWalletEvents } from "@/lib/walletLedger/indexed/store/persistWalletHistory";

async function main() {
  const db = getDb();
  const rows = await db
    .select({
      wallet: walletHistoricalMetrics.walletAddress,
      reasons: walletHistoricalMetrics.historyIncompleteReasons,
      indexedOldest: walletHistoryCoverage.indexedOldestTimestamp,
      apiOldest: walletHistoryCoverage.apiOldestTimestamp,
      eventsBeforeApi: walletHistoryCoverage.eventsBeforeApiBoundary,
    })
    .from(walletHistoricalMetrics)
    .leftJoin(
      walletHistoryCoverage,
      eq(walletHistoricalMetrics.walletAddress, walletHistoryCoverage.walletAddress)
    )
    .where(
      eq(walletHistoricalMetrics.historyValidity, "partial-and-metrics-unsafe")
    );

  let immediateImmunity = 0;
  let needsEarlierIndexing = 0;
  let otherUnsafe = 0;
  let legacyWouldImmune = 0;
  let tradesDrivenBoundaryLikely = 0;
  const samples: Array<Record<string, unknown>> = [];

  for (const row of rows) {
    const activityTruncated = (row.reasons ?? []).includes("activity_truncated");
    const tradesTruncated = (row.reasons ?? []).includes("trades_truncated");
    if (!activityTruncated && !tradesTruncated) {
      otherUnsafe += 1;
      continue;
    }

    const events = await loadPersistedWalletEvents(row.wallet);
    const indexedOldest = row.indexedOldest ?? null;
    const blendedApiOldest = row.apiOldest ?? null;

    // Persisted metadata lacks per-source timestamps; use conservative proxies:
    // - trades boundary = blended apiOldest when trades truncated
    // - activity boundary = blended apiOldest only when activity-only truncation
    // - when activity truncated but blended apiOldest predates indexed by >180d,
    //   treat boundary as trades-driven (d27cc742 pattern) and use indexedOldest
    //   as a lower-bound proxy for activity boundary until coverage stores it.
    const tradesDriven =
      activityTruncated &&
      !tradesTruncated &&
      blendedApiOldest != null &&
      indexedOldest != null &&
      blendedApiOldest + 180 * 86_400 < indexedOldest;
    if (tradesDriven) tradesDrivenBoundaryLikely += 1;

    const oldestTradesTimestamp = tradesTruncated ? blendedApiOldest : null;
    const oldestActivityTimestamp = activityTruncated
      ? tradesDriven
        ? indexedOldest
        : blendedApiOldest
      : null;

    const boundaries = computeSourceBoundaryStats(
      events,
      oldestActivityTimestamp,
      oldestTradesTimestamp
    );
    const newFlags = resolveSourceSpecificTruncationFlags({
      apiActivityTruncated: activityTruncated,
      apiTradesTruncated: tradesTruncated,
      oldestActivityTimestamp,
      oldestTradesTimestamp,
      runSourceBoundaries: boundaries,
    });
    const legacyFlags = resolveIndexedTruncationFlags({
      apiActivityTruncated: activityTruncated,
      apiTradesTruncated: tradesTruncated,
      runExtendsBeforeApiBoundary: (row.eventsBeforeApi ?? 0) > 0,
      runEventsBeforeApiBoundary: row.eventsBeforeApi ?? 0,
    });

    const truncationCleared =
      (!activityTruncated || !newFlags.activityTruncated) &&
      (!tradesTruncated || !newFlags.tradesTruncated);

    if (legacyFlags.apiTruncationImmune) legacyWouldImmune += 1;

    if (truncationCleared) {
      immediateImmunity += 1;
    } else if (
      (activityTruncated && !newFlags.activityTruncationImmune) ||
      (tradesTruncated && !newFlags.tradesTruncationImmune)
    ) {
      if (
        indexedOldest != null &&
        oldestActivityTimestamp != null &&
        indexedOldest >= oldestActivityTimestamp
      ) {
        needsEarlierIndexing += 1;
      } else {
        otherUnsafe += 1;
      }
    } else {
      otherUnsafe += 1;
    }

    if (samples.length < 8) {
      samples.push({
        wallet: row.wallet,
        activityTruncated,
        tradesTruncated,
        tradesDrivenBoundaryLikely: tradesDriven,
        oldestActivityTimestamp,
        oldestTradesTimestamp,
        indexedOldest: boundaries.indexedOldestTimestamp,
        activityImmune: newFlags.activityTruncationImmune,
        tradesImmune: newFlags.tradesTruncationImmune,
        truncationCleared,
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: "source_truncation_cohort_simulation",
        note:
          "Uses persisted metadata with conservative activity/trades boundary proxies; per-source timestamps not yet stored in coverage.",
        totalUnsafe: rows.length,
        immediateTruncationImmunity: immediateImmunity,
        needsEarlierChainIndexing: needsEarlierIndexing,
        remainsUnsafeOtherReason: otherUnsafe,
        legacyBlendedWouldImmune: legacyWouldImmune,
        tradesDrivenBoundaryLikely,
        samples,
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
