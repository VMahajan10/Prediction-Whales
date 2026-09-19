import { enrichShadowWalletWithHistoricalPerformance } from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import type { EnrichedCohortWallet } from "@/lib/walletLedger/indexed/shadow/cohortV2";
import type {
  CredibilityConfusionMatrix,
  ShadowWalletComparison,
} from "@/lib/walletLedger/indexed/shadow/taxonomy";
import type { ShadowBatchSummary } from "@/lib/walletLedger/indexed/shadow/report";

export type ProductionGate = "pass" | "fail" | "unknown";

export interface CohortProductionSpec {
  wallet: string;
  label: string;
  cohortReason: string;
  productionGate?: ProductionGate;
  productionFailureReason?: string;
}

export interface PersistedShadowDecisions {
  productionDecision?: boolean | null;
  apiReconstructedDecision?: boolean | null;
  indexedDecision?: boolean;
}

export interface IndexedMetricsSnapshot {
  credibilityDecision: boolean;
  historyValidity: string;
  historyComplete: boolean;
  credibilityReasons: string[];
  completedPositions: number;
  medianCapitalAtRisk: number | null;
  resolvedVolumeUsd: number | null;
  realizedRoi: number | null;
  profitablePositionRate: number | null;
}

export interface WalletProductionReconciliationRow {
  wallet: string;
  cohortProductionDecision: boolean | null;
  cohortProductionReason: string;
  shadowProductionDecision: boolean | null;
  apiDecision: boolean | null;
  indexedDecision: boolean;
  historyValidity: string;
  executionStatus: string;
  metricsSafe: boolean;
  cohortReason: string;
  productionDecisionMismatch: boolean;
  mismatchExplanation?: string;
}

export class ShadowReportReconciliationError extends Error {
  constructor(public readonly violations: string[]) {
    super(`Shadow report reconciliation failed:\n- ${violations.join("\n- ")}`);
    this.name = "ShadowReportReconciliationError";
  }
}

export function productionGateToDecision(
  gate: ProductionGate | undefined
): boolean | null {
  if (gate === "pass") return true;
  if (gate === "fail") return false;
  return null;
}

export function productionGateLabel(gate: ProductionGate | undefined): string {
  if (gate === "pass") return "PASS";
  if (gate === "fail") return "FAIL";
  return "UNKNOWN";
}

export function isResumeMergedStubRow(row: ShadowWalletComparison): boolean {
  return Object.keys(row.evidence ?? {}).length === 0;
}

export function readPersistedShadowDecisions(
  performance: Record<string, unknown> | null | undefined
): PersistedShadowDecisions | null {
  const raw = performance?.shadowDecisions;
  if (!raw || typeof raw !== "object") return null;
  const decisions = raw as PersistedShadowDecisions;
  return {
    productionDecision: decisions.productionDecision ?? null,
    apiReconstructedDecision: decisions.apiReconstructedDecision ?? null,
    indexedDecision: decisions.indexedDecision ?? false,
  };
}

export function resolveAuthoritativeProductionDecision(
  cohortGate: ProductionGate | undefined
): boolean | null {
  return productionGateToDecision(cohortGate);
}

export function hydrateShadowComparisonRow(
  row: ShadowWalletComparison,
  cohort: CohortProductionSpec,
  indexedMetrics?: IndexedMetricsSnapshot | null
): ShadowWalletComparison {
  const authoritativeA = resolveAuthoritativeProductionDecision(
    cohort.productionGate
  );
  const persisted = readPersistedShadowDecisions(row.performance ?? null);
  const stub = isResumeMergedStubRow(row);

  let apiReconstructedDecision =
    row.apiReconstructedDecision ?? persisted?.apiReconstructedDecision ?? null;
  let indexedDecision =
    row.indexedDecision ?? persisted?.indexedDecision ?? false;
  let historyValidity = row.historyValidity;
  let credibilityMetricsValid = row.credibilityMetricsValid;
  let evidence = row.evidence ?? {};

  if (indexedMetrics && stub) {
    indexedDecision = indexedMetrics.credibilityDecision;
    if (row.status === "complete") {
      historyValidity = indexedMetrics.historyValidity;
    }
    credibilityMetricsValid = indexedMetrics.credibilityDecision;
    evidence = {
      ...evidence,
      indexedCompletedPositions: indexedMetrics.completedPositions,
      indexedRealizedRoi: indexedMetrics.realizedRoi,
      indexedProfitablePositionRate: indexedMetrics.profitablePositionRate,
      productionDecision: authoritativeA,
      apiReconstructedDecision,
      indexedDecision,
      historyValidity: indexedMetrics.historyValidity,
    };
  }

  return enrichShadowWalletWithHistoricalPerformance(
    {
      ...row,
      productionDecision: authoritativeA,
      productionCredible: authoritativeA,
      apiReconstructedDecision,
      indexedDecision,
      indexedCredible: indexedDecision,
      productionAgreement: authoritativeA === indexedDecision,
      apiAgreement: apiReconstructedDecision === indexedDecision,
      agreement: authoritativeA === indexedDecision,
      historyValidity,
      credibilityMetricsValid,
      evidence,
    },
    indexedMetrics
      ? {
          completedPositions: indexedMetrics.completedPositions,
          realizedRoi: indexedMetrics.realizedRoi,
          profitablePositionRate: indexedMetrics.profitablePositionRate,
        }
      : undefined
  );
}

