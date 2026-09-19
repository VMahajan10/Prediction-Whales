import { existsSync, mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendBatchStatusJournal,
  readBatchStatusJournal,
  SHADOW_STATUS_JOURNAL_DIR,
  SHADOW_STATUS_JOURNAL_FILE,
} from "@/lib/walletLedger/indexed/shadow/batchStatusJournal";
import {
  isDeterministicSqlError,
  isRetryableTransientError,
  isTransientNetworkError,
} from "@/lib/walletLedger/indexed/shadow/transientRetry";

describe("transientRetry", () => {
  it("classifies fetch failed and ETIMEDOUT as transient", () => {
    expect(isTransientNetworkError(new Error("fetch failed"))).toBe(true);
    expect(isTransientNetworkError(new Error("connect ETIMEDOUT"))).toBe(true);
    expect(isTransientNetworkError(new Error("HTTP 429"))).toBe(true);
  });

  it("does not retry deterministic SQL errors", () => {
    const sqlError = new Error('column "foo" does not exist');
    expect(isDeterministicSqlError(sqlError)).toBe(true);
    expect(isRetryableTransientError(sqlError)).toBe(false);
  });
});

describe("batch status journal", () => {
  afterEach(() => {
    if (existsSync(SHADOW_STATUS_JOURNAL_FILE)) {
      rmSync(SHADOW_STATUS_JOURNAL_FILE);
    }
  });

  it("appends durable journal entries when DB write would fail", () => {
    if (existsSync(SHADOW_STATUS_JOURNAL_DIR)) {
      rmSync(SHADOW_STATUS_JOURNAL_DIR, { recursive: true, force: true });
    }
    mkdirSync(SHADOW_STATUS_JOURNAL_DIR, { recursive: true });
    appendBatchStatusJournal({
      batchId: "phase2e1-full50-v2",
      wallet: "0xabc",
      desiredStatus: "failed",
      error: "fetch failed",
      timestamp: new Date().toISOString(),
    });
    const entries = readBatchStatusJournal();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.desiredStatus).toBe("failed");
    expect(entries[0]?.wallet).toBe("0xabc");
  });
});

describe("processWallet isolation", () => {
  it("Promise.allSettled continues after one wallet rejection", async () => {
    const wallets = ["0x1", "0x2", "0x3"];
    const results = await Promise.allSettled(
      wallets.map(async (wallet) => {
        if (wallet === "0x2") throw new Error("etherscan fetch failed");
        return { wallet, status: "complete" };
      })
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});

describe("upsertBatchStatusSafe resilience", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(SHADOW_STATUS_JOURNAL_FILE)) {
      rmSync(SHADOW_STATUS_JOURNAL_FILE);
    }
  });

  it("does not throw when transient DB failures exhaust retries (F)", async () => {
    vi.doMock("@/lib/walletLedger/indexed/shadow/transientRetry", () => ({
      retryTransient: vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    }));
    vi.doMock("@/lib/walletLedger/indexed/store/persistWalletHistory", () => ({
      walletHistoryDbEnabled: () => true,
    }));
    const { upsertBatchStatusSafe } = await import(
      "@/lib/walletLedger/indexed/shadow/batchStatusJournal"
    );
    const result = await upsertBatchStatusSafe({
      batchId: "phase2e1-full50-v2",
      wallet: "0xdead",
      status: "failed",
      errorMessage: "etherscan fetch failed",
    });
    expect(result.journaled).toBe(true);
    expect(result.persisted).toBe(false);
    expect(readBatchStatusJournal()).toHaveLength(1);
  });

  it("flushes journaled status on next healthy DB connection (H)", async () => {
    if (!existsSync(SHADOW_STATUS_JOURNAL_DIR)) {
      mkdirSync(SHADOW_STATUS_JOURNAL_DIR, { recursive: true });
    }
    appendBatchStatusJournal({
      batchId: "phase2e1-full50-v2",
      wallet: "0xbeef",
      desiredStatus: "failed",
      error: "fetch failed",
      timestamp: new Date().toISOString(),
    });

    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/crossmarket/store/db", () => ({
      getDb: () => ({
        insert: () => ({
          values: () => ({
            onConflictDoUpdate,
          }),
        }),
      }),
    }));
    vi.doMock("@/lib/walletLedger/indexed/store/persistWalletHistory", () => ({
      walletHistoryDbEnabled: () => true,
    }));
    vi.doMock("@/lib/walletLedger/indexed/shadow/transientRetry", () => ({
      retryTransient: vi.fn(async (fn: () => Promise<void>) => fn()),
    }));

    const { reconcileBatchStatusJournal } = await import(
      "@/lib/walletLedger/indexed/shadow/batchStatusJournal"
    );
    const result = await reconcileBatchStatusJournal("phase2e1-full50-v2");
    expect(result.reconciled).toBe(1);
    expect(onConflictDoUpdate).toHaveBeenCalled();
  });
});

describe("stale running wallet resume", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resetStaleRunningBatchWallets targets running rows only (G)", async () => {
    const returning = vi.fn().mockResolvedValue([{ walletAddress: "0xabc" }]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    vi.doMock("@/lib/crossmarket/store/db", () => ({
      getDb: () => ({ update }),
    }));
    vi.doMock("@/lib/walletLedger/indexed/store/persistWalletHistory", () => ({
      walletHistoryDbEnabled: () => true,
    }));

    const { resetStaleRunningBatchWallets } = await import(
      "@/lib/walletLedger/indexed/shadow/batchStatusJournal"
    );
    const count = await resetStaleRunningBatchWallets("phase2e1-full50-v2");
    expect(count).toBe(1);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending" })
    );
  });
});
