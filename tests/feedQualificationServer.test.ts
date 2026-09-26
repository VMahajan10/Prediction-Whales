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
vi.mock("@/lib/feed/persistProductFeedTradeEligibility", () => ({
  schedulePersistProductFeedTradeEligibility: vi.fn(),
}));
vi.mock("@/lib/feed/productFeedHistoricalVolume", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/feed/productFeedHistoricalVolume")
    >();
  return {
    ...actual,
    fetchProductFeedHistoricalVolumeByWallet: vi.fn(),
  };
});

import {
  collectPolymarketFeedCandidates,
  filterQualifiedPolymarketFeedTrades,
  qualifyWalletsForFeed,
} from "@/lib/feedQualificationServer";
import {
  resolveFeedTradeEvPercents,
} from "@/lib/feedTradeEvServer";
import { findWhaleByWalletCaseInsensitive } from "@/lib/x-agent/whaleRegistryDb";
import { fetchProductFeedHistoricalVolumeByWallet } from "@/lib/feed/productFeedHistoricalVolume";

const qualifiedWhale = {
  resolvedBetsCount: 10,
  avgStakeNotional: 50,
  avgEv: 0.05,
  winRate: 0.55,
  pseudonym: "qualified-whale",
  hydrationStatus: "complete",
  hydratedAt: new Date(),
};

function mockTrustedHistoricalVolume(volumeUsd = 500) {
  vi.mocked(fetchProductFeedHistoricalVolumeByWallet).mockImplementation(
    async (wallets) => {
      const map = new Map();
      for (const wallet of wallets) {
        map.set(wallet, {
          status: "trusted",
          resolvedVolumeUSD: volumeUsd,
          historicalVolumeGateReason: null,
          historicalResolvedVolumeTrusted: true,
        });
      }
      return map;
    }
  );
}

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
    vi.mocked(fetchProductFeedHistoricalVolumeByWallet).mockReset();
    vi.mocked(findWhaleByWalletCaseInsensitive).mockResolvedValue(
      qualifiedWhale as never
    );
    mockTrustedHistoricalVolume();
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
  it("does not drop trades solely for wallet AVG EV below product feed (Option 1)", async () => {
    vi.mocked(resolveFeedTradeEvPercents).mockResolvedValue(
      new Map([[baseTrade.id, 4.2]])
    );
    vi.mocked(findWhaleByWalletCaseInsensitive).mockResolvedValue({
      ...qualifiedWhale,
      avgEv: 0.02,
    } as never);

    const trades = await filterQualifiedPolymarketFeedTrades([baseTrade]);

    expect(trades).toHaveLength(1);
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

  it("drops trades from unindexed Polymarket wallets when metrics are unavailable", async () => {
    vi.mocked(resolveFeedTradeEvPercents).mockResolvedValue(
      new Map([[baseTrade.id, 4.2]])
    );
    vi.mocked(findWhaleByWalletCaseInsensitive).mockResolvedValue(null);

    const trades = await filterQualifiedPolymarketFeedTrades([baseTrade]);

    expect(trades).toHaveLength(0);
  });

  it("admits trades when avgStakeNotional is zero but indexed volume is trustworthy", async () => {
    vi.mocked(resolveFeedTradeEvPercents).mockResolvedValue(
      new Map([[baseTrade.id, 4.2]])
    );
    vi.mocked(findWhaleByWalletCaseInsensitive).mockResolvedValue({
      ...qualifiedWhale,
      resolvedBetsCount: 50,
      avgStakeNotional: 0,
    } as never);
    mockTrustedHistoricalVolume(500);

    const trades = await filterQualifiedPolymarketFeedTrades([baseTrade]);

    expect(trades).toHaveLength(1);
  });

  it("drops trades when indexed historical volume is unavailable", async () => {
    vi.mocked(resolveFeedTradeEvPercents).mockResolvedValue(
      new Map([[baseTrade.id, 4.2]])
    );
    vi.mocked(fetchProductFeedHistoricalVolumeByWallet).mockResolvedValue(
      new Map([
        [
          "0xabc",
          {
            status: "unavailable",
            resolvedVolumeUSD: null,
            historicalVolumeGateReason: "historical_volume_unavailable",
            historicalResolvedVolumeTrusted: false,
          },
        ],
      ])
    );

    const trades = await filterQualifiedPolymarketFeedTrades([baseTrade]);

    expect(trades).toHaveLength(0);
  });

  it("drops trades missing proxyWallet even when stake and EV pass", async () => {
    vi.mocked(resolveFeedTradeEvPercents).mockResolvedValue(
      new Map([[baseTrade.id, 4.2]])
    );

    const trades = await filterQualifiedPolymarketFeedTrades([
      { ...baseTrade, proxyWallet: undefined },
    ]);

    expect(trades).toHaveLength(0);
  });

  it("includes trades when trade and wallet qualification both pass", async () => {
    vi.mocked(resolveFeedTradeEvPercents).mockResolvedValue(
      new Map([[baseTrade.id, 4.2]])
    );

    const trades = await filterQualifiedPolymarketFeedTrades([baseTrade]);

    expect(trades).toHaveLength(1);
    expect(trades[0]!.netEvPercent).toBe(4.2);
  });
});

