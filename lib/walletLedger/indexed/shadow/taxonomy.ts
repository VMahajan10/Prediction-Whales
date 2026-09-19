import type { HistoricalPerformanceFailureReason } from "@/lib/walletLedger/indexed/credibilityContractV2";
import type {
  HistoricalPerformanceDecision,
  IndexedDataValidityVerdict,
} from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import type { IndexedAuditWalletResult } from "@/lib/walletLedger/indexed/types";
import type { ProductionCredibilitySnapshot } from "@/lib/walletLedger/indexed/shadow/productionProbe";

export type ShadowDisagreementReason =
  | "api_truncation"
  | "bad_closed_positions_source"
  | "resolved_position_count"
  | "capital_at_risk"
  | "resolved_volume"
  | "roi_profitability"
  | "legacy_exchange_history"
  | "missing_resolution"
  | "identity"
  | "merge_split"
  | "hydration_failure"
  | "missing_production_metrics"
  | "timestamp_coverage"
  | "other";

export interface ShadowDisagreementEvidence {
  apiEvents?: number;
  indexedEvents?: number;
  eventsBeforeApiBoundary?: number;
  productionResolvedPositions?: number | null;
  apiReconstructedCompletedPositions?: number;
  indexedCompletedPositions?: number;
  productionAvgEv?: number | null;
  apiReconstructedRoi?: number | null;
  indexedRealizedRoi?: number | null;
  productionDecision?: boolean | null;
  apiReconstructedDecision?: boolean | null;
  indexedDecision?: boolean;
  hydrationStatus?: string | null;
  historyValidity?: string;
  timestampCoveragePct?: number;
  [key: string]: unknown;
}

export interface CredibilityConfusionMatrix {
  passToPass: number;
  passToFail: number;
  failToPass: number;
  failToFail: number;
  nullToPass: number;
  nullToFail: number;
  /** Metrics-safe wallets with a known PASS/FAIL left decision. */
  nKnown: number;
  /** Metrics-safe wallets with NULL/unknown left decision. */
  nUnknown: number;
  /** Total metrics-safe wallets included in this matrix. */
  nMetricsSafeTotal: number;
  /** @deprecated use nKnown */
  comparable: number;
  changeRate: number;
}

export interface ShadowWalletComparison {
  wallet: string;
  label: string;
  cohortReason: string;
  /** Current whale_registry / production gate (A). */
  productionDecision: boolean | null;
  /** API-truncated history credibility (B) — NOT production. */
  apiReconstructedDecision: boolean | null;
  /** Indexed chain-history structural validity (C). Legacy name; see indexedDataValidityDecision. */
  indexedDecision: boolean;
  /** Semantic indexed data validity verdict — separate from historical performance. */
  indexedDataValidityDecision?: IndexedDataValidityVerdict;
  /** Shadow-only historical performance verdict (Policy A). */
  historicalPerformanceDecision?: HistoricalPerformanceDecision;
  historicalPerformanceFailureReasons?: HistoricalPerformanceFailureReason[];
  historicalPerformancePolicyVersion?: string;
  /** @deprecated use productionDecision */
  productionCredible: boolean | null;
  /** @deprecated use indexedDecision — alias for indexedDataValidityDecision */
  indexedCredible: boolean;
  productionAgreement: boolean;
  apiAgreement: boolean;
  /** @deprecated use productionAgreement */
  agreement: boolean;
  primaryReason: ShadowDisagreementReason | "agreement";
  productionReasons: ShadowDisagreementReason[];
  apiReasons: ShadowDisagreementReason[];
  /** @deprecated use productionReasons */
  reasons: ShadowDisagreementReason[];
  evidence: ShadowDisagreementEvidence;
  historyValidity: string;
  historyComplete: boolean;
  credibilityMetricsValid: boolean;
  status: "complete" | "wallet_failed" | "unusable" | "deferred_infra" | "internal_error" | "failed";
  error?: string;
  performance?: Record<string, unknown>;
}

