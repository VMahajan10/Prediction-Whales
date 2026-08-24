import { describe, expect, it } from "vitest";
import {
  hasSafeKalshiNamedSelection,
  resolveKalshiFeedDirectionLabel,
  resolveKalshiNamedSelection,
} from "@/lib/feed/kalshiFeedDirection";
import {
  isKalshiTradeEligibleForFeed,
  isKalshiTradeVisibleInUserFeed,
  kalshiFeedTradeToWhale,
} from "@/lib/feed/kalshiFeedTrades";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { pipelineEvLookupKeyKalshi } from "@/lib/evPipeline/types";

const RAW_DIRECTION_PATTERNS = [
  /^BACKING YES$/i,
  /^BACKING NO$/i,
  /^BOUGHT YES$/i,
  /^BOUGHT NO$/i,
];

function evIndex(ticker: string, evPercent: number) {
  const key = pipelineEvLookupKeyKalshi(ticker);
  return new Map<string, PipelineTradeEv>([
    [
      key,
      {
        key,
        status: "ok",
        kalshiTicker: ticker,
        netEvPercent: evPercent,
      } as PipelineTradeEv,
    ],
  ]);
}

const baseTrade = {
  id: "kalshi-1",
  title: "Lakers vs Celtics",
  outcome: "Yes",
  price: 0.42,
  usdNotional: 600,
  timestamp: 1_700_000_000,
  ticker: "NBA-LAL-BOS",
  selectionLabel: "Celtics",
  side: "BUY" as const,
};

describe("resolveKalshiNamedSelection", () => {
  it("accepts a named contract label", () => {
    expect(
      resolveKalshiNamedSelection({
        source: "kalshi",
        selectionLabel: "Celtics",
      })
    ).toBe("Celtics");
  });

  it("rejects raw YES/NO selection labels", () => {
    expect(
      resolveKalshiNamedSelection({ source: "kalshi", selectionLabel: "Yes" })
    ).toBeNull();
    expect(
      resolveKalshiNamedSelection({ source: "kalshi", selectionLabel: "NO" })
    ).toBeNull();
  });
});

describe("resolveKalshiFeedDirectionLabel", () => {
  it("renders Backing for BUY YES-side with named selection", () => {
    expect(
      resolveKalshiFeedDirectionLabel({
        source: "kalshi",
        selectionLabel: "Celtics",
        side: "BUY",
      })
    ).toBe("Backing Celtics");
  });

  it("renders Backing for BUY NO-side with named selection (not Exiting)", () => {
    expect(
      resolveKalshiFeedDirectionLabel({
        source: "kalshi",
        selectionLabel: "Under 45.5 points",
        side: "BUY",
      })
    ).toBe("Backing Under 45.5 points");
  });

  it("renders Exiting only for SELL", () => {
    expect(
      resolveKalshiFeedDirectionLabel({
        source: "kalshi",
        selectionLabel: "Celtics",
        side: "SELL",
      })
    ).toBe("Exiting Celtics");
  });

  it("never renders raw YES/NO directional strings", () => {
    const labels = [
      resolveKalshiFeedDirectionLabel({
        source: "kalshi",
        selectionLabel: "Yes",
        side: "BUY",
      }),
      resolveKalshiFeedDirectionLabel({
        source: "kalshi",
        selectionLabel: undefined,
        side: "BUY",
      }),
    ];

    for (const label of labels) {
      expect(label).toBeNull();
      if (label) {
        for (const pattern of RAW_DIRECTION_PATTERNS) {
          expect(label).not.toMatch(pattern);
        }
      }
    }
  });
});

describe("isKalshiTradeVisibleInUserFeed", () => {
  it("admits Kalshi with stake, EV, and named selection", () => {
    const whale = kalshiFeedTradeToWhale(baseTrade, { netEvPercent: 4.2 });
    expect(
      isKalshiTradeVisibleInUserFeed(whale, evIndex(baseTrade.ticker, 4.5), {
        logRejection: false,
      })
    ).toBe(true);
  });

  it("excludes Kalshi without a safe named selection", () => {
    const whale = kalshiFeedTradeToWhale(
      { ...baseTrade, selectionLabel: undefined },
      { netEvPercent: 4.2 }
    );
    expect(
      isKalshiTradeEligibleForFeed(whale, evIndex(baseTrade.ticker, 4.5), {
        logRejection: false,
      })
    ).toBe(true);
    expect(
      isKalshiTradeVisibleInUserFeed(whale, evIndex(baseTrade.ticker, 4.5), {
        logRejection: false,
      })
    ).toBe(false);
  });

  it("does not require named selection for internal EV gate alone", () => {
    const whale = kalshiFeedTradeToWhale(
      { ...baseTrade, selectionLabel: undefined },
      { netEvPercent: 4.2 }
    );
    expect(hasSafeKalshiNamedSelection(whale)).toBe(false);
    expect(
      isKalshiTradeEligibleForFeed(whale, evIndex(baseTrade.ticker, 4.5), {
        logRejection: false,
      })
    ).toBe(true);
  });
});
