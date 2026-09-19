import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  policyAProductionWalletHydration,
  walletHistoricalMetrics,
} from "@/lib/crossmarket/store/schema";
import { evaluateHistoricalPerformanceVerdict } from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import {
  compareReplayToSnapshot,
  replayMetricsFromValidationSnapshot,
  type ReplayValidationSnapshotResult,
  type WalletValidationSnapshot,
} from "@/lib/walletLedger/indexed/store/validationSnapshot";

export interface DurableValidityRefreshResult {
  wallet: string;
  exactReplayPass: boolean;
  lifecycleSequenceHashMatch: boolean;
  historyValidity: string;
  credibilityMetricsValid: boolean;
  policyADecision: string;
  reasons: string[];
  metricsPreserved: {
    completedPositions: number;
    realizedRoi: number;
    profitablePositionRate: number;
  };
}

export async function verifySnapshotExactReplay(
  snapshot: WalletValidationSnapshot
): Promise<{
  replay: ReplayValidationSnapshotResult;
  exactReplayPass: boolean;
  lifecycleSequenceHashMatch: boolean;
}> {
  const replay = await replayMetricsFromValidationSnapshot(snapshot, {
    frozen: true,
  });
  const comparison = compareReplayToSnapshot(snapshot, replay);
  const lifecycleSequenceHashMatch =
    replay.replayLifecycleInputSequenceHash ===
    snapshot.auditLifecycleInputSequenceHash;
  const exactReplayPass =
    lifecycleSequenceHashMatch && comparison.exactMatch;
  return { replay, exactReplayPass, lifecycleSequenceHashMatch };
}

export async function commitFailClosedValidityFromSnapshot(
  wallet: string,
  snapshot: WalletValidationSnapshot,
  options: {
    preservePerformanceMetrics?: boolean;
    requireExactReplay?: boolean;
  } = {}
): Promise<DurableValidityRefreshResult> {
  const normalized = wallet.toLowerCase();
  const { replay, exactReplayPass, lifecycleSequenceHashMatch } =
    await verifySnapshotExactReplay(snapshot);
  if (options.requireExactReplay !== false && !exactReplayPass) {
    throw new Error(
      `exact replay failed for ${normalized}: lifecycleHash=${lifecycleSequenceHashMatch}`
    );
  }

  const metrics = replay.fullLedgerMetrics;
  const reasons = metrics.historyCompletenessReasons;
  const policyADecision = evaluateHistoricalPerformanceVerdict({
    indexedDataValidity: metrics.credibilityMetricsValid,
    historyValidity: metrics.historyValidity,
    historyComplete: metrics.historyComplete,
    completedPositionCount: metrics.completedPositionCount,
    realizedRoi: metrics.portfolioRealizedRoi,
    profitablePositionRate: metrics.profitablePositionRate,
    metricVersion: WALLET_METRIC_VERSION,
  }).historicalPerformanceDecision;

  const preservePerformanceMetrics = options.preservePerformanceMetrics !== false;
  const db = getDb();
  await db
    .update(walletHistoricalMetrics)
    .set({
      ...(preservePerformanceMetrics
        ? {
            completedPositions: metrics.completedPositionCount,
            medianCapitalAtRisk: metrics.medianCapitalAtRisk,
            resolvedVolumeUsd: metrics.resolvedVolumeUsd,
            profitablePositionRate: metrics.profitablePositionRate,
            outcomeWinRate: metrics.outcomeWinRate,
            realizedRoi: metrics.portfolioRealizedRoi,
          }
        : {}),
      credibilityMetricsValid: metrics.credibilityMetricsValid,
      credibilityDecision: metrics.credibilityMetricsValid,
      historyValidity: metrics.historyValidity,
      historyComplete: metrics.historyComplete,
      credibilityReasons: reasons,
      historyIncompleteReasons: reasons,
      calculatedAt: new Date(),
    })
    .where(
      and(
        eq(walletHistoricalMetrics.walletAddress, normalized),
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
      )
    );

  await db
    .update(policyAProductionWalletHydration)
    .set({
      completedPositions: metrics.completedPositionCount,
      historyValidity: metrics.historyValidity,
      policyADecision,
      updatedAt: new Date(),
    })
    .where(eq(policyAProductionWalletHydration.walletAddress, normalized));

  return {
    wallet: normalized,
    exactReplayPass,
    lifecycleSequenceHashMatch,
    historyValidity: metrics.historyValidity,
    credibilityMetricsValid: metrics.credibilityMetricsValid,
    policyADecision,
    reasons,
    metricsPreserved: {
      completedPositions: metrics.completedPositionCount ?? 0,
      realizedRoi: metrics.portfolioRealizedRoi ?? 0,
      profitablePositionRate: metrics.profitablePositionRate ?? 0,
    },
  };
}

export function assessClassDRecoveryQueueStatus(input: {
  lifecycleRelevantUnresolved: number;
  lifecycleClassDBefore: number;
}): "not_needed" | "pending" | "partial" | "complete" {
  if (input.lifecycleClassDBefore <= 0) return "not_needed";
  if (input.lifecycleRelevantUnresolved <= 0) return "complete";
  const recovered =
    input.lifecycleClassDBefore - input.lifecycleRelevantUnresolved;
  if (recovered <= 0) return "pending";
  return "partial";
}
