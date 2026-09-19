import { describe, expect, it } from "vitest";
import {
  buildWhalePushPayload,
  shouldSendHighEvWhalePush,
} from "@/lib/push/highEvWhalePushLogic";
import type { WhaleTrade } from "@/lib/whaleTrades";

const baseTrade: WhaleTrade = {
  id: "trade-1",
  title: "Will BTC hit $100k?",
  side: "BUY",
  outcome: "Yes",
  price: 0.42,
  size: 1000,
  usdNotional: 1200,
  timestamp: Math.floor(Date.now() / 1000),
  transactionHash: "0xabc",
  detectedAt: Date.now(),
  isLive: true,
  source: "polymarket",
  netEvPercent: 4.2,
};

describe("push notification helpers", () => {
  it("sends high-EV whale pushes above the threshold", () => {
    expect(shouldSendHighEvWhalePush(baseTrade)).toBe(true);
  });

  it("builds whale push payload with market context", () => {
    const payload = buildWhalePushPayload(baseTrade);
    expect(payload.title).toMatch(/High-EV whale trade/);
    expect(payload.body).toMatch(/Will BTC hit \$100k\?/);
    expect(payload.data.path).toBe("/whales/0xabc");
  });

  it("rejects low-EV whale pushes", () => {
    expect(
      shouldSendHighEvWhalePush({
        ...baseTrade,
        netEvPercent: 1.5,
      })
    ).toBe(false);
  });
});
