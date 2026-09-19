import "../preload-env";
import { describe, expect, it } from "vitest";
import {
  HISTORICAL_PERFORMANCE_POLICY_A,
  HISTORICAL_PERFORMANCE_POLICY_VERSION,
} from "@/lib/walletLedger/indexed/credibilityContractV2";
import {
  evaluateHistoricalPerformanceVerdict,
  enrichShadowWalletWithHistoricalPerformance,
} from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import {
  loadStageCDurableEligibleWallets,
  summarizeProductionVsHistoricalPerformance,
} from "@/lib/walletLedger/indexed/shadow/stageCDurablePopulation";
import type { ShadowWalletComparison } from "@/lib/walletLedger/indexed/shadow/taxonomy";

function baseInput(
  overrides: Partial<{
    indexedDataValidity: boolean;
    historyComplete: boolean;
    historyValidity: string;
    completedPositionCount: number;
    realizedRoi: number;
    profitablePositionRate: number;
  }> = {}
) {
  return {
    indexedDataValidity: true,
    historyComplete: true,
    historyValidity: "complete",
    completedPositionCount: 12,
    realizedRoi: 0.1,
    profitablePositionRate: 0.55,
    metricVersion: HISTORICAL_PERFORMANCE_POLICY_A.metricVersion,
    ...overrides,
  };
}

function shadowRow(
  overrides: Partial<ShadowWalletComparison> = {}
): ShadowWalletComparison {
  return {
    wallet: "0xabc",
    label: "test",
    cohortReason: "test",
    productionDecision: null,
    apiReconstructedDecision: null,
    indexedDecision: true,
    productionCredible: null,
    indexedCredible: true,
    productionAgreement: false,
    apiAgreement: false,
    agreement: false,
    primaryReason: "other",
    productionReasons: [],
    apiReasons: [],
    reasons: [],
    evidence: {
      indexedCompletedPositions: 12,
      indexedRealizedRoi: 0.1,
      indexedProfitablePositionRate: 0.55,
    },
    historyValidity: "complete",
    historyComplete: true,
    credibilityMetricsValid: true,
    status: "complete",
    ...overrides,
  };
}

