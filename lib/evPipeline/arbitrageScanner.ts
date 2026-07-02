import { ne } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { marketMappings } from "@/lib/crossmarket/store/schema";
import { pipelineMappingPairKey } from "@/lib/evPipeline/crossAssetLookup";
import {
  getMappingByKalshi,
  getMappingByPm,
  getOrderBookMid,
  evRedisKeys,
  prefetchMappingRedisBatch,
  type CachedOrderBookMid,
} from "@/lib/evPipeline/redisCache";

/** Max combined leg cost for a locked $1 payout (2% minimum edge). */
export const MIN_ARBITRAGE_COST_THRESHOLD = 0.98;

const TEST_FALLBACK_MATCH_METHOD = "TEST_FALLBACK_PAIR";

export type ArbitrageVenue = "polymarket" | "kalshi";
export type ArbitrageSide = "YES" | "NO";

export type ArbitrageStrategy =
  | "pm_yes_kalshi_no"
  | "kalshi_yes_pm_no";

export interface ArbitrageLeg {
  venue: ArbitrageVenue;
  side: ArbitrageSide;
  /** Polymarket CLOB token id or Kalshi ticker. */
  contractId: string;
  askPrice: number;
}

export interface ArbitrageOpportunity {
  mappingPairKey: string;
  polymarketTokenId: string;
  kalshiTicker: string;
  strategy: ArbitrageStrategy;
  legs: ArbitrageLeg[];
  combinedCost: number;
  guaranteedPayout: number;
  netProfitPerUnit: number;
  netRoiPercent: number;
  pmYesAsk: number;
  pmNoAsk: number;
  kalshiYesAsk: number;
  kalshiNoAsk: number;
  orderBookTimestampMs: number | null;
}

export interface PairedMappingRow {
  polymarketTokenId: string;
  kalshiTicker: string;
  orientation: "same" | "inverted";
  matchMethod: string;
}

export interface ArbitrageScanOptions {
  /** Override default 0.98 combined-cost ceiling. */
  maxCombinedCost?: number;
  mappings?: PairedMappingRow[];
  limit?: number;
}

export interface YesNoAsks {
  yesAsk: number;
  noAsk: number;
}

/**
 * Derive executable YES/NO ask prices from a YES-sided order-book snapshot.
 * NO ask is the complement of YES bid: cost to buy NO ≈ 1 − best YES bid.
 */
export function deriveYesNoAsksFromOrderBook(
  ob: CachedOrderBookMid | null | undefined
): YesNoAsks | null {
  if (!ob) return null;

  const yesAsk =
    ob.ask != null && Number.isFinite(ob.ask) && ob.ask > 0 ? ob.ask : null;
  const yesBid =
    ob.bid != null && Number.isFinite(ob.bid) && ob.bid > 0 ? ob.bid : null;

  if (yesAsk == null || yesBid == null || yesBid >= yesAsk) return null;

  const noAsk = 1 - yesBid;
  if (!Number.isFinite(noAsk) || noAsk <= 0 || noAsk >= 1) return null;

  return { yesAsk, noAsk };
}

export function computeNetRoiPercent(combinedCost: number): number {
  if (!Number.isFinite(combinedCost) || combinedCost <= 0) return 0;
  const profit = 1 - combinedCost;
  return Math.round((profit / combinedCost) * 1000) / 10;
}

