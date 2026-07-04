import {
  calculatePTrue,
  type PTrueResult as EnginePTrueResult,
} from "@/lib/ai/probabilityEngine";
import { retrieveMarketContext } from "@/lib/ai/rag/marketContextRetriever";
import type { MarketRAGQuery } from "@/lib/ai/rag/types";

export interface ComputeRagPTrueInput extends MarketRAGQuery {
  marketPrior: number;
  marketDescription?: string;
  /** Extra free-form context appended after retrieved chunks. */
  supplementalContext?: string;
}

export interface ComputeRagPTrueResult {
  engine: EnginePTrueResult;
  contextIds: string[];
  contextText: string;
}

/**
 * Orchestrates RAG retrieval → LLM ensemble p_true.
 */
export async function computeRagPTrue(
  input: ComputeRagPTrueInput
): Promise<ComputeRagPTrueResult> {
  const bundle = await retrieveMarketContext(input);
  const supplemental = input.supplementalContext?.trim() ?? "";
  const marketContext = [bundle.contextText, supplemental]
    .filter(Boolean)
    .join("\n\n");

  const engine = await calculatePTrue({
    marketTitle: input.title?.trim() || input.slug?.trim() || "Unknown market",
    marketDescription: input.marketDescription,
    marketContext,
    marketPrior: input.marketPrior,
    ragChunks: bundle.chunks,
  });

  return {
    engine,
    contextIds: bundle.contextIds,
    contextText: marketContext,
  };
}
