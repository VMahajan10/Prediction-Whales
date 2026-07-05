import { NextRequest, NextResponse } from "next/server";
import { resolveArbitrageDisplay } from "@/lib/arbitrageFinder/displayResolver";
import {
  buildNeutralArbitrageSnapshot,
  type ArbitrageDisplaySnapshot,
} from "@/lib/arbitrageFinder/displayTypes";
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
  tradePrice?: number | null;
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
  const hasCompleteLiveSpread =
    spread?.pmYesAsk != null &&
    spread.opposingNoAsk != null &&
    spread.combinedCost != null;

  if (!hasCompleteLiveSpread) {
    const snapshot =
      (await resolveArbitrageDisplay({
        source: "polymarket",
        pmTokenId: tokenId,
        kalshiTicker: ticker,
        tradePrice: params.tradePrice,
        title: params.title,
        slug: params.slug,
        prefer: "single_venue",
      })) ??
      buildNeutralArbitrageSnapshot({
        venue: "polymarket",
        contractId: tokenId,
        referencePrice: params.tradePrice,
      });
    spread = spreadFromDisplaySnapshot(snapshot, ticker);
  }

  const resolved: BoxSpreadSnapshot = hasCompleteLiveSpread
    ? {
        ...spread!,
        ...deriveSpreadStatus(spread!, {
          hasPmOb,
          hasKalshiOb,
          hasBaseline,
          kalshiTicker: ticker,
        }),
      }
    : spread!;

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
    impliedSumPercent:
      spread.impliedSumPercent ??
      (combinedCost != null ? Math.round(combinedCost * 1000) / 10 : null),
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

function spreadFromDisplaySnapshot(
  snapshot: ArbitrageDisplaySnapshot,
  kalshiTicker?: string | null
): BoxSpreadSnapshot {
  const yesLeg =
    snapshot.legs.find((leg) => leg.side === "YES") ?? snapshot.legs[0];
  const noLeg =
    snapshot.legs.find((leg) => leg.side === "NO") ?? snapshot.legs[1];
  const netProfitDelta =
    snapshot.combinedCost > 0 ? 1 - snapshot.combinedCost : null;
  const opposingVenue = noLeg.venue;
  const opposingVenueLabel =
    opposingVenue === "polymarket"
      ? "Same-venue fallback"
      : opposingVenue === "kalshi"
        ? (kalshiTicker?.toUpperCase() ?? noLeg.contractId)
        : "Sportsbook consensus";

  return {
    pmYesAsk: yesLeg.askPrice,
    opposingNoAsk: noLeg.askPrice,
    opposingVenue,
    opposingVenueLabel,
    combinedCost: snapshot.combinedCost,
    impliedSumPercent: snapshot.impliedSumPercent,
    netProfitDelta,
    netRoiPercent: snapshot.roiPercent,
    isActionable: snapshot.isActionable,
    isExecutable: snapshot.isExecutable,
    degraded: snapshot.degraded,
    primaryQuoteSource: yesLeg.source,
    opposingQuoteSource: noLeg.source,
    exchangeNoAsk:
      opposingVenue === "exchange" ? noLeg.askPrice : null,
    kalshiNoAsk: opposingVenue === "kalshi" ? noLeg.askPrice : null,
    status: snapshot.degraded ? "PARTIAL_QUOTES" : "OK",
    statusMessage: snapshot.degraded
      ? "Estimated same-venue quotes"
      : snapshot.isActionable
        ? "Active intra-venue spread"
        : "Intra-venue spreads are currently efficient",
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const pairKey = searchParams.get("pairKey")?.trim();
  const tokenIdParam = normalizePmTokenId(searchParams.get("tokenId"));
  const kalshiTickerParam = normalizeKalshiTicker(
    searchParams.get("kalshiTicker")
  );
  const slug = searchParams.get("slug")?.trim() || undefined;
  const title = searchParams.get("title")?.trim() || undefined;
  const tradePriceRaw = searchParams.get("tradePrice");
  const tradePrice =
    tradePriceRaw != null && Number.isFinite(parseFloat(tradePriceRaw))
      ? parseFloat(tradePriceRaw)
      : null;

  console.log("Arbitrage API hit. TokenId:", searchParams.get("tokenId"));
  console.log("Arbitrage API Request for token:", tokenIdParam, "pairKey:", pairKey, {
    slug,
    title,
    kalshiTicker: kalshiTickerParam,
  });

  if (!pairKey && !tokenIdParam && !kalshiTickerParam) {
    return NextResponse.json(
      {
        error:
          "Provide pairKey (pair:{pmToken}:{KALSHI_TICKER}), tokenId, or kalshiTicker",
      },
      { status: 400 }
    );
  }

  try {
    if (kalshiTickerParam && !pairKey && !tokenIdParam) {
      const snapshot =
        (await resolveArbitrageDisplay({
          source: "kalshi",
          kalshiTicker: kalshiTickerParam,
          title,
          tradePrice,
          prefer: "single_venue",
        })) ??
        buildNeutralArbitrageSnapshot({
          venue: "kalshi",
          contractId: kalshiTickerParam,
          referencePrice: tradePrice,
        });

      const spread = spreadFromDisplaySnapshot(snapshot, kalshiTickerParam);
      const payload = {
        source: "kalshi",
        kalshiTicker: kalshiTickerParam,
        spreadStatus: spread.status ?? "OK",
        spreadStatusMessage: spread.statusMessage ?? null,
        boxSpread: spread,
        spread,
        opportunities: [],
        alert: null,
        arbitrage: null,
        threshold: MIN_ARBITRAGE_COST_THRESHOLD,
      };
      logArbitragePayload("kalshiTicker", payload);
      return NextResponse.json(payload, { status: 200 });
    }

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
          tradePrice,
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
        tradePrice,
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