export function hydrateShadowRowsForReport(
  rows: ShadowWalletComparison[],
  cohort: CohortProductionSpec[],
  indexedMetricsByWallet: Map<string, IndexedMetricsSnapshot> = new Map()
): ShadowWalletComparison[] {
  const cohortByWallet = new Map(
    cohort.map((spec) => [spec.wallet.toLowerCase(), spec])
  );
  return rows.map((row) => {
    const spec = cohortByWallet.get(row.wallet.toLowerCase());
    if (!spec) return row;
    return hydrateShadowComparisonRow(
      row,
      spec,
      indexedMetricsByWallet.get(row.wallet.toLowerCase()) ?? null
    );
  });
}

export function buildWalletProductionReconciliationTable(
  cohort: CohortProductionSpec[],
  rows: ShadowWalletComparison[]
): WalletProductionReconciliationRow[] {
  const rowByWallet = new Map(
    rows.map((row) => [row.wallet.toLowerCase(), row])
  );
  return cohort.map((spec) => {
    const row = rowByWallet.get(spec.wallet.toLowerCase());
    const cohortProductionDecision = productionGateToDecision(spec.productionGate);
    const shadowProductionDecision = row?.productionDecision ?? null;
    const mismatch =
      row != null && shadowProductionDecision !== cohortProductionDecision;
    let mismatchExplanation: string | undefined;
    if (mismatch) {
      if (row && isResumeMergedStubRow(row) && shadowProductionDecision == null) {
        mismatchExplanation =
          "resume merge stub dropped productionDecision; authoritative value is cohort productionGate";
      } else {
        mismatchExplanation =
          "shadow row productionDecision differs from cohort productionGate snapshot";
      }
    }
    return {
      wallet: spec.wallet,
      cohortProductionDecision,
      cohortProductionReason: spec.productionFailureReason ?? "unknown",
      shadowProductionDecision,
      apiDecision: row?.apiReconstructedDecision ?? null,
      indexedDecision: row?.indexedDecision ?? false,
      historyValidity: row?.historyValidity ?? "unusable",
      executionStatus: row?.status ?? "not_attempted",
      metricsSafe: row?.status === "complete",
      cohortReason: spec.cohortReason,
      productionDecisionMismatch: mismatch,
      mismatchExplanation,
    };
  });
}

