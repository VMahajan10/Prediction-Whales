import { NextRequest, NextResponse } from "next/server";
import {
  normalizeKalshiTicker,
  normalizePmTokenId,
  pipelineMappingPairKey,
} from "@/lib/evPipeline/crossAssetLookup";
import {
  MIN_ARBITRAGE_COST_THRESHOLD,
  computeExchangeBoxSpreadSnapshot,
  computeKalshiBoxSpreadSnapshot,
  scanArbitrageForPair,
  scanArbitrageForPmSports,
  scanArbitrageOpportunities,
  type ArbitrageOpportunity,
  type BoxSpreadSnapshot,
} from "@/lib/evPipeline/arbitrageScanner";
import {
  getMappingByKalshi,
  getMappingByPm,
  getOrderBookMid,
  evRedisKeys,
} from "@/lib/evPipeline/redisCache";
import { lookupExchangeConsensusBaseline } from "@/lib/evPipeline/exchangeConsensusArb";

export const dynamic = "force-dynamic";

function parseMappingPairKey(
  pairKey: string
): { polymarketTokenId: string; kalshiTicker: string } | null {
  const trimmed = pairKey.trim();
  const match = trimmed.match(/^pair:([^:]+):([^:]+)$/i);
  if (!match) return null;

  const polymarketTokenId = normalizePmTokenId(match[1]);
  const kalshiTicker = normalizeKalshiTicker(match[2]);
  if (!polymarketTokenId || !kalshiTicker) return null;

  return { polymarketTokenId, kalshiTicker };
}

function normalizePairKey(pairKey: string): string {
  const parsed = parseMappingPairKey(pairKey);
  if (!parsed) return pairKey.trim().toLowerCase();
  return pipelineMappingPairKey(
    parsed.polymarketTokenId,
    parsed.kalshiTicker
  );
}

function baselinePayload(
  baseline: Awaited<ReturnType<typeof lookupExchangeConsensusBaseline>>
) {
  if (!baseline) return null;
  const exchangeNoAsk = Math.round((1 - baseline.yesAsk) * 10000) / 10000;
  return {
    yesBid: baseline.yesBid,
    yesAsk: baseline.yesAsk,
    exchangeNoAsk,
    outcome: baseline.outcome,
    outcomePm: baseline.outcomePm,
    outcomeLabel: baseline.outcomeLabel ?? null,
    invertedFromOpposing: baseline.invertedFromOpposing ?? false,
    label: baseline.label,
    bookmakerCount: baseline.bookmakerCount,
  };
}

function pickBestAlert(
  opportunities: ArbitrageOpportunity[]
): ArbitrageOpportunity | null {
  if (!opportunities.length) return null;
  return opportunities[0];
}

function emptySpreadShell(
  opposingVenue: "exchange" | "kalshi",
  opposingVenueLabel: string
): BoxSpreadSnapshot {
  return {
    pmYesAsk: null,
    opposingNoAsk: null,
    opposingVenue,
    opposingVenueLabel,
    combinedCost: null,
    netProfitDelta: null,
    netRoiPercent: null,
    isActionable: false,
    exchangeNoAsk: null,
    kalshiNoAsk: null,
  };
}

function spreadQuoteScore(spread: BoxSpreadSnapshot): number {
  let score = 0;
  if (spread.pmYesAsk != null) score += 2;
  if (spread.opposingNoAsk != null) score += 2;
  if (spread.exchangeNoAsk != null) score += 1;
  if (spread.combinedCost != null) score += 4;
  if (spread.isActionable) score += 2;
  return score;
}

