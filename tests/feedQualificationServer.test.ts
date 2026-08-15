import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/feedTradeEvServer", () => ({
  resolveFeedTradeEvPercents: vi.fn(),
  resolveCachedFeedTradeEvPercents: vi.fn(),
}));
vi.mock("@/lib/x-agent/getWhaleAlias", () => ({
  getWhaleAlias: vi.fn(async () => null),
}));
vi.mock("@/lib/x-agent/whaleRegistryDb", () => ({
  findWhaleByWalletCaseInsensitive: vi.fn(),
}));

import {
  collectPolymarketFeedCandidates,
  filterQualifiedPolymarketFeedTrades,
} from "@/lib/feedQualificationServer";
import {
  resolveCachedFeedTradeEvPercents,
  resolveFeedTradeEvPercents,
} from "@/lib/feedTradeEvServer";
import { findWhaleByWalletCaseInsensitive } from "@/lib/x-agent/whaleRegistryDb";

const qualifiedWhale = {
  resolvedBetsCount: 10,
  avgStakeNotional: 50,
  avgEv: 0.05,
  winRate: 0.55,
  pseudonym: "qualified-whale",
};

const baseTrade = {
  id: "t1",
  price: 0.5,
  size: 2000,
  title: "Will Bitcoin reach $100k by end of year?",
  outcome: "Yes",
  side: "BUY" as const,
  assetId: "0xtoken",
  proxyWallet: "0xabc",
};

describe("filterQualifiedPolymarketFeedTrades", () => {
  beforeEach(() => {
    vi.mocked(resolveFeedTradeEvPercents).mockReset();
    vi.mocked(findWhaleByWalletCaseInsensitive).mockReset();
    vi.mocked(findWhaleByWalletCaseInsensitive).mockResolvedValue(
      qualifiedWhale as never
    );
  });

  it("attaches netEvPercent and averageEv for client hydration on page load", async () => {
    vi.mocked(resolveFeedTradeEvPercents).mockResolvedValue(
      new Map([[baseTrade.id, 4.2]])
    );

    const trades = await filterQualifiedPolymarketFeedTrades([baseTrade]);

    expect(trades).toHaveLength(1);
    expect(trades[0]!.netEvPercent).toBe(4.2);
    expect(trades[0]!.averageEv).toBe(4.2);
  });

  it("drops trades below the +3% trade EV threshold", async () => {
    vi.mocked(resolveFeedTradeEvPercents).mockResolvedValue(
      new Map([[baseTrade.id, 1.5]])
    );

    const trades = await filterQualifiedPolymarketFeedTrades([baseTrade]);

    expect(trades).toHaveLength(0);
  });

  it("drops trades with missing EV even when stake passes", async () => {
    vi.mocked(resolveFeedTradeEvPercents).mockResolvedValue(
      new Map([[baseTrade.id, null]])
    );

    const trades = await filterQualifiedPolymarketFeedTrades([baseTrade]);

    expect(trades).toHaveLength(0);
  });
  it("drops trades from traders below product-feed credibility", async () => {
    vi.mocked(resolveFeedTradeEvPercents).mockResolvedValue(
      new Map([[baseTrade.id, 4.2]])
    );
    vi.mocked(findWhaleByWalletCaseInsensitive).mockResolvedValue({
      ...qualifiedWhale,
      resolvedBetsCount: 5,
      avgStakeNotional: 20,
    } as never);

    const trades = await filterQualifiedPolymarketFeedTrades([baseTrade]);

    expect(trades).toHaveLength(0);
  });

  it("includes trades from unindexed Polymarket wallets while metrics backfill", async () => {
    vi.mocked(resolveFeedTradeEvPercents).mockResolvedValue(
      new Map([[baseTrade.id, 4.2]])
    );
    vi.mocked(findWhaleByWalletCaseInsensitive).mockResolvedValue(null);

    const trades = await filterQualifiedPolymarketFeedTrades([baseTrade]);

    expect(trades).toHaveLength(1);
    expect(trades[0]!.netEvPercent).toBe(4.2);
  });
});

describe("collectPolymarketFeedCandidates", () => {
  beforeEach(() => {
    vi.mocked(resolveCachedFeedTradeEvPercents).mockReset();
    vi.mocked(findWhaleByWalletCaseInsensitive).mockReset();
    vi.mocked(findWhaleByWalletCaseInsensitive).mockResolvedValue(
      qualifiedWhale as never
    );
  });

  it("drops trades with uncached EV instead of returning null placeholders", async () => {
    vi.mocked(resolveCachedFeedTradeEvPercents).mockResolvedValue(
      new Map([[baseTrade.id, null]])
    );

    const candidates = await collectPolymarketFeedCandidates([baseTrade]);

    expect(candidates).toHaveLength(0);
  });

  it("attaches cached EV when the pipeline has already scored the asset", async () => {
    vi.mocked(resolveCachedFeedTradeEvPercents).mockResolvedValue(
      new Map([[baseTrade.id, 4.2]])
    );

    const candidates = await collectPolymarketFeedCandidates([baseTrade]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.netEvPercent).toBe(4.2);
    expect(candidates[0]!.averageEv).toBe(4.2);
  });

  it("drops trades already known to be below the +3% threshold", async () => {
    vi.mocked(resolveCachedFeedTradeEvPercents).mockResolvedValue(
      new Map([[baseTrade.id, 1.5]])
    );

    const candidates = await collectPolymarketFeedCandidates([baseTrade]);

    expect(candidates).toHaveLength(0);
  });

  it("drops trades below the tiered stake floor", async () => {
    vi.mocked(resolveCachedFeedTradeEvPercents).mockResolvedValue(
      new Map([[baseTrade.id, 9]])
    );

    const candidates = await collectPolymarketFeedCandidates([
      { ...baseTrade, size: 20 },
    ]);

    expect(candidates).toHaveLength(0);
  });
});
