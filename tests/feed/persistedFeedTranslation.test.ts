import { describe, expect, it } from "vitest";
import {
  classifyPersistedPolymarketTranslation,
  revalidatePersistedPolymarketFeedPayload,
  resolveStrictPolymarketTranslationFromPayload,
} from "@/lib/feed/persistedFeedTranslation";
import { resolveWhaleFeedPositionLabel } from "@/lib/feed/feedPositionLabel";
import { recentTradeToWhale } from "@/lib/feed/whaleFeedHydration";
import { filterTranslatablePolymarketFeedTrades } from "@/lib/feedQualificationServer";
import {
  isPolymarketTradeEligibleForFeed,
  isVisibleInClientFeed,
} from "@/lib/whaleFeedClientQualification";
import { translateWhaleTradeMarket } from "@/lib/marketTranslator";
import type { WhaleTrade } from "@/lib/whaleTrades";

const RAW_DIRECTION_PATTERNS = [
  /^BACKING YES$/i,
  /^BACKING NO$/i,
  /^BOUGHT YES$/i,
  /^BOUGHT NO$/i,
];

function assertNeverRawDirectional(label: string | null): void {
  if (label == null) return;
  for (const pattern of RAW_DIRECTION_PATTERNS) {
    expect(label).not.toMatch(pattern);
  }
  expect(label).not.toMatch(/^YES$/i);
  expect(label).not.toMatch(/^NO$/i);
}

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

describe("persisted Polymarket feed translation", () => {
  it("rejects stale fallback translations when the market is untranslatable", () => {
    const payload = {
      id: "stale-1",
      title: "Will Candidate A win the election?",
      outcome: "No",
      side: "BUY",
      price: 0.4,
      size: 1000,
      timestamp: 1_800_000_000,
      marketTranslation: {
        backingLabel: "bought no",
        sideName: "Candidate A win the election",
      },
    };

    expect(resolveStrictPolymarketTranslationFromPayload(payload)).toBeNull();
    expect(revalidatePersistedPolymarketFeedPayload(payload)).toBeNull();
    expect(classifyPersistedPolymarketTranslation(payload).action).toBe(
      "rejected"
    );
  });

  it("replaces obsolete persisted translations with the current canonical copy", () => {
    const payload = {
      id: "stale-2",
      title: "Candidate A vs Candidate B",
      outcome: "Yes",
      side: "BUY",
      price: 0.55,
      size: 1000,
      timestamp: 1_800_000_000,
      marketTranslation: {
        backingLabel: "bought yes",
        sideName: "YES",
      },
    };

    const validated = revalidatePersistedPolymarketFeedPayload(payload);
    expect(validated?.marketTranslation.backingLabel).toBe(
      "Backing Candidate A"
    );
    expect(classifyPersistedPolymarketTranslation(payload).action).toBe(
      "retranslated"
    );
  });

  it("keeps rows whose stored translation already matches the strict translator", () => {
    const payload = {
      id: "valid-1",
      title: "Candidate A vs Candidate B",
      outcome: "No",
      side: "BUY",
      price: 0.45,
      size: 1000,
      timestamp: 1_800_000_000,
      marketTranslation: {
        backingLabel: "Backing Candidate B",
        sideName: "Candidate B",
      },
    };

    expect(classifyPersistedPolymarketTranslation(payload).action).toBe(
      "unchanged"
    );
  });
});

