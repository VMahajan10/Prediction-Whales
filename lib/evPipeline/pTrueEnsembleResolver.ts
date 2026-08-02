import { lookupExchangeConsensusBaseline } from "@/lib/evPipeline/exchangeConsensusArb";
import { resolveEnsemblePTrueWithLlmFallback } from "@/lib/evPipeline/ensemblePricingFallback";
import { resolveEnsemblePTrue } from "@/lib/evPipeline/ensemblePTrue";
import {
  liquidityWeightedCrossMid,
  resolveMarketPrior,
  restingMidFromOrderBook,
  type PricingMode,
} from "@/lib/evPipeline/pricing";
import type {
  ConfidenceTier,
  PTrueContributor,
  PTrueResolveInput,
  PTrueResolveSyncInput,
  PTrueResult,
  PTrueSource,
} from "@/lib/evPipeline/pTrueTypes";
import {
  confidenceTierFromScore,
} from "@/lib/evPipeline/pTrueTypes";
import { normalizeIncomingTradePrice } from "@/lib/evPipeline/tradeEvRecord";
import type { EvPlatform } from "@/lib/evPipeline/types";

export type { PTrueResolveInput, PTrueResolveSyncInput, PTrueResult };

const PROB_EPS = 1e-6;

function clampProb(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  if (p <= PROB_EPS) return PROB_EPS;
  if (p >= 1 - PROB_EPS) return 1 - PROB_EPS;
  return p;
}

