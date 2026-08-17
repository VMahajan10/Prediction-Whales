import { describe, expect, it } from "vitest";
import {
  mergePipelineEvOntoWhale,
  stampWhaleFeedAdmissionEv,
  whaleHasStampedFeedEv,
} from "@/lib/whaleCardEv";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import type { WhaleTrade } from "@/lib/whaleTrades";

function whaleTrade(overrides: Partial<WhaleTrade> = {}): WhaleTrade {
  return {
    id: "t1",
    title: "Taylor Fritz vs Rafael Jodar",
    side: "BUY",
    outcome: "Yes",
    price: 0.5,
    size: 1000,
    timestamp: 1_700_000_000,
    transactionHash: "0xabc",
    source: "polymarket",
    usdNotional: 1000,
    detectedAt: 1_700_000_000_000,
    isLive: true,
    ...overrides,
  };
}

function pipeline(overrides: Partial<PipelineTradeEv> = {}): PipelineTradeEv {
  return {
    key: "pm:1",
    status: "ok",
    tokenId: "0xtoken",
    kalshiTicker: null,
    netEvPercent: 4.2,
    netEv: 42,
    pTrue: 0.55,
    pTrueSource: "cached_ensemble",
    pTrueConfidence: 0.8,
    pTrueLowConfidence: false,
    ...overrides,
  };
}

describe("mergePipelineEvOntoWhale", () => {
  it("attaches authoritative pipeline EV to a trade with no EV of its own", () => {
    const merged = mergePipelineEvOntoWhale(whaleTrade(), pipeline());

    expect(merged.netEvPercent).toBe(4.2);
    expect(merged.averageEv).toBe(4.2);
  });

  it("keeps EV in percent units so the card does not render 0.8 as 80%", () => {
    const merged = mergePipelineEvOntoWhale(
      whaleTrade(),
      pipeline({ netEvPercent: 0.8 })
    );

    expect(merged.averageEv).toBe(0.8);
  });

  it("withholds EV when p_true is a non-authoritative universal prior", () => {
    const merged = mergePipelineEvOntoWhale(
      whaleTrade({ price: 0.15 }),
      pipeline({
        netEvPercent: 35,
        pTrue: 0.5,
        pTrueSource: "universal_prior",
        pTrueConfidence: 0.1,
        pTrueLowConfidence: true,
      })
    );

    expect(merged.netEvPercent).toBeUndefined();
    expect(merged.averageEv).toBeUndefined();
  });

  it("withholds EV for abstained (unmapped) pipeline entries", () => {
    const merged = mergePipelineEvOntoWhale(
      whaleTrade(),
      pipeline({
        status: "unmapped",
        netEvPercent: null,
        averageEv: null,
        pTrue: null,
      })
    );

    expect(merged.averageEv).toBeUndefined();
  });

  it("preserves referential identity when there is nothing to merge", () => {
    const trade = whaleTrade();

    expect(mergePipelineEvOntoWhale(trade, null)).toBe(trade);
    expect(mergePipelineEvOntoWhale(trade, undefined)).toBe(trade);
  });

  it("reprices stale cached zero EV from pipeline p_true", () => {
    const merged = mergePipelineEvOntoWhale(
      whaleTrade({ price: 0.4, netEvPercent: 0, averageEv: 0 }),
      pipeline({
        netEvPercent: 0,
        averageEv: 0,
        pTrue: 0.5,
        pMarket: 0.4,
        pmMid: 0.4,
      })
    );

    expect(merged.netEvPercent).toBeCloseTo(25, 0);
    expect(merged.averageEv).toBeCloseTo(25, 0);
  });

  it("does not overwrite an EV the trade already carries", () => {
    const trade = whaleTrade({ netEvPercent: 6.1 });
    const merged = mergePipelineEvOntoWhale(trade, pipeline({ netEvPercent: 4.2 }));

    expect(merged).toBe(trade);
    expect(merged.netEvPercent).toBe(6.1);
  });
});

describe("stampWhaleFeedAdmissionEv", () => {
  it("freezes gate-passing EV onto the trade row", () => {
    const stamped = stampWhaleFeedAdmissionEv(whaleTrade(), 4.2);

    expect(stamped.netEvPercent).toBe(4.2);
    expect(stamped.averageEv).toBe(4.2);
  });

  it("does not overwrite an existing stamped EV", () => {
    const trade = whaleTrade({ netEvPercent: 6.1, averageEv: 6.1 });
    const stamped = stampWhaleFeedAdmissionEv(trade, 4.2);

    expect(stamped).toBe(trade);
    expect(stamped.netEvPercent).toBe(6.1);
  });

  it("detects stamped feed EV on the trade", () => {
    expect(whaleHasStampedFeedEv(whaleTrade())).toBe(false);
    expect(whaleHasStampedFeedEv(whaleTrade({ averageEv: 0 }))).toBe(false);
    expect(
      whaleHasStampedFeedEv(
        stampWhaleFeedAdmissionEv(whaleTrade(), 4.2)
      )
    ).toBe(true);
  });
});
