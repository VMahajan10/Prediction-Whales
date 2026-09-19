#!/usr/bin/env tsx
/**
 * Policy A class-D logIndex recovery + post-recovery exact replay verification.
 */
import "../tests/preload-env";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  policyAProductionWalletHydration,
  walletHistoricalMetrics,
} from "@/lib/crossmarket/store/schema";
import { evaluateHistoricalPerformanceVerdict } from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { buildProductionWalletCohort } from "@/lib/walletLedger/indexed/shadow/productionWalletCohort";
import {
  recoverClassDEventsForWallet,
  type ClassDRecoveryReport,
} from "@/lib/walletLedger/indexed/store/classDRecovery";
import {
  filterChainAuthoritativeEvents,
} from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import { loadPersistedWalletEvents } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import { assessUnresolvedChainOrder } from "@/lib/walletLedger/indexed/store/unresolvedChainOrder";
import {
  compareReplayToSnapshot,
  lifecycleEpisodeKey,
  prepareAuthoritativeEventsForLifecycleMerge,
  replayMetricsFromValidationSnapshot,
  type WalletValidationSnapshot,
} from "@/lib/walletLedger/indexed/store/validationSnapshot";
import { classifyChainEventIdentity } from "@/lib/walletLedger/canonicalChainIdentity";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

const RECOVERY_ORDER = (
  process.env.ONLY_WALLETS
    ? process.env.ONLY_WALLETS.split(",").map((w) => w.trim().toLowerCase())
    : [
        "0x40b96182a35fbe3c2bb4162e036ecf0c786db002",
        "0x4e56f1ddaa8f5328036c449b89e731ec748cdee1",
        "0x2a69660046d7acc4ab204d7cc5ba78b0776cd2f7",
      ]
).filter(Boolean);

const APPLY = process.env.DRY_RUN !== "1";

function loadLatestSnapshot(wallet: string): WalletValidationSnapshot | null {
  const dir = join(process.cwd(), ".cache", "wallet-validation-snapshots");
  const prefix = wallet.toLowerCase();
  const match = readdirSync(dir)
    .filter((file) => file.startsWith(prefix))
    .sort()
    .at(-1);
  if (!match) return null;
  return JSON.parse(
    readFileSync(join(dir, match), "utf8")
  ) as WalletValidationSnapshot;
}

function countClassD(events: WalletLedgerEvent[]): number {
  return filterChainAuthoritativeEvents(events).filter(
    (event) => classifyChainEventIdentity(event) === "unresolved_chain_log"
  ).length;
}

async function verifyExactReplay(
  wallet: string,
  snapshot: WalletValidationSnapshot
) {
  const persisted = await loadPersistedWalletEvents(wallet);
  const persistedChain = prepareAuthoritativeEventsForLifecycleMerge(
    filterChainAuthoritativeEvents(persisted)
  );

  const replayA = await replayMetricsFromValidationSnapshot(snapshot, {
    frozen: true,
  });
  const replayB = await replayMetricsFromValidationSnapshot(snapshot, {
    chainEventsOverride: persistedChain,
    frozen: true,
  });
  const comparison = compareReplayToSnapshot(snapshot, replayB);

  const exactReplayPass =
    !replayA.inputMismatch &&
    !replayB.inputMismatch &&
    comparison.exactMatch &&
    replayB.replayLifecycleInputSequenceHash ===
      replayA.replayLifecycleInputSequenceHash &&
    replayB.replayLifecycleInputEventCount ===
      replayA.replayLifecycleInputEventCount;

  return {
    replayA,
    replayB,
    comparison,
    exactReplayPass,
    persistedChainCount: persistedChain.length,
  };
}

async function updateWalletMetricsFromReplay(
  wallet: string,
  replay: Awaited<ReturnType<typeof replayMetricsFromValidationSnapshot>>
): Promise<void> {
  const metrics = replay.fullLedgerMetrics;
  const db = getDb();
  await db
    .update(walletHistoricalMetrics)
    .set({
      completedPositions: metrics.completedPositionCount,
      medianCapitalAtRisk: metrics.medianCapitalAtRisk,
      resolvedVolumeUsd: metrics.resolvedVolumeUsd,
      profitablePositionRate: metrics.profitablePositionRate,
      outcomeWinRate: metrics.outcomeWinRate,
      realizedRoi: metrics.portfolioRealizedRoi,
      credibilityMetricsValid: metrics.credibilityMetricsValid,
      credibilityDecision: metrics.credibilityMetricsValid,
      historyValidity: metrics.historyValidity,
      historyComplete: metrics.historyComplete,
      credibilityReasons: metrics.historyCompletenessReasons,
      historyIncompleteReasons: metrics.historyCompletenessReasons,
      calculatedAt: new Date(),
    })
    .where(eq(walletHistoricalMetrics.walletAddress, wallet));

  const verdict = evaluateHistoricalPerformanceVerdict({
    indexedDataValidity: metrics.credibilityMetricsValid,
    historyValidity: metrics.historyValidity,
    historyComplete: metrics.historyComplete,
    completedPositionCount: metrics.completedPositionCount,
    realizedRoi: metrics.portfolioRealizedRoi,
    profitablePositionRate: metrics.profitablePositionRate,
    metricVersion: WALLET_METRIC_VERSION,
  }).historicalPerformanceDecision;

  await db
    .update(policyAProductionWalletHydration)
    .set({
      completedPositions: metrics.completedPositionCount,
      historyValidity: metrics.historyValidity,
      policyADecision: verdict,
      updatedAt: new Date(),
    })
    .where(eq(policyAProductionWalletHydration.walletAddress, wallet));
}

