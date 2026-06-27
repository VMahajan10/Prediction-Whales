import {
  computeCrossMarketEv,
  outcomeMatchId,
  parseKalshiGameTicker,
  parsePmMoneylineSlug,
  type CrossMarketEv,
  type OutcomeBooks,
} from "@/lib/crossMarketEv";
import { roundPrice } from "@/lib/crossMarketEvDisplay";

export interface TradeEvInput {
  source: "polymarket" | "kalshi";
  price: number;
  slug?: string;
  ticker?: string;
}

function lookupMatchId(trade: TradeEvInput): string | null {
  if (trade.source === "polymarket" && trade.slug) {
    const parsed = parsePmMoneylineSlug(trade.slug);
    if (parsed?.outcome) {
      return outcomeMatchId(parsed.game, parsed.outcome);
    }
  }

  if (trade.source === "kalshi" && trade.ticker) {
    const parsed = parseKalshiGameTicker(trade.ticker);
    if (parsed?.outcome) {
      return outcomeMatchId(parsed.game, parsed.outcome);
    }
  }

  return null;
}

/** Resolve cross-market EV for a specific trade using a pre-built book index. */
export function resolveCrossMarketEvForTrade(
  trade: TradeEvInput,
  index: Map<string, OutcomeBooks>
): CrossMarketEv {
  const pricePaid = roundPrice(trade.price);
  const matchId = lookupMatchId(trade);

  if (!matchId || pricePaid == null) {
    return {
      ev: null,
      fairProb: null,
      fairSource: null,
      pricePaid,
      reason: "no_match",
    };
  }

  const entry = index.get(matchId);
  if (!entry) {
    return {
      ev: null,
      fairProb: null,
      fairSource: null,
      pricePaid,
      reason: "no_match",
    };
  }

  return computeCrossMarketEv({
    tradeSource: trade.source,
    pricePaid,
    game: entry.game,
    outcome: entry.outcome,
    kalshiBook: entry.kalshi,
    polymarketBook: entry.polymarket,
    manifoldBook: entry.manifold,
    sportsbookBook: entry.sportsbook,
  });
}