describe("historicalPerformanceVerdict", () => {
  it("passes Policy A when ROI > 0, rate >= 50%, completed >= 10", () => {
    const result = evaluateHistoricalPerformanceVerdict(baseInput());
    expect(result.historicalPerformanceDecision).toBe("PASS");
    expect(result.historicalPerformanceFailureReasons).toEqual([]);
    expect(result.historicalPerformancePolicyVersion).toBe(
      HISTORICAL_PERFORMANCE_POLICY_VERSION
    );
  });

  it("fails when ROI = 0", () => {
    const result = evaluateHistoricalPerformanceVerdict(
      baseInput({ realizedRoi: 0 })
    );
    expect(result.historicalPerformanceDecision).toBe("FAIL");
    expect(result.historicalPerformanceFailureReasons).toEqual([
      "non_positive_realized_roi",
    ]);
  });

  it("fails when ROI < 0", () => {
    const result = evaluateHistoricalPerformanceVerdict(
      baseInput({ realizedRoi: -0.01 })
    );
    expect(result.historicalPerformanceDecision).toBe("FAIL");
    expect(result.historicalPerformanceFailureReasons).toEqual([
      "non_positive_realized_roi",
    ]);
  });

  it("fails when profitable position rate is 49.9%", () => {
    const result = evaluateHistoricalPerformanceVerdict(
      baseInput({ profitablePositionRate: 0.499 })
    );
    expect(result.historicalPerformanceDecision).toBe("FAIL");
    expect(result.historicalPerformanceFailureReasons).toEqual([
      "below_profitable_position_rate",
    ]);
  });

  it("passes when profitable position rate is exactly 50%", () => {
    const result = evaluateHistoricalPerformanceVerdict(
      baseInput({ profitablePositionRate: 0.5 })
    );
    expect(result.historicalPerformanceDecision).toBe("PASS");
  });

  it("fails when completed positions = 9", () => {
    const result = evaluateHistoricalPerformanceVerdict(
      baseInput({ completedPositionCount: 9 })
    );
    expect(result.historicalPerformanceDecision).toBe("FAIL");
    expect(result.historicalPerformanceFailureReasons).toEqual([
      "below_completed_position_floor",
    ]);
  });

  it("treats completed positions = 10 as eligible for performance evaluation", () => {
    const result = evaluateHistoricalPerformanceVerdict(
      baseInput({ completedPositionCount: 10 })
    );
    expect(result.historicalPerformanceDecision).toBe("PASS");
  });

  it("returns UNKNOWN when historical coverage validity is incomplete", () => {
    const result = evaluateHistoricalPerformanceVerdict(
      baseInput({ historyValidity: "unusable" })
    );
    expect(result.historicalPerformanceDecision).toBe("UNKNOWN");
    expect(result.historicalPerformanceFailureReasons).toEqual([
      "indexed_data_invalid",
    ]);
  });

  it("returns UNKNOWN for 0xfe787d-like partial hydration (metrics-safe, history incomplete, sub-floor)", () => {
    const result = evaluateHistoricalPerformanceVerdict(
      baseInput({
        historyComplete: false,
        historyValidity: "partial-but-metrics-safe",
        completedPositionCount: 2,
        realizedRoi: -0.5,
        profitablePositionRate: 0.1,
      })
    );
    expect(result.historicalPerformanceDecision).toBe("UNKNOWN");
    expect(result.historicalPerformanceFailureReasons).toEqual([
      "historical_metrics_unavailable",
    ]);
    expect(result.indexedDataValidityDecision).toBe("PASS");
  });

  it("still evaluates PASS/FAIL above floor when history is metrics-safe but uncertified", () => {
    const pass = evaluateHistoricalPerformanceVerdict(
      baseInput({
        historyComplete: false,
        historyValidity: "partial-but-metrics-safe",
        completedPositionCount: 12,
        realizedRoi: 0.2,
        profitablePositionRate: 0.6,
      })
    );
    expect(pass.historicalPerformanceDecision).toBe("PASS");

    const fail = evaluateHistoricalPerformanceVerdict(
      baseInput({
        historyComplete: false,
        historyValidity: "partial-but-metrics-safe",
        completedPositionCount: 12,
        realizedRoi: -0.1,
        profitablePositionRate: 0.6,
      })
    );
    expect(fail.historicalPerformanceDecision).toBe("FAIL");
  });

  it("returns UNKNOWN when indexed data validity fails", () => {
    const result = evaluateHistoricalPerformanceVerdict(
      baseInput({ indexedDataValidity: false })
    );
    expect(result.historicalPerformanceDecision).toBe("UNKNOWN");
    expect(result.indexedDataValidityDecision).toBe("FAIL");
    expect(result.historicalPerformanceFailureReasons).toEqual([
      "indexed_data_invalid",
    ]);
  });

  it("returns UNKNOWN when ROI or rate metrics are missing", () => {
    const missingRoi = evaluateHistoricalPerformanceVerdict({
      ...baseInput(),
      realizedRoi: null,
    });
    expect(missingRoi.historicalPerformanceDecision).toBe("UNKNOWN");
    expect(missingRoi.historicalPerformanceFailureReasons).toEqual([
      "historical_metrics_unavailable",
    ]);

    const missingRate = evaluateHistoricalPerformanceVerdict({
      ...baseInput(),
      profitablePositionRate: null,
    });
    expect(missingRate.historicalPerformanceDecision).toBe("UNKNOWN");
  });

  it("collapses multiple threshold failures", () => {
    const result = evaluateHistoricalPerformanceVerdict(
      baseInput({
        completedPositionCount: 8,
        realizedRoi: -0.2,
        profitablePositionRate: 0.2,
      })
    );
    expect(result.historicalPerformanceDecision).toBe("FAIL");
    expect(result.historicalPerformanceFailureReasons).toEqual([
      "multiple_performance_failures",
    ]);
  });

  it("enriches shadow rows without overloading indexedDecision", () => {
    const enriched = enrichShadowWalletWithHistoricalPerformance(shadowRow());
    expect(enriched.indexedDataValidityDecision).toBe("PASS");
    expect(enriched.historicalPerformanceDecision).toBe("PASS");
    expect(enriched.indexedDecision).toBe(true);
    expect(enriched.evidence.historicalPerformanceDecision).toBe("PASS");
    expect(enriched.evidence.indexedDataValidityDecision).toBe("PASS");
  });
});

describe("stage C durable population regression", () => {
  const hasDb = Boolean(process.env.DATABASE_URL);

  it.skipIf(!hasDb)(
    "reproduces Policy A counts and production disagreement from durable data",
    async () => {
      const wallets = await loadStageCDurableEligibleWallets();
      const disagreement = summarizeProductionVsHistoricalPerformance(wallets);

      expect(wallets.length).toBe(55);
      expect(disagreement.historicalPassN).toBe(21);
      expect(disagreement.historicalFailN).toBe(34);
      expect(disagreement.historicalUnknownN).toBe(0);
      expect(disagreement.historicalPassN / wallets.length).toBeCloseTo(
        0.382,
        3
      );

      const productionPass = wallets.filter((w) => w.productionDecision === true);
      const productionFail = wallets.filter((w) => w.productionDecision === false);
      expect(productionPass.length).toBe(37);
      expect(productionFail.length).toBe(2);

      expect(disagreement.productionPass_histPass).toBe(12);
      expect(disagreement.productionPass_histFail).toBe(25);
      expect(disagreement.productionFail_histPass).toBe(0);
      expect(disagreement.productionFail_histFail).toBe(2);
    }
  );
});
