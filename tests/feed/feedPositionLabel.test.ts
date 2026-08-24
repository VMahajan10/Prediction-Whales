import { describe, expect, it } from "vitest";
import { resolveWhaleFeedPositionLabel } from "@/lib/feed/feedPositionLabel";
import { filterTranslatablePolymarketFeedTrades } from "@/lib/feedQualificationServer";
import type { WhaleTrade } from "@/lib/whaleTrades";

const RAW_DIRECTION_PATTERNS = [
  /^BACKING YES$/i,
  /^BACKING NO$/i,
  /^BOUGHT YES$/i,
  /^BOUGHT NO$/i,
];

function polymarketTrade(overrides: Partial<WhaleTrade> = {}): WhaleTrade {
  return {
    id: "pm-trade-1",
    source: "polymarket",
    title: "Candidate A vs Candidate B",
    outcome: "Yes",
    side: "BUY",
    price: 0.5,
    size: 1000,
    usdNotional: 500,
    timestamp: 1_800_000_000,
    detectedAt: 1_800_000_000_000,
    isLive: false,
    proxyWallet: "0xabc123def4567890abcdef1234567890abcdef12",
    netEvPercent: 4.2,
    averageEv: 4.2,
    ...overrides,
  };
}

describe("resolveWhaleFeedPositionLabel", () => {
  it("uses marketTranslation backingLabel for Polymarket", () => {
    expect(
      resolveWhaleFeedPositionLabel(
        polymarketTrade({
          marketTranslation: {
            backingLabel: "Backing Candidate A",
            sideName: "Candidate A",
          },
        })
      )
    ).toBe("Backing Candidate A");
  });

  it("prefers exitByLabel over backingLabel when present", () => {
    expect(
      resolveWhaleFeedPositionLabel(
        polymarketTrade({
          marketTranslation: {
            backingLabel: "Backing Candidate A",
            sideName: "Candidate A",
            exitByLabel: "Exit by Jul 31, 2026",
          },
        })
      )
    ).toBe("Exit by Jul 31, 2026");
  });

  it("returns null for Polymarket without marketTranslation", () => {
    expect(resolveWhaleFeedPositionLabel(polymarketTrade())).toBeNull();
  });

  it("never renders raw YES/NO directional labels", () => {
    const cases = [
      polymarketTrade({ outcome: "Yes" }),
      polymarketTrade({ outcome: "No" }),
      polymarketTrade({
        source: "kalshi",
        outcome: "Yes",
        ticker: "KX-TEST",
      }),
      polymarketTrade({
        marketTranslation: {
          backingLabel: "bought no",
          sideName: "Candidate A win the election",
        },
      }),
      polymarketTrade({
        marketTranslation: {
          backingLabel: "Backing YES",
          sideName: "YES",
        },
      }),
    ];

    for (const trade of cases) {
      const label = resolveWhaleFeedPositionLabel(trade);
      if (label == null) continue;
      for (const pattern of RAW_DIRECTION_PATTERNS) {
        expect(label).not.toMatch(pattern);
      }
      expect(label).not.toMatch(/^YES$/i);
      expect(label).not.toMatch(/^NO$/i);
    }
  });

  it("uses Kalshi selectionLabel when present", () => {
    expect(
      resolveWhaleFeedPositionLabel(
        polymarketTrade({
          source: "kalshi",
          outcome: "Yes",
          ticker: "KX-TEST",
          selectionLabel: "Over 45.5 points",
        })
      )
    ).toBe("Over 45.5 points");
  });

  it("returns null for Kalshi without selectionLabel or marketTranslation", () => {
    expect(
      resolveWhaleFeedPositionLabel(
        polymarketTrade({
          source: "kalshi",
          outcome: "Yes",
          ticker: "KX-TEST",
        })
      )
    ).toBeNull();
  });
});

describe("filterTranslatablePolymarketFeedTrades", () => {
  it("keeps translatable Polymarket trades", () => {
    const kept = filterTranslatablePolymarketFeedTrades([
      {
        title: "Candidate A vs Candidate B",
        outcome: "Yes",
        side: "BUY",
        proxyWallet: "0xabc",
      },
    ]);

    expect(kept).toHaveLength(1);
    expect(kept[0]!.marketTranslation.backingLabel).toBe("Backing Candidate A");
  });

  it("drops untranslatable Polymarket trades", () => {
    const kept = filterTranslatablePolymarketFeedTrades([
      {
        title: "Will Candidate A win the election?",
        outcome: "No",
        side: "BUY",
        proxyWallet: "0xabc",
      },
    ]);

    expect(kept).toHaveLength(0);
  });
});
