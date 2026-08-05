import { eq } from "drizzle-orm";
import type { getDb } from "@/lib/crossmarket/store/db";
import {
  marketMappings,
  trueProbabilities,
  traderEvAnalytics,
  type MarketMapping,
} from "@/lib/crossmarket/store/schema";
import {
  calculateMidpoint,
  calculatePortfolioEV,
  calculateTrueEV,
  type OrderBook,
  type PortfolioPosition,
} from "@/lib/finance/evEngine";
import type { MatchedPair } from "@/lib/evPipeline/types";
import {
  EvPipelineRedisWriteBatch,
  cachePTrue,
  cacheTraderEv,
  evRedisKeys,
} from "@/lib/evPipeline/redisCache";

export const TEST_FALLBACK_MATCH_METHOD = "TEST_FALLBACK_PAIR";
export const TEST_WHALE_WALLET = "0xtestwhaleaddress";
export const TEST_MOCK_P_MARKET = 0.52;
export const TEST_MOCK_P_TRUE = 0.65;
export const TEST_MOCK_EDGE = TEST_MOCK_P_TRUE - TEST_MOCK_P_MARKET;

/** Mock CLOB around mid = 0.52 (bid 0.51 × 100 | ask 0.53 × 100). */
export const TEST_MOCK_ORDER_BOOK: OrderBook = {
  bids: [[0.51, 100]],
  asks: [[0.53, 100]],
};

/** Mock open whale positions on the test asset (allocation weights sum to 1). */
export const TEST_MOCK_OPEN_POSITIONS: Array<{
  entryPrice: number;
  allocation: number;
  label: string;
}> = [
  { entryPrice: 0.52, allocation: 0.4, label: "core_yes" },
  { entryPrice: 0.5, allocation: 0.35, label: "dip_add" },
  { entryPrice: 0.54, allocation: 0.25, label: "momentum_yes" },
];

type Db = ReturnType<typeof getDb>;

export interface TestFallbackTarget {
  polymarketTokenId: string;
  polymarketConditionId: string;
  kalshiTicker: string;
  mappingId?: number;
}

export function pairsToTestFallbackTargets(
  pairs: MatchedPair[]
): TestFallbackTarget[] {
  return pairs
    .filter((p) => p.matchMethod === TEST_FALLBACK_MATCH_METHOD)
    .map((p) => ({
      polymarketTokenId: p.polymarketTokenId.toLowerCase(),
      polymarketConditionId: p.polymarketConditionId,
      kalshiTicker: p.kalshiTicker.toUpperCase(),
    }));
}

export async function loadTestFallbackMappings(
  db: Db
): Promise<MarketMapping[]> {
  return db
    .select()
    .from(marketMappings)
    .where(eq(marketMappings.matchMethod, TEST_FALLBACK_MATCH_METHOD));
}

async function resolveTestFallbackTargets(
  db: Db,
  pairs: MatchedPair[]
): Promise<TestFallbackTarget[]> {
  const fromPairs = pairsToTestFallbackTargets(pairs);
  if (fromPairs.length > 0) {
    try {
      const persisted = await loadTestFallbackMappings(db);
      const byKey = new Map(
        persisted.map((m) => [
          `${m.polymarketTokenId.toLowerCase()}:${m.kalshiTicker.toUpperCase()}`,
          m.id,
        ])
      );
      return fromPairs.map((t) => ({
        ...t,
        mappingId: byKey.get(`${t.polymarketTokenId}:${t.kalshiTicker}`),
      }));
    } catch (err) {
      console.warn(
        "[ev-pipeline] loadTestFallbackMappings failed — using in-memory pairs:",
        err instanceof Error ? err.message : err
      );
      return fromPairs;
    }
  }

  try {
    const persisted = await loadTestFallbackMappings(db);
    return persisted.map((m) => ({
      polymarketTokenId: m.polymarketTokenId.toLowerCase(),
      polymarketConditionId: m.polymarketConditionId ?? "",
      kalshiTicker: m.kalshiTicker.toUpperCase(),
      mappingId: m.id,
    }));
  } catch {
    return [];
  }
}

function fmtProb(n: number): string {
  return n.toFixed(6);
}

/**
 * Stage 3 test bypass — inject mock CLOB mid (0.52) and p_true (0.65).
 */
