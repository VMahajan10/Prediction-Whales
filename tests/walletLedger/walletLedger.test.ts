import { describe, expect, it } from "vitest";
import {
  classifyGammaMarketRow,
  GammaResolutionCache,
  isWinningAsset,
} from "@/lib/walletLedger/gamma";
import {
  rankHistoryIdentityCandidates,
  resolvePolymarketHistoryIdentity,
} from "@/lib/walletLedger/identity";
import {
  buildLedgerEventDedupeKey,
  deduplicateLedgerEvents,
  normalizeActivityRows,
  normalizeTradeRows,
} from "@/lib/walletLedger/normalize";
import { computePositionEconomics } from "@/lib/walletLedger/ledger";
import { analyzeMergeSplitImpact } from "@/lib/walletLedger/mergeSplitAnalysis";
import { computeWalletLedgerMetrics } from "@/lib/walletLedger/metrics";
import {
  assessWalletLedgerValidity,
  computeResolutionCoverage,
} from "@/lib/walletLedger/validity";
import type {
  ActivityApiRow,
  GammaMarketResolution,
  PolymarketHistoryIdentity,
  PositionLifecycle,
  TradeApiRow,
  WalletLedgerEvent,
} from "@/lib/walletLedger/types";

const WALLET = "0xabc0000000000000000000000000000000000001";
const ALT_WALLET = "0xdef0000000000000000000000000000000000002";
const CONDITION = "0xcond";
const ASSET_YES = "asset-yes";
const ASSET_NO = "asset-no";

function event(
  partial: Partial<WalletLedgerEvent> & Pick<WalletLedgerEvent, "type" | "timestamp">
): WalletLedgerEvent {
  const shares = partial.shares ?? 0;
  const price = partial.price ?? 0;
  const cashUsd = partial.cashUsd ?? shares * price;
  return {
    wallet: WALLET,
    conditionId: CONDITION,
    asset: ASSET_YES,
    timestamp: partial.timestamp,
    type: partial.type,
    shares,
    cashUsd,
    price,
    txHash: partial.txHash,
    source: partial.source ?? "activity",
    dedupeKey:
      partial.dedupeKey ??
      buildLedgerEventDedupeKey({
        txHash: partial.txHash,
        asset: ASSET_YES,
        conditionId: CONDITION,
        timestamp: partial.timestamp,
        type: partial.type,
        side: partial.type === "BUY" || partial.type === "SELL" ? partial.type : undefined,
        shares,
        price,
        cashUsd,
      }),
    title: partial.title,
    slug: partial.slug,
    outcome: partial.outcome,
  };
}

function resolvedMarket(winningAsset: string): GammaMarketResolution {
  return {
    conditionId: CONDITION,
    marketFound: true,
    closed: true,
    resolved: true,
    resolutionFinal: true,
    outcomes: ["Yes", "No"],
    outcomePrices: [1, 0],
    winningOutcome: winningAsset === ASSET_YES ? "Yes" : "No",
    winningAsset,
    winningIndex: winningAsset === ASSET_YES ? 0 : 1,
    resolvedAt: "2026-01-01T00:00:00Z",
    umaResolutionStatus: "resolved",
    resolutionStatus: "resolved",
    question: "Test market",
    slug: "test-market",
    clobTokenIds: [ASSET_YES, ASSET_NO],
    source: "condition_id",
    confidence: "high",
  };
}

function baseIdentity(
  partial: Partial<PolymarketHistoryIdentity> = {}
): PolymarketHistoryIdentity {
  return {
    requestedWallet: WALLET,
    historyWallet: WALLET,
    resolutionMethod: "proxy_wallet_direct",
    confidence: "high",
    candidateWallets: [],
    alternateCandidates: [],
    evidence: { notes: [] },
    positionsOnlyMismatch: false,
    activityCount: 100,
    tradeCount: 50,
    positionsCount: 10,
    ...partial,
  };
}

