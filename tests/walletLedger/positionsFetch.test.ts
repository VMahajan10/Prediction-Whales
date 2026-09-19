import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPositionsSnapshot } from "@/lib/walletLedger/fetchers";
import {
  classifyExecutionOutcome,
  clearWalletFailures,
  isCodeDefectError,
  recordWalletFailure,
  resolveExecutionOutcome,
} from "@/lib/walletLedger/indexed/shadow/infraClassification";

describe("positions_fetch runtime binding", () => {
  beforeEach(() => {
    clearWalletFailures();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("invokes fetchTextWithTimeout without ReferenceError", async () => {
    const fetchTextWithTimeout = vi.fn(async () => ({
      response: { ok: true, status: 200 } as Response,
      text: JSON.stringify([{ asset: "1", conditionId: "c1" }]),
    }));
    vi.doMock("@/lib/fetchWithTimeout", () => ({
      FetchTimeoutError: class FetchTimeoutError extends Error {},
      fetchTextWithTimeout,
    }));
    vi.doMock("@/lib/walletLedger/indexed/auditProgress", () => ({
      auditLog: vi.fn(),
      isAuditProgressEnabled: () => false,
    }));

    const { fetchPositionsSnapshot: loadPositions } = await import(
      "@/lib/walletLedger/fetchers"
    );
    const rows = await loadPositions("0x7e5972bfc25819775ee5a9d4f191919375487b8b");
    expect(fetchTextWithTimeout).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
  });
});

describe("strict failure classification", () => {
  beforeEach(() => clearWalletFailures());

  it("does not classify fetchWithTimeout ReferenceError as deferred_infra", () => {
    const err = new ReferenceError("fetchWithTimeout is not defined");
    expect(isCodeDefectError(err)).toBe(true);
    expect(classifyExecutionOutcome(err)).toBe("internal_error");
  });

  it("preserves code defect as primary over later infra failure", () => {
    const wallet = "0xabc";
    recordWalletFailure(wallet, "positions_fetch", new ReferenceError("fetchWithTimeout is not defined"));
    recordWalletFailure(wallet, "loadPersistedWalletEvents", new Error("Neon fetch failed"));
    expect(resolveExecutionOutcome(wallet, new Error("Neon fetch failed"))).toBe(
      "internal_error"
    );
  });

  it("classifies Neon failed query as deferred_infra when no code defect", () => {
    const err = new Error(
      'Failed query: select count(*)::int from "wallet_ledger_events" where wallet_address = $1'
    );
    expect(classifyExecutionOutcome(err)).toBe("deferred_infra");
  });
});
