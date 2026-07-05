/**
 * Executable YES/NO ask derivation from resting order-book mids.
 * Shared by the arbitrage finder — no EV / pTrue coupling.
 */

export interface YesNoAsks {
  yesAsk: number;
  noAsk: number;
}

export interface PartialYesNoAsks {
  yesAsk: number | null;
  noAsk: number | null;
}

export interface OrderBookQuoteSnapshot {
  bid: number | null;
  ask: number | null;
  mid: number;
  ts: number;
}

/**
 * Preserve independently available sides from a YES-token order book.
 * A missing bid means the opposing NO ask is unavailable, but must not erase
 * an otherwise executable YES ask.
 */
export function derivePartialYesNoAsksFromOrderBook(
  ob: OrderBookQuoteSnapshot | null | undefined
): PartialYesNoAsks {
  if (!ob) return { yesAsk: null, noAsk: null };

  const yesAsk =
    ob.ask != null &&
    Number.isFinite(ob.ask) &&
    ob.ask > 0 &&
    ob.ask < 1
      ? ob.ask
      : null;
  const yesBid =
    ob.bid != null &&
    Number.isFinite(ob.bid) &&
    ob.bid > 0 &&
    ob.bid < 1
      ? ob.bid
      : null;
  const derivedNoAsk = yesBid != null ? 1 - yesBid : null;
  const noAsk =
    derivedNoAsk != null &&
    Number.isFinite(derivedNoAsk) &&
    derivedNoAsk > 0 &&
    derivedNoAsk < 1
      ? derivedNoAsk
      : null;

  return { yesAsk, noAsk };
}

/**
 * Derive executable YES/NO ask prices from a YES-sided order-book snapshot.
 * NO ask is the complement of YES bid: cost to buy NO ≈ 1 − best YES bid.
 */
export function deriveYesNoAsksFromOrderBook(
  ob: OrderBookQuoteSnapshot | null | undefined
): YesNoAsks | null {
  if (!ob) return null;

  const { yesAsk, noAsk } = derivePartialYesNoAsksFromOrderBook(ob);
  const yesBid =
    ob.bid != null &&
    Number.isFinite(ob.bid) &&
    ob.bid > 0 &&
    ob.bid < 1
      ? ob.bid
      : null;

  if (yesAsk == null || yesBid == null || noAsk == null || yesBid >= yesAsk) {
    return null;
  }

  return { yesAsk, noAsk };
}
