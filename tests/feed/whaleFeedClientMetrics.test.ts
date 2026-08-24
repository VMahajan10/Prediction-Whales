import { describe, expect, it } from "vitest";
import {
  aggregatePolymarketFeedMetrics,
  type PolymarketFeedMetricsAccumulator,
} from "@/lib/whaleFeedClientQualification";
import type { WalletQualification } from "@/lib/useQualifiedWalletFilter";
import type { WhaleTrade } from "@/lib/whaleTrades";

const WALLET_A = "0xabc123def4567890abcdef1234567890abcdef12";
const WALLET_B = "0xdef4567890abcdef1234567890abcdef12345678";

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
    proxyWallet: WALLET_A,
    netEvPercent: 4.2,
    averageEv: 4.2,
    transactionHash: "0xhash1",
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
    transactionHash: "kalshi-hash-1",
    ...overrides,
  };
}

function emptyAccumulator(): PolymarketFeedMetricsAccumulator {
  return {
    metricsDetected: new Set<string>(),
    metricsPassed: new Set<string>(),
    metricsFinalized: new Set<string>(),
  };
}

function aggregate(
  trades: WhaleTrade[],
  walletQualifications: Map<string, WalletQualification> = new Map(),
  accumulator = emptyAccumulator()
) {
  return aggregatePolymarketFeedMetrics(
    trades,
    walletQualifications,
    new Map(),
    accumulator
  );
}

