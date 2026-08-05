import type { EvPlatform } from "@/lib/evPipeline/types";

export type PricingMode =
  | "paired_cross"
  | "standalone_resting"
  | "exchange_consensus";

/** Which tier supplied the winning p_true estimate. */
export type PTrueSource =
  | "cross_venue_ob"
  | "standalone_ob"
  | "sportsbook_consensus"
  | "cached_ensemble"
  | "computed_ensemble"
  | "rag_ensemble"
  | "derivative_anchor"
  | "execution_price"
  | "universal_prior";

export type ConfidenceTier = "high" | "medium" | "low";

export interface PTrueContributor {
  source: PTrueSource | string;
  weight: number;
  p: number;
  confidence: number;
}

export interface PTrueResult {
  pTrue: number;
  source: PTrueSource;
  confidence: number;
  confidenceTier: ConfidenceTier;
  contributors: PTrueContributor[];
  pricingMode: PricingMode;
  pmMid: number | null;
  kalshiMid: number | null;
  exchangeMid: number | null;
  marketPrior: number;
  lowConfidence: boolean;
  /** RAG chunk ids used when source is rag_ensemble / computed_ensemble with RAG. */
  ragContextIds?: string[];
}

export interface PTrueResolveSyncInput {
  mappingPairKey: string | null;
  platform: EvPlatform;
  pmOb?: import("@/lib/evPipeline/redisCache").CachedOrderBookMid | null;
  kalshiOb?: import("@/lib/evPipeline/redisCache").CachedOrderBookMid | null;
  pmMid?: number | null;
  kalshiMid?: number | null;
  exchangeMid?: number | null;
  executionPrice?: number | null;
  ensemblePTrue?: number | null;
  baselinePTrue?: number | null;
  marketPrior?: number | null;
}

export interface PTrueResolveInput extends PTrueResolveSyncInput {
  tokenId?: string | null;
  kalshiTicker?: string | null;
  title?: string;
  slug?: string;
  fetchExchangeConsensus?: boolean;
  fetchEnsemble?: boolean;
  /** Cron-only: run LLM ensemble when cache is cold. */
  computeEnsembleIfMissing?: boolean;
  /** Trade-time: attempt RAG-backed ensemble when higher tiers are dry. */
  computeRagIfMissing?: boolean;
  /**
   * Hard cap on live OpenAI RAG ensemble (ms). Defaults to 2.5s on request paths.
   * Pass `null` to disable the cap (cron / pipeline warm).
   */
  ensembleLlmTimeoutMs?: number | null;
}

export const EV_FORMULA_VERSION = "binary_true_ev_v1" as const;

export function confidenceTierFromScore(score: number): ConfidenceTier {
  if (score >= 0.7) return "high";
  if (score >= 0.35) return "medium";
  return "low";
}
