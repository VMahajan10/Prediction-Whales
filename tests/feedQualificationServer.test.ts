import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/feedTradeEvServer", () => ({
  resolveFeedTradeEvPercents: vi.fn(),
  resolveCachedFeedTradeEvPercents: vi.fn(),
}));

import {
  collectPolymarketFeedCandidates,
  filterQualifiedPolymarketFeedTrades,
} from "@/lib/feedQualificationServer";
import {
  resolveCachedFeedTradeEvPercents,
  resolveFeedTradeEvPercents,
} from "@/lib/feedTradeEvServer";

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
});

describe("collectPolymarketFeedCandidates", () => {
  beforeEach(() => {
    vi.mocked(resolveCachedFeedTradeEvPercents).mockReset();
  });

  it("keeps stake-qualified trades with uncached EV so the client can hydrate them", async () => {
    vi.mocked(resolveCachedFeedTradeEvPercents).mockResolvedValue(
      new Map([[baseTrade.id, null]])
    );

    const candidates = await collectPolymarketFeedCandidates([baseTrade]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.netEvPercent).toBeNull();
    expect(candidates[0]!.averageEv).toBeNull();
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