export function assertShadowReportReconciliation(input: {
  summary: ShadowBatchSummary;
  cohort: CohortProductionSpec[];
  rows: ShadowWalletComparison[];
}): void {
  const violations: string[] = [];
  const { summary, cohort } = input;

  if (
    summary.productionPass + summary.productionFail + summary.productionUnknown !==
    summary.metricsSafe
  ) {
    violations.push(
      `metrics-safe production PASS+FAIL+UNKNOWN (${summary.productionPass + summary.productionFail + summary.productionUnknown}) != metricsSafe (${summary.metricsSafe})`
    );
  }

  if (summary.productionPass > summary.cohortProductionPass) {
    violations.push(
      `metrics-safe production PASS (${summary.productionPass}) > cohort PASS (${summary.cohortProductionPass})`
    );
  }
  if (summary.productionFail > summary.cohortProductionFail) {
    violations.push(
      `metrics-safe production FAIL (${summary.productionFail}) > cohort FAIL (${summary.cohortProductionFail})`
    );
  }
  if (summary.productionUnknown > summary.cohortProductionUnknown) {
    violations.push(
      `metrics-safe production UNKNOWN (${summary.productionUnknown}) > cohort UNKNOWN (${summary.cohortProductionUnknown})`
    );
  }

  const metricsSafe = summary.metricsSafe;
  const indexedPass = summary.indexedPass;
  const indexedFail = summary.indexedFail;

  if (indexedPass + indexedFail !== metricsSafe) {
    violations.push(
      `indexed PASS+FAIL (${indexedPass + indexedFail}) != metricsSafe (${metricsSafe})`
    );
  }

  if (
    input.summary.cohortProductionPass +
      input.summary.cohortProductionFail +
      input.summary.cohortProductionUnknown !==
    input.summary.cohortSelected
  ) {
    violations.push("cohort PASS+FAIL+UNKNOWN != cohortSelected");
  }

  const attemptedTotal =
    input.summary.metricsSafe +
    input.summary.metricsUnsafe +
    input.summary.unusableValidity +
    input.summary.infraFailed +
    input.summary.walletFailed +
    input.summary.deferredInfra +
    input.summary.notAttempted;
  if (attemptedTotal !== input.summary.cohortSelected) {
    violations.push(
      `outcome buckets (${attemptedTotal}) != cohortSelected (${input.summary.cohortSelected})`
    );
  }

  const productionMatrix = summary.productionVsIndexed;
  const knownCells =
    productionMatrix.passToPass +
    productionMatrix.passToFail +
    productionMatrix.failToPass +
    productionMatrix.failToFail;
  if (knownCells !== productionMatrix.nKnown) {
    violations.push(
      `production matrix known cells (${knownCells}) != nKnownProduction (${productionMatrix.nKnown})`
    );
  }
  const unknownCells = productionMatrix.nullToPass + productionMatrix.nullToFail;
  if (unknownCells !== productionMatrix.nUnknown) {
    violations.push(
      `production matrix NULL cells (${unknownCells}) != nUnknownProduction (${productionMatrix.nUnknown})`
    );
  }
  if (productionMatrix.nKnown + productionMatrix.nUnknown !== productionMatrix.nMetricsSafeTotal) {
    violations.push(
      `nKnownProduction + nUnknownProduction != nMetricsSafeTotal for production matrix`
    );
  }

  const apiMatrix = summary.apiVsIndexed;
  const apiKnownCells =
    apiMatrix.passToPass +
    apiMatrix.passToFail +
    apiMatrix.failToPass +
    apiMatrix.failToFail;
  if (apiKnownCells !== apiMatrix.nKnown) {
    violations.push(
      `api matrix known cells (${apiKnownCells}) != nKnown (${apiMatrix.nKnown})`
    );
  }

  const metricsSafeRows = input.rows.filter((row) => row.status === "complete");
  const metadataMissingRows = metricsSafeRows.filter(
    (row) => row.evidence.comparisonMetadataMissing === true
  );
  const comparableMetricsSafe = metricsSafeRows.length - metadataMissingRows.length;
  if (
    metadataMissingRows.length === 0 &&
    productionMatrix.nKnown + productionMatrix.nUnknown !== metricsSafe
  ) {
    violations.push(
      `production matrix total (${productionMatrix.nKnown + productionMatrix.nUnknown}) != metricsSafe (${metricsSafe})`
    );
  } else if (
    metadataMissingRows.length > 0 &&
    productionMatrix.nKnown + productionMatrix.nUnknown > comparableMetricsSafe
  ) {
    violations.push(
      `production matrix total exceeds comparable metrics-safe wallets (${comparableMetricsSafe})`
    );
  }

  const apiMissingB = metricsSafeRows.filter(
    (row) => row.apiReconstructedDecision == null
  ).length;
  if (apiMatrix.nKnown + apiMissingB < metricsSafe && apiMissingB > 0) {
    // API matrix only includes wallets with valid B; missing wallets are reported separately.
  }
  if (apiMatrix.nKnown > metricsSafe) {
    violations.push(
      `api matrix nKnown (${apiMatrix.nKnown}) > metricsSafe (${metricsSafe})`
    );
  }

  for (const row of metricsSafeRows) {
    const source = row.evidence.productionObservationSource;
    if (source !== "cohort_gate_snapshot") continue;
    const spec = cohort.find(
      (candidate) => candidate.wallet.toLowerCase() === row.wallet.toLowerCase()
    );
    if (!spec) continue;
    const expected = productionGateToDecision(spec.productionGate);
    if (row.productionDecision !== expected) {
      violations.push(
        `cohort_gate_snapshot mismatch for ${row.wallet}: expected ${expected}, got ${row.productionDecision}`
      );
    }
  }

  if (violations.length > 0) {
    throw new ShadowReportReconciliationError(violations);
  }
}

export function cohortSpecsFromEnriched(
  cohort: EnrichedCohortWallet[]
): CohortProductionSpec[] {
  return cohort.map((wallet) => ({
    wallet: wallet.wallet,
    label: wallet.label,
    cohortReason: wallet.cohortReason,
    productionGate: wallet.productionGate,
    productionFailureReason: wallet.productionFailureReason,
  }));
}
