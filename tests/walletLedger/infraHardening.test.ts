import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { FetchTimeoutError, fetchTextWithTimeout } from "@/lib/fetchWithTimeout";
import {
  classifyExecutionOutcome,
  isInfraFailureError,
  isLegacyInfraFailedStatus,
  QueryScaleError,
} from "@/lib/walletLedger/indexed/shadow/infraClassification";
import {
  isDbCircuitOpen,
  recordDbFailure,
  resetDbCircuitForTests,
} from "@/lib/walletLedger/indexed/shadow/dbCircuitBreaker";
import {
  isProviderCircuitOpen,
  recordProviderFailure,
  resetProviderCircuitForTests,
} from "@/lib/walletLedger/indexed/shadow/providerCircuitBreaker";
import { normalizeJournalDesiredStatus } from "@/lib/walletLedger/indexed/shadow/batchStatusJournal";
import { normalizeWalletAddress } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import { categorizeShadowWalletOutcome } from "@/lib/walletLedger/indexed/shadow/report";
import type { ShadowWalletComparison } from "@/lib/walletLedger/indexed/shadow/taxonomy";

describe("infraClassification", () => {
  it("does not classify fetchWithTimeout ReferenceError as deferred_infra", () => {
    const err = new ReferenceError("fetchWithTimeout is not defined");
    expect(classifyExecutionOutcome(err)).toBe("internal_error");
  });

  it("classifies Neon connectivity failure as deferred_infra", () => {
    expect(
      classifyExecutionOutcome(new Error("Neon fetch failed"))
    ).toBe("deferred_infra");
  });

  it("classifies query scale errors as internal_error (F)", () => {
    expect(
      classifyExecutionOutcome(
        new QueryScaleError("persisted event page load failed", new Error("Failed query"))
      )
    ).toBe("internal_error");
  });

  it("classifies deterministic wallet errors as wallet_failed (H)", () => {
    expect(
      classifyExecutionOutcome(new Error("invalid wallet checksum"))
    ).toBe("wallet_failed");
  });

  it("detects legacy infra failed rows for reclassification", () => {
    expect(
      isLegacyInfraFailedStatus({
        status: "failed",
        errorMessage: "Neon fetch failed",
      })
    ).toBe(true);
    expect(
      isLegacyInfraFailedStatus({
        status: "complete",
        errorMessage: null,
      })
    ).toBe(false);
  });
});

describe("db circuit breaker", () => {
  beforeEach(() => resetDbCircuitForTests());
  afterEach(() => resetDbCircuitForTests());

  it("opens after consecutive transient failures (B)", () => {
    const err = new Error("fetch failed");
    recordDbFailure(err);
    recordDbFailure(err);
    expect(isDbCircuitOpen()).toBe(false);
    recordDbFailure(err);
    expect(isDbCircuitOpen()).toBe(true);
  });
});

describe("provider circuit breaker", () => {
  beforeEach(() => resetProviderCircuitForTests());
  afterEach(() => resetProviderCircuitForTests());

  it("opens after consecutive provider timeouts (G)", () => {
    const err = new FetchTimeoutError();
    recordProviderFailure(err);
    recordProviderFailure(err);
    expect(isProviderCircuitOpen()).toBe(false);
    recordProviderFailure(err);
    expect(isProviderCircuitOpen()).toBe(true);
  });
});

describe("journal reconciliation", () => {
  it("never converts deferred_infra to failed during normalization (C)", () => {
    expect(normalizeJournalDesiredStatus("deferred_infra")).toBe("deferred_infra");
    expect(normalizeJournalDesiredStatus("failed")).toBe("deferred_infra");
    expect(normalizeJournalDesiredStatus("wallet_failed")).toBe("wallet_failed");
  });
});

describe("report outcome categories", () => {
  const base = {
    wallet: "0x1",
    label: "x",
    cohortReason: "test",
    productionDecision: null,
    apiReconstructedDecision: null,
    indexedDecision: false,
    productionCredible: null,
    indexedCredible: false,
    productionAgreement: false,
    apiAgreement: false,
    agreement: false,
    primaryReason: "other" as const,
    productionReasons: ["other" as const],
    apiReasons: ["other" as const],
    reasons: ["other" as const],
    evidence: {},
    historyValidity: "unusable",
    historyComplete: false,
    credibilityMetricsValid: false,
  };

  it("excludes deferred_infra from wallet-failed confusion matrix (D)", () => {
    const row: ShadowWalletComparison = {
      ...base,
      status: "deferred_infra",
    };
    expect(categorizeShadowWalletOutcome(row)).toBe("deferred-infra");
    expect(categorizeShadowWalletOutcome({ ...base, status: "wallet_failed" })).toBe(
      "wallet-failed"
    );
  });
});

describe("fetchTextWithTimeout", () => {
  it("aborts hung fetch within configured timeout (E)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted.", "AbortError")),
            { once: true }
          );
        });
      })
    );
    const started = Date.now();
    await expect(
      fetchTextWithTimeout("https://example.com/etherscan", { timeoutMs: 100 })
    ).rejects.toBeInstanceOf(FetchTimeoutError);
    expect(Date.now() - started).toBeLessThan(1000);
    vi.unstubAllGlobals();
  });
});

describe("wallet address normalization (I)", () => {
  it("normalizes to lowercase for indexed equality queries", () => {
    expect(normalizeWalletAddress("0xAbC")).toBe("0xabc");
  });
});

describe("infra error detection", () => {
  it("recognizes Neon and Etherscan outage messages", () => {
    expect(isInfraFailureError(new Error("Neon fetch failed"))).toBe(true);
    expect(isInfraFailureError(new Error("Request timed out"))).toBe(true);
  });
});
