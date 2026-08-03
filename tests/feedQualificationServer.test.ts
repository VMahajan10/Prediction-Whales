import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/feedTradeEvServer", () => ({
  resolveFeedTradeEvPercents: vi.fn(),
}));

import { filterQualifiedPolymarketFeedTrades } from "@/lib/feedQualificationServer";
import { resolveFeedTradeEvPercents } from "@/lib/feedTradeEvServer";

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
