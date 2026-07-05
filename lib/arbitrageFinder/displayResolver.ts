import { normalizeKalshiTicker, normalizePmTokenId } from "@/lib/evPipeline/crossAssetLookup";
import { attachStakeToBestWindow } from "@/lib/arbitrageFinder/stakeOptimizer";
import {
  getArbitrageWindowsForPair,
  parseStakeUsd,
} from "@/lib/arbitrageFinder/windowService";
import type {
  ArbitrageDisplayLeg,
  ArbitrageDisplaySnapshot,
  ArbDisplayMode,
  ResolveArbitrageDisplayInput,
} from "@/lib/arbitrageFinder/displayTypes";
import { hasSub100ArbitrageEdge } from "@/lib/arbitrageFinder/displayTypes";
import {
  resolveExchangeProxyQuotes,
  resolveVenueYesNoQuotes,
  singleVenueLegs,
} from "@/lib/arbitrageFinder/quoteFallbackLadder";
import type { ArbitrageWindow } from "@/lib/arbitrageFinder/types";
import {
  evaluateBinaryBoxArbitrage,
  type ArbMathResult,
} from "@/lib/finance/arbitrageEngine";

function pickBestWindowForDisplay(
  windows: ArbitrageWindow[]
): ArbitrageWindow | null {
  if (windows.length === 0) return null;
  const actionable = windows.filter((w) => w.isActionable);
  if (actionable.length > 0) {
    return actionable.sort((a, b) => b.roiPercent - a.roiPercent)[0] ?? null;
  }
  return [...windows].sort(
    (a, b) => a.impliedSumPercent - b.impliedSumPercent
  )[0] ?? null;
}

function windowToDisplaySnapshot(
  window: ArbitrageWindow
): ArbitrageDisplaySnapshot {
  const legs: [ArbitrageDisplayLeg, ArbitrageDisplayLeg] = [
    {
      venue: window.legs[0].venue,
      side: window.legs[0].side,
      contractId: window.legs[0].contractId,
      askPrice: window.legs[0].askPrice,
      source: "order_book",
    },
    {
      venue: window.legs[1].venue,
      side: window.legs[1].side,
      contractId: window.legs[1].contractId,
      askPrice: window.legs[1].askPrice,
      source: "order_book",
    },
  ];

  return {
    mode: "cross_venue_lock",
    label: "Cross-Venue Lock",
    impliedSumPercent: window.impliedSumPercent,
    inverseOddsSumPercent: window.inverseOddsSumPercent,
    roiPercent: window.roiPercent,
    isActionable: window.isActionable,
    hasSub100Edge: hasSub100ArbitrageEdge(window.impliedSumPercent),
    isExecutable: true,
    combinedCost: window.combinedCost,
    degraded: false,
    legs,
    scannedAt: window.scannedAt,
    crossVenueWindow: window,
    stakePlan: window.stakePlan,
  };
}

function buildDisplaySnapshot(params: {
  mode: ArbDisplayMode;
  label: string;
  legs: [ArbitrageDisplayLeg, ArbitrageDisplayLeg];
  math: ArbMathResult;
  degraded: boolean;
  isExecutable: boolean;
  crossVenueWindow?: ArbitrageWindow | null;
}): ArbitrageDisplaySnapshot {
  const hasSub100Edge = hasSub100ArbitrageEdge(
    params.math.impliedSumPercent
  );
  return {
    mode: params.mode,
    label: params.label,
    impliedSumPercent: params.math.impliedSumPercent,
    inverseOddsSumPercent: params.math.inverseOddsSumPercent,
    roiPercent: params.math.roiPercent,
    isActionable:
      params.math.isActionable && params.isExecutable && hasSub100Edge,
    hasSub100Edge,
    isExecutable: params.isExecutable,
    combinedCost: params.math.combinedCost,
    degraded: params.degraded,
    legs: params.legs,
    scannedAt: new Date().toISOString(),
    crossVenueWindow: params.crossVenueWindow ?? null,
  };
}

function inferNativeVenue(
  input: ResolveArbitrageDisplayInput
): "polymarket" | "kalshi" | null {
  if (input.source === "kalshi") return "kalshi";
  if (input.source === "polymarket") return "polymarket";
  if (input.kalshiTicker && !input.pmTokenId) return "kalshi";
  if (input.pmTokenId && !input.kalshiTicker) return "polymarket";
  if (input.kalshiTicker) return "kalshi";
  if (input.pmTokenId) return "polymarket";
  return null;
}