function buildEvidence(input: {
  production: ProductionCredibilitySnapshot;
  audit: IndexedAuditWalletResult;
  productionDecision: boolean | null;
  apiReconstructedDecision: boolean | null;
  indexedDecision: boolean;
}): ShadowDisagreementEvidence {
  const metrics = input.audit.indexedLedgerMetrics;
  return {
    apiEvents: input.audit.coverage.apiEventCount,
    indexedEvents: input.audit.coverage.indexedEventCount,
    eventsBeforeApiBoundary: input.audit.coverage.eventsBeforeApiBoundary,
    productionResolvedPositions: input.production.resolvedBetsCount,
    apiReconstructedCompletedPositions: input.audit.apiCompletedPositions,
    indexedCompletedPositions: input.audit.indexedCompletedPositions,
    productionAvgEv: input.production.avgEv,
    apiReconstructedRoi: input.audit.apiLedgerMetrics?.portfolioRealizedRoi ?? null,
    indexedRealizedRoi: metrics?.portfolioRealizedRoi ?? null,
    indexedProfitablePositionRate: metrics?.profitablePositionRate ?? null,
    productionDecision: input.productionDecision,
    apiReconstructedDecision: input.apiReconstructedDecision,
    indexedDecision: input.indexedDecision,
    hydrationStatus: input.production.hydrationStatus,
    historyValidity: metrics?.historyValidity,
    timestampCoveragePct: input.audit.blockTimestampStats?.timestampCoveragePct,
  };
}

function collectReasons(input: {
  production: ProductionCredibilitySnapshot;
  audit: IndexedAuditWalletResult;
  leftDecision: boolean | null;
  indexedDecision: boolean;
  compareProduction: boolean;
}): ShadowDisagreementReason[] {
  const metrics = input.audit.indexedLedgerMetrics;
  if (input.leftDecision === input.indexedDecision) return [];

  const reasons: ShadowDisagreementReason[] = [];
  if (input.compareProduction && input.production.hydrationStatus !== "complete") {
    reasons.push("hydration_failure");
  }
  if (
    input.compareProduction &&
    input.leftDecision == null &&
    !input.production.inRegistry
  ) {
    reasons.push("missing_production_metrics");
  }
  if (
    input.audit.extendsBeforeApiBoundary ||
    input.audit.coverage.eventsBeforeApiBoundary > 0 ||
    metrics?.activityTruncated ||
    metrics?.tradesTruncated
  ) {
    reasons.push("api_truncation");
  }
  if (
    metrics?.historyCompletenessReasons.some((r) => r.startsWith("identity"))
  ) {
    reasons.push("identity");
  }
  if (
    metrics?.historyCompletenessReasons.some((r) =>
      r.startsWith("gamma_resolution")
    )
  ) {
    reasons.push("missing_resolution");
  }
  if (metrics?.historyCompletenessReasons.some((r) => r.startsWith("merge_split"))) {
    reasons.push("merge_split");
  }
  if (
    input.audit.blockTimestampStats &&
    input.audit.blockTimestampStats.timestampCoveragePct < 0.95
  ) {
    reasons.push("timestamp_coverage");
  }
  if (
    input.compareProduction &&
    input.production.resolvedBetsCount != null &&
    input.production.resolvedBetsCount !== input.audit.indexedCompletedPositions
  ) {
    reasons.push("resolved_position_count");
  }
  if (!input.compareProduction) {
    if (
      input.audit.apiCompletedPositions !== input.audit.indexedCompletedPositions
    ) {
      reasons.push("resolved_position_count");
    }
  }
  if (metrics?.medianCapitalAtRisk != null) reasons.push("capital_at_risk");
  if (metrics?.resolvedVolumeUsd != null) reasons.push("resolved_volume");
  if (
    metrics?.profitablePositionRate != null ||
    metrics?.portfolioRealizedRoi != null
  ) {
    reasons.push("roi_profitability");
  }
  if (reasons.length === 0) reasons.push("other");
  return reasons;
}

export function classifyShadowDisagreement(input: {
  production: ProductionCredibilitySnapshot;
  audit: IndexedAuditWalletResult;
}): Pick<
  ShadowWalletComparison,
  | "primaryReason"
  | "productionReasons"
  | "apiReasons"
  | "reasons"
  | "evidence"
