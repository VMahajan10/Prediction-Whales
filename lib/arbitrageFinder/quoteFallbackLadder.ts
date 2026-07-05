import {
  fetchKalshiOrderBookMid,
  fetchPmOrderBookMid,
} from "@/lib/arbitrageFinder/adapters/orderBookAdapter";
import type {
  ArbitrageDisplayLeg,
  QuoteSource,
} from "@/lib/arbitrageFinder/displayTypes";
import { derivePartialYesNoAsksFromOrderBook } from "@/lib/finance/orderBookQuotes";
import {
  exchangeBaselineToYesNoAsks,
  lookupExchangeConsensusBaseline,
} from "@/lib/evPipeline/exchangeConsensusArb";
import { resolveEnsemblePTrue } from "@/lib/evPipeline/ensemblePTrue";
import { resolvePTrueSync } from "@/lib/evPipeline/pTrueEnsembleResolver";
import type { PTrueSource } from "@/lib/evPipeline/pTrueTypes";

export interface ResolvedYesNoQuotes {
  yesAsk: number;
  noAsk: number;
  yesSource: QuoteSource;
  noSource: QuoteSource;
  degraded: boolean;
  isExecutable: boolean;
}

function isValidAsk(price: number | null | undefined): price is number {
  return price != null && Number.isFinite(price) && price > 0 && price < 1;
}

function normalizeOutcomeSide(
  side: string | null | undefined
): "yes" | "no" | null {
  if (!side) return null;
  const normalized = side.trim().toLowerCase();
  if (normalized === "yes") return "yes";
  if (normalized === "no") return "no";
  return null;
}

function quoteSourceFromPTrueSource(source: PTrueSource): QuoteSource {
  if (source === "sportsbook_consensus") return "consensus";
  if (source === "execution_price") return "trade_price";
  if (source === "universal_prior") return "universal_prior";
  if (source === "standalone_ob" || source === "cross_venue_ob") {
    return "mid_proxy";
  }
  return "p_true";
}

function legFromQuote(
  venue: ArbitrageDisplayLeg["venue"],
  side: "YES" | "NO",
  contractId: string,
  askPrice: number,
  source: QuoteSource
): ArbitrageDisplayLeg {
  return { venue, side, contractId, askPrice, source };
}

export function completeYesNoQuoteCandidates(params: {
  venue: "polymarket" | "kalshi";
  yesAsk: number | null;
  noAsk: number | null;
  tradeOutcomeSide?: string | null;
  tradePrice?: number | null;
  fairYes: number;
  fairSource: QuoteSource;
}): ResolvedYesNoQuotes {
  let yesAsk = params.yesAsk;
  let noAsk = params.noAsk;
  let yesSource: QuoteSource | null = yesAsk != null ? "order_book" : null;
  let noSource: QuoteSource | null = noAsk != null ? "order_book" : null;
  const outcomeSide = normalizeOutcomeSide(params.tradeOutcomeSide);

  // A Polymarket asset id is the selected outcome token. Team-name outcomes
  // (common in LoL) therefore use the trade price as the selected/YES leg.
  if (
    isValidAsk(params.tradePrice) &&
    (params.venue === "polymarket" || outcomeSide !== "no")
  ) {
    yesAsk = params.tradePrice;
    yesSource = "trade_price";
  }
  if (
    params.venue === "kalshi" &&
    outcomeSide === "no" &&
    isValidAsk(params.tradePrice)
  ) {
    noAsk = params.tradePrice;
    noSource = "trade_price";
  }

  if (!isValidAsk(yesAsk)) {
    yesAsk = params.fairYes;
    yesSource = params.fairSource;
  }

  // Preserve a real selected-leg quote and proxy only the missing opposing leg.
  if (!isValidAsk(noAsk)) {
    noAsk = Math.round((1 - params.fairYes) * 10000) / 10000;
    noSource =
      params.fairSource === "trade_price" ? "complement" : params.fairSource;
  }

  if (!isValidAsk(yesAsk) || !isValidAsk(noAsk)) {
    yesAsk = 0.5;
    noAsk = 0.5;
    yesSource = "universal_prior";
    noSource = "universal_prior";
  }

  const isExecutable =
    yesSource === "order_book" && noSource === "order_book";

  return {
    yesAsk,
    noAsk,
    yesSource: yesSource ?? "universal_prior",
    noSource: noSource ?? "universal_prior",
    degraded: !isExecutable,
    isExecutable,
  };
}