function positionLifecycle(
  partial: Partial<PositionLifecycle>
): PositionLifecycle {
  return {
    wallet: WALLET,
    conditionId: CONDITION,
    asset: ASSET_YES,
    title: "Test",
    outcome: "Yes",
    slug: null,
    events: [],
    grossBuyCash: 10,
    grossSellCash: 0,
    redeemCash: 0,
    netShares: 0,
    maxCumulativeCashOutlay: 10,
    firstEntryAt: 1,
    lastActivityAt: 2,
    fullyExited: true,
    accountingStatus: "ok",
    completed: true,
    completionReason: "fully_exited",
    resolution: null,
    resolutionPayoutUsd: 0,
    realizedPnl: 2,
    capitalAtRisk: 10,
    positionRoi: 0.2,
    heldThroughResolution: false,
    outcomeCorrect: null,
    excludedFromMetrics: false,
    exclusionReason: null,
    ...partial,
  };
}

describe("resolvePolymarketHistoryIdentity", () => {
  it("uses direct proxy wallet when it has history", async () => {
    const identity = await resolvePolymarketHistoryIdentity({
      wallet: WALLET,
      probe: async () => ({
        activityCount: 120,
        tradeCount: 80,
        positionsCount: 10,
      }),
    });
    expect(identity.historyWallet).toBe(WALLET);
    expect(identity.resolutionMethod).toBe("proxy_wallet_direct");
    expect(identity.confidence).toBe("high");
  });

  it("selects alternate wallet when it scores higher", () => {
    const ranked = rankHistoryIdentityCandidates([
      {
        wallet: WALLET,
        source: "requested",
        activityCount: 0,
        tradeCount: 0,
        positionsCount: 100,
        historyScore: 0,
      },
      {
        wallet: ALT_WALLET,
        source: "positions_proxy",
        activityCount: 200,
        tradeCount: 50,
        positionsCount: 5,
        historyScore: 250,
      },
    ]);
    expect(ranked.historyWallet).toBe(ALT_WALLET);
    expect(ranked.resolutionMethod).toBe("data_api_resolved");
  });

  it("flags ambiguous identity when two wallets have similar history", () => {
    const ranked = rankHistoryIdentityCandidates([
      {
        wallet: WALLET,
        source: "requested",
        activityCount: 500,
        tradeCount: 500,
        positionsCount: 10,
        historyScore: 1000,
      },
      {
        wallet: ALT_WALLET,
        source: "positions_proxy",
        activityCount: 480,
        tradeCount: 480,
        positionsCount: 10,
        historyScore: 960,
      },
    ]);
    expect(ranked.resolutionMethod).toBe("ambiguous");
    expect(ranked.historyWallet).toBeNull();
  });

  it("marks positions-only proxy as unresolved without transaction hash", async () => {
    const identity = await resolvePolymarketHistoryIdentity({
      wallet: WALLET,
      probe: async () => ({
        activityCount: 0,
        tradeCount: 0,
        positionsCount: 100,
      }),
    });
    expect(identity.historyWallet).toBeNull();
    expect(identity.positionsOnlyMismatch).toBe(true);
    expect(identity.confidence).toBe("low");
    expect(identity.evidence.notes).toContain(
      "positions_without_history_events_no_tx_hash"
    );
  });

  it("uses transaction-hash alternate when proxy has no history", () => {
    const ranked = rankHistoryIdentityCandidates(
      [
        {
          wallet: WALLET,
          source: "requested",
          activityCount: 0,
          tradeCount: 0,
          positionsCount: 100,
          historyScore: 0,
        },
        {
          wallet: ALT_WALLET,
          source: "onchain",
          activityCount: 200,
          tradeCount: 50,
          positionsCount: 5,
          historyScore: 250,
        },
      ],
      { transactionHashResolved: true }
    );
    expect(ranked.historyWallet).toBe(ALT_WALLET);
    expect(ranked.resolutionMethod).toBe("onchain_receipt_resolved");
    expect(ranked.positionsOnlyMismatch).toBe(false);
  });

  it("keeps positions-only proxy unresolved when alternate also lacks history", () => {
    const ranked = rankHistoryIdentityCandidates(
      [
        {
          wallet: WALLET,
          source: "requested",
          activityCount: 0,
          tradeCount: 0,
          positionsCount: 100,
          historyScore: 0,
        },
        {
          wallet: ALT_WALLET,
          source: "onchain",
          activityCount: 0,
          tradeCount: 0,
          positionsCount: 1,
          historyScore: 0,
        },
      ],
      { transactionHashResolved: true }
    );
    expect(ranked.historyWallet).toBeNull();
    expect(ranked.positionsOnlyMismatch).toBe(true);
  });
});

