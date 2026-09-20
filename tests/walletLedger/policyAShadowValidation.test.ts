import { describe, expect, it } from "vitest";
import {
  buildPriorityRepairQueue,
  buildProductionGateConfusionMatrix,
  buildUnknownReasonBreakdown,
  classifyProductionGate,
  classifyShadowUnknownReportReason,
  deriveShadowRecommendation,
  mapUnknownReasonToReportCategory,
} from "@/lib/walletLedger/indexed/shadow/policyAShadowValidation";
import type { ProductionWalletCohortMember } from "@/lib/walletLedger/indexed/shadow/productionWalletCohort";

function member(
  overrides: Partial<ProductionWalletCohortMember> & { wallet: string }
): ProductionWalletCohortMember {
  return {
    priorityTier: 2,
    inFeedTrades: false,
    feedVisibleTradeCount: 0,
    inXPostLog: false,
    xPostLogTradeCount: 0,
    passesProductionWalletGate: false,
    tradeGateQualifiedTradeCount: 0,
    productionHydrationState: "complete",
    hasIndexedCoverage: false,
    hasIndexedMetrics: false,
    indexedDataValidity: false,
    policyADecision: "UNKNOWN",
    policyAUnknownReason: "no_indexed_history",
    completedPositions: null,
    realizedRoi: null,
    profitablePositionRate: null,
    historyValidity: null,
    historyComplete: null,
    hasValidDurableCoverage: false,
    ...overrides,
  };
}

