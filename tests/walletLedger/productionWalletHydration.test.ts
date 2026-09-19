import { describe, expect, it } from "vitest";
import { hasDefinitivePolicyAVerdict } from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import {
  assessBatchHydrationEligibility,
  shouldSkipPolicyAHydration,
} from "@/lib/walletLedger/indexed/shadow/productionWalletHydration";
import type { ProductionWalletCohortMember } from "@/lib/walletLedger/indexed/shadow/productionWalletCohort";

function fe787LikeMember(
  overrides: Partial<ProductionWalletCohortMember> = {}
): ProductionWalletCohortMember {
  return {
    wallet: "0xfe787d2da716d60e8acff57fb87eb13cd4d10319",
    priorityTier: 1,
    inFeedTrades: true,
    feedVisibleTradeCount: 4,
    inXPostLog: false,
    xPostLogTradeCount: 0,
    passesProductionWalletGate: true,
    tradeGateQualifiedTradeCount: 5,
    productionHydrationState: "complete",
    hasIndexedCoverage: true,
    hasIndexedMetrics: true,
    indexedDataValidity: true,
    policyADecision: "UNKNOWN",
    policyAUnknownReason: "incomplete_indexed_history",
    completedPositions: 3,
    realizedRoi: -0.2,
    profitablePositionRate: 0,
    historyValidity: "partial-but-metrics-safe",
    historyComplete: false,
    hasValidDurableCoverage: true,
    ...overrides,
  };
}

describe("productionWalletHydration skip semantics", () => {
  it("does not skip 0xfe787d-like wallets with durable coverage but Policy A UNKNOWN", () => {
    const metrics = {
      credibilityMetricsValid: true,
      historyValidity: "partial-but-metrics-safe",
      historyComplete: false,
      completedPositions: 2,
      realizedRoi: -0.68,
      profitablePositionRate: 0,
      metricVersion: "phase2e1-v1",
    };
    expect(hasDefinitivePolicyAVerdict(metrics)).toBe(false);
    expect(shouldSkipPolicyAHydration({ metrics })).toBe(false);
  });

  it("skips only when Policy A is already definitive PASS", () => {
    const metrics = {
      credibilityMetricsValid: true,
      historyValidity: "partial-but-metrics-safe",
      historyComplete: false,
      completedPositions: 12,
      realizedRoi: 0.2,
      profitablePositionRate: 0.6,
      metricVersion: "phase2e1-v1",
    };
    expect(hasDefinitivePolicyAVerdict(metrics)).toBe(true);
    expect(shouldSkipPolicyAHydration({ metrics })).toBe(true);
  });

  it("skips only when Policy A is already definitive FAIL", () => {
    const metrics = {
      credibilityMetricsValid: true,
      historyValidity: "complete",
      historyComplete: true,
      completedPositions: 12,
      realizedRoi: -0.1,
      profitablePositionRate: 0.6,
      metricVersion: "phase2e1-v1",
    };
    expect(hasDefinitivePolicyAVerdict(metrics)).toBe(true);
    expect(shouldSkipPolicyAHydration({ metrics })).toBe(true);
  });

  it("excludes Batch-1-complete fe787-like wallets from batch hydration selection", () => {
    const member = fe787LikeMember();
    const eligibility = assessBatchHydrationEligibility({
      member,
      metricReasons: ["gamma_resolution_incomplete", "merge_split_unresolved"],
      hydrationStatus: "complete",
      coverage: {
        identityComplete: true,
        eventHistoryComplete: true,
      },
    });
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.hydrationEligibilityReason).toBe(
      "excluded_already_hydrated_trustworthy_low_sample_unknown"
    );
  });

  it("still includes truncation-blocked UNKNOWN wallets needing repair", () => {
    const member = fe787LikeMember({
      historyValidity: "partial-and-metrics-unsafe",
      hasValidDurableCoverage: false,
      productionHydrationState: "unknown",
      policyAUnknownReason: "incomplete_indexed_history",
      completedPositions: 876,
    });
    const eligibility = assessBatchHydrationEligibility({
      member,
      metricReasons: ["activity_truncated", "trades_truncated"],
      hydrationStatus: null,
      coverage: {
        identityComplete: true,
        eventHistoryComplete: false,
      },
    });
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.hydrationEligibilityReason).toBe(
      "eligible_incomplete_indexed_history"
    );
  });

  it("excludes insufficient_completed_positions after trustworthy hydration", () => {
    const member = fe787LikeMember({
      policyAUnknownReason: "insufficient_completed_positions",
      completedPositions: 3,
    });
    const eligibility = assessBatchHydrationEligibility({
      member,
      metricReasons: [],
      hydrationStatus: "complete",
      coverage: {
        identityComplete: true,
        eventHistoryComplete: true,
      },
    });
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.hydrationEligibilityReason).toBe(
      "excluded_final_unknown_insufficient_completed_positions"
    );
  });

  it("excludes unresolved_chain_order wallets from normal hydration selection", () => {
    const member = fe787LikeMember({
      policyAUnknownReason: "unresolved_chain_order",
      historyValidity: "partial-and-metrics-unsafe",
      hasValidDurableCoverage: false,
      indexedDataValidity: false,
      productionHydrationState: "complete",
    });
    const eligibility = assessBatchHydrationEligibility({
      member,
      metricReasons: ["unresolved_chain_order", "gamma_resolution_incomplete"],
      hydrationStatus: "complete",
      coverage: {
        identityComplete: true,
        eventHistoryComplete: true,
      },
    });
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.hydrationEligibilityReason).toBe(
      "excluded_class_d_recovery_pending"
    );
  });

  it("does not skip metrics-unsafe wallets that remain Policy A UNKNOWN", () => {
    const metrics = {
      credibilityMetricsValid: false,
      historyValidity: "partial-and-metrics-unsafe",
      historyComplete: false,
      completedPositions: 4,
      realizedRoi: 0.27,
      profitablePositionRate: 0.5,
      metricVersion: "phase2e1-v1",
    };
    expect(hasDefinitivePolicyAVerdict(metrics)).toBe(false);
    expect(shouldSkipPolicyAHydration({ metrics })).toBe(false);
  });
});
