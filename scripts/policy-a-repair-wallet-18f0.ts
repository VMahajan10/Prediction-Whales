#!/usr/bin/env tsx
/**
 * Wallet 18f0 only: canonical reconciliation preflight, Phase-1, exact replay, Phase-2.
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
import { runIndexedWalletAudit } from "@/lib/walletLedger/indexed/pipeline";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import {
  assessAuthoritativeBaselineCompleteness,
  countMissingPersistableAuthoritativeEvents,
  filterChainAuthoritativeEvents,
  filterPersistableAuthoritativeEvents,
  loadPersistedAuthoritativeDedupeKeys,
  selectAuthoritativePersistenceCandidates,
} from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import {
  bulkBackfillCanonicalIdentityFromDedupeKeys,
  preflightCanonicalReconciliation,
} from "@/lib/walletLedger/indexed/store/canonicalEventReconciliation";
import { auditCanonicalDuplicates } from "@/lib/walletLedger/indexed/store/canonicalWalletCollapse";
import {
  countWalletLedgerEvents,
  loadPersistedWalletEvents,
  markDerivedStateCommitted,
  persistAuthoritativePhase,
  persistDerivedPhase,
} from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import type { IndexedAuditWalletResult } from "@/lib/walletLedger/indexed/types";
import {
  buildValidationSnapshotFromAudit,
  compareReplayToSnapshot,
  lifecycleEpisodeKey,
  prepareAuthoritativeEventsForLifecycleMerge,
  replayMetricsFromValidationSnapshot,
  saveValidationSnapshot,
} from "@/lib/walletLedger/indexed/store/validationSnapshot";

const WALLET = "0x18f0faf72b241dc55094ae704987e391c2a23d5e";
const COLLISION_DEDUPE =
  "chain|137|0x311d50cbc0773e6b693e44855040353e84e9ece2f6d65f9dabc731b9b9027da0|1013";

async function main(): Promise<void> {
  const rowsBefore = await countWalletLedgerEvents(WALLET);
  const backfilledIdentityRows = await bulkBackfillCanonicalIdentityFromDedupeKeys(
    WALLET
  );

  const audit = await runIndexedWalletAudit({
    label: "policy-a-repair-18f0",
    wallet: WALLET,
    providerId: "etherscan_v2",
    fullHistory: true,
    resumeCheckpoint: true,
    allowEarlierThanIncremental: true,
  });

  const apiEvents = audit.apiEvents ?? [];
  if (apiEvents.length === 0) {
    throw new Error("audit.apiEvents missing");
  }

  const authoritative = filterChainAuthoritativeEvents(
    audit.authoritativeIndexedEvents ?? []
  );
  const persistable = filterPersistableAuthoritativeEvents(
    audit.authoritativeIndexedEvents ?? []
  );
  const persistedKeysBefore = await loadPersistedAuthoritativeDedupeKeys(WALLET);

  const preflight = await preflightCanonicalReconciliation(
    WALLET,
    selectAuthoritativePersistenceCandidates({
      mode: "baseline_repair",
      authoritativeEvents: authoritative,
      deltaEvents: authoritative,
      persistedDedupeKeys: persistedKeysBefore,
    })
  );

  if (preflight.blocked) {
    console.log(
      JSON.stringify(
        {
          recommendation: "FIX_REQUIRED",
          stage: "preflight",
          reason: preflight.blockReason,
          preflight: preflight.diagnostics,
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  const duplicateAuditBefore = await auditCanonicalDuplicates(WALLET);
  const phase1 = await persistAuthoritativePhase(audit);
  const persistDiag = phase1.authoritativePersistDiagnostics;

  if (
    !persistDiag?.baselineComplete ||
    (persistDiag.persistableMissingAfter ?? 0) > 0
  ) {
    console.log(
      JSON.stringify(
        {
          recommendation: "FIX_REQUIRED",
          stage: "phase1",
          persistDiag,
          preflight: preflight.diagnostics,
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  const duplicateAuditAfter = await auditCanonicalDuplicates(WALLET);
  if (duplicateAuditAfter.economicConflictGroups > 0) {
    console.log(
      JSON.stringify(
        {
          recommendation: "FIX_REQUIRED",
          stage: "post_phase1_duplicates",
          duplicateAuditAfter,
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  const auditPreparedChain = prepareAuthoritativeEventsForLifecycleMerge(
    filterChainAuthoritativeEvents(audit.authoritativeIndexedEvents ?? [])
  );
  const persistedChain = prepareAuthoritativeEventsForLifecycleMerge(
    filterChainAuthoritativeEvents(await loadPersistedWalletEvents(WALLET))
  );
  const persistedKeys = await loadPersistedAuthoritativeDedupeKeys(WALLET);
  const persistableMissingAfter = countMissingPersistableAuthoritativeEvents(
    authoritative,
    persistedKeys
  );

  const snapshot = buildValidationSnapshotFromAudit(
    { ...audit, authoritativeIndexedEvents: persistedChain },
    { apiEvents, gammaCacheEntries: audit.gammaCacheEntries ?? [] }
  );
  const replayA = await replayMetricsFromValidationSnapshot(snapshot, {
    chainEventsOverride: persistedChain,
    frozen: true,
  });
  const frozenSnapshot = {
    ...snapshot,
    auditMetrics: replayA.metrics,
    lifecycleEpisodeKeys: replayA.positions.map(lifecycleEpisodeKey).sort(),
  };
  const replayB = await replayMetricsFromValidationSnapshot(frozenSnapshot, {
    chainEventsOverride: persistedChain,
    frozen: true,
  });
  const comparison = compareReplayToSnapshot(frozenSnapshot, replayB);

  const exactReplayPass =
    !replayA.inputMismatch &&
    !replayB.inputMismatch &&
    comparison.exactMatch &&
    replayB.replayLifecycleInputSequenceHash ===
      replayA.replayLifecycleInputSequenceHash &&
    replayA.replayLifecycleInputSequenceHash ===
      snapshot.auditLifecycleInputSequenceHash;

  if (!exactReplayPass) {
    console.log(
      JSON.stringify(
        {
          recommendation: "FIX_REQUIRED",
          stage: "exact_replay",
          comparison,
          replayA: {
            sequenceHash: replayA.replayLifecycleInputSequenceHash,
            eventCount: replayA.replayLifecycleInputEventCount,
            metrics: replayA.metrics,
          },
          replayB: {
            sequenceHash: replayB.replayLifecycleInputSequenceHash,
            eventCount: replayB.replayLifecycleInputEventCount,
          },
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  const derived = await persistDerivedPhase({
    ...audit,
    indexedLifecyclePositions: replayA.positions,
    indexedLedgerMetrics: replayA.fullLedgerMetrics,
  } as IndexedAuditWalletResult);
  await markDerivedStateCommitted(WALLET);

  const db = getDb();
  const verdict = evaluateHistoricalPerformanceVerdict({
    indexedDataValidity: Boolean(replayA.metrics.credibilityMetricsValid),
    historyValidity: replayA.metrics.historyValidity,
    completedPositionCount: replayA.metrics.completedPositions,
    realizedRoi: replayA.metrics.realizedRoi,
    profitablePositionRate: replayA.metrics.profitablePositionRate,
    metricVersion: WALLET_METRIC_VERSION,
  });

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

  const [lifecycleCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(walletPositionLifecycles)
    .where(
      and(
        eq(walletPositionLifecycles.walletAddress, WALLET.toLowerCase()),
        eq(walletPositionLifecycles.metricVersion, WALLET_METRIC_VERSION)
      )
    );

  const snapshotPath = await saveValidationSnapshot(frozenSnapshot);

  console.log(
    JSON.stringify(
      {
        collisionForensics: {
          dedupeKey: COLLISION_DEDUPE,
          classification:
            "A/B cross-wallet: global dedupe_key row owned by 0x1610 with canonical_identity=NULL; 18f0 requires per-wallet row under composite (wallet,dedupe_key) unique",
          globalOwnerWallet: "0x1610db79f753a80207e1d66716be9e91e627ae49",
          globalOwnerRowId: 11512765,
        },
        preflight: {
          authoritativeCount: authoritative.length,
          persistableAuthoritativeCount: persistable.length,
          persistedRowsBefore: rowsBefore,
          identityBackfillRows: backfilledIdentityRows,
          ...preflight.diagnostics,
          ambiguousCollisions: preflight.diagnostics.ambiguousCollisions,
          economicConflicts: preflight.diagnostics.economicConflicts,
        },
        phase1: {
          baselineComplete: persistDiag?.baselineComplete,
          persistableMissingAfter: persistDiag?.persistableMissingAfter,
          eventsInserted: phase1.eventsUpserted,
          rowsAfter: await countWalletLedgerEvents(WALLET),
          reconciliation: phase1.eventWriteStats,
        },
        exactReplay: {
          pass: exactReplayPass,
          comparison,
          completedPositions: replayA.metrics.completedPositions,
          lifecycleEpisodeCount: replayA.metrics.lifecycleEpisodeCount,
          policyAVerdict: replayA.metrics.policyAVerdict,
          roi: replayA.metrics.realizedRoi,
          profitablePositionRate: replayA.metrics.profitablePositionRate,
        },
        phase2: {
          lifecycleParity: derived.lifecycleStats.lifecycleParity,
          lifecycleRowsAfter: derived.lifecycleStats.lifecycleRowsAfter,
          staleDeleted: derived.lifecycleStats.staleLifecycleRowsDeleted,
          lifecycleCount: lifecycleCount?.count ?? 0,
        },
        snapshotPath,
        recommendation: "READY_FOR_BATCH_1_RESUME",
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error("[policy-a-repair-wallet-18f0] failed:", error);
  process.exit(1);
});
