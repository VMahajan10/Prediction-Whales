export type {
  MarketRAGBundle,
  MarketRAGQuery,
  OddsHistoryPoint,
  RAGContextChunk,
  SimilarMarketProfile,
} from "@/lib/ai/rag/types";

export {
  appendOddsHistory,
  clearOddsHistoryMemory,
  getOddsHistory,
} from "@/lib/ai/rag/oddsHistoryStore";

export {
  clearSimilarMarketCandidates,
  findSimilarMarkets,
  getSimilarMarketCandidates,
  loadSimilarMarketCandidatesFromDb,
  setSimilarMarketCandidates,
} from "@/lib/ai/rag/similarMarketIndex";

export {
  formatRagChunksForPrompt,
  retrieveMarketContext,
} from "@/lib/ai/rag/marketContextRetriever";

export {
  computeRagPTrue,
  type ComputeRagPTrueInput,
  type ComputeRagPTrueResult,
} from "@/lib/ai/rag/ragPTrueProvider";

export {
  ingestRagContext,
  type IngestRagContextResult,
} from "@/lib/ai/rag/ingestRagContext";
