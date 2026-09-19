import { afterEach, describe, expect, it, vi } from "vitest";
import * as persistWalletHistory from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import * as dbModule from "@/lib/crossmarket/store/db";
import { upsertBatchStatusSafe } from "@/lib/walletLedger/indexed/shadow/batchStatusJournal";

describe("upsertBatchStatusSafe", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs nested DB error causes when persistence fails", async () => {
    vi.spyOn(persistWalletHistory, "walletHistoryDbEnabled").mockReturnValue(true);
    const rootCause = new Error("Connection terminated due to connection timeout");
    (rootCause as Error & { code?: string }).code = "57P01";
    const drizzleError = new Error("Failed query: insert into wallet_shadow_batch_status");
    (drizzleError as Error & { cause?: unknown }).cause = rootCause;

    vi.spyOn(dbModule, "getDb").mockReturnValue({
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: async () => {
            throw drizzleError;
          },
        }),
      }),
    } as never);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await upsertBatchStatusSafe({
      batchId: "test-batch",
      wallet: "0xabc",
      status: "deferred_infra",
      errorMessage: "Etherscan fetch aborted",
    });

    expect(result.persisted).toBe(false);
    expect(result.journaled).toBe(true);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("Connection terminated");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("code=57P01");
  });
});
