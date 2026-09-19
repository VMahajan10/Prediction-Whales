#!/usr/bin/env tsx
/**
 * 0562 durability gate: diagnose lifecycle row discrepancy, atomic-replace
 * stale current-version rows from frozen replay (no authoritative rehydration).
 */
import "../tests/preload-env";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  policyAProductionWalletHydration,
  walletHistoricalMetrics,
  walletHistoryCoverage,
  walletPositionLifecycles,
} from "@/lib/crossmarket/store/schema";
import { evaluateHistoricalPerformanceVerdict } from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import {
  filterChainAuthoritativeEvents,
  countMissingPersistableAuthoritativeEvents,
  loadPersistedAuthoritativeDedupeKeys,
} from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import {
  auditLifecycleParity,
  loadPersistedLifecycleRows,
} from "@/lib/walletLedger/indexed/store/incrementalLifecycles";
import {
  countWalletLedgerEvents,
  loadPersistedWalletEvents,
  markDerivedStateCommitted,
  persistDerivedPhase,
} from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import type { IndexedAuditWalletResult } from "@/lib/walletLedger/indexed/types";
import {
  loadValidationSnapshot,
  prepareAuthoritativeEventsForLifecycleMerge,
  replayMetricsFromValidationSnapshot,
} from "@/lib/walletLedger/indexed/store/validationSnapshot";

const WALLET = "0x0562e01b3c3e65bb93bf0de32f02cec238a79d66";
const SNAPSHOT_PATH =
  process.env.SNAPSHOT_PATH ??
  ".cache/wallet-validation-snapshots/0x0562e01b3c3e65bb93bf0de32f02cec238a79d66-0x0562e01b3c3e65bb93bf0de32f02cec238a79d66-post-collapse-mu2tx42k.json";

async function lifecycleTableBreakdown(wallet: string) {
  const db = getDb();
  const walletAddress = wallet.toLowerCase();

  const byMetricVersion = await db
    .select({
      metricVersion: walletPositionLifecycles.metricVersion,
      count: sql<number>`count(*)::int`,
    })
    .from(walletPositionLifecycles)
    .where(sql`lower(${walletPositionLifecycles.walletAddress}) = ${walletAddress}`)
    .groupBy(walletPositionLifecycles.metricVersion);

  const byStatusCurrent = await db
    .select({
      completed: walletPositionLifecycles.completed,
      count: sql<number>`count(*)::int`,
    })
    .from(walletPositionLifecycles)
    .where(
      and(
        sql`lower(${walletPositionLifecycles.walletAddress}) = ${walletAddress}`,
        eq(walletPositionLifecycles.metricVersion, WALLET_METRIC_VERSION)
      )
    )
    .groupBy(walletPositionLifecycles.completed);

  const duplicateEpisodeKeys = await db.execute(sql`
    SELECT condition_id, asset_id, lifecycle_episode, count(*)::int AS cnt
    FROM wallet_position_lifecycles
    WHERE lower(wallet_address) = ${walletAddress}
      AND metric_version = ${WALLET_METRIC_VERSION}
    GROUP BY condition_id, asset_id, lifecycle_episode
    HAVING count(*) > 1
  `);

  const currentRows = await loadPersistedLifecycleRows(walletAddress);
  const episodeKeyCounts = new Map<string, number>();
  for (const row of currentRows) {
    const key = `${row.conditionId}::${row.assetId}::${row.lifecycleEpisode}`;
    episodeKeyCounts.set(key, (episodeKeyCounts.get(key) ?? 0) + 1);
  }

  return {
    byMetricVersion,
    byStatusCurrent,
    currentVersionTotal: currentRows.length,
    duplicateEpisodeKeyGroups: duplicateEpisodeKeys.rows ?? [],
    uniqueEpisodeKeys: episodeKeyCounts.size,
  };
}

