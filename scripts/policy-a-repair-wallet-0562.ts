#!/usr/bin/env tsx
/**
 * Repair sparse-baseline + two-phase hydration for 0x0562 only.
 */
import "../tests/preload-env";
import { createHash } from "node:crypto";
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
  evaluateIndexedProviders,
  runIndexedWalletAudit,
} from "@/lib/walletLedger/indexed/pipeline";
import { buildProductionWalletCohort } from "@/lib/walletLedger/indexed/shadow/productionWalletCohort";
import {
  filterChainAuthoritativeEvents,
  hashAuthoritativeEventIdentities,
  summarizePersistableAuthoritativeEvents,
} from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import { auditMissingAuthoritativeIdentities } from "@/lib/walletLedger/indexed/store/missingIdentityAudit";
import {
  countWalletLedgerEvents,
  loadPersistedWalletEvents,
  markDerivedStateUncommitted,
  persistAuthoritativePhase,
  persistDerivedPhase,
} from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import {
  buildValidationSnapshotFromAudit,
  compareReplayToSnapshot,
  replayMetricsFromValidationSnapshot,
  saveValidationSnapshot,
} from "@/lib/walletLedger/indexed/store/validationSnapshot";

const WALLET = "0x0562e01b3c3e65bb93bf0de32f02cec238a79d66";

function hashApiEvents(events: { dedupeKey: string }[]): string {
  return createHash("sha256")
    .update(events.map((e) => e.dedupeKey).sort().join("\n"))
    .digest("hex");
}

async function loadDerivedStateSummary(wallet: string) {
  const db = getDb();
  const normalized = wallet.toLowerCase();
  const [metrics] = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      and(
        eq(walletHistoricalMetrics.walletAddress, normalized),
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
      )
    )
    .limit(1);
  const [coverage] = await db
    .select()
    .from(walletHistoryCoverage)
    .where(eq(walletHistoryCoverage.walletAddress, normalized))
    .limit(1);
  const [hydration] = await db
    .select()
    .from(policyAProductionWalletHydration)
    .where(eq(policyAProductionWalletHydration.walletAddress, normalized))
    .limit(1);
  const [lifecycleCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(walletPositionLifecycles)
    .where(
      and(
        eq(walletPositionLifecycles.walletAddress, normalized),
        eq(walletPositionLifecycles.metricVersion, WALLET_METRIC_VERSION)
      )
    );
  return {
    metrics,
    coverage,
    hydration,
    lifecycleRows: lifecycleCount?.count ?? 0,
  };
}

async function explainCohortDelta(): Promise<{
  currentTotal: number;
  added: string[];
  removed: string[];
  note: string;
}> {
  const cohort = await buildProductionWalletCohort();
  const current = new Set(cohort.wallets.map((w) => w.wallet.toLowerCase()));
  const baselineRef = Number(process.env.COHORT_BASELINE_TOTAL ?? "90");
  return {
    currentTotal: cohort.totalWallets,
    added: [],
    removed: [],
    note:
      cohort.totalWallets !== baselineRef
        ? `cohort total ${cohort.totalWallets} vs baseline reference ${baselineRef}; compare feed 30d lookback membership`
        : "cohort total matches baseline reference",
  };
}

