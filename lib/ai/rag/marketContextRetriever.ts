import { getOddsHistory } from "@/lib/ai/rag/oddsHistoryStore";
import { findSimilarMarkets } from "@/lib/ai/rag/similarMarketIndex";
import type {
  MarketRAGBundle,
  MarketRAGQuery,
  RAGContextChunk,
} from "@/lib/ai/rag/types";

function fmtProb(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function buildOddsHistoryChunk(
  tokenId: string,
  points: Awaited<ReturnType<typeof getOddsHistory>>
): RAGContextChunk | null {
  if (points.length === 0) return null;

  const lines = points.map((p) => {
    const drift =
      p.pTrue != null && points[0].pTrue != null
        ? p.pTrue - points[0].pTrue
        : null;
    const driftLabel =
      drift != null ? ` (Δp_true ${drift >= 0 ? "+" : ""}${(drift * 100).toFixed(1)}pp)` : "";
    return `- ${p.ts}: prior=${fmtProb(p.marketPrior)} pm=${fmtProb(p.pmMid)} kalshi=${fmtProb(p.kalshiMid)} p_true=${fmtProb(p.pTrue)}${driftLabel}`;
  });

  return {
    id: `odds:${tokenId}`,
    kind: "odds_history",
    title: "Implied probability history",
    body: lines.join("\n"),
    relevance: 0.85,
  };
}

function buildSimilarMarketChunks(
  title: string,
  excludeTokenId?: string | null
): RAGContextChunk[] {
  const similar = findSimilarMarkets(title, excludeTokenId, 3);
  return similar.map((market, idx) => ({
    id: `similar:${market.tokenId}`,
    kind: "similar_market",
    title: `Similar market ${idx + 1}`,
    body: [
      `Title: ${market.title}`,
      `p_true estimate: ${fmtProb(market.pTrue)}`,
      market.kalshiTicker ? `Kalshi: ${market.kalshiTicker}` : null,
      market.sourceType ? `Source: ${market.sourceType}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    relevance: 0.7 - idx * 0.08,
  }));
}

function buildOrderBookChunk(query: MarketRAGQuery): RAGContextChunk | null {
  const { pmMid, kalshiMid, exchangeMid } = query;
  if (
    pmMid == null &&
    kalshiMid == null &&
    exchangeMid == null
  ) {
    return null;
  }

  return {
    id: "ob:snapshot",
    kind: "order_book",
    title: "Current order-book mids",
    body: [
      pmMid != null ? `Polymarket mid: ${fmtProb(pmMid)}` : null,
      kalshiMid != null ? `Kalshi mid: ${fmtProb(kalshiMid)}` : null,
      exchangeMid != null
        ? `Sportsbook / exchange consensus mid: ${fmtProb(exchangeMid)}`
        : null,
    ]
      .filter(Boolean)
      .join("\n"),
    relevance: 0.75,
  };
}

function buildSportsbookChunk(
  exchangeMid: number | null | undefined
): RAGContextChunk | null {
  if (exchangeMid == null || !Number.isFinite(exchangeMid)) return null;
  return {
    id: "sportsbook:consensus",
    kind: "sportsbook",
    title: "Sportsbook consensus",
    body: `Cross-exchange sportsbook implied YES probability: ${fmtProb(exchangeMid)}. Treat as independent anchor vs prediction-market prices.`,
    relevance: 0.8,
  };
}

export function formatRagChunksForPrompt(chunks: RAGContextChunk[]): string {
  if (chunks.length === 0) return "";

  const sorted = [...chunks].sort((a, b) => b.relevance - a.relevance);
  const sections = sorted.map(
    (chunk) => `### ${chunk.title} [${chunk.kind}]\n${chunk.body}`
  );

  return [
    "Retrieved market context (use for directional grading only — do not copy probabilities verbatim):",
    sections.join("\n\n"),
  ].join("\n\n");
}

/**
 * Hybrid retrieval: odds history + similar mapped markets + live OB / sportsbook snapshot.
 */
export async function retrieveMarketContext(
  query: MarketRAGQuery
): Promise<MarketRAGBundle> {
  const chunks: RAGContextChunk[] = [];
  const title =
    query.title?.trim() ||
    query.slug?.trim() ||
    query.tokenId?.trim() ||
    "Unknown market";

  if (query.tokenId) {
    const history = await getOddsHistory(query.tokenId);
    const historyChunk = buildOddsHistoryChunk(query.tokenId, history);
    if (historyChunk) chunks.push(historyChunk);
  }

  const obChunk = buildOrderBookChunk(query);
  if (obChunk) chunks.push(obChunk);

  const sportsChunk = buildSportsbookChunk(query.exchangeMid);
  if (sportsChunk) chunks.push(sportsChunk);

  if (title.length > 3) {
    chunks.push(...buildSimilarMarketChunks(title, query.tokenId));
  }

  if (query.marketPrior != null && Number.isFinite(query.marketPrior)) {
    chunks.push({
      id: "mapping:prior",
      kind: "mapping",
      title: "Market prior",
      body: `Blended market-implied prior for this event: ${fmtProb(query.marketPrior)}.`,
      relevance: 0.55,
    });
  }

  const contextText = formatRagChunksForPrompt(chunks);
  return {
    chunks,
    contextText,
    contextIds: chunks.map((c) => c.id),
  };
}