function buildOpportunity(params: {
  mappingPairKey: string;
  polymarketTokenId: string;
  kalshiTicker: string;
  strategy: ArbitrageStrategy;
  combinedCost: number;
  pm: YesNoAsks;
  kalshi: YesNoAsks;
  orderBookTimestampMs: number | null;
}): ArbitrageOpportunity {
  const netProfitPerUnit = 1 - params.combinedCost;
  const legs: ArbitrageLeg[] =
    params.strategy === "pm_yes_kalshi_no"
      ? [
          {
            venue: "polymarket",
            side: "YES",
            contractId: params.polymarketTokenId,
            askPrice: params.pm.yesAsk,
          },
          {
            venue: "kalshi",
            side: "NO",
            contractId: params.kalshiTicker,
            askPrice: params.kalshi.noAsk,
          },
        ]
      : [
          {
            venue: "kalshi",
            side: "YES",
            contractId: params.kalshiTicker,
            askPrice: params.kalshi.yesAsk,
          },
          {
            venue: "polymarket",
            side: "NO",
            contractId: params.polymarketTokenId,
            askPrice: params.pm.noAsk,
          },
        ];

  return {
    mappingPairKey: params.mappingPairKey,
    polymarketTokenId: params.polymarketTokenId,
    kalshiTicker: params.kalshiTicker,
    strategy: params.strategy,
    legs,
    combinedCost: Math.round(params.combinedCost * 10000) / 10000,
    guaranteedPayout: 1,
    netProfitPerUnit: Math.round(netProfitPerUnit * 10000) / 10000,
    netRoiPercent: computeNetRoiPercent(params.combinedCost),
    pmYesAsk: params.pm.yesAsk,
    pmNoAsk: params.pm.noAsk,
    kalshiYesAsk: params.kalshi.yesAsk,
    kalshiNoAsk: params.kalshi.noAsk,
    orderBookTimestampMs: params.orderBookTimestampMs,
  };
}

/**
 * Evaluate a single paired mapping for cross-venue YES/NO box arbitrage.
 */
export function evaluatePairArbitrage(
  mapping: PairedMappingRow,
  pmOb: CachedOrderBookMid | null,
  kalshiOb: CachedOrderBookMid | null,
  maxCombinedCost = MIN_ARBITRAGE_COST_THRESHOLD
): ArbitrageOpportunity[] {
  if (mapping.orientation === "inverted") {
    return [];
  }

  const pm = deriveYesNoAsksFromOrderBook(pmOb);
  const kalshi = deriveYesNoAsksFromOrderBook(kalshiOb);
  if (!pm || !kalshi) return [];

  const tokenId = mapping.polymarketTokenId.toLowerCase();
  const kalshiTicker = mapping.kalshiTicker.toUpperCase();
  const pairKey = pipelineMappingPairKey(tokenId, kalshiTicker);
  const orderBookTimestampMs = Math.max(
    pmOb?.ts ?? 0,
    kalshiOb?.ts ?? 0
  );

  const costOptionA = pm.yesAsk + kalshi.noAsk;
  const costOptionB = kalshi.yesAsk + pm.noAsk;
  const opportunities: ArbitrageOpportunity[] = [];

  if (costOptionA < maxCombinedCost) {
    opportunities.push(
      buildOpportunity({
        mappingPairKey: pairKey,
        polymarketTokenId: tokenId,
        kalshiTicker,
        strategy: "pm_yes_kalshi_no",
        combinedCost: costOptionA,
        pm,
        kalshi,
        orderBookTimestampMs: orderBookTimestampMs || null,
      })
    );
  }

  if (costOptionB < maxCombinedCost) {
    opportunities.push(
      buildOpportunity({
        mappingPairKey: pairKey,
        polymarketTokenId: tokenId,
        kalshiTicker,
        strategy: "kalshi_yes_pm_no",
        combinedCost: costOptionB,
        pm,
        kalshi,
        orderBookTimestampMs: orderBookTimestampMs || null,
      })
    );
  }

  return opportunities.sort((a, b) => b.netRoiPercent - a.netRoiPercent);
}

