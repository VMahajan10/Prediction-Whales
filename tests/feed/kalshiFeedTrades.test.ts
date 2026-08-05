import { describe, expect, it } from "vitest";
import {
  isKalshiTradeEligibleForFeed,
  isKalshiTradeStakeCandidate,
  kalshiFeedTradeToWhale,
  meetsKalshiFeedStakeThreshold,
} from "@/lib/feed/kalshiFeedTrades";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { pipelineEvLookupKeyKalshi } from "@/lib/evPipeline/types";
import {
  STAKE_FLOOR_DEFAULT_USD,
  STAKE_FLOOR_SPORTS_ENTERTAINMENT_USD,
} from "@/lib/x-agent/stakeFloor";

const sportsTrade = {
  id: "kalshi-trade-sports",
  title: "Will the Lakers win the NBA Finals?",
  outcome: "Yes",
  price: 0.42,
  usdNotional: 300,
  timestamp: 1_700_000_000,
  ticker: "NBA-LAL-FINALS",
};

const macroTrade = {
  id: "kalshi-trade-macro",
  title: "Will CPI come in above 3%?",
  outcome: "Yes",
  price: 0.42,
  usdNotional: 600,
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
    const whale = kalshiFeedTradeToWhale(sportsTrade);

    expect(whale.source).toBe("kalshi");
    expect(whale.platform).toBe("KALSHI");
    expect(whale.ticker).toBe("NBA-LAL-FINALS");
    expect(whale.usdNotional).toBe(300);
    expect(whale.detectedAt).toBe(1_700_000_000_000);
    expect(whale.proxyWallet).toBeFalsy();
    expect(whale.whaleIdentity).toBeUndefined();
  });

  it("derives side from the Kalshi outcome when absent", () => {
    expect(kalshiFeedTradeToWhale(sportsTrade).side).toBe("BUY");
    expect(
      kalshiFeedTradeToWhale({ ...sportsTrade, outcome: "No" }).side
    ).toBe("SELL");
  });
});

describe("meetsKalshiFeedStakeThreshold", () => {
  it("uses $250 for sports/culture and $500 default", () => {
    const sportsWhale = kalshiFeedTradeToWhale(sportsTrade);
    const macroWhale = kalshiFeedTradeToWhale(macroTrade);

    expect(meetsKalshiFeedStakeThreshold(sportsWhale)).toBe(true);
    expect(meetsKalshiFeedStakeThreshold(macroWhale)).toBe(true);

    expect(
      meetsKalshiFeedStakeThreshold(
        kalshiFeedTradeToWhale({
          ...sportsTrade,
          usdNotional: STAKE_FLOOR_SPORTS_ENTERTAINMENT_USD - 1,
        })
      )
    ).toBe(false);

    expect(
      meetsKalshiFeedStakeThreshold(
        kalshiFeedTradeToWhale({
          ...macroTrade,
          usdNotional: STAKE_FLOOR_DEFAULT_USD - 1,
        })
      )
    ).toBe(false);
  });
});

describe("isKalshiTradeEligibleForFeed", () => {
  it("admits Kalshi flow clearing tiered stake and +3% EV", () => {
    const whale = kalshiFeedTradeToWhale(sportsTrade);
    expect(
      isKalshiTradeEligibleForFeed(whale, evIndex(sportsTrade.ticker, 4.5))
    ).toBe(true);
  });

  it("rejects stakes below the tiered floor", () => {
    const whale = kalshiFeedTradeToWhale({
      ...sportsTrade,
      usdNotional: STAKE_FLOOR_SPORTS_ENTERTAINMENT_USD - 1,
    });
    expect(
      isKalshiTradeEligibleForFeed(whale, evIndex(sportsTrade.ticker, 9))
    ).toBe(false);
    expect(isKalshiTradeStakeCandidate(whale)).toBe(false);
  });

  it("rejects EV below +3%", () => {
    const whale = kalshiFeedTradeToWhale(sportsTrade);
    expect(
      isKalshiTradeEligibleForFeed(whale, evIndex(sportsTrade.ticker, 2.9))
    ).toBe(false);
  });

  it("admits stake-qualified Kalshi trades while EV is still hydrating", () => {
    const whale = kalshiFeedTradeToWhale(sportsTrade);
    expect(isKalshiTradeEligibleForFeed(whale, new Map())).toBe(true);
    expect(
      isKalshiTradeEligibleForFeed(whale, evIndex(sportsTrade.ticker, 5))
    ).toBe(true);
  });

  it("ignores Polymarket rows", () => {
    const whale = {
      ...kalshiFeedTradeToWhale(sportsTrade),
      source: "polymarket" as const,
    };
    expect(
      isKalshiTradeEligibleForFeed(whale, evIndex(sportsTrade.ticker, 9))
    ).toBe(false);
  });
});