describe("Gamma resolution", () => {
  it("classifies resolved winner from conditionId row", () => {
    const resolution = classifyGammaMarketRow(
      {
        conditionId: CONDITION,
        closed: true,
        outcomes: '["Yes","No"]',
        outcomePrices: '["1","0"]',
        clobTokenIds: `["${ASSET_YES}","${ASSET_NO}"]`,
        umaResolutionStatus: "resolved",
        closedTime: "2026-01-01T00:00:00Z",
      },
      CONDITION,
      "condition_id"
    );
    expect(resolution.marketFound).toBe(true);
    expect(resolution.resolutionFinal).toBe(true);
    expect(resolution.winningAsset).toBe(ASSET_YES);
    expect(resolution.confidence).toBe("high");
  });

  it("classifies resolved loser only when market is closed", () => {
    const resolution = classifyGammaMarketRow(
      {
        conditionId: CONDITION,
        closed: true,
        outcomes: '["Yes","No"]',
        outcomePrices: '["0","1"]',
        clobTokenIds: `["${ASSET_YES}","${ASSET_NO}"]`,
        umaResolutionStatus: "resolved",
      },
      CONDITION,
      "condition_id"
    );
    expect(resolution.resolutionFinal).toBe(true);
    expect(resolution.winningAsset).toBe(ASSET_NO);
  });

  it("does not mark open markets final from price drift alone", () => {
    const resolution = classifyGammaMarketRow(
      {
        conditionId: CONDITION,
        closed: false,
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.04","0.96"]',
      },
      CONDITION,
      "condition_id"
    );
    expect(resolution.marketFound).toBe(true);
    expect(resolution.resolutionFinal).toBe(false);
  });

  it("classifies unresolved/disputed market", () => {
    const resolution = classifyGammaMarketRow(
      {
        conditionId: CONDITION,
        closed: true,
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.5","0.5"]',
        umaResolutionStatus: "disputed",
      },
      CONDITION,
      "condition_id"
    );
    expect(resolution.resolutionFinal).toBe(false);
    expect(resolution.resolutionStatus).toBe("unresolved_or_disputed");
  });

  it("resolves via slug fallback in cache", async () => {
    const cache = new GammaResolutionCache();
    cache.seed(CONDITION, {
      ...resolvedMarket(ASSET_YES),
      source: "slug",
    });
    const got = await cache.resolve(CONDITION);
    expect(got.source).toBe("slug");
    expect(got.resolutionFinal).toBe(true);
  });

  it("maps winning asset helper", () => {
    expect(isWinningAsset(resolvedMarket(ASSET_YES), ASSET_YES)).toBe(true);
    expect(isWinningAsset(resolvedMarket(ASSET_NO), ASSET_YES)).toBe(false);
  });
});

describe("event normalization and deduplication", () => {
  it("deduplicates the same fill from activity and trades", () => {
    const activity = normalizeActivityRows(
      [
        {
          type: "TRADE",
          side: "BUY",
          conditionId: CONDITION,
          asset: ASSET_YES,
          timestamp: 100,
          size: 10,
          usdcSize: 5,
          price: 0.5,
          transactionHash: "0xhash",
        } satisfies ActivityApiRow,
      ],
      WALLET
    );
    const trades = normalizeTradeRows(
      [
        {
          side: "BUY",
          conditionId: CONDITION,
          asset: ASSET_YES,
          timestamp: 100,
          size: 10,
          price: 0.5,
          transactionHash: "0xhash",
        } satisfies TradeApiRow,
      ],
      WALLET
    );

    const merged = deduplicateLedgerEvents(activity, trades);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe("activity");
  });
});