async function main(): Promise<void> {
  const breakdownBefore = await lifecycleTableBreakdown(WALLET);
  const physicalDbRows = await countWalletLedgerEvents(WALLET);
  const db = getDb();
  const identityCounts = await db.execute(sql`
    SELECT
      count(*)::int AS physical_rows,
      count(*) FILTER (WHERE canonical_identity IS NOT NULL)::int AS with_canonical_identity,
      count(*) FILTER (WHERE canonical_identity IS NULL)::int AS without_canonical_identity
    FROM wallet_ledger_events
    WHERE lower(wallet_address) = ${WALLET.toLowerCase()}
  `);
  const identityRow = (identityCounts.rows?.[0] ?? {}) as {
    physical_rows?: number;
    with_canonical_identity?: number;
    without_canonical_identity?: number;
  };
  const chainEvents = filterChainAuthoritativeEvents(
    await loadPersistedWalletEvents(WALLET)
  );
  const persistedKeys = await loadPersistedAuthoritativeDedupeKeys(WALLET);
  const persistableMissingAfter = countMissingPersistableAuthoritativeEvents(
    chainEvents,
    persistedKeys
  );

  const snapshot = await loadValidationSnapshot(SNAPSHOT_PATH);
  const preparedChain = prepareAuthoritativeEventsForLifecycleMerge(chainEvents);
  const replay = await replayMetricsFromValidationSnapshot(snapshot, {
    chainEventsOverride: preparedChain,
    frozen: true,
  });

  const persistedBefore = await loadPersistedLifecycleRows(WALLET);
  const parityBefore = auditLifecycleParity(replay.positions, persistedBefore);

  const staleCurrentVersionRows =
    parityBefore.persistedKeysOnly.length +
    parityBefore.duplicatePersistedEpisodeKeys.length;
  const classification =
    breakdownBefore.byMetricVersion.length > 1
      ? "A_old_metricVersion_rows_present"
      : staleCurrentVersionRows > 0
        ? "B_stale_current_version_lifecycle_episodes"
        : parityBefore.duplicatePersistedEpisodeKeys.length > 0
          ? "C_duplicate_episode_keys"
          : "exact_match";

  let derivedCommit: Awaited<ReturnType<typeof persistDerivedPhase>> | null =
    null;
  if (!parityBefore.exactParity || breakdownBefore.currentVersionTotal !== replay.positions.length) {
    const auditForCommit = {
      wallet: WALLET,
      providerId: "etherscan_v2",
      throughBlock: snapshot.throughBlock,
      scanFromBlock: snapshot.scanFromBlock,
      coverage: {
        oldestActivityTimestamp: snapshot.oldestActivityTimestamp,
        oldestTradesTimestamp: snapshot.oldestTradesTimestamp,
        apiOldestTimestamp: snapshot.oldestActivityTimestamp,
        indexedOldestTimestamp: snapshot.oldestActivityTimestamp,
        eventsBeforeApiBoundary: 0,
      },
      sourceTruncationImmunity: {
        activityTruncated: snapshot.activityTruncated,
        tradesTruncated: snapshot.tradesTruncated,
      },
      indexedLedgerMetrics: replay.fullLedgerMetrics,
      indexedLifecyclePositions: replay.positions,
      extendsBeforeApiBoundary: true,
      eventsBeforeApiBoundaryEffective: 0,
    } as IndexedAuditWalletResult;

    derivedCommit = await persistDerivedPhase(auditForCommit);
    await markDerivedStateCommitted(WALLET);
  }

  const persistedAfter = await loadPersistedLifecycleRows(WALLET);
  const parityAfter = auditLifecycleParity(replay.positions, persistedAfter);
  const breakdownAfter = await lifecycleTableBreakdown(WALLET);

  const [metrics] = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      and(
        eq(walletHistoricalMetrics.walletAddress, WALLET.toLowerCase()),
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
      )
    )
    .limit(1);
  const [coverage] = await db
    .select()
    .from(walletHistoryCoverage)
    .where(eq(walletHistoryCoverage.walletAddress, WALLET.toLowerCase()))
    .limit(1);
  const [hydration] = await db
    .select()
    .from(policyAProductionWalletHydration)
    .where(eq(policyAProductionWalletHydration.walletAddress, WALLET.toLowerCase()))
    .limit(1);

  const verdict = evaluateHistoricalPerformanceVerdict({
    indexedDataValidity: Boolean(replay.metrics.credibilityMetricsValid),
    historyValidity: replay.metrics.historyValidity,
    completedPositionCount: replay.metrics.completedPositions,
    realizedRoi: replay.metrics.realizedRoi,
    profitablePositionRate: replay.metrics.profitablePositionRate,
    metricVersion: WALLET_METRIC_VERSION,
  });

  const canonicalAuthoritativeRowsUsed =
    identityRow.with_canonical_identity ?? chainEvents.length;
  const legacyCoordinateIncompleteRows =
    identityRow.without_canonical_identity ??
    Math.max(0, physicalDbRows - canonicalAuthoritativeRowsUsed);
  const gates = {
    currentVersionLifecycleRows: breakdownAfter.currentVersionTotal,
    replayLifecycleEpisodes: replay.positions.length,
    exactLifecycleParity: parityAfter.exactParity,
    completedPositions: replay.metrics.completedPositions === 304,
    roi: Math.abs(replay.metrics.realizedRoi - 0.02775) <= 1e-4,
    profitableRate: Math.abs(replay.metrics.profitablePositionRate - 0.5033) <= 1e-4,
    policyA: verdict.historicalPerformanceDecision === "PASS",
    credibilityMetricsValid: replay.metrics.credibilityMetricsValid === true,
    historyValidity: replay.metrics.historyValidity === "partial-but-metrics-safe",
    hydrationComplete: hydration?.status === "complete",
    baselineComplete: persistableMissingAfter === 0,
  };
  const allPass =
    Object.values(gates).every(Boolean) && persistableMissingAfter === 0;

  console.log(
    JSON.stringify(
      {
        wallet: WALLET,
        discrepancyExplanation: {
          physicalLifecycleRowsBefore: breakdownBefore.currentVersionTotal,
          replayLifecycleEpisodes: replay.positions.length,
          delta: breakdownBefore.currentVersionTotal - replay.positions.length,
          classification,
          breakdownBefore,
          parityBefore: {
            exactParity: parityBefore.exactParity,
            persistedKeysOnlyCount: parityBefore.persistedKeysOnly.length,
            replayKeysOnlyCount: parityBefore.replayKeysOnly.length,
            duplicateKeysCount: parityBefore.duplicatePersistedEpisodeKeys.length,
            persistedKeysOnlySample: parityBefore.persistedKeysOnly.slice(0, 5),
          },
          rootCause:
            "Phase-2 incremental upsert left stale current-version episode rows from failed baseline-incomplete hydration; incremental deleteStaleLifecycleEpisodes only runs for event-affected base keys",
        },
        atomicReplace: derivedCommit?.lifecycleStats ?? null,
        parityAfter,
        breakdownAfter,
        eventRowTechnicalDebt: {
          physicalDbRows,
          canonicalAuthoritativeRowsUsed,
          legacyCoordinateIncompleteRows,
          mergeKeyDedupedChainEvents: chainEvents.length,
          blocking: false,
          note: "Policy A replay/hydration paths filter via filterChainAuthoritativeEvents before lifecycle merge; physical cleanup deferred",
        },
        finalDurableState: {
          metrics,
          coverage,
          hydration,
          gates,
        },
        persistableMissingAfter,
        recommendation: allPass ? "READY_FOR_BATCH_1_RESUME" : "FIX_REQUIRED",
      },
      null,
      2
    )
  );

  if (!allPass) {
    process.exit(1);
  }
}

void main().catch((error) => {
  console.error("[policy-a-lifecycle-parity-0562] failed:", error);
  process.exit(1);
});