describe("policyAShadowValidation", () => {
  it("classifies production gate UNKNOWN when hydration pending", () => {
    expect(
      classifyProductionGate({
        passesProductionWalletGate: false,
        productionHydrationState: "pending",
        hasIndexedMetrics: false,
      })
    ).toBe("UNKNOWN");
  });

  it("maps unresolved_chain_order to report category", () => {
    expect(
      mapUnknownReasonToReportCategory("unresolved_chain_order")
    ).toBe("unresolved_chain_order");
  });

  it("maps identity metric reasons to identity_related", () => {
    expect(
      mapUnknownReasonToReportCategory("missing_metrics", [
        "identity_collision",
      ])
    ).toBe("identity_related");
  });

  it("maps d91e-style identity repair path to identity_related", () => {
    const d91e = member({
      wallet: "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296",
      policyADecision: "UNKNOWN",
      policyAUnknownReason: "incomplete_indexed_history",
      feedVisibleTradeCount: 30,
      tradeGateQualifiedTradeCount: 87,
      passesProductionWalletGate: true,
      priorityTier: 1,
      hasIndexedCoverage: true,
      hasIndexedMetrics: true,
      indexedDataValidity: false,
      historyValidity: "partial-and-metrics-unsafe",
      historyComplete: false,
      completedPositions: 227,
      hasValidDurableCoverage: false,
      productionHydrationState: "complete",
    });
    const metricReasons = [
      "identity_unresolved",
      "identity_low_confidence",
      "positions_without_history_events",
      "gamma_resolution_incomplete",
    ];

    expect(classifyShadowUnknownReportReason(d91e, metricReasons)).toBe(
      "identity_related"
    );
    expect(
      buildUnknownReasonBreakdown([d91e], { [d91e.wallet]: metricReasons })
        .identity_related
    ).toBe(1);
    expect(
      buildPriorityRepairQueue([d91e], "2026-09-19T00:00:00.000Z", {
        [d91e.wallet]: metricReasons,
      })[0]?.policyAUnknownReason
    ).toBe("identity_related");
  });

  it("maps fe787-style trustworthy low sample to insufficient_completed_positions", () => {
    const fe787 = member({
      wallet: "0xfe787d2da716d60e8acff57fb87eb13cd4d10319",
      policyADecision: "UNKNOWN",
      policyAUnknownReason: "incomplete_indexed_history",
      feedVisibleTradeCount: 5,
      tradeGateQualifiedTradeCount: 6,
      passesProductionWalletGate: true,
      priorityTier: 1,
      hasIndexedCoverage: true,
      hasIndexedMetrics: true,
      indexedDataValidity: true,
      historyValidity: "partial-but-metrics-safe",
      historyComplete: false,
      completedPositions: 3,
      hasValidDurableCoverage: true,
      productionHydrationState: "complete",
    });
    const metricReasons = [
      "gamma_resolution_incomplete",
      "merge_split_unresolved",
    ];

    expect(classifyShadowUnknownReportReason(fe787, metricReasons)).toBe(
      "insufficient_completed_positions"
    );
    expect(
      buildUnknownReasonBreakdown([fe787], { [fe787.wallet]: metricReasons })
        .insufficient_completed_positions
    ).toBe(1);
    expect(
      buildPriorityRepairQueue([fe787], "2026-09-19T00:00:00.000Z", {
        [fe787.wallet]: metricReasons,
      })[0]?.policyAUnknownReason
    ).toBe("insufficient_completed_positions");
  });

  it("builds priority repair queue for feed-visible UNKNOWN only", () => {
    const queue = buildPriorityRepairQueue(
      [
        member({
          wallet: "0x1111111111111111111111111111111111111111",
          policyADecision: "UNKNOWN",
          feedVisibleTradeCount: 2,
        }),
        member({
          wallet: "0x2222222222222222222222222222222222222222",
          policyADecision: "UNKNOWN",
          tradeGateQualifiedTradeCount: 1,
        }),
        member({
          wallet: "0x0000000000000000000000000000000000000000",
          policyADecision: "UNKNOWN",
          tradeGateQualifiedTradeCount: 100,
        }),
      ],
      "2026-09-18T00:00:00.000Z"
    );
    expect(queue).toHaveLength(1);
    expect(queue[0]?.wallet).toBe("0x1111111111111111111111111111111111111111");
  });

  it("builds production gate confusion matrix cells", () => {
    const stake = new Map([
      ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1500],
      ["0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 800],
    ]);
    const matrix = buildProductionGateConfusionMatrix(
      [
        member({
          wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          passesProductionWalletGate: true,
          policyADecision: "PASS",
          feedVisibleTradeCount: 3,
        }),
        member({
          wallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          passesProductionWalletGate: true,
          policyADecision: "FAIL",
          feedVisibleTradeCount: 1,
        }),
      ],
      stake
    );
    expect(matrix).toHaveLength(2);
    expect(matrix.find((c) => c.policyA === "PASS")?.walletCount).toBe(1);
    expect(matrix.find((c) => c.policyA === "PASS")?.totalStakeUsd).toBe(1500);
    expect(matrix.find((c) => c.policyA === "FAIL")?.totalStakeUsd).toBe(800);
  });

  it("aggregates unknown reason breakdown", () => {
    const breakdown = buildUnknownReasonBreakdown([
      member({
        wallet: "0x1",
        policyADecision: "UNKNOWN",
        policyAUnknownReason: "unresolved_chain_order",
      }),
      member({
        wallet: "0x2",
        policyADecision: "PASS",
      }),
    ]);
    expect(breakdown.unresolved_chain_order).toBe(1);
    expect(breakdown.no_indexed_history).toBe(0);
  });

  it("returns SHADOW_PERIOD_IN_PROGRESS before observation completes", () => {
    expect(
      deriveShadowRecommendation({
        daysObserved: 3,
        observationComplete: false,
        cohort: {
          totalWallets: 77,
          pass: 12,
          fail: 32,
          unknown: 33,
          evaluablePct: 57.1,
          validDurableCoveragePct: 70.1,
        },
        tradeImpact: {
          tradesPassingTradeGates: 100,
          tradesCurrentlyVisible: 50,
          tradesRetainedUnderPolicyA: 30,
          tradesRemovedWalletFail: 10,
          tradesWithheldWalletUnknown: 10,
          feedVolumeReductionPct: 40,
          stakeUsdAffected: 1000,
          stakeUsdRetained: 2000,
        },
        feedVisibleUnknownCount: 0,
        priorityRepairCount: 0,
      })
    ).toBe("SHADOW_PERIOD_IN_PROGRESS");
  });
});
