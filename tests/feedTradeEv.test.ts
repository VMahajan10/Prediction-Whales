import { describe, expect, it } from "vitest";
import { resolveFeedTradeEvPercent } from "@/lib/feedTradeEv";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { passesFeedSocketStakeGate } from "@/lib/feedSocketGateClient";
import type { SocketTrade } from "@/lib/types/socket";

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

  it("ignores low-confidence universal_prior pTrue fallback", () => {
    const pipeline = {
      key: "pm:1",
      status: "ok",
      netEvPercent: null,
      grossEvPercent: null,
      averageEv: null,
      pTrue: 0.5,
      pTrueLowConfidence: true,
      pTrueSource: "universal_prior",
      pmMid: 0.41,
    } as PipelineTradeEv;

    expect(
      resolveFeedTradeEvPercent({ price: 0.41 }, pipeline)
    ).toBeNull();
  });

  it("rejects synthetic netEvPercent from low-confidence pipeline EV", () => {
    const pipeline = {
      key: "pm:1",
      status: "ok",
      netEvPercent: 35,
      grossEvPercent: null,
      pTrue: 0.5,
      pTrueLowConfidence: true,
      pTrueSource: "universal_prior",
      pTrueConfidence: 0.1,
    } as PipelineTradeEv;

    expect(resolveFeedTradeEvPercent({ price: 0.15 }, pipeline)).toBeNull();
  });

  it("uses authoritative netEvPercent for high-edge trades", () => {
    const pipeline = {
      key: "pm:1",
      status: "ok",
      netEvPercent: 9,
      grossEvPercent: null,
      pTrue: 0.59,
      pTrueLowConfidence: false,
      pTrueSource: "cached_ensemble",
      pTrueConfidence: 0.8,
    } as PipelineTradeEv;

    expect(resolveFeedTradeEvPercent({ price: 0.5 }, pipeline)).toBe(9);
  });
});

describe("passesFeedSocketStakeGate", () => {
  it("enforces the flat $500 product feed floor regardless of category", () => {
    // Sports below $500 no longer qualifies — tiered floors are post-queue only.
    expect(
      passesFeedSocketStakeGate(
        socketTrade({
          usdNotional: 250,
          title: "Will the Lakers win the NBA Finals?",
        })
      )
    ).toBe(false);

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
          usdNotional: 500,
          title: "Will the Lakers win the NBA Finals?",
        })
      )
    ).toBe(true);

    // Macro no longer needs $1k for the product feed.
    expect(
      passesFeedSocketStakeGate(
        socketTrade({
          usdNotional: 500,
          title: "Will Trump win the 2028 presidential election?",
        })
      )
    ).toBe(true);
  });
});
