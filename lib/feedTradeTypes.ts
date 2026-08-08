/** Client-safe feed trade shape — shared by UI hooks and API responses. */

export interface FeedTrade {
  id: string;
  source: "polymarket" | "kalshi";
  title: string;
  outcome: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  usdNotional: number;
  timestamp: number;
  traceable: boolean;
  transactionHash?: string;
  ticker?: string;
  slug?: string;
  /** Kalshi contract selection (player, line, prop) — not Yes/No side. */
  selectionLabel?: string;
  /** Polymarket CLOB token id (YES leg) for pipeline EV lookup. */
  assetId?: string;
  isBlockTrade?: boolean;
  /** Trade-level EV % (+3.0 = +3%) when known at ingest or from DB. */
  netEvPercent?: number | null;
  /** Normalized feed category (SPORTS, POLITICS, CULTURE, OTHER). */
  category?: string;
}