export async function processTestFallbackPTrue(
  db: Db,
  pairs: MatchedPair[] = []
): Promise<number> {
  const targets = await resolveTestFallbackTargets(db, pairs);
  if (targets.length === 0) return 0;

  const midResult = calculateMidpoint(TEST_MOCK_ORDER_BOOK);
  const pMarket = midResult?.midpoint ?? TEST_MOCK_P_MARKET;
  const evBreakdown = calculateTrueEV(
    TEST_MOCK_P_TRUE,
    pMarket,
    "polymarket"
  );

  let processed = 0;
  const redisBatch = new EvPipelineRedisWriteBatch();

  for (const target of targets) {
    const tokenId = target.polymarketTokenId;

    redisBatch.queueOrderBookMid(evRedisKeys.orderBookPm(tokenId), {
      bid: 0.51,
      ask: 0.53,
      mid: pMarket,
      ts: Date.now(),
    });

    await db
      .insert(trueProbabilities)
      .values({
        mappingId: target.mappingId ?? null,
        polymarketTokenId: tokenId,
        kalshiTicker: target.kalshiTicker,
        pTrue: fmtProb(TEST_MOCK_P_TRUE),
        sourceScore: "1.0",
        variance: "0.01",
        sourceType: "ensemble",
        modelVersion: "test_fallback_v1",
        contributors: [
          {
            source: "mock_clob_midpoint",
            weight: 0.35,
            p: pMarket,
            variance: 0.001,
          },
          {
            source: "mock_llm_forecast",
            weight: 0.65,
            p: TEST_MOCK_P_TRUE,
            variance: 0.01,
          },
        ],
      })
      .onConflictDoUpdate({
        target: trueProbabilities.polymarketTokenId,
        set: {
          mappingId: target.mappingId ?? null,
          kalshiTicker: target.kalshiTicker,
          pTrue: fmtProb(TEST_MOCK_P_TRUE),
          sourceScore: "1.0",
          variance: "0.01",
          sourceType: "ensemble",
          modelVersion: "test_fallback_v1",
          contributors: [
            {
              source: "mock_clob_midpoint",
              weight: 0.35,
              p: pMarket,
              variance: 0.001,
            },
            {
              source: "mock_llm_forecast",
              weight: 0.65,
              p: TEST_MOCK_P_TRUE,
              variance: 0.01,
            },
          ],
          calculatedAt: new Date(),
        },
      });

    await cachePTrue(tokenId, {
      pTrue: TEST_MOCK_P_TRUE,
      variance: 0.01,
      sourceScore: 1,
      sourceType: "ensemble",
      kalshiTicker: target.kalshiTicker,
      calculatedAt: new Date().toISOString(),
    });

    console.info(
      `[ev-pipeline] computePTrue TEST_FALLBACK_PAIR ${tokenId}: p_market=${pMarket.toFixed(2)} p_true=${TEST_MOCK_P_TRUE} gross_edge=${(evBreakdown.grossEv * 100).toFixed(1)}% net_edge=${(evBreakdown.netEv * 100).toFixed(1)}%`
    );

    processed += 1;
  }

  try {
    await redisBatch.flush();
  } catch (flushErr) {
    console.warn(
      "[ev-pipeline] test fallback Redis flush failed:",
      flushErr instanceof Error ? flushErr.message : flushErr
    );
  }

  return processed;
}

/**
 * Stage 4 test bypass — mock whale wallet positions → portfolio EV aggregation.
 */
export async function processTestFallbackTraderEv(
  db: Db,
  pairs: MatchedPair[] = []
): Promise<number> {
  const targets = await resolveTestFallbackTargets(db, pairs);
  if (targets.length === 0) return 0;

  const portfolioPositions: PortfolioPosition[] = TEST_MOCK_OPEN_POSITIONS.map(
    (pos) => {
      const ev = calculateTrueEV(
        TEST_MOCK_P_TRUE,
        pos.entryPrice,
        "polymarket"
      ).netEv;
      return { ev, allocation: pos.allocation };
    }
  );

  const portfolio = calculatePortfolioEV(portfolioPositions);
  const positionEvs = portfolioPositions.map((p) => p.ev);
  const averageEv =
    positionEvs.length > 0
      ? positionEvs.reduce((s, v) => s + v, 0) / positionEvs.length
      : 0;
  const positiveEvCount = positionEvs.filter((ev) => ev > 0).length;

  const wallet = TEST_WHALE_WALLET.toLowerCase();
  const tokenIds = targets.map((t) => t.polymarketTokenId);

  await db
    .insert(traderEvAnalytics)
    .values({
      wallet,
      platform: "polymarket",
      period: "live",
      averageEv: fmtProb(averageEv),
      totalPortfolioEv: fmtProb(portfolio.totalEv),
      tradeCount: TEST_MOCK_OPEN_POSITIONS.length,
      closedTradeCount: 0,
      breakdown: {
        meanTradeEv: averageEv,
        weightedEvUsd: portfolio.totalEv,
        positiveEvCount,
        negativeEvCount: positionEvs.length - positiveEvCount,
      },
      calculatedAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        traderEvAnalytics.wallet,
        traderEvAnalytics.platform,
        traderEvAnalytics.period,
      ],
      set: {
        averageEv: fmtProb(averageEv),
        totalPortfolioEv: fmtProb(portfolio.totalEv),
        tradeCount: TEST_MOCK_OPEN_POSITIONS.length,
        closedTradeCount: 0,
        breakdown: {
          meanTradeEv: averageEv,
          weightedEvUsd: portfolio.totalEv,
          positiveEvCount,
          negativeEvCount: positionEvs.length - positiveEvCount,
        },
        calculatedAt: new Date(),
        updatedAt: new Date(),
      },
    });

  await cacheTraderEv(wallet, "polymarket", {
    averageEv,
    totalPortfolioEv: portfolio.totalEv,
    tradeCount: TEST_MOCK_OPEN_POSITIONS.length,
    closedTradeCount: 0,
    updatedAt: new Date().toISOString(),
  });

  console.info(
    `[ev-pipeline] computeTraderEv TEST_FALLBACK_PAIR wallet=${wallet} tokens=${tokenIds.join(",")} positions=${portfolio.positionCount} portfolio_ev=${portfolio.totalEv.toFixed(4)} avg_ev=${averageEv.toFixed(4)} (p_true=${TEST_MOCK_P_TRUE} vs p_market=${TEST_MOCK_P_MARKET})`
  );

  return 1;
}
