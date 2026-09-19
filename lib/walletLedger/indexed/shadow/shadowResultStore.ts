import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { walletShadowResults } from "@/lib/crossmarket/store/schema";
import { recordDbSuccess } from "@/lib/walletLedger/indexed/shadow/dbCircuitBreaker";
import { retryTransient } from "@/lib/walletLedger/indexed/shadow/transientRetry";
import { QUERY_PLAN_VERSION } from "@/lib/walletLedger/indexed/checkpoint";
import { enrichShadowWalletWithHistoricalPerformance } from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import type { ProductionCredibilitySnapshot } from "@/lib/walletLedger/indexed/shadow/productionProbe";
import type {
  ShadowDisagreementReason,
  ShadowWalletComparison,
} from "@/lib/walletLedger/indexed/shadow/taxonomy";

export type ShadowObservationSource =
  | "captured_evaluation"
  | "cohort_gate_snapshot"
  | "persisted_indexed_audit"
  | "reconstructed_production_decision"
  | "comparison_metadata_missing";

export interface ShadowWalletObservation {
  batchId: string;
  wallet: string;
  label: string;
  cohortReason: string;
  executionStatus: ShadowWalletComparison["status"];
  historyValidity: string;
  historyComplete: boolean;
  credibilityMetricsValid: boolean;
  productionDecision: boolean | null;
  productionReasons: ShadowDisagreementReason[];
  productionMetricsSnapshot: Record<string, unknown> | null;
  apiReconstructedDecision: boolean | null;
  apiReasons: ShadowDisagreementReason[];
  apiMetricsSnapshot: Record<string, unknown> | null;
  indexedDecision: boolean;
  indexedReasons: ShadowDisagreementReason[];
  indexedMetricsSnapshot: Record<string, unknown> | null;
  evidence: Record<string, unknown>;
  comparisonMetadataMissing: boolean;
  productionObservationSource: ShadowObservationSource;
  apiObservationSource: ShadowObservationSource;
  indexedObservationSource: ShadowObservationSource;
  metricVersion: string;
  queryPlanVersion: string;
  evaluatedAt: string | null;
  performance?: Record<string, unknown>;
  error?: string;
}

export function observationFromComparisonRow(
  batchId: string,
  row: ShadowWalletComparison,
  sources: {
    production: ShadowObservationSource;
    api: ShadowObservationSource;
    indexed: ShadowObservationSource;
  }
): ShadowWalletObservation {
  const missing =
    (sources.production === "comparison_metadata_missing" &&
      row.productionDecision == null) ||
    sources.indexed === "comparison_metadata_missing";
  return {
    batchId,
    wallet: row.wallet.toLowerCase(),
    label: row.label,
    cohortReason: row.cohortReason,
    executionStatus: row.status,
    historyValidity: row.historyValidity,
    historyComplete: row.historyComplete,
    credibilityMetricsValid: row.credibilityMetricsValid,
    productionDecision: row.productionDecision,
    productionReasons: row.productionReasons,
    productionMetricsSnapshot: {
      productionResolvedPositions: row.evidence.productionResolvedPositions ?? null,
      productionAvgEv: row.evidence.productionAvgEv ?? null,
      hydrationStatus: row.evidence.hydrationStatus ?? null,
    },
    apiReconstructedDecision: row.apiReconstructedDecision,
    apiReasons: row.apiReasons,
    apiMetricsSnapshot: {
      apiEvents: row.evidence.apiEvents ?? null,
      apiReconstructedCompletedPositions:
        row.evidence.apiReconstructedCompletedPositions ?? null,
      apiReconstructedRoi: row.evidence.apiReconstructedRoi ?? null,
    },
    indexedDecision: row.indexedDecision,
    indexedReasons: row.reasons,
    indexedMetricsSnapshot: {
      indexedEvents: row.evidence.indexedEvents ?? null,
      indexedCompletedPositions: row.evidence.indexedCompletedPositions ?? null,
      indexedRealizedRoi: row.evidence.indexedRealizedRoi ?? null,
      indexedProfitablePositionRate:
        row.evidence.indexedProfitablePositionRate ?? null,
      eventsBeforeApiBoundary: row.evidence.eventsBeforeApiBoundary ?? null,
      timestampCoveragePct: row.evidence.timestampCoveragePct ?? null,
      indexedDataValidityDecision: row.indexedDataValidityDecision ?? null,
      historicalPerformanceDecision: row.historicalPerformanceDecision ?? null,
      historicalPerformanceFailureReasons:
        row.historicalPerformanceFailureReasons ?? [],
      historicalPerformancePolicyVersion:
        row.historicalPerformancePolicyVersion ?? null,
    },
    evidence: row.evidence as Record<string, unknown>,
    comparisonMetadataMissing: missing,
    productionObservationSource: sources.production,
    apiObservationSource: sources.api,
    indexedObservationSource: sources.indexed,
    metricVersion: WALLET_METRIC_VERSION,
    queryPlanVersion: QUERY_PLAN_VERSION,
    evaluatedAt: new Date().toISOString(),
    performance: row.performance as Record<string, unknown> | undefined,
    error: row.error,
  };
}

