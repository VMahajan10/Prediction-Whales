import type {
  HistoryValidity,
  WalletLedgerMetrics,
} from "@/lib/walletLedger/types";

/** Canonical indexed/API credibility view — single source for shadow + persistence. */
export interface CredibilityResult {
  credibilityDecision: boolean;
  credibilityMetricsValid: boolean;
  historyValidity: HistoryValidity;
  historyComplete: boolean;
  reasons: string[];
}

export interface PersistedCoverageSnapshot {
  extendsBeforeApiBoundary: boolean;
  eventsBeforeApiBoundary: number;
  indexedOldestTimestamp: number | null;
  eventHistoryComplete: boolean;
  chainId: string;
  metricVersion: string;
  provider: string;
  lastIndexedBlock?: number | null;
  lastReconstructedBlock?: number | null;
}

export interface PersistedCoverageContext {
  wallet: string;
  chainId: string;
  metricVersion: string;
  provider: string;
}

function isStructurallyValidCoverageRow(
  row: PersistedCoverageSnapshot
): boolean {
  return (
    typeof row.chainId === "string" &&
    row.chainId.trim().length > 0 &&
    typeof row.metricVersion === "string" &&
    row.metricVersion.trim().length > 0 &&
    typeof row.provider === "string" &&
    row.provider.trim().length > 0 &&
    Number.isFinite(row.eventsBeforeApiBoundary) &&
    row.eventsBeforeApiBoundary >= 0
  );
}

/** Stale/incompatible coverage must not grant API truncation immunity. */
export function isPersistedCoverageCompatibleForTruncationImmunity(
  row: PersistedCoverageSnapshot,
  context: PersistedCoverageContext
): boolean {
  if (!isStructurallyValidCoverageRow(row)) return false;
  return (
    row.chainId === context.chainId &&
    row.metricVersion === context.metricVersion &&
    row.provider === context.provider
  );
}

export function selectTruncationImmunityCoverage(
  row: PersistedCoverageSnapshot | null,
  context: PersistedCoverageContext
): PersistedCoverageSnapshot | null {
  if (!row) return null;
  if (!isPersistedCoverageCompatibleForTruncationImmunity(row, context)) {
    return null;
  }
  return row;
}

export function buildCredibilityResult(
  metrics: WalletLedgerMetrics
): CredibilityResult {
  return {
    credibilityDecision: metrics.credibilityMetricsValid,
    credibilityMetricsValid: metrics.credibilityMetricsValid,
    historyValidity: metrics.historyValidity,
    historyComplete: metrics.historyComplete,
    reasons: [...metrics.historyCompletenessReasons],
  };
}

/**
 * @deprecated Prefer resolveSourceSpecificTruncationFlags. Blended boundary grants
 * immunity to both sources when either boundary is satisfied (legacy behavior).
 */
export function resolveIndexedTruncationFlags(input: {
  apiActivityTruncated: boolean;
  apiTradesTruncated: boolean;
  runExtendsBeforeApiBoundary: boolean;
  runEventsBeforeApiBoundary: number;
  persistedCoverage?: PersistedCoverageSnapshot | null;
}): {
  activityTruncated: boolean;
  tradesTruncated: boolean;
  apiTruncationImmune: boolean;
} {
  const persisted = input.persistedCoverage;
  const persistedGrantsImmunity =
    persisted != null &&
    (persisted.extendsBeforeApiBoundary === true ||
      persisted.eventsBeforeApiBoundary > 0);

  const apiTruncationImmune =
    input.runExtendsBeforeApiBoundary ||
    input.runEventsBeforeApiBoundary > 0 ||
    persistedGrantsImmunity;

  return {
    apiTruncationImmune,
    activityTruncated: apiTruncationImmune ? false : input.apiActivityTruncated,
    tradesTruncated: apiTruncationImmune ? false : input.apiTradesTruncated,
  };
}

export {
  computeSourceBoundaryStats,
  resolveSourceSpecificTruncationFlags,
  type PersistedSourceCoverageSnapshot,
  type SourceBoundaryStats,
  type SourceTruncationImmunityResult,
} from "@/lib/walletLedger/indexed/sourceTruncationImmunity";

export function effectiveEventsBeforeApiBoundary(input: {
  runEventsBeforeApiBoundary: number;
  persistedCoverage?: PersistedCoverageSnapshot | null;
}): number {
  return Math.max(
    input.runEventsBeforeApiBoundary,
    input.persistedCoverage?.eventsBeforeApiBoundary ?? 0
  );
}

export function effectiveExtendsBeforeApiBoundary(input: {
  runExtendsBeforeApiBoundary: boolean;
  runEventsBeforeApiBoundary: number;
  persistedCoverage?: PersistedCoverageSnapshot | null;
}): boolean {
  return (
    input.runExtendsBeforeApiBoundary ||
    effectiveEventsBeforeApiBoundary({
      runEventsBeforeApiBoundary: input.runEventsBeforeApiBoundary,
      persistedCoverage: input.persistedCoverage,
    }) > 0
  );
}
