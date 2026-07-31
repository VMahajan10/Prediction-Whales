import { describe, expect, it } from "vitest";
import {
  evaluatePostQueueSourceGate,
  isPostQueueSourceAllowed,
  KALSHI_PUBLIC_POSTING_DISABLED,
} from "@/lib/x-agent/postQueueGates";

describe("postQueueGates", () => {
  it("allows only polymarket trades through the post-queue source gate", () => {
    expect(isPostQueueSourceAllowed("polymarket")).toBe(true);
    expect(isPostQueueSourceAllowed("kalshi")).toBe(false);
  });

  it("rejects kalshi with KALSHI_PUBLIC_POSTING_DISABLED", () => {
    const result = evaluatePostQueueSourceGate({
      source: "kalshi",
      tradeId: "kalshi-trade-1",
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe(KALSHI_PUBLIC_POSTING_DISABLED);
  });

  it("passes polymarket trades", () => {
    const result = evaluatePostQueueSourceGate({
      source: "polymarket",
      tradeId: "pm-trade-1",
    });

    expect(result.passed).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});