export function comparisonRowFromObservation(
  observation: ShadowWalletObservation
): ShadowWalletComparison {
  const productionAgreement =
    observation.productionDecision === observation.indexedDecision;
  const apiAgreement =
    observation.apiReconstructedDecision === observation.indexedDecision;
  const row: ShadowWalletComparison = {
    wallet: observation.wallet,
    label: observation.label,
    cohortReason: observation.cohortReason,
    productionDecision: observation.productionDecision,
    apiReconstructedDecision: observation.apiReconstructedDecision,
    indexedDecision: observation.indexedDecision,
    productionCredible: observation.productionDecision,
    indexedCredible: observation.indexedDecision,
    productionAgreement,
    apiAgreement,
    agreement: productionAgreement,
    primaryReason: observation.productionReasons[0] ?? "other",
    productionReasons: observation.productionReasons,
    apiReasons: observation.apiReasons,
    reasons: observation.indexedReasons,
    evidence: {
      ...observation.evidence,
      productionDecision: observation.productionDecision,
      apiReconstructedDecision: observation.apiReconstructedDecision,
      indexedDecision: observation.indexedDecision,
      comparisonMetadataMissing: observation.comparisonMetadataMissing,
      productionObservationSource: observation.productionObservationSource,
      apiObservationSource: observation.apiObservationSource,
      indexedObservationSource: observation.indexedObservationSource,
      ...(observation.productionMetricsSnapshot ?? {}),
      ...(observation.apiMetricsSnapshot ?? {}),
      ...(observation.indexedMetricsSnapshot ?? {}),
    },
    historyValidity: observation.historyValidity,
    historyComplete: observation.historyComplete,
    credibilityMetricsValid: observation.credibilityMetricsValid,
    status: observation.executionStatus,
    error: observation.error,
    performance: observation.performance as ShadowWalletComparison["performance"],
  };
  const snapshot = observation.indexedMetricsSnapshot ?? {};
  row.indexedDataValidityDecision =
    (snapshot.indexedDataValidityDecision as ShadowWalletComparison["indexedDataValidityDecision"]) ??
    (row.indexedDecision ? "PASS" : "FAIL");
  row.historicalPerformanceDecision =
    snapshot.historicalPerformanceDecision as ShadowWalletComparison["historicalPerformanceDecision"];
  row.historicalPerformanceFailureReasons =
    (snapshot.historicalPerformanceFailureReasons as ShadowWalletComparison["historicalPerformanceFailureReasons"]) ??
    [];
  row.historicalPerformancePolicyVersion =
    (snapshot.historicalPerformancePolicyVersion as string | undefined) ??
    undefined;
  if (row.historicalPerformanceDecision == null) {
    return enrichShadowWalletWithHistoricalPerformance(row, {
      completedPositions:
        (snapshot.indexedCompletedPositions as number | null | undefined) ?? null,
      realizedRoi: (snapshot.indexedRealizedRoi as number | null | undefined) ?? null,
      profitablePositionRate:
        (snapshot.indexedProfitablePositionRate as number | null | undefined) ??
        null,
      metricVersion: observation.metricVersion,
    });
  }
  return row;
}

export function observationFromProductionSnapshot(
  production: ProductionCredibilitySnapshot
): Pick<
  ShadowWalletObservation,
  "productionDecision" | "productionReasons" | "productionMetricsSnapshot"
> {
  return {
    productionDecision: production.productionCredible,
    productionReasons:
      production.productionGateReason === "ok"
        ? []
        : [production.productionGateReason as ShadowDisagreementReason],
    productionMetricsSnapshot: {
      productionResolvedPositions: production.resolvedBetsCount,
      productionAvgEv: production.avgEv,
      hydrationStatus: production.hydrationStatus,
      avgStakeNotional: production.avgStakeNotional,
      winRate: production.winRate,
      hydratedAt: production.hydratedAt,
    },
  };
}

