import { describe, expect, it } from "vitest";
import {
  buildCredibilityResult,
  isPersistedCoverageCompatibleForTruncationImmunity,
  resolveIndexedTruncationFlags,
  selectTruncationImmunityCoverage,
} from "@/lib/walletLedger/indexed/indexedCredibility";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { analyzeMergeSplitImpact } from "@/lib/walletLedger/mergeSplitAnalysis";
import { computeWalletLedgerMetrics } from "@/lib/walletLedger/metrics";
import { assessWalletLedgerValidity } from "@/lib/walletLedger/validity";
import type {
  PolymarketHistoryIdentity,
  PositionLifecycle,
} from "@/lib/walletLedger/types";

function baseIdentity(
  overrides: Partial<PolymarketHistoryIdentity> = {}
): PolymarketHistoryIdentity {
  return {
    wallet: "0x7e5972bfc25819775ee5a9d4f191919375487b8b",
    historyWallet: "0x7e5972bfc25819775ee5a9d4f191919375487b8b",
    resolutionMethod: "direct",
    confidence: "high",
    positionsOnlyMismatch: false,
    ...overrides,
  };
}

function positionLifecycle(
  overrides: Partial<PositionLifecycle> = {}
): PositionLifecycle {
  return {
    conditionId: "0xcond",
    asset: "0xasset",
    lifecycleEpisode: 0,
    completed: true,
    fullyExited: true,
    heldThroughResolution: false,
    completionReason: "fully_exited",
    capitalAtRisk: 100,
    grossBuyCash: 100,
    grossSellCash: 120,
    realizedPnl: 20,
    positionRoi: 0.2,
    netShares: 0,
    firstEntryAt: 1,
    lastActivityAt: 2,
    excludedFromMetrics: false,
    events: [],
    ...overrides,
  };
}

const gammaCoverage = {
  distinctMarkets: 1,
  marketsFoundBefore: 1,
  marketsFoundAfter: 1,
  resolvedBefore: 0,
  resolvedAfter: 0,
  coverageBeforePct: 0,
  coverageAfterPct: 0,
  marketFoundCoverageAfterPct: 1,
};

