import { describe, expect, it } from "vitest";
import {
  classifyBlockTimestampFailure,
  computeNextRetryAt,
  recordBlockFailure,
  shouldSkipFailedBlock,
} from "@/lib/walletLedger/indexed/blockTimestampFailures";

describe("blockTimestampFailures TTL", () => {
  it("uses transient class by default", () => {
    expect(classifyBlockTimestampFailure("Request timed out")).toBe("transient");
  });

  it("skips block before nextRetryAt", () => {
    const store: Record<string, import("@/lib/walletLedger/indexed/blockTimestampFailures").BlockTimestampFailureEntry> = {};
    recordBlockFailure(store, 123, "transient");
    const entry = store["123"]!;
    expect(shouldSkipFailedBlock(entry, Date.now())).toBe(true);
    expect(
      shouldSkipFailedBlock(entry, Date.parse(entry.nextRetryAt) + 1_000)
    ).toBe(false);
  });

  it("increases attemptCount on repeated failures", () => {
    const store: Record<string, import("@/lib/walletLedger/indexed/blockTimestampFailures").BlockTimestampFailureEntry> = {};
    recordBlockFailure(store, 50, "transient");
    recordBlockFailure(store, 50, "transient");
    expect(store["50"]!.attemptCount).toBe(2);
    const t1 = Date.parse(computeNextRetryAt(1, "transient", 1_000_000));
    const t2 = Date.parse(computeNextRetryAt(2, "transient", 1_000_000));
    expect(t2).toBeGreaterThan(t1);
  });
});