async function recoverWallet(wallet: string) {
  const normalized = wallet.toLowerCase();
  const snapshot = loadLatestSnapshot(wallet);
  if (!snapshot) {
    throw new Error(`missing validation snapshot for ${wallet}`);
  }

  const beforeEvents = await loadPersistedWalletEvents(normalized);
  const beforeClassD = countClassD(beforeEvents);
  const beforeUnresolved = assessUnresolvedChainOrder(beforeEvents);

  const recovery = await recoverClassDEventsForWallet(normalized, {
    apply: APPLY,
  });

  const afterEvents = await loadPersistedWalletEvents(normalized);
  const afterUnresolved = assessUnresolvedChainOrder(afterEvents);
  const replay = await verifyExactReplay(normalized, snapshot);

  if (APPLY && replay.exactReplayPass) {
    await updateWalletMetricsFromReplay(normalized, replay.replayB);
  }

  const correctedVerdict = evaluateHistoricalPerformanceVerdict({
    indexedDataValidity: replay.replayB.metrics.credibilityMetricsValid,
    historyValidity: replay.replayB.metrics.historyValidity,
    completedPositionCount: replay.replayB.metrics.completedPositions,
    realizedRoi: replay.replayB.metrics.realizedRoi,
    profitablePositionRate: replay.replayB.metrics.profitablePositionRate,
    metricVersion: WALLET_METRIC_VERSION,
  }).historicalPerformanceDecision;

  return {
    wallet: normalized,
    beforeClassD,
    beforeUnresolved,
    recovery,
    afterUnresolved,
    replay: {
      exactReplayPass: replay.exactReplayPass,
      comparison: replay.comparison,
      metrics: replay.replayB.metrics,
      lifecycleEpisodeKeys: replay.replayB.positions.map(lifecycleEpisodeKey).sort(),
      snapshotEpisodeKeys: snapshot.lifecycleEpisodeKeys,
    },
    corrected: {
      historyValidity: replay.replayB.metrics.historyValidity,
      credibilityMetricsValid: replay.replayB.metrics.credibilityMetricsValid,
      policyAVerdict: correctedVerdict,
      unresolvedChainEventsInLifecycle:
        afterUnresolved.unresolvedChainEventsInLifecycle,
      reasons: replay.replayB.fullLedgerMetrics.historyCompletenessReasons,
    },
  };
}

async function main(): Promise<void> {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL not configured");
    process.exit(1);
  }

  const wallets = [];
  for (const wallet of RECOVERY_ORDER) {
    console.error(`[class-d-recovery] processing ${wallet} apply=${APPLY}`);
    try {
      wallets.push(await recoverWallet(wallet));
    } catch (error) {
      wallets.push({
        wallet: wallet.toLowerCase(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const cohort = await buildProductionWalletCohort();

  const report = {
    mode: "policy_a_class_d_recovery",
    generatedAt: new Date().toISOString(),
    apply: APPLY,
    wallets,
    cohort: {
      measuredPreBatch2: { total: 77, pass: 11, fail: 27, unknown: 39 },
      measuredPostBatch2BeforeClassD: { total: 77, pass: 13, fail: 30, unknown: 34 },
      correctedCurrent: {
        total: cohort.totalWallets,
        pass: cohort.policyAPass,
        fail: cohort.policyAFail,
        unknown: cohort.policyAUnknown,
      },
      note: "correctedCurrent uses durable DB metrics after recovery updates",
    },
    recommendation:
      wallets.every(
        (w) =>
          "corrected" in w &&
          w.corrected.unresolvedChainEventsInLifecycle === 0 &&
          w.replay?.exactReplayPass === true
      )
        ? "READY_FOR_BATCH_3_CONCURRENCY_2"
        : "FIX_REQUIRED",
  };

  const outDir = join(process.cwd(), ".cache");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "policy-a-class-d-recovery.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.error(`\n[wrote] ${outPath}`);
}

void main().catch((error) => {
  console.error("[policy-a-class-d-recovery] failed:", error);
  process.exit(1);
});
