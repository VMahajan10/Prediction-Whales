import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/x-agent/whaleRegistryDb", () => ({
  findWhaleByWalletCaseInsensitive: vi.fn(),
}));

import { filterPolymarketTradesByWalletCredibility } from "@/lib/feedQualificationServer";
import { findWhaleByWalletCaseInsensitive } from "@/lib/x-agent/whaleRegistryDb";

const qualifiedWhale = {
  resolvedBetsCount: 10,
  avgStakeNotional: 30,
  avgEv: 0.03,
  winRate: 0.55,
  pseudonym: "qualified-whale",
};

type RecentLikeTrade = {
  id: string;
  proxyWallet?: string;
};

describe("recent/backfill Polymarket wallet gate", () => {
  beforeEach(() => {
    vi.mocked(findWhaleByWalletCaseInsensitive).mockReset();
  });

  it("excludes trade-qualified rows when wallet AVG EV fails", async () => {
    vi.mocked(findWhaleByWalletCaseInsensitive).mockResolvedValue({
      ...qualifiedWhale,
      avgEv: 0.02,
    } as never);

    const trades: RecentLikeTrade[] = [
      { id: "t1", proxyWallet: "0xabc" },
    ];

    const filtered = await filterPolymarketTradesByWalletCredibility(trades);

    expect(filtered).toHaveLength(0);
  });

  it("excludes trade-qualified rows when resolved-bet requirement fails", async () => {
    vi.mocked(findWhaleByWalletCaseInsensitive).mockResolvedValue({
      ...qualifiedWhale,
      resolvedBetsCount: 5,
      avgStakeNotional: 20,
    } as never);

    const filtered = await filterPolymarketTradesByWalletCredibility([
      { id: "t1", proxyWallet: "0xabc" },
    ]);

    expect(filtered).toHaveLength(0);
  });

  it("excludes trade-qualified rows when wallet metrics are missing", async () => {
    vi.mocked(findWhaleByWalletCaseInsensitive).mockResolvedValue(null);

    const filtered = await filterPolymarketTradesByWalletCredibility([
      { id: "t1", proxyWallet: "0xabc" },
    ]);

    expect(filtered).toHaveLength(0);
  });

  it("includes trade-qualified rows when wallet qualification passes", async () => {
    vi.mocked(findWhaleByWalletCaseInsensitive).mockResolvedValue(
      qualifiedWhale as never
    );

    const filtered = await filterPolymarketTradesByWalletCredibility([
      { id: "t1", proxyWallet: "0xabc" },
    ]);

    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.id).toBe("t1");
  });
});