describe("indexed credibility isolation from API truncation", () => {
  it("resolveIndexedTruncationFlags clears API truncation when run extends before API", () => {
    const flags = resolveIndexedTruncationFlags({
      apiActivityTruncated: true,
      apiTradesTruncated: true,
      runExtendsBeforeApiBoundary: true,
      runEventsBeforeApiBoundary: 50_000,
    });
    expect(flags.apiTruncationImmune).toBe(true);
    expect(flags.activityTruncated).toBe(false);
    expect(flags.tradesTruncated).toBe(false);
  });

  it("resolveIndexedTruncationFlags clears API truncation from persisted coverage on sparse incremental run", () => {
    const flags = resolveIndexedTruncationFlags({
      apiActivityTruncated: true,
      apiTradesTruncated: true,
      runExtendsBeforeApiBoundary: false,
      runEventsBeforeApiBoundary: 0,
      persistedCoverage: {
        extendsBeforeApiBoundary: true,
        eventsBeforeApiBoundary: 145_000,
        indexedOldestTimestamp: 1_781_706_121,
        eventHistoryComplete: true,
        chainId: "137",
        metricVersion: WALLET_METRIC_VERSION,
        provider: "etherscan_v2",
      },
    });
    expect(flags.apiTruncationImmune).toBe(true);
    expect(flags.activityTruncated).toBe(false);
    expect(flags.tradesTruncated).toBe(false);
  });

  it("0x7e59-like case: API FAIL metrics, indexed partial-but-metrics-safe PASS", () => {
    const positions = [
      positionLifecycle({}),
      positionLifecycle({
        completed: false,
        fullyExited: false,
        heldThroughResolution: true,
        completionReason: "held_through_resolution",
        netShares: 10,
        capitalAtRisk: 50,
      }),
    ];
    const mergeSplit = analyzeMergeSplitImpact(positions);

    const apiMetrics = computeWalletLedgerMetrics({
      positions,
      identity: baseIdentity(),
      activityTruncated: true,
      tradesTruncated: true,
      rawEventCount: 10_000,
      deduplicatedEventCount: 10_000,
      gammaCoverage,
      mergeSplit,
      hasHistoryEvents: true,
    });

    const indexedFlags = resolveIndexedTruncationFlags({
      apiActivityTruncated: true,
      apiTradesTruncated: true,
      runExtendsBeforeApiBoundary: true,
      runEventsBeforeApiBoundary: 140_000,
    });

    const indexedMetrics = computeWalletLedgerMetrics({
      positions,
      identity: baseIdentity(),
      activityTruncated: indexedFlags.activityTruncated,
      tradesTruncated: indexedFlags.tradesTruncated,
      rawEventCount: 180_000,
      deduplicatedEventCount: 180_000,
      gammaCoverage,
      mergeSplit,
      hasHistoryEvents: true,
    });

    const apiResult = buildCredibilityResult(apiMetrics);
    const indexedResult = buildCredibilityResult(indexedMetrics);

    expect(apiResult.credibilityDecision).toBe(false);
    expect(apiResult.reasons).toContain("activity_truncated");
    expect(apiResult.reasons).toContain("trades_truncated");

    expect(indexedResult.credibilityDecision).toBe(true);
    expect(indexedResult.historyValidity).toBe("partial-but-metrics-safe");
    expect(indexedResult.historyComplete).toBe(false);
    expect(indexedResult.reasons).not.toContain("activity_truncated");
    expect(indexedResult.reasons).not.toContain("trades_truncated");
    expect(indexedResult.reasons).toContain("gamma_resolution_incomplete");
  });

  it("stale persisted coverage version must not grant truncation immunity", () => {
    const stale = {
      extendsBeforeApiBoundary: true,
      eventsBeforeApiBoundary: 145_000,
      indexedOldestTimestamp: 1_781_706_121,
      eventHistoryComplete: true,
      chainId: "137",
      metricVersion: "phase1-legacy",
      provider: "etherscan_v2",
    };
    expect(
      isPersistedCoverageCompatibleForTruncationImmunity(stale, {
        wallet: "0x7e5972bfc25819775ee5a9d4f191919375487b8b",
        chainId: "137",
        metricVersion: WALLET_METRIC_VERSION,
        provider: "etherscan_v2",
      })
    ).toBe(false);
    const selected = selectTruncationImmunityCoverage(stale, {
      wallet: "0x7e5972bfc25819775ee5a9d4f191919375487b8b",
      chainId: "137",
      metricVersion: WALLET_METRIC_VERSION,
      provider: "etherscan_v2",
    });
    expect(selected).toBeNull();
    const flags = resolveIndexedTruncationFlags({
      apiActivityTruncated: true,
      apiTradesTruncated: true,
      runExtendsBeforeApiBoundary: false,
      runEventsBeforeApiBoundary: 0,
      persistedCoverage: selected,
    });
    expect(flags.apiTruncationImmune).toBe(false);
    expect(flags.activityTruncated).toBe(true);
    expect(flags.tradesTruncated).toBe(true);
  });

  it("assessWalletLedgerValidity: gamma incomplete alone does not block credibility", () => {
    const positions = [positionLifecycle({})];
    const validity = assessWalletLedgerValidity({
      positions,
      identity: baseIdentity(),
      activityTruncated: false,
      tradesTruncated: false,
      resolutionCoverage: {
        positionsRequiringResolution: 1,
        positionsSuccessfullyResolved: 0,
        positionsUnresolved: 1,
        resolutionCoveragePct: 0,
      },
      mergeSplit: analyzeMergeSplitImpact(positions),
      hasHistoryEvents: true,
    });
    expect(validity.credibilityMetricsValid).toBe(true);
    expect(validity.historyValidity).toBe("partial-but-metrics-safe");
    expect(validity.historyComplete).toBe(false);
    expect(validity.historyCompletenessReasons).toContain(
      "gamma_resolution_incomplete"
    );
  });
});
