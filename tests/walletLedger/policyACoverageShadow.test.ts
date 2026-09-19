import { describe, expect, it } from "vitest";
import {
  classifyProductionWalletUnknownReason,
  hasValidDurableIndexedCoverage,
} from "@/lib/walletLedger/indexed/shadow/productionWalletCohort";

describe("policyACoverageShadow taxonomy", () => {
  it("classifies hydration pending", () => {
    expect(
      classifyProductionWalletUnknownReason({
        metrics: null,
        coverage: null,
        productionHydrationState: "pending",
      })
    ).toBe("hydration_pending");
  });

  it("classifies incomplete indexed history when historyComplete is false", () => {
    expect(
      classifyProductionWalletUnknownReason({
        metrics: {
          credibilityMetricsValid: true,
          completedPositions: 2,
          realizedRoi: -0.5,
          profitablePositionRate: 0.1,
          historyValidity: "partial-but-metrics-safe",
          historyComplete: false,
        },
        coverage: { walletAddress: "0xfe787d2da716d60e8acff57fb87eb13cd4d10319" },
        productionHydrationState: "complete",
      })
    ).toBe("incomplete_indexed_history");
  });

  it("classifies insufficient completed positions only when history is certified complete", () => {
    expect(
      classifyProductionWalletUnknownReason({
        metrics: {
          credibilityMetricsValid: true,
          completedPositions: 2,
          realizedRoi: 0.1,
          profitablePositionRate: 0.5,
          historyValidity: "complete",
          historyComplete: true,
        },
        coverage: { walletAddress: "0xabc" },
        productionHydrationState: "complete",
      })
    ).toBe("insufficient_completed_positions");
  });

  it("detects valid durable coverage for metrics-safe partial history", () => {
    expect(
      hasValidDurableIndexedCoverage({
        metrics: {
          metricVersion: "phase2e1-v1",
          credibilityMetricsValid: true,
          historyValidity: "partial-but-metrics-safe",
        },
        coverage: {
          walletAddress: "0xabc",
          metricVersion: "phase2e1-v1",
        },
      })
    ).toBe(true);
  });
});