describe("collectPolymarketFeedCandidates", () => {
  beforeEach(() => {
    vi.mocked(resolveFeedTradeEvPercents).mockReset();
    vi.mocked(findWhaleByWalletCaseInsensitive).mockReset();
    vi.mocked(fetchProductFeedHistoricalVolumeByWallet).mockReset();
    vi.mocked(findWhaleByWalletCaseInsensitive).mockResolvedValue(
      qualifiedWhale as never
    );
    mockTrustedHistoricalVolume();
  });

  it("drops trades when pipeline cannot resolve trade EV", async () => {
    vi.mocked(resolveFeedTradeEvPercents).mockResolvedValue(
      new Map([[baseTrade.id, null]])
    );

    const candidates = await collectPolymarketFeedCandidates([baseTrade]);

    expect(candidates).toHaveLength(0);
  });

  it("attaches hydrated EV when the pipeline scores the asset", async () => {
    vi.mocked(resolveFeedTradeEvPercents).mockResolvedValue(
      new Map([[baseTrade.id, 4.2]])
    );

    const candidates = await collectPolymarketFeedCandidates([baseTrade]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.netEvPercent).toBe(4.2);
    expect(candidates[0]!.averageEv).toBe(4.2);
  });

  it("drops trades already known to be below the +3% threshold", async () => {
    vi.mocked(resolveFeedTradeEvPercents).mockResolvedValue(
      new Map([[baseTrade.id, 1.5]])
    );

    const candidates = await collectPolymarketFeedCandidates([baseTrade]);

    expect(candidates).toHaveLength(0);
  });

  it("drops trades below the tiered stake floor", async () => {
    vi.mocked(resolveFeedTradeEvPercents).mockResolvedValue(
      new Map([[baseTrade.id, 9]])
    );

    const candidates = await collectPolymarketFeedCandidates([
      { ...baseTrade, size: 20 },
    ]);

    expect(candidates).toHaveLength(0);
  });

  it("reuses provided wallet qualifications without extra registry lookups", async () => {
    vi.mocked(resolveFeedTradeEvPercents).mockResolvedValue(
      new Map([[baseTrade.id, 4.2]])
    );

    const walletQualifications = {
      "0xabc": {
        qualified: true,
        hydrationState: "complete",
        avgEv: 0.05,
        resolvedBetsCount: 10,
        avgStakeNotional: 50,
        resolvedVolumeUSD: 500,
        historicalResolvedVolumeTrusted: true,
        identity: {
          pseudonym: "qualified-whale",
          initials: "QW",
          winRate: 0.55,
          resolvedBetsCount: 10,
          avgEv: 0.05,
          roi: null,
        },
      },
    };

    const candidates = await collectPolymarketFeedCandidates([baseTrade], {
      walletQualifications,
    });

    expect(candidates).toHaveLength(1);
    expect(findWhaleByWalletCaseInsensitive).not.toHaveBeenCalled();
  });
});

describe("qualifyWalletsForFeed batch historical volume", () => {
  beforeEach(() => {
    vi.mocked(findWhaleByWalletCaseInsensitive).mockReset();
    vi.mocked(fetchProductFeedHistoricalVolumeByWallet).mockReset();
    mockTrustedHistoricalVolume();
    vi.mocked(findWhaleByWalletCaseInsensitive).mockResolvedValue(
      qualifiedWhale as never
    );
  });

  it("fetches authoritative volume exactly once for many wallets and duplicate addresses", async () => {
    const wallets = [
      "0xabc",
      "0xabc",
      "0xdef",
      "0xdef",
      "0xdef",
      "0XABC",
    ];

    await qualifyWalletsForFeed(wallets);

    expect(fetchProductFeedHistoricalVolumeByWallet).toHaveBeenCalledTimes(1);
    const [batchArg] = vi.mocked(fetchProductFeedHistoricalVolumeByWallet).mock
      .calls[0]!;
    expect(batchArg.sort()).toEqual(["0xabc", "0xdef"]);
    expect(findWhaleByWalletCaseInsensitive).toHaveBeenCalledTimes(2);
  });
});
