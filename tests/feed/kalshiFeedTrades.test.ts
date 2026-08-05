import { describe, expect, it } from "vitest";
import {
  isKalshiTradeEligibleForFeed,
  kalshiFeedTradeToWhale,
} from "@/lib/feed/kalshiFeedTrades";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { pipelineEvLookupKeyKalshi } from "@/lib/evPipeline/types";
import { MIN_PRODUCT_FEED_STAKE_USD } from "@/lib/feedQualification";

const baseTrade = {
  id: "kalshi-trade-1",
  title: "Will CPI come in above 3%?",
  outcome: "Yes",
  price: 0.42,
  usdNotional: 900,
  timestamp: 1_700_000_000,
  ticker: "CPI-24-A3",
};

function evIndex(ticker: string, evPercent: number) {
  const key = pipelineEvLookupKeyKalshi(ticker);
  const entry = {
    key,
    status: "ok",
    kalshiTicker: ticker,
    netEvPercent: evPercent,
    pTrueSource: "ensemble",
    pTrueConfidence: 0.8,
    pTrueLowConfidence: false,
  } as unknown as PipelineTradeEv;

  return new Map<string, PipelineTradeEv>([[key, entry]]);
}

describe("kalshiFeedTradeToWhale", () => {
  it("maps a Kalshi feed trade without any trader identity", () => {
    const whale = kalshiFeedTradeToWhale(baseTrade);

    expect(whale.source).toBe("kalshi");
    expect(whale.platform).toBe("KALSHI");
    expect(whale.ticker).toBe("CPI-24-A3");
    expect(whale.usdNotional).toBe(900);
    expect(whale.detectedAt).toBe(1_700_000_000_000);
    expect(whale.proxyWallet).toBeFalsy();
    expect(whale.whaleIdentity).toBeUndefined();
  });

  it("derives side from the Kalshi outcome when absent", () => {
    expect(kalshiFeedTradeToWhale(baseTrade).side).toBe("BUY");
    expect(
      kalshiFeedTradeToWhale({ ...baseTrade, outcome: "No" }).side
    ).toBe("SELL");
  });
});

describe("isKalshiTradeEligibleForFeed", () => {
  it("admits Kalshi flow clearing $500 stake and +3% EV", () => {
    const whale = kalshiFeedTradeToWhale(baseTrade);
    expect(
      isKalshiTradeEligibleForFeed(whale, evIndex(baseTrade.ticker, 4.5))
    ).toBe(true);
  });

  it("rejects stakes below the flat product feed floor", () => {
    const whale = kalshiFeedTradeToWhale({
      ...baseTrade,
      usdNotional: MIN_PRODUCT_FEED_STAKE_USD - 1,
    });
    expect(
      isKalshiTradeEligibleForFeed(whale, evIndex(baseTrade.ticker, 9))
    ).toBe(false);
  });

  it("rejects EV below +3%", () => {
    const whale = kalshiFeedTradeToWhale(baseTrade);
    expect(
      isKalshiTradeEligibleForFeed(whale, evIndex(baseTrade.ticker, 2.9))
    ).toBe(false);
  });

  it("admits stake-qualified Kalshi trades while EV is still hydrating", () => {
    const whale = kalshiFeedTradeToWhale(baseTrade);
    expect(isKalshiTradeEligibleForFeed(whale, new Map())).toBe(true);
    expect(
      isKalshiTradeEligibleForFeed(whale, evIndex(baseTrade.ticker, 5))
    ).toBe(true);
  });

  it("ignores Polymarket rows", () => {
    const whale = { ...kalshiFeedTradeToWhale(baseTrade), source: "polymarket" as const };
    expect(
      isKalshiTradeEligibleForFeed(whale, evIndex(baseTrade.ticker, 9))
    ).toBe(false);
  });
});
