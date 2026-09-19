import { describe, expect, it } from "vitest";
import { isIndexedLogCacheEnabled } from "@/lib/walletLedger/indexed/cache";

describe("indexed log cache", () => {
  it("disables inline JSON cache for etherscan checkpoints", () => {
    expect(isIndexedLogCacheEnabled("etherscan_v2")).toBe(false);
    expect(isIndexedLogCacheEnabled("full_history_rpc")).toBe(true);
  });
});
