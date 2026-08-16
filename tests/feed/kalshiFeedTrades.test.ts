import { describe, expect, it } from "vitest";
import {
  diagnoseKalshiFeedTradeGate,
  isKalshiTradeEligibleForFeed,
  isKalshiTradeStakeCandidate,
  kalshiFeedTradeToWhale,
  meetsKalshiFeedStakeThreshold,
  resolveKalshiContractEvFallback,
  resolveKalshiFeedTradeEvPercent,
} from "@/lib/feed/kalshiFeedTrades";
import {
  FEED_ALLOW_MISSING_EV,
  MIN_PRODUCT_FEED_STAKE_USD,
} from "@/lib/feedQualification";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { pipelineEvLookupKeyKalshi } from "@/lib/evPipeline/types";

const sportsTrade = {
  id: "kalshi-trade-sports",
  title: "Will the Lakers win the NBA Finals?",
  outcome: "Yes",
  price: 0.42,
  usdNotional: 600,
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

function unmappedWithPmMid(ticker: string, pmMid: number) {
  const key = pipelineEvLookupKeyKalshi(ticker);
  const entry = {
    key,
    status: "unmapped",
    kalshiTicker: ticker,
    pmMid,
    kalshiMid: null,
    netEvPercent: null,
    pTrueLowConfidence: true,
  } as unknown as PipelineTradeEv;

  return new Map<string, PipelineTradeEv>([[key, entry]]);
}

describe("kalshiFeedTradeToWhale", () => {
  it("maps a Kalshi feed trade without any trader identity", () => {
    const whale = kalshiFeedTradeToWhale(sportsTrade);

    expect(whale.source).toBe("kalshi");
    expect(whale.platform).toBe("KALSHI");
    expect(whale.ticker).toBe("NBA-LAL-FINALS");
    expect(whale.usdNotional).toBe(600);
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
  it("uses flat $500 product feed stake floor", () => {
    expect(
      meetsKalshiFeedStakeThreshold(kalshiFeedTradeToWhale(sportsTrade))
    ).toBe(true);

    expect(
      meetsKalshiFeedStakeThreshold(
        kalshiFeedTradeToWhale({
          ...sportsTrade,
          usdNotional: MIN_PRODUCT_FEED_STAKE_USD,
        })
      )
    ).toBe(true);

    expect(
      meetsKalshiFeedStakeThreshold(
        kalshiFeedTradeToWhale({
          ...sportsTrade,
          usdNotional: MIN_PRODUCT_FEED_STAKE_USD - 1,
        })
      )
    ).toBe(false);
  });
});

describe("resolveKalshiContractEvFallback", () => {
  it("derives EV from PM mid when pipeline ensemble is unmapped", () => {
    const ev = resolveKalshiContractEvFallback(0.4, {
      status: "unmapped",
      pmMid: 0.5,
      kalshiMid: null,
    } as PipelineTradeEv);
    expect(ev).toBeCloseTo(25, 5);
  });
});

describe("isKalshiTradeEligibleForFeed", () => {
  it("admits Kalshi flow clearing $500 stake and relaxed EV", () => {
    const whale = kalshiFeedTradeToWhale(sportsTrade);
    expect(
      isKalshiTradeEligibleForFeed(whale, evIndex(sportsTrade.ticker, 4.5), {
        logRejection: false,
      })
    ).toBe(true);
  });

  it("rejects stakes below the flat $500 floor", () => {
    const whale = kalshiFeedTradeToWhale({
      ...sportsTrade,
      usdNotional: MIN_PRODUCT_FEED_STAKE_USD - 1,
    });
    const result = diagnoseKalshiFeedTradeGate(
      whale,
      evIndex(sportsTrade.ticker, 9)
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toBe("stake_floor");
    expect(isKalshiTradeStakeCandidate(whale)).toBe(false);
  });

  it("rejects negative EV under relaxed +0% floor", () => {
    const whale = kalshiFeedTradeToWhale(sportsTrade);
    const result = diagnoseKalshiFeedTradeGate(
      whale,
      evIndex(sportsTrade.ticker, -0.5)
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toBe("trade_ev");
  });

  it("admits missing pipeline EV during diagnostic volume mode", () => {
    expect(FEED_ALLOW_MISSING_EV).toBe(true);
    const whale = kalshiFeedTradeToWhale(sportsTrade);
    const result = diagnoseKalshiFeedTradeGate(whale, new Map());
    expect(result.passed).toBe(true);
  });

  it("admits via contract mid fallback when ensemble EV is unmapped", () => {
    const whale = kalshiFeedTradeToWhale({ ...sportsTrade, price: 0.4 });
    expect(
      isKalshiTradeEligibleForFeed(
        whale,
        unmappedWithPmMid(sportsTrade.ticker, 0.5),
        { logRejection: false }
      )
    ).toBe(true);
    expect(resolveKalshiFeedTradeEvPercent(whale, null)).toBeNull();
  });

  it("admits when trade carries precomputed netEvPercent", () => {
    const whale = kalshiFeedTradeToWhale(sportsTrade, { netEvPercent: 4.2 });
    expect(
      isKalshiTradeEligibleForFeed(whale, new Map(), { logRejection: false })
    ).toBe(true);
  });

  it("ignores Polymarket rows", () => {
    const whale = {
      ...kalshiFeedTradeToWhale(sportsTrade),
      source: "polymarket" as const,
    };
    expect(
      isKalshiTradeEligibleForFeed(whale, evIndex(sportsTrade.ticker, 9), {
        logRejection: false,
      })
    ).toBe(false);
  });
});