export async function resolveVenueYesNoQuotes(params: {
  venue: "polymarket" | "kalshi";
  contractId: string;
  pmTokenId?: string | null;
  tradeOutcomeSide?: string | null;
  tradePrice?: number | null;
  pmMid?: number | null;
  title?: string | null;
  slug?: string | null;
}): Promise<ResolvedYesNoQuotes | null> {
  const contractId = params.contractId.trim();
  if (!contractId) return null;

  const tokenForPTrue =
    params.pmTokenId?.trim().toLowerCase() ??
    (params.venue === "polymarket" ? contractId.toLowerCase() : null);
  const obPromise =
    params.venue === "kalshi"
      ? fetchKalshiOrderBookMid(contractId)
      : fetchPmOrderBookMid(contractId);
  const ensemblePromise = tokenForPTrue
    ? resolveEnsemblePTrue(tokenForPTrue)
    : Promise.resolve(null);
  const baselinePromise =
    params.venue === "polymarket" &&
    tokenForPTrue &&
    (params.slug || params.title)
      ? lookupExchangeConsensusBaseline({
          tokenId: tokenForPTrue,
          slug: params.slug ?? undefined,
          title: params.title ?? undefined,
        })
      : Promise.resolve(null);
  const [ob, ensemblePTrue, baseline] = await Promise.all([
    obPromise,
    ensemblePromise,
    baselinePromise,
  ]);

  const fromOb = derivePartialYesNoAsksFromOrderBook(ob);

  const exchangeMid = baseline
    ? Math.round(((baseline.yesBid + baseline.yesAsk) / 2) * 10000) / 10000
    : null;
  const resolvedPTrue = resolvePTrueSync({
    mappingPairKey: null,
    platform: params.venue,
    pmOb: params.venue === "polymarket" ? ob : null,
    kalshiOb: params.venue === "kalshi" ? ob : null,
    pmMid: params.pmMid,
    exchangeMid,
    executionPrice: params.tradePrice,
    ensemblePTrue,
  });
  return completeYesNoQuoteCandidates({
    venue: params.venue,
    yesAsk: fromOb.yesAsk,
    noAsk: fromOb.noAsk,
    tradeOutcomeSide: params.tradeOutcomeSide,
    tradePrice: params.tradePrice,
    fairYes: resolvedPTrue.pTrue,
    fairSource: quoteSourceFromPTrueSource(resolvedPTrue.source),
  });
}

export async function resolveExchangeProxyQuotes(params: {
  pmTokenId: string;
  slug?: string | null;
  title?: string | null;
  tradeOutcomeSide?: string | null;
  tradePrice?: number | null;
  pmMid?: number | null;
}): Promise<{
  pmYes: ArbitrageDisplayLeg;
  exchangeNo: ArbitrageDisplayLeg;
  degraded: boolean;
} | null> {
  const tokenId = params.pmTokenId.trim().toLowerCase();
  if (!tokenId) return null;

  const [pmQuotes, baseline] = await Promise.all([
    resolveVenueYesNoQuotes({
      venue: "polymarket",
      contractId: tokenId,
      pmTokenId: tokenId,
      tradeOutcomeSide: params.tradeOutcomeSide,
      tradePrice: params.tradePrice,
      pmMid: params.pmMid,
      title: params.title,
      slug: params.slug,
    }),
    lookupExchangeConsensusBaseline({
      tokenId,
      slug: params.slug,
      title: params.title,
    }),
  ]);

  if (!pmQuotes) return null;

  let exchangeNoAsk: number | null = null;
  const exchangeSource: QuoteSource = "consensus";

  if (baseline) {
    exchangeNoAsk = exchangeBaselineToYesNoAsks(baseline).noAsk;
  }

  if (!isValidAsk(exchangeNoAsk)) {
    return null;
  }

  const degraded = true;

  return {
    pmYes: legFromQuote(
      "polymarket",
      "YES",
      tokenId,
      pmQuotes.yesAsk,
      pmQuotes.yesSource
    ),
    exchangeNo: legFromQuote(
      "exchange",
      "NO",
      baseline?.matchId ?? "consensus",
      exchangeNoAsk,
      exchangeSource
    ),
    degraded,
  };
}

export function singleVenueLegs(
  venue: "polymarket" | "kalshi",
  contractId: string,
  quotes: ResolvedYesNoQuotes
): [ArbitrageDisplayLeg, ArbitrageDisplayLeg] {
  return [
    legFromQuote(venue, "YES", contractId, quotes.yesAsk, quotes.yesSource),
    legFromQuote(venue, "NO", contractId, quotes.noAsk, quotes.noSource),
  ];
}
