import { describe, expect, it } from "vitest";
import { resolveFeedTradeEvPercent } from "@/lib/feedTradeEv";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { passesFeedSocketStakeGate } from "@/lib/feedSocketGate";
import type { SocketTrade } from "@/lib/usePolymarketSocket";

function socketTrade(
  overrides: Partial<SocketTrade> & Pick<SocketTrade, "usdNotional" | "title">
): SocketTrade {
  return {
    id: "t1",
    side: "BUY",
    outcome: "Yes",
    price: 0.5,
    size: 1000,
    timestamp: 1_700_000_000,
    transactionHash: "0xabc",
    ...overrides,
  };
}

describe("resolveFeedTradeEvPercent", () => {
  it("does not treat wallet averageEv as trade EV", () => {
    const pipeline = {
      key: "pm:1",
      status: "ok",
      netEvPercent: null,
      grossEvPercent: null,
      averageEv: 8.5,
      pTrue: 0.45,
    } as PipelineTradeEv;

    expect(
      resolveFeedTradeEvPercent({ price: 0.5 }, pipeline)
    ).toBeCloseTo(-5, 0);
  });

  it("prefers netEvPercent over averageEv", () => {
    const pipeline = {
      key: "pm:1",
      status: "ok",
      netEvPercent: 4.2,
      grossEvPercent: null,
      averageEv: 8.5,
      pTrue: 0.55,
    } as PipelineTradeEv;

    expect(resolveFeedTradeEvPercent({ price: 0.5 }, pipeline)).toBe(4.2);
  });
});

describe("passesFeedSocketStakeGate", () => {
  it("enforces tiered stake floors on socket trades", () => {
    expect(
      passesFeedSocketStakeGate(
        socketTrade({
          usdNotional: 250,
          title: "Will the Lakers win the NBA Finals?",
        })
      )
    ).toBe(true);

    expect(
      passesFeedSocketStakeGate(
        socketTrade({
          usdNotional: 300,
          title: "Will Bitcoin reach $100k?",
        })
      )
    ).toBe(false);

    expect(
      passesFeedSocketStakeGate(
        socketTrade({
          usdNotional: 1000,
          title: "Will Trump win the 2028 presidential election?",
        })
      )
    ).toBe(true);
  });
});
