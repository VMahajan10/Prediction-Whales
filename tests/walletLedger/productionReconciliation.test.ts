import { describe, expect, it } from "vitest";
import {
  assertShadowReportReconciliation,
  buildWalletProductionReconciliationTable,
  hydrateShadowComparisonRow,
  hydrateShadowRowsForReport,
  productionGateToDecision,
  ShadowReportReconciliationError,
} from "@/lib/walletLedger/indexed/shadow/productionReconciliation";
import { summarizeShadowBatch } from "@/lib/walletLedger/indexed/shadow/report";
import { buildConfusionMatrix, type ShadowWalletComparison } from "@/lib/walletLedger/indexed/shadow/taxonomy";

function row(
  wallet: string,
  overrides: Partial<ShadowWalletComparison> = {}
): ShadowWalletComparison {
  return {
    wallet,
    label: wallet,
    cohortReason: "test",
    productionDecision: null,
    apiReconstructedDecision: null,
    indexedDecision: false,
    productionCredible: null,
    indexedCredible: false,
    productionAgreement: false,
    apiAgreement: false,
    agreement: false,
    primaryReason: "other",
    productionReasons: ["other"],
    apiReasons: ["other"],
    reasons: ["other"],
    evidence: {},
    historyValidity: "partial-but-metrics-safe",
    historyComplete: false,
    credibilityMetricsValid: false,
    status: "complete",
    ...overrides,
  };
}

describe("productionReconciliation", () => {
  const cohort = [
    {
      wallet: "0xpass",
      label: "pass",
      cohortReason: "pass",
      productionGate: "pass" as const,
      productionFailureReason: "ok",
    },
    {
      wallet: "0xfail",
      label: "fail",
      cohortReason: "fail",
      productionGate: "fail" as const,
      productionFailureReason: "below_resolved_bets",
    },
    {
      wallet: "0xunknown",
      label: "unknown",
      cohortReason: "unknown",
      productionGate: "unknown" as const,
      productionFailureReason: "hydration_pending",
    },
  ];

  it("maps cohort productionGate to authoritative A", () => {
    expect(productionGateToDecision("pass")).toBe(true);
    expect(productionGateToDecision("fail")).toBe(false);
    expect(productionGateToDecision("unknown")).toBeNull();
  });

  it("hydrates resume stub rows from cohort gate instead of null", () => {
    const hydrated = hydrateShadowComparisonRow(row("0xfail"), cohort[1]!);
    expect(hydrated.productionDecision).toBe(false);
    expect(hydrated.productionCredible).toBe(false);
  });

  it("restores indexed decision from DB metrics for resume stubs", () => {
    const hydrated = hydrateShadowComparisonRow(row("0xfail"), cohort[1]!, {
      credibilityDecision: true,
      historyValidity: "partial-but-metrics-safe",
      historyComplete: false,
      credibilityReasons: [],
      completedPositions: 12,
      medianCapitalAtRisk: 10,
      resolvedVolumeUsd: 100,
      realizedRoi: 0.2,
      profitablePositionRate: 0.5,
    });
    expect(hydrated.indexedDecision).toBe(true);
  });

  it("flags cohort vs shadow production mismatches in reconciliation table", () => {
    const table = buildWalletProductionReconciliationTable(cohort, [
      row("0xfail", { productionDecision: null }),
    ]);
    const failRow = table.find((entry) => entry.wallet === "0xfail");
    expect(failRow?.productionDecisionMismatch).toBe(true);
    expect(failRow?.cohortProductionDecision).toBe(false);
  });

  it("asserts metrics-safe production counts reconcile with cohort bounds", () => {
    const rows = hydrateShadowRowsForReport(
      [
        row("0xpass", {
          productionDecision: true,
          indexedDecision: true,
          evidence: { indexedEvents: 1 },
        }),
        row("0xfail", {
          productionDecision: false,
          indexedDecision: false,
          evidence: { indexedEvents: 1 },
        }),
        row("0xunknown", {
          productionDecision: null,
          indexedDecision: true,
          evidence: { indexedEvents: 1 },
        }),
      ],
      cohort
    );
    const summary = summarizeShadowBatch({
      batchId: "test",
      cohort,
      rows,
      skipReconciliationAssertions: true,
    });
    expect(() =>
      assertShadowReportReconciliation({ summary, cohort, rows })
    ).not.toThrow();
    expect(summary.productionPass).toBe(1);
    expect(summary.productionFail).toBe(1);
    expect(summary.productionUnknown).toBe(1);
  });

  it("fails assertions when metrics-safe production counts contradict hydrated rows", () => {
    const rows = hydrateShadowRowsForReport([row("0xpass")], [cohort[0]!]);
    const summary = summarizeShadowBatch({
      batchId: "test",
      cohort: [cohort[0]!],
      rows,
      skipReconciliationAssertions: true,
    });
    expect(() =>
      assertShadowReportReconciliation({
        summary: {
          ...summary,
          productionPass: 0,
          productionUnknown: 1,
        },
        cohort: [cohort[0]!],
        rows,
      })
    ).toThrow(ShadowReportReconciliationError);
  });

  it("keeps UNKNOWN transitions out of known-decision confusion matrix denominator", () => {
    const rows = hydrateShadowRowsForReport(
      [
        row("0xpass", {
          productionDecision: true,
          indexedDecision: true,
          evidence: { indexedEvents: 1 },
        }),
        row("0xunknown", {
          productionDecision: null,
          indexedDecision: false,
          evidence: { indexedEvents: 1 },
        }),
      ],
      cohort
    );
    const matrix = buildConfusionMatrix(rows, "production");
    expect(matrix.nKnown).toBe(1);
    expect(matrix.nUnknown).toBe(1);
    expect(matrix.nMetricsSafeTotal).toBe(2);
    expect(matrix.passToPass).toBe(1);
    expect(matrix.nullToFail).toBe(1);
  });

  it("joins wallets case-insensitively", () => {
    const hydrated = hydrateShadowRowsForReport(
      [row("0xPASS", { productionDecision: null })],
      [{ ...cohort[0]!, wallet: "0xpass" }]
    );
    expect(hydrated[0]?.productionDecision).toBe(true);
  });
});