describe("position lifecycle economics", () => {
  it("single BUY → win at resolution", () => {
    const events = [
      event({ type: "BUY", timestamp: 1, shares: 100, price: 0.4, cashUsd: 40 }),
    ];
    const economics = computePositionEconomics(
      events,
      resolvedMarket(ASSET_YES),
      ASSET_YES
    );
    expect(economics.completed).toBe(true);
    expect(economics.realizedPnl).toBeCloseTo(60, 6);
    expect(economics.capitalAtRisk).toBeCloseTo(40, 6);
  });

  it("single BUY → loss at resolution", () => {
    const events = [
      event({ type: "BUY", timestamp: 1, shares: 100, price: 0.4, cashUsd: 40 }),
    ];
    const economics = computePositionEconomics(
      events,
      resolvedMarket(ASSET_NO),
      ASSET_YES
    );
    expect(economics.completed).toBe(true);
    expect(economics.realizedPnl).toBeCloseTo(-40, 6);
  });

  it("BUY + full SELL completes before resolution (no gamma required)", () => {
    const events = [
      event({ type: "BUY", timestamp: 1, shares: 100, price: 0.5, cashUsd: 50 }),
      event({ type: "SELL", timestamp: 2, shares: 100, price: 0.7, cashUsd: 70 }),
    ];
    const economics = computePositionEconomics(events, null, ASSET_YES);
    expect(economics.completed).toBe(true);
    expect(economics.realizedPnl).toBeCloseTo(20, 6);
  });

  it("held position requires gamma resolution to complete", () => {
    const events = [
      event({ type: "BUY", timestamp: 1, shares: 10, price: 0.5, cashUsd: 5 }),
    ];
    const openResolution: GammaMarketResolution = {
      ...resolvedMarket(ASSET_YES),
      resolved: false,
      resolutionFinal: false,
      resolutionStatus: "open",
      closed: false,
    };
    const economics = computePositionEconomics(events, openResolution, ASSET_YES);
    expect(economics.completed).toBe(false);
  });

  it("losing held position completes after final resolution", () => {
    const events = [
      event({ type: "BUY", timestamp: 1, shares: 80, price: 0.25, cashUsd: 20 }),
    ];
    const economics = computePositionEconomics(
      events,
      resolvedMarket(ASSET_NO),
      ASSET_YES
    );
    expect(economics.completed).toBe(true);
    expect(economics.realizedPnl).toBeCloseTo(-20, 6);
  });
});