async function resolveSingleVenueDisplay(
  input: ResolveArbitrageDisplayInput
): Promise<ArbitrageDisplaySnapshot | null> {
  const nativeVenue = inferNativeVenue(input);
  const pmTokenId = normalizePmTokenId(input.pmTokenId ?? null);
  const kalshiTicker = normalizeKalshiTicker(input.kalshiTicker ?? null);

  const attempts: Array<{
    venue: "polymarket" | "kalshi";
    contractId: string;
  }> = [];

  if (nativeVenue === "kalshi" && kalshiTicker) {
    attempts.push({ venue: "kalshi", contractId: kalshiTicker });
  } else if (nativeVenue === "polymarket" && pmTokenId) {
    attempts.push({ venue: "polymarket", contractId: pmTokenId });
  }

  if (kalshiTicker && nativeVenue !== "kalshi") {
    attempts.push({ venue: "kalshi", contractId: kalshiTicker });
  }
  if (pmTokenId && nativeVenue !== "polymarket") {
    attempts.push({ venue: "polymarket", contractId: pmTokenId });
  }

  for (const attempt of attempts) {
    const quotes = await resolveVenueYesNoQuotes({
      venue: attempt.venue,
      contractId: attempt.contractId,
      pmTokenId,
      tradeOutcomeSide: input.tradeOutcomeSide,
      tradePrice: input.tradePrice,
      pmMid: input.pmMid,
      title: input.title,
      slug: input.slug,
    });
    if (!quotes) continue;

    const math = evaluateBinaryBoxArbitrage(
      { askPrice: quotes.yesAsk },
      { askPrice: quotes.noAsk }
    );
    if (math.rejectReason === "invalid_price") continue;

    return buildDisplaySnapshot({
      mode: "single_venue_box",
      label: "Arbitrage Sum",
      legs: singleVenueLegs(attempt.venue, attempt.contractId, quotes),
      math,
      degraded: quotes.degraded,
      isExecutable: quotes.isExecutable,
    });
  }

  return null;
}

async function resolveExchangeProxyDisplay(
  input: ResolveArbitrageDisplayInput
): Promise<ArbitrageDisplaySnapshot | null> {
  const pmTokenId = normalizePmTokenId(input.pmTokenId ?? null);
  if (!pmTokenId) return null;

  const proxy = await resolveExchangeProxyQuotes({
    pmTokenId,
    slug: input.slug,
    title: input.title,
    tradeOutcomeSide: input.tradeOutcomeSide,
    tradePrice: input.tradePrice,
    pmMid: input.pmMid,
  });
  if (!proxy) return null;

  const math = evaluateBinaryBoxArbitrage(
    { askPrice: proxy.pmYes.askPrice },
    { askPrice: proxy.exchangeNo.askPrice }
  );
  if (math.rejectReason === "invalid_price") return null;

  return buildDisplaySnapshot({
    mode: "exchange_proxy_box",
    label: proxy.degraded ? "Arbitrage Est." : "Exchange Proxy",
    legs: [proxy.pmYes, proxy.exchangeNo],
    math,
    degraded: proxy.degraded,
    isExecutable: false,
  });
}

export async function resolveArbitrageDisplay(
  input: ResolveArbitrageDisplayInput
): Promise<ArbitrageDisplaySnapshot | null> {
  const pmTokenId = normalizePmTokenId(input.pmTokenId ?? null);
  const kalshiTicker = normalizeKalshiTicker(input.kalshiTicker ?? null);
  if (!pmTokenId && !kalshiTicker) return null;

  const stakeUsd = parseStakeUsd(input.stakeUsd);
  const prefer = input.prefer ?? "auto";

  if (prefer !== "single_venue") {
    const pair = await getArbitrageWindowsForPair(
      { pmTokenId, kalshiTicker },
      { stakeUsd, bestOnly: false }
    );
    const best = pickBestWindowForDisplay(pair.windows);
    if (best) {
      let window = best;
      if (stakeUsd != null && window.isActionable) {
        const withStake = attachStakeToBestWindow([window], {
          totalStakeUsd: stakeUsd,
        });
        window = withStake ?? window;
      }
      return windowToDisplaySnapshot(window);
    }
  }

  const single = await resolveSingleVenueDisplay({
    ...input,
    pmTokenId,
    kalshiTicker,
  });
  if (single) return single;

  if (prefer !== "single_venue" && pmTokenId && (input.slug || input.title)) {
    const exchange = await resolveExchangeProxyDisplay({
      ...input,
      pmTokenId,
    });
    if (exchange) return exchange;
  }

  return null;
}