> {
  const { production, audit } = input;
  const apiCredibility = audit.apiCredibility;
  const indexedCredibility = audit.indexedCredibility;
  const productionDecision = production.productionCredible;
  const apiReconstructedDecision =
    apiCredibility?.credibilityDecision ?? audit.credibilityMetricsValidBefore;
  const indexedDecision =
    indexedCredibility?.credibilityDecision ?? audit.credibilityMetricsValidAfter;

  const evidence = buildEvidence({
    production,
    audit,
    productionDecision,
    apiReconstructedDecision,
    indexedDecision,
  });

  const productionReasons = collectReasons({
    production,
    audit,
    leftDecision: productionDecision,
    indexedDecision,
    compareProduction: true,
  });
  const apiReasons = collectReasons({
    production,
    audit,
    leftDecision: apiReconstructedDecision,
    indexedDecision,
    compareProduction: false,
  });

  const primaryReason =
    productionReasons.length > 0
      ? productionReasons[0]!
      : apiReasons.length > 0
        ? apiReasons[0]!
        : "agreement";

  return {
    primaryReason,
    productionReasons,
    apiReasons,
    reasons: productionReasons,
    evidence,
  };
}

export function buildProductionVsHistoricalPerformanceMatrix(
  rows: ShadowWalletComparison[]
): CredibilityConfusionMatrix {
  const eligible = rows.filter(
    (r) =>
      r.status === "complete" &&
      r.historicalPerformanceDecision != null &&
      r.indexedDataValidityDecision === "PASS"
  );
  const withKnown = eligible.filter((r) => r.productionDecision != null);
  const withUnknown = eligible.filter((r) => r.productionDecision == null);
  const histPass = (r: ShadowWalletComparison) =>
    r.historicalPerformanceDecision === "PASS";

  const passToPass = withKnown.filter(
    (r) => r.productionDecision === true && histPass(r)
  ).length;
  const passToFail = withKnown.filter(
    (r) => r.productionDecision === true && !histPass(r)
  ).length;
  const failToPass = withKnown.filter(
    (r) => r.productionDecision === false && histPass(r)
  ).length;
  const failToFail = withKnown.filter(
    (r) => r.productionDecision === false && !histPass(r)
  ).length;
  const nullToPass = withUnknown.filter((r) => histPass(r)).length;
  const nullToFail = withUnknown.filter((r) => !histPass(r)).length;
  const changed = withKnown.filter(
    (r) =>
      (r.productionDecision === true && !histPass(r)) ||
      (r.productionDecision === false && histPass(r))
  ).length;

  return {
    passToPass,
    passToFail,
    failToPass,
    failToFail,
    nullToPass,
    nullToFail,
    nKnown: withKnown.length,
    nUnknown: withUnknown.length,
    nMetricsSafeTotal: eligible.length,
    comparable: withKnown.length,
    changeRate: withKnown.length > 0 ? changed / withKnown.length : 0,
  };
}

export function buildConfusionMatrix(
  rows: ShadowWalletComparison[],
  side: "production" | "api"
): CredibilityConfusionMatrix {
  const metricsSafe = rows.filter((r) => r.status === "complete");
  const left = (r: ShadowWalletComparison) =>
    side === "production" ? r.productionDecision : r.apiReconstructedDecision;

  const withKnown = metricsSafe.filter((r) => left(r) != null);
  const withUnknown = metricsSafe.filter((r) => left(r) == null);
  const passToPass = withKnown.filter(
    (r) => left(r) === true && r.indexedDecision
  ).length;
  const passToFail = withKnown.filter(
    (r) => left(r) === true && !r.indexedDecision
  ).length;
  const failToPass = withKnown.filter(
    (r) => left(r) === false && r.indexedDecision
  ).length;
  const failToFail = withKnown.filter(
    (r) => left(r) === false && !r.indexedDecision
  ).length;
  const nullToPass = withUnknown.filter((r) => r.indexedDecision).length;
  const nullToFail = withUnknown.filter((r) => !r.indexedDecision).length;
  const changed = withKnown.filter((r) => left(r) !== r.indexedDecision).length;

  return {
    passToPass,
    passToFail,
    failToPass,
    failToFail,
    nullToPass,
    nullToFail,
    nKnown: withKnown.length,
    nUnknown: withUnknown.length,
    nMetricsSafeTotal: metricsSafe.length,
    comparable: withKnown.length,
    changeRate: withKnown.length > 0 ? changed / withKnown.length : 0,
  };
}