describe("metric validity gating", () => {
  it("invalidates credible metrics on truncated history but keeps observed", () => {
    const positions = [positionLifecycle({})];
    const metrics = computeWalletLedgerMetrics({
      positions,
      identity: baseIdentity(),
      activityTruncated: true,
      tradesTruncated: true,
      rawEventCount: 100,
      deduplicatedEventCount: 90,
      gammaCoverage: {
        distinctMarkets: 1,
        marketsFoundBefore: 1,
        marketsFoundAfter: 1,
        resolvedBefore: 1,
        resolvedAfter: 1,
        coverageBeforePct: 1,
        coverageAfterPct: 1,
        marketFoundCoverageAfterPct: 1,
      },
      mergeSplit: analyzeMergeSplitImpact(positions),
      hasHistoryEvents: true,
    });
    expect(metrics.credibilityMetricsValid).toBe(false);
    expect(metrics.credibilityMetrics).toBeNull();
    expect(metrics.observedWindowMetrics.completedPositionCount).toBe(1);
    expect(metrics.historyValidity).toBe("partial-and-metrics-unsafe");
    expect(metrics.historyCompletenessReasons).toContain("activity_truncated");
  });

  it("early exit does not require gamma for resolution coverage", () => {
    const coverage = computeResolutionCoverage([
      positionLifecycle({
        completionReason: "fully_exited",
        fullyExited: true,
        heldThroughResolution: false,
      }),
    ]);
    expect(coverage.positionsRequiringResolution).toBe(0);
    expect(coverage.resolutionCoveragePct).toBe(1);
  });

  it("held-through position requires gamma in coverage report", () => {
    const coverage = computeResolutionCoverage([
      positionLifecycle({
        completionReason: "held_through_resolution",
        heldThroughResolution: true,
        fullyExited: false,
        resolution: {
          ...resolvedMarket(ASSET_YES),
          resolutionFinal: false,
          resolved: false,
        },
      }),
    ]);
    expect(coverage.positionsRequiringResolution).toBe(1);
    expect(coverage.positionsSuccessfullyResolved).toBe(0);
  });

  it("low-confidence identity invalidates credible metrics", () => {
    const validity = assessWalletLedgerValidity({
      positions: [positionLifecycle({})],
      identity: baseIdentity({ confidence: "low", resolutionMethod: "unresolved" }),
      activityTruncated: false,
      tradesTruncated: false,
      resolutionCoverage: computeResolutionCoverage([]),
      mergeSplit: analyzeMergeSplitImpact([]),
      hasHistoryEvents: false,
    });
    expect(validity.credibilityMetricsValid).toBe(false);
    expect(validity.metricValidity).toBe("unusable");
  });
});

describe("MERGE/SPLIT materiality", () => {
  it("classifies ambiguous merge/split positions", () => {
    const positions = [
      positionLifecycle({
        fullyExited: false,
        completed: false,
        accountingStatus: "requires_merge_split_resolution",
        events: [
          event({ type: "BUY", timestamp: 1, shares: 10, price: 0.5, cashUsd: 5 }),
          event({ type: "MERGE", timestamp: 2, shares: 10, cashUsd: 0 }),
        ],
      }),
    ];
    const impact = analyzeMergeSplitImpact(positions);
    expect(impact.positionsWithMergeSplit).toBe(1);
    expect(impact.ambiguousMergeSplit).toBe(1);
    expect(impact.recommendation).toBe("exclude_policy_sufficient");
  });

  it("recommends phase 2c when ambiguous merge/split affects completed positions", () => {
    const positions = Array.from({ length: 10 }, (_, i) =>
      positionLifecycle({
        conditionId: `${CONDITION}-${i}`,
        completed: true,
      })
    );
    positions.push(
      positionLifecycle({
        fullyExited: false,
        completed: true,
        accountingStatus: "requires_merge_split_resolution",
        events: [
          event({ type: "BUY", timestamp: 1, shares: 10, price: 0.5, cashUsd: 5 }),
          event({ type: "MERGE", timestamp: 2, shares: 10, cashUsd: 0 }),
        ],
      })
    );
    const impact = analyzeMergeSplitImpact(positions);
    expect(impact.pctAmbiguousOfCompleted).toBeGreaterThan(0.05);
    expect(impact.recommendation).toBe("phase_2c_accounting_required");
  });
});

describe("capitalAtRisk and positionROI", () => {
  it("uses max cumulative cash outlay for capitalAtRisk", () => {
    const events = [
      event({ type: "BUY", timestamp: 1, shares: 100, price: 0.5, cashUsd: 50 }),
      event({ type: "SELL", timestamp: 2, shares: 60, price: 0.6, cashUsd: 36 }),
      event({ type: "BUY", timestamp: 3, shares: 40, price: 0.7, cashUsd: 28 }),
    ];
    const economics = computePositionEconomics(events, null, ASSET_YES);
    expect(economics.capitalAtRisk).toBeCloseTo(50, 6);
  });
});
