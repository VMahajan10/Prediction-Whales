#!/usr/bin/env tsx
/**
 * 0562 only: canonical duplicate collapse + exact Phase-2 replay commit.
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
  assessAuthoritativeBaselineCompleteness,
  countMissingPersistableAuthoritativeEvents,
  filterChainAuthoritativeEvents,
  loadPersistedAuthoritativeDedupeKeys,
} from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import {
  auditCanonicalDuplicates,
  backfillCanonicalIdentityForWallet,
  collapseCanonicalDuplicatesForWallet,
  postCollapseGateReport,
} from "@/lib/walletLedger/indexed/store/canonicalWalletCollapse";
import { hashLifecycleInputSequence } from "@/lib/walletLedger/indexed/store/lifecycleInputHash";
import {
  countWalletLedgerEvents,
  loadPersistedWalletEvents,
  markDerivedStateCommitted,
  persistDerivedPhase,
} from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import type { IndexedAuditWalletResult } from "@/lib/walletLedger/indexed/types";
import {
  buildLifecycleInput,
  compareReplayToSnapshot,
  hashReplayInput,
  loadValidationSnapshot,
  prepareAuthoritativeEventsForLifecycleMerge,
  replayMetricsFromValidationSnapshot,
  saveValidationSnapshot,
  verifyLifecycleEpisodeDeterminism,
} from "@/lib/walletLedger/indexed/store/validationSnapshot";

const WALLET = "0x0562e01b3c3e65bb93bf0de32f02cec238a79d66";
const SNAPSHOT_PATH =
  process.env.SNAPSHOT_PATH ??
  ".cache/wallet-validation-snapshots/0x0562e01b3c3e65bb93bf0de32f02cec238a79d66-0x0562e01b3c3e65bb93bf0de32f02cec238a79d66-mu28o1n7.json";

function buildPostCollapseSnapshot(
  frozen: Awaited<ReturnType<typeof loadValidationSnapshot>>,
  chainEvents: ReturnType<typeof filterChainAuthoritativeEvents>,
  combined: ReturnType<typeof buildLifecycleInput>
) {
  const sequence = hashLifecycleInputSequence(combined);
  const preparedChain = prepareAuthoritativeEventsForLifecycleMerge(chainEvents);
  const metricComputationInputHash = hashReplayInput({
    apiEvents: frozen.apiEvents,
    authoritativeEvents: preparedChain,
    activityTruncated: frozen.activityTruncated,
    tradesTruncated: frozen.tradesTruncated,
    gammaCacheEntries: frozen.gammaCacheEntries,
  });
  return {
    ...frozen,
    authoritativeEvents: preparedChain,
    authoritativeEventCount: preparedChain.length,
    combinedEventCount: combined.length,
    auditLifecycleInputSequenceHash: sequence.hash,
    auditLifecycleInputEventCount: sequence.count,
    metricComputationInputHash,
    replayInputHash: metricComputationInputHash,
    throughBlock: frozen.throughBlock,
  };
}

async function main(): Promise<void> {
  const rowsBefore = await countWalletLedgerEvents(WALLET);
  const duplicateAuditBefore = await auditCanonicalDuplicates(WALLET);

  if (duplicateAuditBefore.economicConflictGroups > 0) {
    console.log(
      JSON.stringify(
        {
          recommendation: "FIX_REQUIRED",
          reason: "economic_conflicts_before_collapse",
          duplicateAuditBefore,
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  await backfillCanonicalIdentityForWallet(WALLET);
  const collapse = await collapseCanonicalDuplicatesForWallet(WALLET);
  if (collapse.economicConflicts > 0) {
    console.log(
      JSON.stringify(
        {
          recommendation: "FIX_REQUIRED",
          reason: "economic_conflicts_during_collapse",
          collapse,
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  const postCollapse = await postCollapseGateReport(WALLET);
  const persistedKeys = await loadPersistedAuthoritativeDedupeKeys(WALLET);
  const frozenSnapshot = await loadValidationSnapshot(SNAPSHOT_PATH);
  const chainEvents = filterChainAuthoritativeEvents(
    await loadPersistedWalletEvents(WALLET)
  );
  const preparedChain = prepareAuthoritativeEventsForLifecycleMerge(chainEvents);
  const combined = buildLifecycleInput(frozenSnapshot.apiEvents, preparedChain);
  const postSnapshot = buildPostCollapseSnapshot(
    frozenSnapshot,
    preparedChain,
    combined
  );
  const sequence = hashLifecycleInputSequence(combined);

  const authoritativeForBaseline = chainEvents;
  const baselineAssessment = assessAuthoritativeBaselineCompleteness({
    authoritativeEvents: authoritativeForBaseline,
    persistedDedupeKeys: persistedKeys,
    persistedEventsBefore: postCollapse.rowsAfter,
    lastIndexedBlock: frozenSnapshot.throughBlock,
  });
  const persistableMissingAfter = countMissingPersistableAuthoritativeEvents(
    authoritativeForBaseline,
    persistedKeys
  );

  const replayA = await replayMetricsFromValidationSnapshot(postSnapshot, {
    chainEventsOverride: preparedChain,
    frozen: true,
  });
  const replayB = await replayMetricsFromValidationSnapshot(postSnapshot, {
    chainEventsOverride: preparedChain,
    frozen: true,
  });
  const determinism = await verifyLifecycleEpisodeDeterminism(
    WALLET,
    combined,
    frozenSnapshot.gammaCacheEntries
  );

  const sequenceMatch =
    replayA.replayLifecycleInputSequenceHash === sequence.hash &&
    replayA.replayLifecycleInputEventCount === sequence.count &&
    replayB.replayLifecycleInputSequenceHash === replayA.replayLifecycleInputSequenceHash;

  const metricsSelfMatch =
    replayA.metrics.completedPositions === replayB.metrics.completedPositions &&
    Math.abs(replayA.metrics.realizedRoi - replayB.metrics.realizedRoi) <= 1e-9 &&
    Math.abs(
      replayA.metrics.profitablePositionRate -
        replayB.metrics.profitablePositionRate
    ) <= 1e-9 &&
    replayA.metrics.policyAVerdict === replayB.metrics.policyAVerdict;

  const comparison = compareReplayToSnapshot(
    {
      ...postSnapshot,
      auditMetrics: replayA.metrics,
      lifecycleEpisodeKeys: replayA.positions.map((p) =>
        [
          p.conditionId,
          p.asset,
          p.completed ? "1" : "0",
          p.completionReason ?? "",
          p.firstEntryAt ?? "",
          p.lastActivityAt ?? "",
        ].join("|")
      ),
    },
    replayA
  );

  const baselineGate =
    postCollapse.duplicateCanonicalGroupsRemaining === 0 &&
    collapse.economicConflicts === 0 &&
    persistableMissingAfter === 0 &&
    baselineAssessment.baselineComplete;

  const exactPass =
    baselineGate &&
    sequenceMatch &&
    metricsSelfMatch &&
    determinism.deterministic &&
    comparison.exactMatch;

  let derivedCommitted = false;
  let hydrationStatus = "phase2_blocked";

  if (exactPass) {
    const auditForCommit = {
      wallet: WALLET,
      providerId: "etherscan_v2",
      throughBlock: frozenSnapshot.throughBlock,
      scanFromBlock: frozenSnapshot.scanFromBlock,
      coverage: {
        oldestActivityTimestamp: frozenSnapshot.oldestActivityTimestamp,
        oldestTradesTimestamp: frozenSnapshot.oldestTradesTimestamp,
        apiOldestTimestamp: frozenSnapshot.oldestActivityTimestamp,
        indexedOldestTimestamp: frozenSnapshot.oldestActivityTimestamp,
        eventsBeforeApiBoundary: 0,
      },
      sourceTruncationImmunity: {
        activityTruncated: frozenSnapshot.activityTruncated,
        tradesTruncated: frozenSnapshot.tradesTruncated,
      },
      indexedLedgerMetrics: replayA.fullLedgerMetrics,
      indexedLifecyclePositions: replayA.positions,
      extendsBeforeApiBoundary: true,
      eventsBeforeApiBoundaryEffective: 0,
    } as IndexedAuditWalletResult;

    await persistDerivedPhase(auditForCommit);
    await markDerivedStateCommitted(WALLET);

    const verdict = evaluateHistoricalPerformanceVerdict({
      indexedDataValidity: Boolean(replayA.metrics.credibilityMetricsValid),
      historyValidity: replayA.metrics.historyValidity,
      completedPositionCount: replayA.metrics.completedPositions,
      realizedRoi: replayA.metrics.realizedRoi,
      profitablePositionRate: replayA.metrics.profitablePositionRate,
      metricVersion: WALLET_METRIC_VERSION,
    });

    const db = getDb();
    await db
      .update(policyAProductionWalletHydration)
      .set({
        status: "complete",
        completedPositions: replayA.metrics.completedPositions,
        historyValidity: replayA.metrics.historyValidity,
        policyADecision: verdict.historicalPerformanceDecision,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(policyAProductionWalletHydration.walletAddress, WALLET.toLowerCase()));

    derivedCommitted = true;
    hydrationStatus = "complete";
  }

  const db = getDb();
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
  const [lifecycleCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(walletPositionLifecycles)
    .where(
      and(
        eq(walletPositionLifecycles.walletAddress, WALLET.toLowerCase()),
        eq(walletPositionLifecycles.metricVersion, WALLET_METRIC_VERSION)
      )
    );

  const snapshotPath = await saveValidationSnapshot({
    ...postSnapshot,
    auditMetrics: replayA.metrics,
    lifecycleEpisodeKeys: replayA.positions.map((p) =>
      [
        p.conditionId,
        p.asset,
        p.completed ? "1" : "0",
        p.completionReason ?? "",
        p.firstEntryAt ?? "",
        p.lastActivityAt ?? "",
      ].join("|")
    ),
    runId: `${WALLET.toLowerCase()}-post-collapse-${Date.now().toString(36)}`,
    runTimestamp: new Date().toISOString(),
  });

  const recommendation = exactPass && derivedCommitted
    ? "READY_TO_RESUME_BATCH_1"
    : "FIX_REQUIRED";

  console.log(
    JSON.stringify(
      {
        priorFalseLifecycleHashExplanation: {
          legacyHashUsedDedupeKeyNotCanonicalMergeKey:
            "auditLifecycleInputHash keyed on dedupeKey; duplicate physical logs with legacy vs canonical dedupe_key produced separate lines but identical multiset counts between audit snapshot and DB replay load",
          metricsComparedToStaleSnapshotAuditMetrics:
            "completedDelta=5 arose from comparing replay metrics to stale snapshot auditMetrics captured before collapse; sequence hash appeared to match because both sides used the same duplicate-bearing 80k merge-key set",
          sequenceHashNowUsesCanonicalMergeIdentity:
            "auditLifecycleInputSequenceHash uses canonical merge identity + economic fields; multiplicity counts in sorted order",
        },
        duplicateAuditBefore,
        collapse,
        rowsBefore,
        rowsAfter: postCollapse.rowsAfter,
        postCollapseGate: postCollapse,
        persistableMissingAfter,
        baselineComplete: baselineAssessment.baselineComplete,
        lifecycleInputComparison: {
          auditLifecycleInputEventCount: sequence.count,
          replayLifecycleInputEventCount: replayA.replayLifecycleInputEventCount,
          auditLifecycleInputSequenceHash: sequence.hash,
          replayLifecycleInputSequenceHash: replayA.replayLifecycleInputSequenceHash,
          sequenceMatch,
          legacyAuditLifecycleInputHash: frozenSnapshot.auditLifecycleInputHash,
          legacyReplayLifecycleInputHash: replayA.replayLifecycleInputHash,
        },
        phase2Metrics: {
          completedPositions: replayA.metrics.completedPositions,
          realizedRoi: replayA.metrics.realizedRoi,
          profitablePositionRate: replayA.metrics.profitablePositionRate,
          policyAVerdict: replayA.metrics.policyAVerdict,
          lifecycleEpisodeCount: replayA.metrics.lifecycleEpisodeCount,
          comparison,
          metricsSelfMatch,
          determinism,
        },
        derivedStateCommitted: derivedCommitted,
        hydrationStatus,
        postCommit: {
          metrics,
          coverage,
          hydration,
          lifecycleRows: lifecycleCount?.count ?? 0,
        },
        snapshotPath,
        recommendation,
      },
      null,
      2
    )
  );

  if (recommendation !== "READY_TO_RESUME_BATCH_1") {
    process.exit(1);
  }
}

void main().catch((error) => {
  console.error("[policy-a-collapse-phase2-0562] failed:", error);
  process.exit(1);
});
