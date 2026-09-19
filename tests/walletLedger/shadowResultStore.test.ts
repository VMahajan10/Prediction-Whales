import { afterEach, describe, expect, it, vi } from "vitest";
import * as dbModule from "@/lib/crossmarket/store/db";
import { upsertShadowWalletObservation } from "@/lib/walletLedger/indexed/shadow/shadowResultStore";
import type { ShadowWalletObservation } from "@/lib/walletLedger/indexed/shadow/shadowResultStore";

function sampleObservation(): ShadowWalletObservation {
  return {
    batchId: "phase2e2-stageC-v1",
    wallet: "0xabc",
    label: "test",
    cohortReason: "test",
    executionStatus: "complete",
    historyValidity: "partial-but-metrics-safe",
    historyComplete: false,
    credibilityMetricsValid: true,
    productionDecision: true,
    productionReasons: [],
    productionMetricsSnapshot: null,
    apiReconstructedDecision: true,
    apiReasons: [],
    apiMetricsSnapshot: null,
    indexedDecision: true,
    indexedReasons: [],
    indexedMetricsSnapshot: null,
    evidence: {},
    comparisonMetadataMissing: false,
    productionObservationSource: "captured_evaluation",
    apiObservationSource: "captured_evaluation",
    indexedObservationSource: "persisted_indexed_audit",
    metricVersion: "phase2e1-v1",
    queryPlanVersion: "v3",
    evaluatedAt: new Date().toISOString(),
  };
}

describe("upsertShadowWalletObservation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries transient Neon fetch failures", async () => {
    let attempts = 0;
    vi.spyOn(dbModule, "getDb").mockReturnValue({
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: async () => {
            attempts += 1;
            if (attempts < 3) {
              throw new Error("fetch failed");
            }
          },
        }),
      }),
    } as never);

    await upsertShadowWalletObservation(sampleObservation());
    expect(attempts).toBe(3);
  });

  it("does not retry deterministic SQL failures", async () => {
    let attempts = 0;
    vi.spyOn(dbModule, "getDb").mockReturnValue({
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: async () => {
            attempts += 1;
            throw new Error("syntax error at or near");
          },
        }),
      }),
    } as never);

    await expect(
      upsertShadowWalletObservation(sampleObservation())
    ).rejects.toThrow(/syntax error/i);
    expect(attempts).toBe(1);
  });
});
