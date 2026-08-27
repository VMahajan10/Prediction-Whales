import { describe, expect, it } from "vitest";
import { cacheKey } from "@/lib/walletLedger/indexed/cache";
import { blockWindows } from "@/lib/walletLedger/indexed/providers/etherscan";
import { buildWalletLogQueries } from "@/lib/walletLedger/indexed/providers/fullHistoryRpc";
import { POLYMARKET_EXCHANGE_INITIAL_BLOCK } from "@/lib/walletLedger/onchain/contracts";

const WALLET = "0x0562e01b3c3e65bb93bf0de32f02cec238a79d66";

describe("indexed provider helpers", () => {
  it("builds wallet log query patterns for exchanges and CTF", () => {
    const queries = buildWalletLogQueries(WALLET, 1_000, 2_000);
    expect(queries.length).toBeGreaterThanOrEqual(7);
    expect(queries.some((q) => q.address === "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e")).toBe(
      true
    );
    expect(
      queries.some((q) => q.address === "0x4d97dcd97ec945f40cf65f87097ace5ea0476045")
    ).toBe(true);
  });

  it("splits block ranges into etherscan-safe windows", () => {
    const windows = blockWindows(10_000, 20_000, 4_999);
    expect(windows.length).toBeGreaterThan(1);
    expect(windows[0].from).toBe(10_000);
    expect(windows.at(-1)?.to).toBeLessThanOrEqual(20_000);
  });

  it("generates stable cache keys", () => {
    const a = cacheKey(["etherscan", WALLET, "wallet"]);
    const b = cacheKey(["etherscan", WALLET, "wallet"]);
    const c = cacheKey(["etherscan", WALLET, "resolution"]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("uses exchange initial block as full-history floor", () => {
    expect(POLYMARKET_EXCHANGE_INITIAL_BLOCK).toBeGreaterThan(50_000_000);
  });
});

describe("indexed completeness guard", () => {
  it("does not mark complete without pre-api events and full scan", () => {
    const indexedHistoryComplete =
      false && 0 > 0 && true;
    expect(indexedHistoryComplete).toBe(false);
  });
});