function deriveSpreadStatus(
  spread: BoxSpreadSnapshot,
  ctx: {
    hasPmOb: boolean;
    hasKalshiOb: boolean;
    hasBaseline: boolean;
    kalshiTicker?: string;
  }
): Pick<BoxSpreadSnapshot, "status" | "statusMessage"> {
  const hasPmQuote = spread.pmYesAsk != null;
  const hasOpposingQuote = spread.opposingNoAsk != null;
  const hasFullBox = spread.combinedCost != null;

  if (hasFullBox && spread.isActionable) {
    return { status: "OK", statusMessage: "Active arbitrage spread" };
  }

  if (!ctx.hasBaseline && !hasOpposingQuote && !ctx.hasPmOb && !ctx.hasKalshiOb) {
    return {
      status: "INSUFFICIENT_LIQUIDITY",
      statusMessage: "Awaiting order book depth and exchange baseline",
    };
  }

  if (!ctx.hasPmOb && !hasPmQuote) {
    if (hasOpposingQuote) {
      return {
        status: "AWAITING_PM_ORDER_BOOK",
        statusMessage: "Awaiting Polymarket order book depth",
      };
    }
  }

  if (
    ctx.kalshiTicker &&
    !ctx.hasKalshiOb &&
    spread.opposingVenue === "kalshi" &&
    !hasOpposingQuote
  ) {
    return {
      status: "AWAITING_KALSHI_ORDER_BOOK",
      statusMessage: "Awaiting Kalshi order book depth",
    };
  }

  if (
    !ctx.hasBaseline &&
    spread.opposingVenue === "exchange" &&
    !hasOpposingQuote
  ) {
    return {
      status: "AWAITING_EXCHANGE_BASELINE",
      statusMessage: "Awaiting sportsbook consensus baseline",
    };
  }

  if (!hasFullBox && (hasPmQuote || hasOpposingQuote)) {
    return {
      status: "PARTIAL_QUOTES",
      statusMessage: "Awaiting order book depth",
    };
  }

  if (!hasFullBox) {
    return {
      status: "INSUFFICIENT_LIQUIDITY",
      statusMessage: "Awaiting order book depth",
    };
  }

  return { status: "OK", statusMessage: "Spreads are currently efficient" };
}

async function resolveBoxSpread(params: {
  polymarketTokenId: string;
  kalshiTicker?: string;
  slug?: string;
  title?: string;
}): Promise<BoxSpreadSnapshot> {
  const tokenId = params.polymarketTokenId.toLowerCase();
  const ticker = params.kalshiTicker?.toUpperCase();

  const [pmOb, kalshiOb, baseline] = await Promise.all([
    getOrderBookMid(evRedisKeys.orderBookPm(tokenId)),
    ticker
      ? getOrderBookMid(evRedisKeys.orderBookKalshi(ticker))
      : Promise.resolve(null),
    lookupExchangeConsensusBaseline({
      tokenId,
      slug: params.slug,
      title: params.title,
    }),
  ]);

  const hasPmOb = !!pmOb;
  const hasKalshiOb = !!kalshiOb;
  const hasBaseline = !!baseline;

  const exchangeSpread = baseline
    ? computeExchangeBoxSpreadSnapshot(pmOb, baseline)
    : null;
  const kalshiSpread = ticker
    ? computeKalshiBoxSpreadSnapshot(pmOb, kalshiOb, ticker)
    : null;

  const candidates = [kalshiSpread, exchangeSpread].filter(
    (spread): spread is BoxSpreadSnapshot => spread != null
  );
  let spread =
    candidates.sort((a, b) => spreadQuoteScore(b) - spreadQuoteScore(a))[0] ??
    null;

  if (!spread && baseline) {
    const exchangeNoAsk = exchangeNoAskFromBaseline(baseline);
    spread = {
      pmYesAsk: null,
      opposingNoAsk: exchangeNoAsk,
      exchangeNoAsk,
      opposingVenue: "exchange",
      opposingVenueLabel: baseline.label,
      combinedCost: null,
      netProfitDelta: null,
      netRoiPercent: null,
      isActionable: false,
    };
  }

  if (!spread) {
    spread = ticker
      ? emptySpreadShell("kalshi", ticker)
      : emptySpreadShell("exchange", "Awaiting opposing quote");
  }

  const statusFields = deriveSpreadStatus(spread, {
    hasPmOb,
    hasKalshiOb,
    hasBaseline,
    kalshiTicker: ticker,
  });
  const resolved: BoxSpreadSnapshot = { ...spread, ...statusFields };

  console.log("[api/ev/arbitrage] resolveBoxSpread", {
    tokenId,
    kalshiTicker: ticker ?? null,
    hasPmOb,
    hasKalshiOb,
    hasBaseline,
    status: resolved.status,
    statusMessage: resolved.statusMessage,
    pmOutcomeLabel: baseline?.outcomeLabel ?? null,
    baselineYesAsk: baseline?.yesAsk ?? null,
    baselineExchangeNoAsk: baseline ? exchangeNoAskFromBaseline(baseline) : null,
    pmYesAsk: resolved.pmYesAsk,
    opposingNoAsk: resolved.opposingNoAsk,
    exchangeNoAsk: resolved.exchangeNoAsk ?? null,
    combinedCost: resolved.combinedCost,
  });

  return resolved;
}

