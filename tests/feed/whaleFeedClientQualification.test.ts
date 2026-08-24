import { describe, expect, it } from "vitest";
import {
  isVisibleInClientFeed,
  passesPolymarketClientFeedVisibilityGate,
  passesPolymarketWalletCredibilityForClient,
} from "@/lib/whaleFeedClientQualification";
import type { WalletQualification } from "@/lib/useQualifiedWalletFilter";
import type { WhaleTrade } from "@/lib/whaleTrades";

const WALLET = "0xabc123def4567890abcdef1234567890abcdef12";

function qualifiedWalletQualification(
  overrides: Partial<WalletQualification> = {}
): WalletQualification {
  return {
    qualified: true,
    avgEv: 0.03,
    resolvedBetsCount: 10,
    avgStakeNotional: 30,
    resolvedVolumeUSD: 300,
    identity: {
      pseudonym: "Qualified Whale",
      initials: "QW",
      winRate: 0.55,
      resolvedBetsCount: 10,
      avgEv: 0.03,
      roi: null,
    },
    ...overrides,
  };
}

function polymarketTrade(overrides: Partial<WhaleTrade> = {}): WhaleTrade {
  return {
    id: "pm-trade-1",
    source: "polymarket",
    title: "Will Bitcoin reach $100k by end of year?",
    outcome: "Yes",
    side: "BUY",
    price: 0.5,
    size: 1000,
    usdNotional: 500,
    timestamp: 1_800_000_000,
    detectedAt: 1_800_000_000_000,
    isLive: false,
    proxyWallet: WALLET,
    netEvPercent: 4.2,
    averageEv: 4.2,
    ...overrides,
  };
}

function kalshiTrade(overrides: Partial<WhaleTrade> = {}): WhaleTrade {
  return {
    id: "kalshi-trade-1",
    source: "kalshi",
    title: "Will the Fed cut rates in March?",
    outcome: "Yes",
    side: "BUY",
    price: 0.4,
    size: 2000,
    usdNotional: 800,
    timestamp: 1_800_000_000,
    detectedAt: 1_800_000_000_000,
    isLive: false,
    ticker: "KX-FED-26MAR",
    netEvPercent: 5,
    averageEv: 5,
    ...overrides,
  };
}

describe("whaleFeedClientQualification", () => {
  const emptyPipeline = new Map();

  it("renders Polymarket trades when trade and wallet gates pass", () => {
    const quals = new Map([[WALLET, qualifiedWalletQualification()]]);
    expect(
      passesPolymarketClientFeedVisibilityGate(
        polymarketTrade(),
        quals,
        emptyPipeline
      )
    ).toBe(true);
    expect(
      isVisibleInClientFeed(polymarketTrade(), quals, emptyPipeline)
    ).toBe(true);
  });

  it("hides Polymarket trades when wallet AVG EV is below +3%", () => {
    const quals = new Map([
      [WALLET, qualifiedWalletQualification({ avgEv: 0.02, qualified: false })],
    ]);
    expect(
      passesPolymarketClientFeedVisibilityGate(
        polymarketTrade(),
        quals,
        emptyPipeline
      )
    ).toBe(false);
  });

  it("hides Polymarket trades when wallet metrics are missing", () => {
    expect(
      passesPolymarketClientFeedVisibilityGate(
        polymarketTrade(),
        new Map(),
        emptyPipeline
      )
    ).toBe(false);
    expect(
      passesPolymarketWalletCredibilityForClient(WALLET, undefined)
    ).toBe(false);
  });

  it("hides Polymarket trades when wallet qualification is unknown in cache", () => {
    const quals = new Map<string, WalletQualification>();
    expect(
      isVisibleInClientFeed(polymarketTrade(), quals, emptyPipeline)
    ).toBe(false);
  });

  it("hides stale buffer Polymarket rows that fail wallet credibility", () => {
    const trade = polymarketTrade();
    const failedQuals = new Map([
      [WALLET, qualifiedWalletQualification({ avgEv: 0.01, qualified: false })],
    ]);
    expect(isVisibleInClientFeed(trade, failedQuals, emptyPipeline)).toBe(
      false
    );
  });

  it("hides Polymarket trades that pass trade EV but fail wallet resolved bets", () => {
    const quals = new Map([
      [
        WALLET,
        qualifiedWalletQualification({
          resolvedBetsCount: 5,
          avgStakeNotional: 20,
          qualified: false,
        }),
      ],
    ]);
    expect(
      isVisibleInClientFeed(polymarketTrade(), quals, emptyPipeline)
    ).toBe(false);
  });

  it("keeps Kalshi visibility on trade EV only without wallet qualification", () => {
    expect(
      isVisibleInClientFeed(kalshiTrade(), new Map(), emptyPipeline)
    ).toBe(true);
    expect(
      isVisibleInClientFeed(
        kalshiTrade({ netEvPercent: 1, averageEv: 1 }),
        new Map(),
        emptyPipeline
      )
    ).toBe(false);
  });
});

describe("recent/backfill admission policy", () => {
  it("requires wallet qualification before Polymarket visibility (seed simulation)", () => {
    const trade = polymarketTrade();
    const pipeline = new Map();

    expect(isVisibleInClientFeed(trade, new Map(), pipeline)).toBe(false);

    const quals = new Map([[WALLET, qualifiedWalletQualification()]]);
    expect(isVisibleInClientFeed(trade, quals, pipeline)).toBe(true);
  });

  it("rejects backfill-style Polymarket rows when wallet gate fails", () => {
    const trade = polymarketTrade({ isLive: false });
    const quals = new Map([
      [WALLET, qualifiedWalletQualification({ avgEv: 0.02, qualified: false })],
    ]);
    expect(isVisibleInClientFeed(trade, quals, new Map())).toBe(false);
  });
});