describe("aggregatePolymarketFeedMetrics", () => {
  it("counts fully qualified trades in gatePassedTrades and passed wallets", () => {
    const quals = new Map([[WALLET_A, qualifiedWalletQualification()]]);
    const delta = aggregate([polymarketTrade()], quals);

    expect(delta.tradesDetected).toBe(1);
    expect(delta.gatePassedTrades).toBe(1);
    expect(delta.passedWallets).toEqual([WALLET_A]);
  });

  it("does not gate-pass when trade passes but wallet AVG EV fails", () => {
    const quals = new Map([
      [WALLET_A, qualifiedWalletQualification({ avgEv: 0.01, qualified: false })],
    ]);
    const delta = aggregate([polymarketTrade({ usdNotional: 1000, netEvPercent: 5 })], quals);

    expect(delta.tradesDetected).toBe(1);
    expect(delta.gatePassedTrades).toBe(0);
    expect(delta.passedWallets).toEqual([]);
  });

  it("does not gate-pass when wallet metrics are missing", () => {
    const delta = aggregate([polymarketTrade({ usdNotional: 1000, netEvPercent: 5 })]);

    expect(delta.tradesDetected).toBe(1);
    expect(delta.gatePassedTrades).toBe(0);
    expect(delta.passedWallets).toEqual([]);
  });

  it("does not gate-pass when wallet resolved-bets count is below floor", () => {
    const quals = new Map([
      [
        WALLET_A,
        qualifiedWalletQualification({
          resolvedBetsCount: 5,
          avgStakeNotional: 20,
          qualified: false,
        }),
      ],
    ]);
    const delta = aggregate([polymarketTrade()], quals);

    expect(delta.tradesDetected).toBe(1);
    expect(delta.gatePassedTrades).toBe(0);
    expect(delta.passedWallets).toEqual([]);
  });

  it("counts three gate-passed trades for one wallet without double-counting on reprocess", () => {
    const quals = new Map([[WALLET_A, qualifiedWalletQualification()]]);
    const accumulator = emptyAccumulator();
    const trades = [
      polymarketTrade({ id: "t1", transactionHash: "0x1" }),
      polymarketTrade({ id: "t2", transactionHash: "0x2" }),
      polymarketTrade({ id: "t3", transactionHash: "0x3" }),
    ];

    const first = aggregate(trades, quals, accumulator);
    expect(first.tradesDetected).toBe(3);
    expect(first.gatePassedTrades).toBe(3);
    expect(first.passedWallets).toEqual([WALLET_A, WALLET_A, WALLET_A]);

    const second = aggregate(trades, quals, accumulator);
    expect(second.tradesDetected).toBe(0);
    expect(second.gatePassedTrades).toBe(0);
    expect(second.passedWallets).toEqual([]);
  });

  it("normalizes duplicate wallet casing in passed wallets", () => {
    const upperWallet = WALLET_A.toUpperCase();
    const quals = new Map([[WALLET_A, qualifiedWalletQualification()]]);
    const delta = aggregate(
      [polymarketTrade({ proxyWallet: upperWallet })],
      quals
    );

    expect(delta.gatePassedTrades).toBe(1);
    expect(delta.passedWallets).toEqual([upperWallet.toLowerCase()]);
  });

  it("counts mixed qualification batches correctly", () => {
    const quals = new Map([
      [WALLET_A, qualifiedWalletQualification()],
      [WALLET_B, qualifiedWalletQualification({ avgEv: 0.01, qualified: false })],
    ]);
    const trades = [
      polymarketTrade({ id: "full-1", transactionHash: "0xf1", proxyWallet: WALLET_A }),
      polymarketTrade({ id: "full-2", transactionHash: "0xf2", proxyWallet: WALLET_A }),
      polymarketTrade({
        id: "wallet-fail",
        transactionHash: "0xw1",
        proxyWallet: WALLET_B,
        usdNotional: 700,
        netEvPercent: 4,
      }),
      polymarketTrade({
        id: "stake-fail",
        transactionHash: "0xs1",
        usdNotional: 100,
        netEvPercent: 10,
      }),
      polymarketTrade({
        id: "missing-wallet",
        transactionHash: "0xm1",
        proxyWallet: "0x9999999999999999999999999999999999999999",
        usdNotional: 600,
        netEvPercent: 4,
      }),
    ];

    const delta = aggregate(trades, quals);

    expect(delta.tradesDetected).toBe(4);
    expect(delta.gatePassedTrades).toBe(2);
    expect(delta.passedWallets).toEqual([WALLET_A, WALLET_A]);
  });

  it("gate-passes once wallet qualification arrives after initial detection", () => {
    const trade = polymarketTrade({
      id: "pending-wallet",
      transactionHash: "0xpending",
      usdNotional: 1000,
      netEvPercent: 5,
    });
    const accumulator = emptyAccumulator();

    const beforeQual = aggregate([trade], new Map(), accumulator);
    expect(beforeQual.tradesDetected).toBe(1);
    expect(beforeQual.gatePassedTrades).toBe(0);

    const afterQual = aggregate(
      [trade],
      new Map([[WALLET_A, qualifiedWalletQualification()]]),
      accumulator
    );
    expect(afterQual.tradesDetected).toBe(0);
    expect(afterQual.gatePassedTrades).toBe(1);
    expect(afterQual.passedWallets).toEqual([WALLET_A]);
  });

  it("example: high stake and trade EV but low wallet AVG EV is not gate-passed", () => {
    const quals = new Map([
      [WALLET_A, qualifiedWalletQualification({ avgEv: 0.01, qualified: false })],
    ]);
    const delta = aggregate(
      [
        polymarketTrade({
          usdNotional: 1000,
          netEvPercent: 5,
          averageEv: 5,
        }),
      ],
      quals
    );

    expect(delta.tradesDetected).toBe(1);
    expect(delta.gatePassedTrades).toBe(0);
    expect(delta.passedWallets).toEqual([]);
  });

  it("ignores Kalshi trades for Polymarket metrics aggregation", () => {
    const delta = aggregate([kalshiTrade(), kalshiTrade({ id: "k2" })]);

    expect(delta.tradesDetected).toBe(0);
    expect(delta.gatePassedTrades).toBe(0);
    expect(delta.passedWallets).toEqual([]);
  });
});