function isFiniteProb(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

function resolveEnsembleInline(input: PTrueResolveSyncInput): number | null {
  if (isFiniteProb(input.ensemblePTrue)) return input.ensemblePTrue;
  if (isFiniteProb(input.baselinePTrue)) return input.baselinePTrue;
  return null;
}

function platformRestingMid(
  platform: EvPlatform,
  pmResting: number | null,
  kalshiResting: number | null
): number | null {
  return platform === "polymarket" ? pmResting : kalshiResting;
}

function contributor(
  source: PTrueSource,
  p: number,
  weight: number,
  confidence: number
): PTrueContributor {
  return { source, p: clampProb(p), weight, confidence };
}

function buildResult(params: {
  pTrue: number;
  source: PTrueSource;
  confidence: number;
  contributors: PTrueContributor[];
  pricingMode: PricingMode;
  pmMid: number | null;
  kalshiMid: number | null;
  exchangeMid: number | null;
  marketPrior: number;
}): PTrueResult {
  const confidenceTier: ConfidenceTier = confidenceTierFromScore(
    params.confidence
  );
  return {
    pTrue: clampProb(params.pTrue),
    source: params.source,
    confidence: params.confidence,
    confidenceTier,
    contributors: params.contributors,
    pricingMode: params.pricingMode,
    pmMid: params.pmMid,
    kalshiMid: params.kalshiMid,
    exchangeMid: params.exchangeMid,
    marketPrior: params.marketPrior,
    lowConfidence: params.confidence < 0.35,
  };
}

/**
 * Synchronous tier cascade — never returns null.
 * Tier 1: cross-venue / standalone OB
 * Tier 2: sportsbook consensus (exchangeMid)
 * Tier 3: cached/computed ensemble
 * Tier 4: execution price
 * Tier 5: universal prior (marketPrior, default 0.5)
 */
export function resolvePTrueSync(input: PTrueResolveSyncInput): PTrueResult {
  const pmResting =
    restingMidFromOrderBook(input.pmOb) ?? input.pmMid ?? null;
  const kalshiResting =
    restingMidFromOrderBook(input.kalshiOb) ?? input.kalshiMid ?? null;
  const ensemble = resolveEnsembleInline(input);
  const executionPrice =
    normalizeIncomingTradePrice(input.executionPrice) ?? null;
  const marketPrior = resolveMarketPrior(
    pmResting,
    kalshiResting,
    input.marketPrior
  );
  const contributors: PTrueContributor[] = [];

  if (input.mappingPairKey) {
    const crossMid = liquidityWeightedCrossMid(
      input.pmOb,
      input.kalshiOb,
      pmResting,
      kalshiResting
    );

    if (crossMid != null) {
      contributors.push(contributor("cross_venue_ob", crossMid, 1, 0.85));
      return buildResult({
        pTrue: ensemble ?? crossMid,
        source: ensemble != null ? "cached_ensemble" : "cross_venue_ob",
        confidence: ensemble != null ? 0.8 : 0.85,
        contributors,
        pricingMode: "paired_cross",
        pmMid: pmResting,
        kalshiMid: kalshiResting,
        exchangeMid: input.exchangeMid ?? null,
        marketPrior,
      });
    }

    if (ensemble != null) {
      contributors.push(contributor("cached_ensemble", ensemble, 1, 0.75));
      return buildResult({
        pTrue: ensemble,
        source: "cached_ensemble",
        confidence: 0.75,
        contributors,
        pricingMode: "paired_cross",
        pmMid: pmResting,
        kalshiMid: kalshiResting,
        exchangeMid: input.exchangeMid ?? null,
        marketPrior,
      });
    }

    if (isFiniteProb(input.exchangeMid)) {
      contributors.push(
        contributor("sportsbook_consensus", input.exchangeMid, 1, 0.7)
      );
      return buildResult({
        pTrue: input.exchangeMid,
        source: "sportsbook_consensus",
        confidence: 0.7,
        contributors,
        pricingMode: "exchange_consensus",
        pmMid: pmResting,
        kalshiMid: kalshiResting,
        exchangeMid: input.exchangeMid,
        marketPrior,
      });
    }
  }

  const standalone = platformRestingMid(
    input.platform,
    pmResting,
    kalshiResting
  );

  if (
    !input.mappingPairKey &&
    input.platform === "polymarket" &&
    isFiniteProb(input.exchangeMid)
  ) {
    const pTrue = ensemble ?? input.exchangeMid;
    contributors.push(
      contributor(
        ensemble != null ? "cached_ensemble" : "sportsbook_consensus",
        pTrue,
        1,
        ensemble != null ? 0.75 : 0.7
      )
    );
    return buildResult({
      pTrue,
      source: ensemble != null ? "cached_ensemble" : "sportsbook_consensus",
      confidence: ensemble != null ? 0.75 : 0.7,
      contributors,
      pricingMode: "exchange_consensus",
      pmMid: pmResting,
      kalshiMid: kalshiResting,
      exchangeMid: input.exchangeMid,
      marketPrior,
    });
  }

  if (standalone != null) {
    contributors.push(
      contributor("standalone_ob", standalone, 1, 0.8)
    );
    return buildResult({
      pTrue: ensemble ?? standalone,
      source: ensemble != null ? "cached_ensemble" : "standalone_ob",
      confidence: ensemble != null ? 0.75 : 0.8,
      contributors,
      pricingMode: "standalone_resting",
      pmMid: pmResting,
      kalshiMid: kalshiResting,
      exchangeMid: input.exchangeMid ?? null,
      marketPrior,
    });
  }

  if (ensemble != null) {
    contributors.push(contributor("cached_ensemble", ensemble, 1, 0.65));
    return buildResult({
      pTrue: ensemble,
      source: "cached_ensemble",
      confidence: 0.65,
      contributors,
      pricingMode: input.mappingPairKey ? "paired_cross" : "standalone_resting",
      pmMid: pmResting,
      kalshiMid: kalshiResting,
      exchangeMid: input.exchangeMid ?? null,
      marketPrior,
    });
  }

  if (isFiniteProb(input.exchangeMid)) {
    contributors.push(
      contributor("sportsbook_consensus", input.exchangeMid, 1, 0.6)
    );
    return buildResult({
      pTrue: input.exchangeMid,
      source: "sportsbook_consensus",
      confidence: 0.6,
      contributors,
      pricingMode: "exchange_consensus",
      pmMid: pmResting,
      kalshiMid: kalshiResting,
      exchangeMid: input.exchangeMid,
      marketPrior,
    });
  }

  if (executionPrice != null) {
    contributors.push(
      contributor("execution_price", executionPrice, 1, 0.25)
    );
    return buildResult({
      pTrue: executionPrice,
      source: "execution_price",
      confidence: 0.25,
      contributors,
      pricingMode: "standalone_resting",
      pmMid: pmResting,
      kalshiMid: kalshiResting,
      exchangeMid: input.exchangeMid ?? null,
      marketPrior,
    });
  }

  contributors.push(contributor("universal_prior", marketPrior, 1, 0.1));
  // No authoritative estimate — abstain from a synthetic 50/50 p_true anchor.
  // Downstream EV uses netEvPercent from ensemble tiers or flags low confidence.
  return buildResult({
    pTrue: executionPrice ?? marketPrior,
    source: executionPrice != null ? "execution_price" : "universal_prior",
    confidence: executionPrice != null ? 0.25 : 0.1,
    contributors,
    pricingMode: input.mappingPairKey ? "paired_cross" : "standalone_resting",
    pmMid: pmResting,
    kalshiMid: kalshiResting,
    exchangeMid: input.exchangeMid ?? null,
    marketPrior,
  });
}

/**
 * Async resolver — hydrates exchange consensus and ensemble cache before sync cascade.
 * Optionally runs LLM ensemble on cron paths when cache is cold.
 */
export async function resolvePTrue(
  input: PTrueResolveInput
): Promise<PTrueResult> {
  let exchangeMid = input.exchangeMid ?? null;
  let ensemblePTrue = input.ensemblePTrue ?? input.baselinePTrue ?? null;

  if (
    input.fetchExchangeConsensus &&
    exchangeMid == null &&
    input.tokenId &&
    input.platform === "polymarket"
  ) {
    try {
      const baseline = await lookupExchangeConsensusBaseline({
        tokenId: input.tokenId,
        slug: input.slug,
        title: input.title,
      });
      if (baseline) {
        exchangeMid =
          Math.round(((baseline.yesBid + baseline.yesAsk) / 2) * 10000) / 10000;
      }
    } catch {
      // Fall through to other tiers.
    }
  }

  if (input.fetchEnsemble && ensemblePTrue == null && input.tokenId) {
    ensemblePTrue = await resolveEnsemblePTrue(input.tokenId);
  }

  if (
    ensemblePTrue == null &&
    (input.title || input.tokenId || input.slug)
  ) {
    const consensusUnresolved =
      Boolean(input.fetchExchangeConsensus) &&
      input.platform === "polymarket" &&
      !isFiniteProb(exchangeMid);
    const needsRag =
      input.computeEnsembleIfMissing ||
      input.computeRagIfMissing ||
      consensusUnresolved;

    if (needsRag) {
      try {
        const computed = await resolveEnsemblePTrueWithLlmFallback(
          {
            tokenId: input.tokenId,
            kalshiTicker: input.kalshiTicker,
            title: input.title || input.tokenId || "Unknown market",
            slug: input.slug,
            pmMid: input.pmMid ?? null,
            kalshiMid: input.kalshiMid ?? null,
            exchangeMid,
          },
          { logPrefix: "[pTrueEnsembleResolver]" }
        );
        if (computed) {
          ensemblePTrue = computed.pTrue;
          const source = computed.source;
          const syncResult = resolvePTrueSync({
            ...input,
            exchangeMid,
            ensemblePTrue,
            baselinePTrue: ensemblePTrue,
          });
          return {
            ...syncResult,
            source,
            confidence: Math.max(
              syncResult.confidence,
              computed.sourceScore
            ),
            ragContextIds: computed.contextIds,
            contributors: [
              contributor(
                source,
                computed.pTrue,
                1,
                computed.sourceScore
              ),
              ...syncResult.contributors,
            ],
          };
        }
      } catch {
        // Fall through to sync resolver without ensemble.
      }
    }
  }

  return resolvePTrueSync({
    ...input,
    exchangeMid,
    ensemblePTrue,
    baselinePTrue: ensemblePTrue ?? input.baselinePTrue,
  });
}

/** Whether the asset has enough identity to resolve p_true (never unmapped). */
export function canResolvePTrueAsset(input: {
  tokenId?: string | null;
  kalshiTicker?: string | null;
}): boolean {
  return Boolean(
    input.tokenId?.trim() || input.kalshiTicker?.trim()
  );
}