async function main(): Promise<void> {
  const dbBefore = await countWalletLedgerEvents(WALLET);
  const derivedBefore = await loadDerivedStateSummary(WALLET);

  await markDerivedStateUncommitted(
    WALLET,
    "repair_run_invalidates_prior_failed_hydration"
  );

  const audit = await runIndexedWalletAudit({
    label: "policy-a-0562-repair",
    wallet: WALLET,
    providerId: "etherscan_v2",
    providerEvaluations: await evaluateIndexedProviders(),
    fullHistory: true,
    resumeCheckpoint: true,
  });

  const authoritative = filterChainAuthoritativeEvents(
    audit.authoritativeIndexedEvents ?? audit.indexedEvents ?? []
  );
  const persistableSummary = summarizePersistableAuthoritativeEvents(authoritative);
  const apiEvents = audit.apiEvents ?? [];
  const missingBefore = await auditMissingAuthoritativeIdentities(
    WALLET,
    authoritative
  );

  const phase1 = await persistAuthoritativePhase(audit);
  const persistDiag = phase1.authoritativePersistDiagnostics;

  const missingAfter = await auditMissingAuthoritativeIdentities(
    WALLET,
    authoritative
  );

  const snapshot = buildValidationSnapshotFromAudit(audit, {
    apiEvents,
    gammaCacheEntries: audit.gammaCacheEntries ?? [],
  });

  let exactReplayPass = false;
  let replayComparison = null as ReturnType<typeof compareReplayToSnapshot> | null;
  let replay = null as Awaited<
    ReturnType<typeof replayMetricsFromValidationSnapshot>
  > | null;
  let derivedCommitted = false;
  let hydrationStatus = "baseline_incomplete";

  if (persistDiag.baselineComplete) {
    const persistedChain = filterChainAuthoritativeEvents(
      await loadPersistedWalletEvents(WALLET)
    );
    replay = await replayMetricsFromValidationSnapshot(snapshot, {
      chainEventsOverride: persistedChain,
      frozen: true,
    });
    replayComparison = compareReplayToSnapshot(snapshot, replay);
    exactReplayPass =
      !replay.inputMismatch &&
      replayComparison.exactMatch &&
      replay.replayLifecycleInputHash === snapshot.auditLifecycleInputHash;
    if (exactReplayPass) {
      await persistDerivedPhase(audit);
      derivedCommitted = true;
      hydrationStatus = "complete";
      const db = getDb();
      const verdict = evaluateHistoricalPerformanceVerdict({
        indexedDataValidity: Boolean(audit.indexedLedgerMetrics?.credibilityMetricsValid),
        historyValidity: audit.indexedLedgerMetrics?.historyValidity,
        completedPositionCount: audit.indexedLedgerMetrics?.completedPositionCount ?? null,
        realizedRoi: audit.indexedLedgerMetrics?.portfolioRealizedRoi ?? null,
        profitablePositionRate: audit.indexedLedgerMetrics?.profitablePositionRate ?? null,
        metricVersion: WALLET_METRIC_VERSION,
      });
      await db
        .update(policyAProductionWalletHydration)
        .set({
          status: "complete",
          completedPositions: audit.indexedLedgerMetrics?.completedPositionCount ?? null,
          historyValidity: audit.indexedLedgerMetrics?.historyValidity ?? null,
          policyADecision: verdict.historicalPerformanceDecision,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(policyAProductionWalletHydration.walletAddress, WALLET.toLowerCase()));
    } else {
      await markDerivedStateUncommitted(
        WALLET,
        replay?.inputMismatchReason ?? "exact_replay_failed"
      );
      hydrationStatus = "exact_replay_failed";
    }
  } else {
    await markDerivedStateUncommitted(
      WALLET,
      `baseline_incomplete persistableMissingAfter=${persistDiag.persistableMissingAfter}`
    );
  }

  const dbAfter = await countWalletLedgerEvents(WALLET);
  const derivedAfter = await loadDerivedStateSummary(WALLET);
  const snapshotPath = await saveValidationSnapshot(snapshot);
  const cohortDelta = await explainCohortDelta();
  const metrics = audit.indexedLedgerMetrics;
  const auditVerdict = evaluateHistoricalPerformanceVerdict({
    indexedDataValidity: Boolean(metrics?.credibilityMetricsValid),
    historyValidity: metrics?.historyValidity,
    completedPositionCount: metrics?.completedPositionCount ?? null,
    realizedRoi: metrics?.portfolioRealizedRoi ?? null,
    profitablePositionRate: metrics?.profitablePositionRate ?? null,
    metricVersion: WALLET_METRIC_VERSION,
  });

  const recommendation =
    persistDiag.baselineComplete && exactReplayPass && derivedCommitted
      ? "READY_TO_RESUME_BATCH_1"
      : "FIX_REQUIRED";

  console.log(
    JSON.stringify(
      {
        wallet: WALLET,
        throughBlock: audit.throughBlock,
        scanFromBlock: audit.scanFromBlock,
        authoritativeCount: persistableSummary.authoritativeTotal,
        persistableAuthoritativeCount: persistableSummary.persistableTotal,
        classDCount: persistableSummary.unresolvedClassDTotal,
        missingBefore: missingBefore.missing,
        missingBeforeSummary: missingBefore.summary,
        inserted: phase1.eventsUpserted,
        backfilled: phase1.eventWriteStats.backfilled,
        missingAfter: missingAfter.missing,
        missingAfterSummary: missingAfter.summary,
        persistableMissingBefore: persistDiag.persistableMissingBefore,
        persistableMissingAfter: persistDiag.persistableMissingAfter,
        baselineComplete: persistDiag.baselineComplete,
        dbPersistedEventCountBefore: dbBefore,
        dbPersistedEventCountAfter: dbAfter,
        authoritativeHash: hashAuthoritativeEventIdentities(authoritative),
        snapshotAuthoritativeHash: snapshot.authoritativeEventIdentityHash,
        apiCount: apiEvents.length,
        apiHash: hashApiEvents(apiEvents),
        auditCompletedPositions: metrics?.completedPositionCount ?? null,
        replayCompletedPositions: replay?.metrics.completedPositions ?? null,
        auditRoi: metrics?.portfolioRealizedRoi ?? null,
        replayRoi: replay?.metrics.portfolioRealizedRoi ?? null,
        auditProfitableRate: metrics?.profitablePositionRate ?? null,
        replayProfitableRate: replay?.metrics.profitablePositionRate ?? null,
        auditPolicyA: auditVerdict.historicalPerformanceDecision,
        replayPolicyA: replayComparison?.policyAMatch
          ? auditVerdict.historicalPerformanceDecision
          : replay?.metrics
            ? evaluateHistoricalPerformanceVerdict({
                indexedDataValidity: Boolean(replay.metrics.credibilityMetricsValid),
                historyValidity: replay.metrics.historyValidity,
                completedPositionCount: replay.metrics.completedPositions,
                realizedRoi: replay.metrics.realizedRoi,
                profitablePositionRate: replay.metrics.profitablePositionRate,
                metricVersion: WALLET_METRIC_VERSION,
              }).historicalPerformanceDecision
            : null,
        exactReplayPass,
        derivedStateCommitted: derivedCommitted,
        hydrationStatus,
        derivedStateBefore: derivedBefore,
        derivedStateAfter: derivedAfter,
        cohortDelta,
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
  console.error("[policy-a-repair-0562] failed:", error);
  process.exit(1);
});
