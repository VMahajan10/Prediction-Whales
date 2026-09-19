import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

function minFinite(values: number[]): number | null {
  if (values.length === 0) return null;
  let min = values[0]!;
  for (let i = 1; i < values.length; i += 1) {
    const value = values[i]!;
    if (value < min) min = value;
  }
  return min;
}

export interface SourceBoundaryStats {
  oldestActivityTimestamp: number | null;
  oldestTradesTimestamp: number | null;
  indexedOldestTimestamp: number | null;
  eventsBeforeActivityBoundary: number;
  eventsBeforeTradesBoundary: number;
  activityExtendsBeforeBoundary: boolean;
  tradesExtendsBeforeBoundary: boolean;
}

export interface PersistedSourceCoverageSnapshot {
  extendsBeforeApiBoundary: boolean;
  eventsBeforeApiBoundary: number;
  indexedOldestTimestamp: number | null;
  eventHistoryComplete: boolean;
  chainId: string;
  metricVersion: string;
  provider: string;
  lastIndexedBlock?: number | null;
  lastReconstructedBlock?: number | null;
  oldestActivityTimestamp?: number | null;
  oldestTradesTimestamp?: number | null;
  eventsBeforeActivityBoundary?: number;
  eventsBeforeTradesBoundary?: number;
  activityTruncationImmune?: boolean;
  tradesTruncationImmune?: boolean;
}

export interface SourceTruncationImmunityResult {
  activityTruncated: boolean;
  tradesTruncated: boolean;
  activityTruncationImmune: boolean;
  tradesTruncationImmune: boolean;
  oldestActivityTimestamp: number | null;
  oldestTradesTimestamp: number | null;
  eventsBeforeActivityBoundary: number;
  eventsBeforeTradesBoundary: number;
  /** @deprecated Reporting-only blended min(activity, trades). */
  apiOldestTimestampReporting: number | null;
}

function boundaryEvidenceForSource(
  authoritativeIndexedEvents: WalletLedgerEvent[],
  boundaryTimestamp: number | null
): { extendsBeforeBoundary: boolean; eventsBeforeBoundary: number } {
  if (boundaryTimestamp == null) {
    return { extendsBeforeBoundary: false, eventsBeforeBoundary: 0 };
  }
  const indexedTs = authoritativeIndexedEvents
    .map((event) => event.timestamp)
    .filter((ts) => Number.isFinite(ts) && ts > 0);
  const indexedOldest = minFinite(indexedTs);
  if (
    indexedOldest == null ||
    indexedOldest >= boundaryTimestamp
  ) {
    return { extendsBeforeBoundary: false, eventsBeforeBoundary: 0 };
  }
  const eventsBeforeBoundary = authoritativeIndexedEvents.filter(
    (event) => event.timestamp > 0 && event.timestamp < boundaryTimestamp
  ).length;
  return {
    extendsBeforeBoundary: eventsBeforeBoundary > 0,
    eventsBeforeBoundary,
  };
}

export function computeSourceBoundaryStats(
  authoritativeIndexedEvents: WalletLedgerEvent[],
  oldestActivityTimestamp: number | null,
  oldestTradesTimestamp: number | null
): SourceBoundaryStats {
  const indexedTs = authoritativeIndexedEvents
    .map((event) => event.timestamp)
    .filter((ts) => Number.isFinite(ts) && ts > 0);
  const activity = boundaryEvidenceForSource(
    authoritativeIndexedEvents,
    oldestActivityTimestamp
  );
  const trades = boundaryEvidenceForSource(
    authoritativeIndexedEvents,
    oldestTradesTimestamp
  );
  return {
    oldestActivityTimestamp,
    oldestTradesTimestamp,
    indexedOldestTimestamp: minFinite(indexedTs),
    eventsBeforeActivityBoundary: activity.eventsBeforeBoundary,
    eventsBeforeTradesBoundary: trades.eventsBeforeBoundary,
    activityExtendsBeforeBoundary: activity.extendsBeforeBoundary,
    tradesExtendsBeforeBoundary: trades.extendsBeforeBoundary,
  };
}

