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
  it("preserves netEvPercent stamped on the API payload", () => {
    const whale = kalshiFeedTradeToWhale({
      ...sportsTrade,
      netEvPercent: 4.8,
    });
    expect(whale.netEvPercent).toBe(4.8);
    expect(
      isKalshiTradeEligibleForFeed(whale, new Map(), { logRejection: false })
    ).toBe(true);
  });

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

  it("derives EV from pMarket when mids are absent on unmapped rows", () => {
    const ev = resolveKalshiContractEvFallback(0.4, {
      status: "unmapped",
      pmMid: null,
      kalshiMid: null,
      pMarket: 0.5,
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

  it("rejects negative EV under the +3% product feed floor", () => {
    const whale = kalshiFeedTradeToWhale(sportsTrade);
    const result = diagnoseKalshiFeedTradeGate(
      whale,
      evIndex(sportsTrade.ticker, -0.5)
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toBe("trade_ev");
  });

  it("rejects missing pipeline EV when product feed requires resolved edge", () => {
    const whale = kalshiFeedTradeToWhale(sportsTrade);
    const result = diagnoseKalshiFeedTradeGate(whale, new Map());
    expect(result.passed).toBe(false);
    expect(result.reason).toBe("missing_trade_ev");
  });

  it("admits via entry-price fallback when pipeline index misses but pTrue is on row", () => {
    const whale = kalshiFeedTradeToWhale({
      ...macroTrade,
      ticker: "KXFED-26OCT-T3.00",
      price: 0.4,
    });
    const pipeline = {
      key: pipelineEvLookupKeyKalshi("KXFED-26OCT-T3.00"),
      status: "unmapped",
      kalshiTicker: "KXFED-26OCT-T3.00",
      pTrue: 0.5,
      pMarket: null,
      pmMid: null,
      kalshiMid: null,
      netEvPercent: null,
    } as PipelineTradeEv;

    expect(resolveKalshiFeedTradeEvPercent(whale, pipeline)).toBeCloseTo(25, 5);
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

  it("admits NO-side trades via PM mid converted to NO probability space", () => {
    const whale = kalshiFeedTradeToWhale({
      ...sportsTrade,
      outcome: "No",
      price: 0.35,
    });
    expect(
      isKalshiTradeEligibleForFeed(
        whale,
        unmappedWithPmMid(sportsTrade.ticker, 0.6),
        { logRejection: false }
      )
    ).toBe(true);
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
