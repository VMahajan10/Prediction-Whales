import { ne } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { marketMappings } from "@/lib/crossmarket/store/schema";
import { pipelineMappingPairKey } from "@/lib/evPipeline/crossAssetLookup";
import {
  exchangeBaselineToYesNoAsks,
  lookupExchangeConsensusBaseline,
  type ExchangeConsensusBaseline,
} from "@/lib/evPipeline/exchangeConsensusArb";
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

export type ArbitrageVenue = "polymarket" | "kalshi" | "exchange";
export type ArbitrageSide = "YES" | "NO";

export type ArbitrageStrategy =
  | "pm_yes_kalshi_no"
  | "kalshi_yes_pm_no"
  | "pm_vs_exchange_arb";

export interface ArbitrageLeg {
  venue: ArbitrageVenue;
  side: ArbitrageSide;
  /** Polymarket CLOB token id, Kalshi ticker, or exchange match id. */
  contractId: string;
  askPrice: number;
}

export interface ArbitrageOpportunity {
  mappingPairKey: string;
  polymarketTokenId: string;
  kalshiTicker: string | null;
  strategy: ArbitrageStrategy;
  legs: ArbitrageLeg[];
  combinedCost: number;
  guaranteedPayout: number;
  netProfitPerUnit: number;
  netRoiPercent: number;
  pmYesAsk: number;
  pmNoAsk: number;
  kalshiYesAsk: number | null;
  kalshiNoAsk: number | null;
  exchangeYesBid?: number | null;
  exchangeYesAsk?: number | null;
  exchangeLabel?: string | null;
  secondaryVenue?: "kalshi" | "exchange";
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

function buildKalshiOpportunity(params: {
  mappingPairKey: string;
  polymarketTokenId: string;
  kalshiTicker: string;
  strategy: "pm_yes_kalshi_no" | "kalshi_yes_pm_no";
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
    secondaryVenue: "kalshi",
    orderBookTimestampMs: params.orderBookTimestampMs,
  };
}

function buildExchangeOpportunity(params: {
  polymarketTokenId: string;
  combinedCost: number;
  pm: YesNoAsks;
  exchange: YesNoAsks;
  baseline: ExchangeConsensusBaseline;
  orderBookTimestampMs: number | null;
}): ArbitrageOpportunity {
  const exchangeNoAsk = exchangeBaselineToYesNoAsks(params.baseline).noAsk;
  const legs: ArbitrageLeg[] = [
    {
      venue: "polymarket",
      side: "YES",
      contractId: params.polymarketTokenId,
      askPrice: params.pm.yesAsk,
    },
    {
      venue: "exchange",
      side: "NO",
      contractId: params.baseline.matchId,
      askPrice: exchangeNoAsk,
    },
  ];

  const netProfitPerUnit = 1 - params.combinedCost;
  const pairKey = `exchange:pm:${params.polymarketTokenId}`;

  return {
    mappingPairKey: pairKey,
    polymarketTokenId: params.polymarketTokenId,
    kalshiTicker: null,
    strategy: "pm_vs_exchange_arb",
    legs,
    combinedCost: Math.round(params.combinedCost * 10000) / 10000,
    guaranteedPayout: 1,
    netProfitPerUnit: Math.round(netProfitPerUnit * 10000) / 10000,
    netRoiPercent: computeNetRoiPercent(params.combinedCost),
    pmYesAsk: params.pm.yesAsk,
    pmNoAsk: params.pm.noAsk,
    kalshiYesAsk: null,
    kalshiNoAsk: null,
    exchangeYesBid: params.baseline.yesBid,
    exchangeYesAsk: params.baseline.yesAsk,
    exchangeLabel: params.baseline.label,
    secondaryVenue: "exchange",
    orderBookTimestampMs: params.orderBookTimestampMs,
  };
}

/**
 * PM resting book vs sportsbook consensus (Pinnacle/Betfair no-vig cache).
 */
export function evaluateExchangeArbitrage(
  polymarketTokenId: string,
  pmOb: CachedOrderBookMid | null,
  baseline: ExchangeConsensusBaseline,
  maxCombinedCost = MIN_ARBITRAGE_COST_THRESHOLD
): ArbitrageOpportunity[] {
  const pm = deriveYesNoAsksFromOrderBook(pmOb);
  const exchange = exchangeBaselineToYesNoAsks(baseline);
  if (!pm) return [];

  const tokenId = polymarketTokenId.toLowerCase();
  const orderBookTimestampMs = Math.max(
    pmOb?.ts ?? 0,
    baseline.quoteUpdatedAt ? baseline.quoteUpdatedAt * 1000 : 0
  );

  const costPmYesExchangeNo = pm.yesAsk + exchange.noAsk;
  const costExchangeYesPmNo = exchange.yesAsk + pm.noAsk;
  const opportunities: ArbitrageOpportunity[] = [];

  if (costPmYesExchangeNo < maxCombinedCost) {
    opportunities.push(
      buildExchangeOpportunity({
        polymarketTokenId: tokenId,
        combinedCost: costPmYesExchangeNo,
        pm,
        exchange,
        baseline,
        orderBookTimestampMs: orderBookTimestampMs || null,
      })
    );
  }

  if (
    costExchangeYesPmNo < maxCombinedCost &&
    costExchangeYesPmNo < costPmYesExchangeNo
  ) {
    opportunities.push({
      ...buildExchangeOpportunity({
        polymarketTokenId: tokenId,
        combinedCost: costExchangeYesPmNo,
        pm,
        exchange,
        baseline,
        orderBookTimestampMs: orderBookTimestampMs || null,
      }),
      strategy: "pm_vs_exchange_arb",
      legs: [
        {
          venue: "exchange",
          side: "YES",
          contractId: baseline.matchId,
          askPrice: exchange.yesAsk,
        },
        {
          venue: "polymarket",
          side: "NO",
          contractId: tokenId,
          askPrice: pm.noAsk,
        },
      ],
    });
  }

  return opportunities.sort((a, b) => b.netRoiPercent - a.netRoiPercent);
}

/**
 * Evaluate a single paired mapping for cross-venue YES/NO box arbitrage.
 */
export function evaluatePairArbitrage(
  mapping: PairedMappingRow,
  pmOb: CachedOrderBookMid | null,
  kalshiOb: CachedOrderBookMid | null,
  maxCombinedCost = MIN_ARBITRAGE_COST_THRESHOLD,
  exchangeBaseline?: ExchangeConsensusBaseline | null
): ArbitrageOpportunity[] {
  if (mapping.orientation === "inverted") {
    return [];
  }

  const tokenId = mapping.polymarketTokenId.toLowerCase();
  const kalshiTicker = mapping.kalshiTicker.toUpperCase();
  const pairKey = pipelineMappingPairKey(tokenId, kalshiTicker);

  const pm = deriveYesNoAsksFromOrderBook(pmOb);
  const kalshi = deriveYesNoAsksFromOrderBook(kalshiOb);

  if (!pm) return [];

  if (!kalshi && exchangeBaseline) {
    return evaluateExchangeArbitrage(
      tokenId,
      pmOb,
      exchangeBaseline,
      maxCombinedCost
    );
  }

  if (!kalshi) return [];

  const orderBookTimestampMs = Math.max(
    pmOb?.ts ?? 0,
    kalshiOb?.ts ?? 0
  );

  const costOptionA = pm.yesAsk + kalshi.noAsk;
  const costOptionB = kalshi.yesAsk + pm.noAsk;
  const opportunities: ArbitrageOpportunity[] = [];

  if (costOptionA < maxCombinedCost) {
    opportunities.push(
      buildKalshiOpportunity({
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
      buildKalshiOpportunity({
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
  maxCombinedCost = MIN_ARBITRAGE_COST_THRESHOLD,
  options: { slug?: string | null; title?: string | null } = {}
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

  const kalshiAsks = deriveYesNoAsksFromOrderBook(kalshiOb);
  let exchangeBaseline: ExchangeConsensusBaseline | null = null;
  if (!kalshiAsks) {
    exchangeBaseline = await lookupExchangeConsensusBaseline({
      tokenId,
      slug: options.slug,
      title: options.title,
    });
  }

  return evaluatePairArbitrage(
    mapping,
    pmOb,
    kalshiOb,
    maxCombinedCost,
    exchangeBaseline
  );
}

/**
 * Sports PM token arbitrage via exchange consensus when Kalshi is absent.
 */
export async function scanArbitrageForPmSports(
  polymarketTokenId: string,
  options: {
    slug?: string | null;
    title?: string | null;
    maxCombinedCost?: number;
  } = {}
): Promise<ArbitrageOpportunity[]> {
  const tokenId = polymarketTokenId.toLowerCase();
  const maxCombinedCost =
    options.maxCombinedCost ?? MIN_ARBITRAGE_COST_THRESHOLD;

  const [pmOb, baseline] = await Promise.all([
    getOrderBookMid(evRedisKeys.orderBookPm(tokenId)),
    lookupExchangeConsensusBaseline({
      tokenId,
      slug: options.slug,
      title: options.title,
    }),
  ]);

  if (!baseline) return [];
  return evaluateExchangeArbitrage(tokenId, pmOb, baseline, maxCombinedCost);
}

/** Unified box-spread matrix for Kalshi or exchange opposing leg. */
export type BoxSpreadStatus =
  | "OK"
  | "AWAITING_PM_ORDER_BOOK"
  | "AWAITING_KALSHI_ORDER_BOOK"
  | "AWAITING_EXCHANGE_BASELINE"
  | "INSUFFICIENT_LIQUIDITY"
  | "PARTIAL_QUOTES";

export interface BoxSpreadSnapshot {
  pmYesAsk: number | null;
  opposingNoAsk: number | null;
  opposingVenue: "kalshi" | "exchange";
  opposingVenueLabel: string;
  combinedCost: number | null;
  netProfitDelta: number | null;
  netRoiPercent: number | null;
  isActionable: boolean;
  /** Alias for opposingNoAsk when venue is exchange. */
  exchangeNoAsk?: number | null;
  /** Alias for opposingNoAsk when venue is kalshi. */
  kalshiNoAsk?: number | null;
  /** Machine-readable quote availability for the dashboard. */
  status?: BoxSpreadStatus;
  /** Human-readable status for the dashboard. */
  statusMessage?: string;
}

/** @deprecated Use BoxSpreadSnapshot — kept for API compat during migration. */
export interface ExchangeSpreadSnapshot {
  pmYesAsk: number | null;
  pmNoAsk: number | null;
  exchangeYesBid: number;
  exchangeYesAsk: number;
  exchangeNoAsk: number;
  combinedCost: number | null;
  edgePerDollar: number | null;
  netRoiPercent: number | null;
  isActionable: boolean;
}

function roundSpread4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function computeKalshiBoxSpreadSnapshot(
  pmOb: CachedOrderBookMid | null,
  kalshiOb: CachedOrderBookMid | null,
  kalshiTicker: string,
  maxCombinedCost = MIN_ARBITRAGE_COST_THRESHOLD
): BoxSpreadSnapshot {
  const pm = deriveYesNoAsksFromOrderBook(pmOb);
  const kalshi = deriveYesNoAsksFromOrderBook(kalshiOb);
  const combinedCost =
    pm && kalshi ? roundSpread4(pm.yesAsk + kalshi.noAsk) : null;
  const netProfitDelta =
    combinedCost != null ? roundSpread4(1 - combinedCost) : null;

  return {
    pmYesAsk: pm?.yesAsk ?? null,
    opposingNoAsk: kalshi?.noAsk ?? null,
    opposingVenue: "kalshi",
    opposingVenueLabel: kalshiTicker.toUpperCase(),
    combinedCost,
    netProfitDelta,
    netRoiPercent:
      combinedCost != null ? computeNetRoiPercent(combinedCost) : null,
    isActionable:
      combinedCost != null &&
      combinedCost < maxCombinedCost &&
      (netProfitDelta ?? 0) > 0,
  };
}

export function computeExchangeBoxSpreadSnapshot(
  pmOb: CachedOrderBookMid | null,
  baseline: ExchangeConsensusBaseline,
  maxCombinedCost = MIN_ARBITRAGE_COST_THRESHOLD
): BoxSpreadSnapshot {
  const pm = deriveYesNoAsksFromOrderBook(pmOb);
  const exchange = exchangeBaselineToYesNoAsks(baseline);
  const combinedCost = pm
    ? roundSpread4(pm.yesAsk + exchange.noAsk)
    : null;
  const netProfitDelta =
    combinedCost != null ? roundSpread4(1 - combinedCost) : null;

  const snapshot = {
    pmYesAsk: pm?.yesAsk ?? null,
    opposingNoAsk: exchange.noAsk,
    opposingVenue: "exchange" as const,
    opposingVenueLabel: baseline.label,
    combinedCost,
    netProfitDelta,
    netRoiPercent:
      combinedCost != null ? computeNetRoiPercent(combinedCost) : null,
    isActionable:
      combinedCost != null &&
      combinedCost < maxCombinedCost &&
      (netProfitDelta ?? 0) > 0,
    exchangeNoAsk: exchange.noAsk,
  };

  console.log("[arbitrageScanner] computeExchangeBoxSpreadSnapshot", {
    matchId: baseline.matchId,
    outcome: baseline.outcome,
    outcomeLabel: baseline.outcomeLabel ?? null,
    yesAsk: baseline.yesAsk,
    exchangeNoAsk: exchange.noAsk,
    pmYesAsk: snapshot.pmYesAsk,
    combinedCost: snapshot.combinedCost,
    invertedFromOpposing: baseline.invertedFromOpposing ?? false,
  });

  return snapshot;
}

/** @deprecated Use computeExchangeBoxSpreadSnapshot */
export function computeExchangeSpreadSnapshot(
  pmOb: CachedOrderBookMid | null,
  baseline: ExchangeConsensusBaseline,
  maxCombinedCost = MIN_ARBITRAGE_COST_THRESHOLD
): ExchangeSpreadSnapshot {
  const box = computeExchangeBoxSpreadSnapshot(pmOb, baseline, maxCombinedCost);
  const exchange = exchangeBaselineToYesNoAsks(baseline);
  const pm = deriveYesNoAsksFromOrderBook(pmOb);

  return {
    pmYesAsk: box.pmYesAsk,
    pmNoAsk: pm?.noAsk ?? null,
    exchangeYesBid: baseline.yesBid,
    exchangeYesAsk: baseline.yesAsk,
    exchangeNoAsk: exchange.noAsk,
    combinedCost: box.combinedCost,
    edgePerDollar: box.netProfitDelta,
    netRoiPercent: box.netRoiPercent,
    isActionable: box.isActionable,
  };
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
