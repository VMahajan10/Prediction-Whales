/**
 * Shared normalized contract shape for cross-platform EV mapping.
 */

export type EvPlatform = "polymarket" | "kalshi";

export interface NormalizedMarketContract {
  platform: EvPlatform;
  /** Polymarket condition id or Kalshi market ticker. */
  externalId: string;
  /** Polymarket CLOB token id (YES leg) or Kalshi ticker. */
  tokenOrTicker: string;
  title: string;
  description: string;
  expiration: string | null;
  yesBid: number | null;
  yesAsk: number | null;
  /** Absolute bid-ask width in probability units (0–1). */
  spread: number | null;
  impliedProbability: number | null;
  /** Text sent to the embedding model. */
  embeddingText: string;
  /** Polymarket market slug (fifwc-rsa-can-…). */
  slug?: string | null;
  /** Parent event slug when available. */
  eventSlug?: string | null;
}

export interface MappingFailure {
  stage: "fetch_polymarket" | "fetch_kalshi" | "embed" | "match" | "persist";
  message: string;
  polymarketTokenId?: string;
  kalshiTicker?: string;
}

export interface MatchedPair {
  polymarketTokenId: string;
  polymarketConditionId: string;
  kalshiTicker: string;
  /** Adjusted similarity after token boosting (0–1). */
  similarity: number;
  /** Raw embedding cosine similarity before boosting. */
  rawSimilarity?: number;
  polymarketTitle: string;
  kalshiTitle: string;
  /** vector | token_boost | token_heuristic | sports_structure | TEST_FALLBACK_PAIR */
  matchMethod?: string;
  /** Pre-computed ensemble p_true (primary PM market). */
  pTrue?: number | null;
  /** Resting-mid average EV % on the primary PM market (pre-computed at mapping). */
  averageEv?: number | null;
  grossEvPercent?: number | null;
  netEvPercent?: number | null;
}

export interface MapMarketsResult {
  ok: boolean;
  polymarketCount: number;
  kalshiCount: number;
  embeddedCount: number;
  matchedCount: number;
  persistedCount: number;
  threshold: number;
  failures: MappingFailure[];
  matches: MatchedPair[];
  durationMs: number;
}

export const DEFAULT_SIMILARITY_THRESHOLD = 0.75;
/** Secondary pass when the primary threshold yields zero pairs. */
export const FALLBACK_SIMILARITY_THRESHOLD = 0.62;
/** Tertiary pass — token evidence preferred but not required. */
export const MINIMUM_SIMILARITY_THRESHOLD = 0.55;
/** Broad pass — capture long-tail cross-platform pairs for whale feed coverage. */
export const BROAD_SIMILARITY_THRESHOLD = 0.52;
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

/** Pipeline-resolved trade EV (client-safe shape). */
export interface PipelineTradeEvInput {
  source: "polymarket" | "kalshi";
  tokenId?: string;
  kalshiTicker?: string;
  tradePrice?: number;
  /** Market question/title for OpenAI ensemble fallback when consensus mapping fails. */
  title?: string;
  /** Polymarket slug for sportsbook / RAG context. */
  slug?: string;
  /** Kalshi contract side — YES mids are converted to NO space when `no`. */
  kalshiOutcomeSide?: "yes" | "no";
}

export type PipelineTradeEvStatus = "ok" | "unmapped" | "error" | "timeout";

/** Provenance for the winning p_true tier (see pTrueEnsembleResolver). */
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

export interface PipelineTradeEv {
  key: string;
  status: PipelineTradeEvStatus;
  tokenId: string | null;
  kalshiTicker: string | null;
  /** Cross-venue pair key: pair:{pmToken}:{kalshiTicker} */
  mappingPairKey?: string | null;
  netEvPercent: number | null;
  netEv: number;
  grossEv?: number;
  grossEvPercent?: number | null;
  /** Resting-mid / cross-venue average EV % (alias for netEvPercent at mapping time). */
  averageEv?: number | null;
  pTrue?: number | null;
  pMarket?: number | null;
  /** Cached PM resting mid used by pricing engine. */
  pmMid?: number | null;
  /** Cached Kalshi resting mid used by pricing engine. */
  kalshiMid?: number | null;
  /** Which tier supplied pTrue (ok status). */
  pTrueSource?: PTrueSource | null;
  /** 0–1 confidence score for pTrue estimate. */
  pTrueConfidence?: number | null;
  /** True when estimate used universal_prior or execution_price only. */
  pTrueLowConfidence?: boolean;
  /** EV formula version used for netEvPercent. */
  evFormulaVersion?: string | null;
}

/** Shared frontend/API lookup keys for batch trade EV. */
export function pipelineEvLookupKeyPm(tokenId: string): string {
  return `pm:${tokenId.trim().toLowerCase()}`;
}

export function pipelineEvLookupKeyKalshi(kalshiTicker: string): string {
  return `kalshi:${kalshiTicker.trim().toUpperCase()}`;
}

/**
 * Bulletproof lookup key — normalizes prefix, casing, and bare token/ticker IDs.
 */
export function normalizePipelineLookupKey(
  rawKey: string,
  source?: EvPlatform
): string {
  let searchKey = rawKey.trim();
  if (!searchKey) return searchKey;

  const lower = searchKey.toLowerCase();
  if (lower.startsWith("pm:")) {
    return pipelineEvLookupKeyPm(searchKey.slice(3));
  }
  if (lower.startsWith("kalshi:")) {
    return pipelineEvLookupKeyKalshi(searchKey.slice(7));
  }

  if (source === "polymarket") {
    return pipelineEvLookupKeyPm(searchKey);
  }
  if (source === "kalshi") {
    return pipelineEvLookupKeyKalshi(searchKey);
  }

  if (/^\d+$/.test(searchKey) || searchKey.length > 30) {
    return pipelineEvLookupKeyPm(searchKey);
  }
  if (/^KX[A-Z0-9-]+$/i.test(searchKey)) {
    return pipelineEvLookupKeyKalshi(searchKey);
  }

  return pipelineEvLookupKeyKalshi(searchKey);
}

export function pipelineEvLookupKey(input: PipelineTradeEvInput): string | null {
  if (input.source === "polymarket" && input.tokenId?.trim()) {
    return pipelineEvLookupKeyPm(input.tokenId);
  }
  if (input.source === "kalshi" && input.kalshiTicker?.trim()) {
    return pipelineEvLookupKeyKalshi(input.kalshiTicker);
  }
  return null;
}

export function isResolvedPipelineTradeEv(
  ev: PipelineTradeEv | null | undefined
): ev is PipelineTradeEv & {
  status: "ok";
  netEvPercent: number;
  pTrue: number;
} {
  const evPercent =
    ev?.netEvPercent ?? ev?.grossEvPercent ?? ev?.averageEv ?? null;
  return (
    ev != null &&
    ev.status === "ok" &&
    evPercent !== null &&
    evPercent !== undefined &&
    Number.isFinite(evPercent) &&
    ev.pTrue != null &&
    Number.isFinite(ev.pTrue)
  );
}