describe("untranslatable Polymarket trades are dropped end-to-end", () => {
  const untranslatable = {
    title: "Will Candidate A win the election?",
    outcome: "No",
    side: "BUY" as const,
    proxyWallet: "0xabc",
  };

  it("fails strict translation", () => {
    expect(translateWhaleTradeMarket(untranslatable)).toBeNull();
  });

  it("is excluded by filterTranslatablePolymarketFeedTrades", () => {
    expect(filterTranslatablePolymarketFeedTrades([untranslatable])).toEqual(
      []
    );
  });

  it("does not hydrate from recent trades", () => {
    expect(
      recentTradeToWhale({
        id: "recent-1",
        source: "polymarket",
        title: untranslatable.title,
        outcome: untranslatable.outcome,
        side: untranslatable.side,
        price: 0.4,
        size: 1000,
        usdNotional: 400,
        timestamp: 1_800_000_000,
        proxyWallet: untranslatable.proxyWallet,
        netEvPercent: 4.2,
      })
    ).toBeNull();
  });

  it("cannot pass the client feed visibility gate even with stale marketTranslation", () => {
    const trade = polymarketTrade({
      title: untranslatable.title,
      outcome: untranslatable.outcome,
      marketTranslation: {
        backingLabel: "bought no",
        sideName: "Candidate A win the election",
      },
    });

    expect(
      isPolymarketTradeEligibleForFeed(trade, new Map())
    ).toBe(false);
    expect(
      isVisibleInClientFeed(trade, new Map(), new Map())
    ).toBe(false);
  });
});

describe("feed card direction copy never renders raw YES/NO", () => {
  const cases: Array<{ label: string; trade: WhaleTrade }> = [
    {
      label: "Polymarket Yes outcome without translation",
      trade: polymarketTrade({ outcome: "Yes" }),
    },
    {
      label: "Polymarket No outcome without translation",
      trade: polymarketTrade({ outcome: "No" }),
    },
    {
      label: "Polymarket stale bought no fallback",
      trade: polymarketTrade({
        title: "Will Candidate A win the election?",
        outcome: "No",
        marketTranslation: {
          backingLabel: "bought no",
          sideName: "Candidate A win the election",
        },
      }),
    },
    {
      label: "Kalshi without selectionLabel",
      trade: polymarketTrade({
        source: "kalshi",
        outcome: "Yes",
        side: "BUY",
        ticker: "KX-TEST",
      }),
    },
    {
      label: "Kalshi NO-side BUY with raw Yes/No selectionLabel",
      trade: polymarketTrade({
        source: "kalshi",
        outcome: "No",
        side: "BUY",
        ticker: "KX-TEST",
        selectionLabel: "No",
      }),
    },
  ];

  for (const { label, trade } of cases) {
    it(label, () => {
      assertNeverRawDirectional(resolveWhaleFeedPositionLabel(trade));
    });
  }
});

describe("Kalshi without safe selection is excluded from user-facing copy", () => {
  it("does not render BACKING YES for missing selectionLabel", () => {
    const trade = polymarketTrade({
      source: "kalshi",
      outcome: "Yes",
      side: "BUY",
      ticker: "KX-TEST",
    });

    expect(resolveWhaleFeedPositionLabel(trade)).toBeNull();
    assertNeverRawDirectional(resolveWhaleFeedPositionLabel(trade));
  });

  it("does not mislabel a NO-side BUY as EXITING POSITION", () => {
    const trade = polymarketTrade({
      source: "kalshi",
      outcome: "No",
      side: "BUY",
      ticker: "KX-TEST",
      selectionLabel: "Under 45.5 points",
    });

    const label = resolveWhaleFeedPositionLabel(trade);
    expect(label).toBe("Backing Under 45.5 points");
    expect(label).not.toMatch(/exiting/i);
  });
});

describe("whale details backing label uses strict translation only", () => {
  it("returns empty backing copy when strict translation fails", () => {
    const trade = polymarketTrade({
      title: "Will Candidate A win the election?",
      outcome: "No",
      marketTranslation: {
        backingLabel: "bought no",
        sideName: "Candidate A win the election",
      },
    });

    const strict = translateWhaleTradeMarket(trade);
    expect(strict).toBeNull();
    expect(strict?.backingLabel ?? "").toBe("");
  });

  it("uses canonical strict translation when stale copy is obsolete", () => {
    const trade = polymarketTrade({
      marketTranslation: {
        backingLabel: "bought yes",
        sideName: "YES",
      },
    });

    expect(translateWhaleTradeMarket(trade)?.backingLabel).toBe(
      "Backing Candidate A"
    );
  });
});