function exchangeNoAskFromBaseline(
  baseline: Awaited<ReturnType<typeof lookupExchangeConsensusBaseline>>
): number | null {
  if (!baseline) return null;
  return Math.round((1 - baseline.yesAsk) * 10000) / 10000;
}

function spreadPayload(
  spread: BoxSpreadSnapshot,
  baseline: Awaited<ReturnType<typeof lookupExchangeConsensusBaseline>>
): BoxSpreadSnapshot {
  const baselineExchangeNoAsk = exchangeNoAskFromBaseline(baseline);

  const exchangeNoAsk =
    spread.opposingVenue === "exchange"
      ? (spread.opposingNoAsk ?? spread.exchangeNoAsk ?? baselineExchangeNoAsk)
      : (spread.exchangeNoAsk ?? baselineExchangeNoAsk);

  const opposingNoAsk = spread.opposingNoAsk ?? exchangeNoAsk ?? null;
  const pmYesAsk = spread.pmYesAsk;
  const combinedCost =
    spread.combinedCost ??
    (pmYesAsk != null && exchangeNoAsk != null
      ? Math.round((pmYesAsk + exchangeNoAsk) * 10000) / 10000
      : pmYesAsk != null && opposingNoAsk != null
        ? Math.round((pmYesAsk + opposingNoAsk) * 10000) / 10000
        : null);
  const netProfitDelta =
    spread.netProfitDelta ??
    (combinedCost != null
      ? Math.round((1 - combinedCost) * 10000) / 10000
      : null);
  const netRoiPercent =
    spread.netRoiPercent ??
    (combinedCost != null && combinedCost > 0
      ? Math.round(((1 - combinedCost) / combinedCost) * 1000) / 10
      : null);

  return {
    ...spread,
    opposingNoAsk,
    exchangeNoAsk,
    kalshiNoAsk:
      spread.opposingVenue === "kalshi" ? spread.opposingNoAsk : spread.kalshiNoAsk ?? null,
    combinedCost,
    netProfitDelta,
    netRoiPercent,
    isActionable:
      spread.isActionable ??
      (combinedCost != null &&
        combinedCost < MIN_ARBITRAGE_COST_THRESHOLD &&
        (netProfitDelta ?? 0) > 0),
    status: spread.status,
    statusMessage: spread.statusMessage,
  };
}