function sourceImmunityFromPersisted(
  persisted: PersistedSourceCoverageSnapshot | null | undefined,
  source: "activity" | "trades"
): boolean {
  if (!persisted) return false;
  if (source === "activity") {
    return (
      persisted.activityTruncationImmune === true ||
      (persisted.eventsBeforeActivityBoundary ?? 0) > 0
    );
  }
  return (
    persisted.tradesTruncationImmune === true ||
    (persisted.eventsBeforeTradesBoundary ?? 0) > 0
  );
}

function resolveSingleSourceTruncation(input: {
  apiTruncated: boolean;
  boundaryTimestamp: number | null;
  runExtendsBeforeBoundary: boolean;
  runEventsBeforeBoundary: number;
  persistedImmune: boolean;
}): { immune: boolean; effectiveTruncated: boolean } {
  if (!input.apiTruncated) {
    return { immune: true, effectiveTruncated: false };
  }
  const runImmune =
    input.boundaryTimestamp != null &&
    input.runExtendsBeforeBoundary &&
    input.runEventsBeforeBoundary > 0;
  const immune = runImmune || input.persistedImmune;
  return { immune, effectiveTruncated: !immune };
}

/**
 * Per-source truncation immunity: activity and trades boundaries are evaluated
 * independently. A complete trades history must not clear activity truncation.
 */
export function resolveSourceSpecificTruncationFlags(input: {
  apiActivityTruncated: boolean;
  apiTradesTruncated: boolean;
  oldestActivityTimestamp: number | null;
  oldestTradesTimestamp: number | null;
  runSourceBoundaries: Pick<
    SourceBoundaryStats,
    | "eventsBeforeActivityBoundary"
    | "eventsBeforeTradesBoundary"
    | "activityExtendsBeforeBoundary"
    | "tradesExtendsBeforeBoundary"
  >;
  persistedCoverage?: PersistedSourceCoverageSnapshot | null;
}): SourceTruncationImmunityResult {
  const activity = resolveSingleSourceTruncation({
    apiTruncated: input.apiActivityTruncated,
    boundaryTimestamp: input.oldestActivityTimestamp,
    runExtendsBeforeBoundary: input.runSourceBoundaries.activityExtendsBeforeBoundary,
    runEventsBeforeBoundary: input.runSourceBoundaries.eventsBeforeActivityBoundary,
    persistedImmune: sourceImmunityFromPersisted(
      input.persistedCoverage,
      "activity"
    ),
  });
  const trades = resolveSingleSourceTruncation({
    apiTruncated: input.apiTradesTruncated,
    boundaryTimestamp: input.oldestTradesTimestamp,
    runExtendsBeforeBoundary: input.runSourceBoundaries.tradesExtendsBeforeBoundary,
    runEventsBeforeBoundary: input.runSourceBoundaries.eventsBeforeTradesBoundary,
    persistedImmune: sourceImmunityFromPersisted(
      input.persistedCoverage,
      "trades"
    ),
  });

  const reportingTimestamps = [
    input.oldestActivityTimestamp,
    input.oldestTradesTimestamp,
  ].filter((ts): ts is number => ts != null && Number.isFinite(ts));

  return {
    activityTruncated: activity.effectiveTruncated,
    tradesTruncated: trades.effectiveTruncated,
    activityTruncationImmune: activity.immune,
    tradesTruncationImmune: trades.immune,
    oldestActivityTimestamp: input.oldestActivityTimestamp,
    oldestTradesTimestamp: input.oldestTradesTimestamp,
    eventsBeforeActivityBoundary:
      input.runSourceBoundaries.eventsBeforeActivityBoundary,
    eventsBeforeTradesBoundary:
      input.runSourceBoundaries.eventsBeforeTradesBoundary,
    apiOldestTimestampReporting:
      reportingTimestamps.length > 0 ? Math.min(...reportingTimestamps) : null,
  };
}