async function upsertShadowWalletObservationOnce(
  observation: ShadowWalletObservation
): Promise<void> {
  const db = getDb();
  await db
    .insert(walletShadowResults)
    .values({
      batchId: observation.batchId,
      walletAddress: observation.wallet.toLowerCase(),
      label: observation.label,
      cohortReason: observation.cohortReason,
      executionStatus: observation.executionStatus,
      historyValidity: observation.historyValidity,
      historyComplete: observation.historyComplete,
      credibilityMetricsValid: observation.credibilityMetricsValid,
      productionDecision: observation.productionDecision,
      productionReasons: observation.productionReasons,
      productionMetricsSnapshot: observation.productionMetricsSnapshot,
      apiReconstructedDecision: observation.apiReconstructedDecision,
      apiReasons: observation.apiReasons,
      apiMetricsSnapshot: observation.apiMetricsSnapshot,
      indexedDecision: observation.indexedDecision,
      indexedReasons: observation.indexedReasons,
      indexedMetricsSnapshot: observation.indexedMetricsSnapshot,
      evidence: observation.evidence,
      comparisonMetadataMissing: observation.comparisonMetadataMissing,
      productionObservationSource: observation.productionObservationSource,
      apiObservationSource: observation.apiObservationSource,
      indexedObservationSource: observation.indexedObservationSource,
      metricVersion: observation.metricVersion,
      queryPlanVersion: observation.queryPlanVersion,
      evaluatedAt: observation.evaluatedAt
        ? new Date(observation.evaluatedAt)
        : null,
      performance: observation.performance,
    })
    .onConflictDoUpdate({
      target: [walletShadowResults.batchId, walletShadowResults.walletAddress],
      set: {
        label: sql`excluded.label`,
        cohortReason: sql`excluded.cohort_reason`,
        executionStatus: sql`excluded.execution_status`,
        historyValidity: sql`excluded.history_validity`,
        historyComplete: sql`excluded.history_complete`,
        credibilityMetricsValid: sql`excluded.credibility_metrics_valid`,
        productionDecision: sql`excluded.production_decision`,
        productionReasons: sql`excluded.production_reasons`,
        productionMetricsSnapshot: sql`excluded.production_metrics_snapshot`,
        apiReconstructedDecision: sql`excluded.api_reconstructed_decision`,
        apiReasons: sql`excluded.api_reasons`,
        apiMetricsSnapshot: sql`excluded.api_metrics_snapshot`,
        indexedDecision: sql`excluded.indexed_decision`,
        indexedReasons: sql`excluded.indexed_reasons`,
        indexedMetricsSnapshot: sql`excluded.indexed_metrics_snapshot`,
        evidence: sql`excluded.evidence`,
        comparisonMetadataMissing: sql`excluded.comparison_metadata_missing`,
        productionObservationSource: sql`excluded.production_observation_source`,
        apiObservationSource: sql`excluded.api_observation_source`,
        indexedObservationSource: sql`excluded.indexed_observation_source`,
        metricVersion: sql`excluded.metric_version`,
        queryPlanVersion: sql`excluded.query_plan_version`,
        evaluatedAt: sql`excluded.evaluated_at`,
        performance: sql`excluded.performance`,
        updatedAt: sql`now()`,
      },
    });
}

export async function upsertShadowWalletObservation(
  observation: ShadowWalletObservation
): Promise<void> {
  await retryTransient(() => upsertShadowWalletObservationOnce(observation), {
    maxAttempts: 4,
    label: "upsertShadowWalletObservation",
  });
  recordDbSuccess();
}

export async function loadShadowWalletObservations(
  batchId: string
): Promise<Map<string, ShadowWalletObservation>> {
  const db = getDb();
  const rows = await db
    .select()
    .from(walletShadowResults)
    .where(sql`${walletShadowResults.batchId} = ${batchId}`);
  const map = new Map<string, ShadowWalletObservation>();
  for (const row of rows) {
    map.set(row.walletAddress.toLowerCase(), {
      batchId: row.batchId,
      wallet: row.walletAddress.toLowerCase(),
      label: row.label ?? row.walletAddress,
      cohortReason: row.cohortReason ?? "",
      executionStatus: row.executionStatus as ShadowWalletComparison["status"],
      historyValidity: row.historyValidity,
      historyComplete: row.historyComplete,
      credibilityMetricsValid: row.credibilityMetricsValid,
      productionDecision: row.productionDecision ?? null,
      productionReasons: (row.productionReasons ?? []) as ShadowDisagreementReason[],
      productionMetricsSnapshot:
        (row.productionMetricsSnapshot as Record<string, unknown> | null) ?? null,
      apiReconstructedDecision: row.apiReconstructedDecision ?? null,
      apiReasons: (row.apiReasons ?? []) as ShadowDisagreementReason[],
      apiMetricsSnapshot:
        (row.apiMetricsSnapshot as Record<string, unknown> | null) ?? null,
      indexedDecision: row.indexedDecision,
      indexedReasons: (row.indexedReasons ?? []) as ShadowDisagreementReason[],
      indexedMetricsSnapshot:
        (row.indexedMetricsSnapshot as Record<string, unknown> | null) ?? null,
      evidence: (row.evidence as Record<string, unknown>) ?? {},
      comparisonMetadataMissing: row.comparisonMetadataMissing,
      productionObservationSource:
        (row.productionObservationSource as ShadowObservationSource) ??
        "comparison_metadata_missing",
      apiObservationSource:
        (row.apiObservationSource as ShadowObservationSource) ??
        "comparison_metadata_missing",
      indexedObservationSource:
        (row.indexedObservationSource as ShadowObservationSource) ??
        "comparison_metadata_missing",
      metricVersion: row.metricVersion ?? WALLET_METRIC_VERSION,
      queryPlanVersion: row.queryPlanVersion ?? QUERY_PLAN_VERSION,
      evaluatedAt: row.evaluatedAt?.toISOString() ?? null,
      performance: (row.performance as Record<string, unknown> | undefined) ?? undefined,
    });
  }
  return map;
}

export async function loadShadowWalletObservationsAsRows(
  batchId: string
): Promise<ShadowWalletComparison[]> {
  const observations = await loadShadowWalletObservations(batchId);
  return [...observations.values()].map(comparisonRowFromObservation);
}
