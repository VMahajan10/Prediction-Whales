import { describe, expect, it } from "vitest";
import {
  resolveKalshiMarketTitleParts,
  resolveKalshiSelectionLabelForTrade,
} from "@/lib/kalshiTitleResolver";
import {
  hasSafeKalshiNamedSelection,
  resolveKalshiNamedSelection,
} from "@/lib/feed/kalshiFeedDirection";
import {
  isKalshiTradeVisibleInUserFeed,
  kalshiFeedTradeToWhale,
} from "@/lib/feed/kalshiFeedTrades";

// Re-exported helper for tests — mirrors fetchKalshiMarketResolved output.
function buildKalshiResolvedMarket(
  market: Parameters<typeof resolveKalshiMarketTitleParts>[0],
  event?: Parameters<typeof resolveKalshiMarketTitleParts>[1]
) {
  const yesParts = resolveKalshiMarketTitleParts(market, event, {
    takerOutcomeSide: "yes",
  });
  const noParts = resolveKalshiMarketTitleParts(market, event, {
    takerOutcomeSide: "no",
  });
  return {
    eventTitle: yesParts.eventTitle,
    selectionLabel: yesParts.contractLabel,
    yesSelectionLabel: yesParts.contractLabel,
    noSelectionLabel: noParts.contractLabel,
  };
}

const WTA_MARKET = {
  ticker: "KXWTAMATCH-26AUG24LIUWAT-WAT",
  title: "WAT",
  yes_sub_title: "WAT",
  no_sub_title: "LIU",
};

const WTA_EVENT = { title: "LIU vs WAT" };

describe("Kalshi selectionLabel enrichment", () => {
  it("collapses contract label without event metadata (skipEventFetch path)", () => {
    const parts = resolveKalshiMarketTitleParts(WTA_MARKET, null);
    expect(parts.eventTitle).toBe("WAT");
    expect(parts.contractLabel).toBeNull();
  });

  it("splits event title and named contract when event metadata is present", () => {
    const resolved = buildKalshiResolvedMarket(WTA_MARKET, WTA_EVENT);
    expect(resolved.eventTitle).toBe("LIU vs WAT");
    expect(resolved.yesSelectionLabel).toBe("WAT");
    expect(resolved.noSelectionLabel).toBe("LIU");
  });

  it("picks YES-side selection for YES taker trades", () => {
    const resolved = buildKalshiResolvedMarket(WTA_MARKET, WTA_EVENT);
    expect(resolveKalshiSelectionLabelForTrade(resolved, "yes")).toBe("WAT");
  });

  it("picks NO-side selection for NO taker trades", () => {
    const resolved = buildKalshiResolvedMarket(WTA_MARKET, WTA_EVENT);
    expect(resolveKalshiSelectionLabelForTrade(resolved, "no")).toBe("LIU");
  });

  it("never uses raw YES/NO as selectionLabel", () => {
    expect(
      resolveKalshiNamedSelection({
        source: "kalshi",
        selectionLabel: "Yes",
      })
    ).toBeNull();
    expect(
      resolveKalshiNamedSelection({
        source: "kalshi",
        selectionLabel: "NO",
      })
    ).toBeNull();
  });

  it("allows public feed visibility when named selection is populated", () => {
    const whale = kalshiFeedTradeToWhale(
      {
        id: "k1",
        title: "LIU vs WAT",
        outcome: "Yes",
        side: "BUY",
        price: 0.66,
        usdNotional: 528,
        timestamp: 1_700_000_000,
        ticker: WTA_MARKET.ticker,
        selectionLabel: "WAT",
        netEvPercent: 4,
      },
      { isLive: false, netEvPercent: 4 }
    );

    expect(hasSafeKalshiNamedSelection(whale)).toBe(true);
    expect(isKalshiTradeVisibleInUserFeed(whale, new Map())).toBe(true);
  });

  it("excludes public feed when named selection is missing", () => {
    const whale = kalshiFeedTradeToWhale(
      {
        id: "k2",
        title: "WAT",
        outcome: "Yes",
        side: "BUY",
        price: 0.66,
        usdNotional: 528,
        timestamp: 1_700_000_000,
        ticker: WTA_MARKET.ticker,
        netEvPercent: 4,
      },
      { isLive: false, netEvPercent: 4 }
    );

    expect(hasSafeKalshiNamedSelection(whale)).toBe(false);
    expect(isKalshiTradeVisibleInUserFeed(whale, new Map())).toBe(false);
  });
});
