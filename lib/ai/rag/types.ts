/** Retrieved context chunk fed into calculatePTrue sentiment grading. */
export interface RAGContextChunk {
  id: string;
  kind: "odds_history" | "similar_market" | "order_book" | "sportsbook" | "mapping";
  title: string;
  body: string;
  /** Relevance weight in [0, 1] for prompt ordering. */
  relevance: number;
}

export interface OddsHistoryPoint {
  ts: string;
  pmMid: number | null;
  kalshiMid: number | null;
  marketPrior: number;
  pTrue: number | null;
}

export interface SimilarMarketProfile {
  tokenId: string;
  kalshiTicker: string | null;
  title: string;
  pTrue: number | null;
  pmMid: number | null;
  kalshiMid: number | null;
  sourceType: string | null;
}

export interface MarketRAGQuery {
  tokenId?: string | null;
  kalshiTicker?: string | null;
  title?: string | null;
  slug?: string | null;
  pmMid?: number | null;
  kalshiMid?: number | null;
  exchangeMid?: number | null;
  marketPrior?: number | null;
}

export interface MarketRAGBundle {
  chunks: RAGContextChunk[];
  contextText: string;
  contextIds: string[];
}