export async function loadActivePairedMappings(
  limit = 2000
): Promise<PairedMappingRow[]> {
  if (!isDatabaseEnabled()) return [];

  const db = getDb();
  const rows = await db
    .select({
      polymarketTokenId: marketMappings.polymarketTokenId,
      kalshiTicker: marketMappings.kalshiTicker,
      orientation: marketMappings.orientation,
      matchMethod: marketMappings.matchMethod,
    })
    .from(marketMappings)
    .where(ne(marketMappings.matchMethod, TEST_FALLBACK_MATCH_METHOD))
    .limit(limit);

  return rows.map((row) => ({
    polymarketTokenId: row.polymarketTokenId.toLowerCase(),
    kalshiTicker: row.kalshiTicker.toUpperCase(),
    orientation: row.orientation === "inverted" ? "inverted" : "same",
    matchMethod: row.matchMethod,
  }));
}

async function resolveMappingRows(
  options: ArbitrageScanOptions
): Promise<PairedMappingRow[]> {
  if (options.mappings?.length) return options.mappings;
  return loadActivePairedMappings(options.limit);
}

/**
 * Scan all active paired mappings for cross-venue box arbitrage opportunities.
 */
export async function scanArbitrageOpportunities(
  options: ArbitrageScanOptions = {}
): Promise<ArbitrageOpportunity[]> {
  const maxCombinedCost =
    options.maxCombinedCost ?? MIN_ARBITRAGE_COST_THRESHOLD;
  const mappings = await resolveMappingRows(options);

  if (mappings.length === 0) return [];

  const prefetch = await prefetchMappingRedisBatch(
    mappings.map((m) => ({
      polymarketTokenId: m.polymarketTokenId,
      kalshiTicker: m.kalshiTicker,
    }))
  );

  const opportunities: ArbitrageOpportunity[] = [];

  for (const mapping of mappings) {
    const pairKey = pipelineMappingPairKey(
      mapping.polymarketTokenId,
      mapping.kalshiTicker
    );
    const books = prefetch.get(pairKey);
    const pairOpps = evaluatePairArbitrage(
      mapping,
      books?.pmOb ?? null,
      books?.kalshiOb ?? null,
      maxCombinedCost
    );
    opportunities.push(...pairOpps);
  }

  return opportunities.sort((a, b) => b.netRoiPercent - a.netRoiPercent);
}

/**
 * Evaluate a single PM token ↔ Kalshi ticker pair (DB/cache lookup + live books).
 */
export async function scanArbitrageForPair(
  polymarketTokenId: string,
  kalshiTicker: string,
  maxCombinedCost = MIN_ARBITRAGE_COST_THRESHOLD
): Promise<ArbitrageOpportunity[]> {
  const tokenId = polymarketTokenId.toLowerCase();
  const ticker = kalshiTicker.toUpperCase();

  let mapping: PairedMappingRow | null = null;

  const [pmMapping, kalshiMapping, pmOb, kalshiOb] = await Promise.all([
    getMappingByPm(tokenId),
    getMappingByKalshi(ticker),
    getOrderBookMid(evRedisKeys.orderBookPm(tokenId)),
    getOrderBookMid(evRedisKeys.orderBookKalshi(ticker)),
  ]);

  const cached = pmMapping ?? kalshiMapping;
  if (cached) {
    mapping = {
      polymarketTokenId: cached.polymarketTokenId.toLowerCase(),
      kalshiTicker: cached.kalshiTicker.toUpperCase(),
      orientation: cached.orientation === "inverted" ? "inverted" : "same",
      matchMethod: cached.matchMethod,
    };
  } else {
    mapping = {
      polymarketTokenId: tokenId,
      kalshiTicker: ticker,
      orientation: "same",
      matchMethod: "manual",
    };
  }

  return evaluatePairArbitrage(mapping, pmOb, kalshiOb, maxCombinedCost);
}

/** Type guard for downstream alert consumers. */
export function isActiveArbitrageAlert(
  opportunity: ArbitrageOpportunity,
  maxCombinedCost = MIN_ARBITRAGE_COST_THRESHOLD
): boolean {
  return (
    opportunity.combinedCost < maxCombinedCost &&
    opportunity.netProfitPerUnit > 0 &&
    opportunity.legs.length === 2
  );
}