function logArbitragePayload(
  label: string,
  payload: Record<string, unknown>
): void {
  console.log(`Arbitrage Endpoint Data Payload (${label}):`, JSON.stringify(payload));
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const pairKey = searchParams.get("pairKey")?.trim();
  const tokenIdParam = normalizePmTokenId(searchParams.get("tokenId"));
  const slug = searchParams.get("slug")?.trim() || undefined;
  const title = searchParams.get("title")?.trim() || undefined;

  console.log("Arbitrage API hit. TokenId:", searchParams.get("tokenId"));
  console.log("Arbitrage API Request for token:", tokenIdParam, "pairKey:", pairKey, {
    slug,
    title,
  });

  if (!pairKey && !tokenIdParam) {
    return NextResponse.json(
      {
        error:
          "Provide pairKey (pair:{pmToken}:{KALSHI_TICKER}) or tokenId for sports exchange scan",
      },
      { status: 400 }
    );
  }

  try {
    if (tokenIdParam && !pairKey) {
      const pmMapping = await getMappingByPm(tokenIdParam);
      const kalshiTicker = pmMapping?.kalshiTicker;

      const [kalshiOpps, exchangeOpps, baseline, boxSpread] = await Promise.all([
        kalshiTicker
          ? scanArbitrageForPair(
              tokenIdParam,
              kalshiTicker,
              MIN_ARBITRAGE_COST_THRESHOLD,
              { slug, title }
            )
          : Promise.resolve([] as ArbitrageOpportunity[]),
        scanArbitrageForPmSports(tokenIdParam, { slug, title }),
        lookupExchangeConsensusBaseline({ tokenId: tokenIdParam, slug, title }),
        resolveBoxSpread({
          polymarketTokenId: tokenIdParam,
          kalshiTicker,
          slug,
          title,
        }),
      ]);

      const opportunities = [...kalshiOpps, ...exchangeOpps].sort(
        (a, b) => b.netRoiPercent - a.netRoiPercent
      );
      const alert = pickBestAlert(opportunities);
      const spread = spreadPayload(boxSpread, baseline);
      const exchangeNoAsk = spread.exchangeNoAsk ?? exchangeNoAskFromBaseline(baseline);

      const payload = {
        source:
          alert?.secondaryVenue ??
          boxSpread.opposingVenue ??
          (baseline ? "exchange" : "none"),
        pairKey: alert?.mappingPairKey ?? `exchange:pm:${tokenIdParam}`,
        tokenId: tokenIdParam,
        baseline: baselinePayload(baseline),
        exchangeNoAsk,
        spreadStatus: spread.status ?? "INSUFFICIENT_LIQUIDITY",
        spreadStatusMessage: spread.statusMessage ?? "Awaiting order book depth",
        boxSpread: spread,
        spread,
        opportunities,
        alert,
        arbitrage: alert,
        threshold: MIN_ARBITRAGE_COST_THRESHOLD,
      };
      logArbitragePayload("tokenId", payload);

      return NextResponse.json(payload, { status: 200 });
    }

    const parsed = parseMappingPairKey(pairKey!);
    if (!parsed) {
      return NextResponse.json(
        { error: "Invalid pairKey format" },
        { status: 400 }
      );
    }

    const [pmMapping, kalshiMapping] = await Promise.all([
      getMappingByPm(parsed.polymarketTokenId),
      getMappingByKalshi(parsed.kalshiTicker),
    ]);
    const cached = pmMapping ?? kalshiMapping;

    const opportunities = await scanArbitrageOpportunities({
      mappings: [
        cached
          ? {
              polymarketTokenId: cached.polymarketTokenId.toLowerCase(),
              kalshiTicker: cached.kalshiTicker.toUpperCase(),
              orientation:
                cached.orientation === "inverted" ? "inverted" : "same",
              matchMethod: cached.matchMethod,
            }
          : {
              polymarketTokenId: parsed.polymarketTokenId,
              kalshiTicker: parsed.kalshiTicker,
              orientation: "same",
              matchMethod: "manual",
            },
      ],
    });

    const targetKey = normalizePairKey(pairKey!);
    let alert =
      opportunities.find(
        (opportunity) =>
          opportunity.mappingPairKey.toLowerCase() === targetKey.toLowerCase()
      ) ?? null;

    if (!alert) {
      const exchangeFallback = await scanArbitrageForPmSports(
        parsed.polymarketTokenId,
        { slug, title }
      );
      alert = pickBestAlert(exchangeFallback);
    }

    const [baseline, boxSpread] = await Promise.all([
      lookupExchangeConsensusBaseline({
        tokenId: parsed.polymarketTokenId,
        slug,
        title,
      }),
      resolveBoxSpread({
        polymarketTokenId: parsed.polymarketTokenId,
        kalshiTicker: parsed.kalshiTicker,
        slug,
        title,
      }),
    ]);
    const spread = spreadPayload(boxSpread, baseline);
    const exchangeNoAsk = spread.exchangeNoAsk ?? exchangeNoAskFromBaseline(baseline);

    const payload = {
      source:
        alert?.secondaryVenue ??
        boxSpread.opposingVenue ??
        (baseline ? "exchange" : "kalshi"),
      pairKey: targetKey,
      baseline: baselinePayload(baseline),
      exchangeNoAsk,
      spreadStatus: spread.status ?? "INSUFFICIENT_LIQUIDITY",
      spreadStatusMessage: spread.statusMessage ?? "Awaiting order book depth",
      boxSpread: spread,
      spread,
      alert,
      arbitrage: alert,
      opportunities: alert ? [alert] : [],
      threshold: MIN_ARBITRAGE_COST_THRESHOLD,
    };
    logArbitragePayload("pairKey", payload);

    return NextResponse.json(payload, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Arbitrage scan failed";
    console.error("[api/ev/arbitrage]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
