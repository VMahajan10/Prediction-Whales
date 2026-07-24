import { desc, eq, ne } from "drizzle-orm";
import type { getDb } from "@/lib/crossmarket/store/db";
import {
  marketMappings,
  trueProbabilities,
} from "@/lib/crossmarket/store/schema";
import type { MatchedPair, PipelineTradeEv } from "@/lib/evPipeline/types";
import { resolvePTrue } from "@/lib/evPipeline/pTrueEnsembleResolver";
import type { PTrueResult } from "@/lib/evPipeline/pTrueTypes";
import {
  pipelineEvLookupKeyKalshi,
  pipelineEvLookupKeyPm,
} from "@/lib/evPipeline/types";
import {
  buildOkPipelineTradeEv,
} from "@/lib/evPipeline/tradeEvRecord";
import {
  buildPipelineTradeEvFromPricing,
  computePricingPTrue,
} from "@/lib/evPipeline/pricing";
import { pipelineMappingPairKey } from "@/lib/evPipeline/crossAssetLookup";
import {
  EvPipelineRedisWriteBatch,
  mappingRedisPairKey,
  prefetchMappingRedisBatch,
  type CachedOrderBookMid,
  type MappingRedisPrefetch,
} from "@/lib/evPipeline/redisCache";
import {
  createDerivativeAnchorStore,
  deriveDerivativePTrue,
  parseDerivativeFromMapping,
  sortMappingsForDerivativePricing,
  updateDerivativeAnchorFromPrimary,
} from "@/lib/evPipeline/derivativePTrue";
import { appendOddsHistory } from "@/lib/ai/rag/oddsHistoryStore";

type Db = ReturnType<typeof getDb>;

const TEST_FALLBACK_MATCH_METHOD = "TEST_FALLBACK_PAIR";

function fmtProb(n: number): string {
  return n.toFixed(6);
}

function resolvePlatformMarket(
  platformMid: number | null,
  crossMid: number | null,
  marketPrior: number
): number {
  if (platformMid != null && Number.isFinite(platformMid)) return platformMid;
  if (crossMid != null && Number.isFinite(crossMid)) return crossMid;
  return marketPrior;
}

function marketContextFromPrefetch(prefetch: MappingRedisPrefetch): {
  pmMid: number | null;
  kalshiMid: number | null;
  marketPrior: number;
} {
  const pmMid = prefetch.pmOb?.mid ?? null;
  const kalshiMid = prefetch.kalshiOb?.mid ?? null;
  const marketPrior =
    pmMid != null && kalshiMid != null
      ? (pmMid + kalshiMid) / 2
      : (pmMid ?? kalshiMid ?? 0.5);
  return { pmMid, kalshiMid, marketPrior };
}

function emptyMappingPrefetch(): MappingRedisPrefetch {
  return { pmOb: null, kalshiOb: null, pTrue: null };
}

async function resolveMappingEnsemblePTrue(params: {
  tokenId: string;
  kalshiTicker: string;
  title: string;
  pmMid: number | null;
  kalshiMid: number | null;
  marketPrior: number;
  pmOb: MappingRedisPrefetch["pmOb"];
  kalshiOb: MappingRedisPrefetch["kalshiOb"];
  computeEnsembleIfMissing?: boolean;
}): Promise<PTrueResult> {
  return resolvePTrue({
    mappingPairKey: pipelineMappingPairKey(params.tokenId, params.kalshiTicker),
    platform: "polymarket",
    tokenId: params.tokenId,
    kalshiTicker: params.kalshiTicker,
    title: params.title,
    pmOb: params.pmOb,
    kalshiOb: params.kalshiOb,
    pmMid: params.pmMid,
    kalshiMid: params.kalshiMid,
    marketPrior: params.marketPrior,
    fetchEnsemble: true,
    fetchExchangeConsensus: true,
    computeEnsembleIfMissing: params.computeEnsembleIfMissing ?? true,
  });
}

async function persistTradeEvLookups(
  pmKey: string,
  kalshiKey: string,
  pmRecord: PipelineTradeEv,
  kalshiRecord: PipelineTradeEv,
  redisBatch: EvPipelineRedisWriteBatch
): Promise<void> {
  redisBatch.queueTradeEvLookups(pmKey, kalshiKey, pmRecord, kalshiRecord);
}

async function loadMappingsForPTrue(
  db: Db,
  recentMatches: MatchedPair[],
  dbLimit = 2000
): Promise<
  Array<{
    id: number;
    polymarketTokenId: string;
    kalshiTicker: string;
    polymarketTitle: string;
    kalshiTitle: string;
  }>
> {
  const fromRun = recentMatches.filter(
    (m) => m.matchMethod !== TEST_FALLBACK_MATCH_METHOD
  );

  if (fromRun.length > 0) {
    const rows = await db
      .select({
        id: marketMappings.id,
        polymarketTokenId: marketMappings.polymarketTokenId,
        kalshiTicker: marketMappings.kalshiTicker,
      })
      .from(marketMappings)
      .where(ne(marketMappings.matchMethod, TEST_FALLBACK_MATCH_METHOD));

    const byPair = new Map(
      rows.map((r) => [
        `${r.polymarketTokenId.toLowerCase()}:${r.kalshiTicker.toUpperCase()}`,
        r,
      ])
    );

    return fromRun.map((m) => {
      const row = byPair.get(
        `${m.polymarketTokenId.toLowerCase()}:${m.kalshiTicker.toUpperCase()}`
      );
      return {
        id: row?.id ?? 0,
        polymarketTokenId: m.polymarketTokenId,
        kalshiTicker: m.kalshiTicker,
        polymarketTitle: m.polymarketTitle,
        kalshiTitle: m.kalshiTitle,
      };
    });
  }

  const rows = await db
    .select({
      id: marketMappings.id,
      polymarketTokenId: marketMappings.polymarketTokenId,
      kalshiTicker: marketMappings.kalshiTicker,
    })
    .from(marketMappings)
    .where(ne(marketMappings.matchMethod, TEST_FALLBACK_MATCH_METHOD))
    .orderBy(desc(marketMappings.updatedAt))
    .limit(dbLimit);

  return rows.map((r) => ({
    id: r.id,
    polymarketTokenId: r.polymarketTokenId,
    kalshiTicker: r.kalshiTicker,
    polymarketTitle: r.polymarketTokenId,
    kalshiTitle: r.kalshiTicker,
  }));
}

async function cacheLookupEvForMapping(
  tokenId: string,
  kalshiTicker: string,
  pmMid: number | null,
  kalshiMid: number | null,
  marketPrior: number,
  redisBatch: EvPipelineRedisWriteBatch,
  pmOb: MappingRedisPrefetch["pmOb"] = null,
  kalshiOb: MappingRedisPrefetch["kalshiOb"] = null,
  ensemblePTrue: number | null = null
): Promise<{
  pmRecord: PipelineTradeEv;
  kalshiRecord: PipelineTradeEv;
} | null> {
  const pmKey = pipelineEvLookupKeyPm(tokenId);
  const kalshiKey = pipelineEvLookupKeyKalshi(kalshiTicker);
  const mappingPairKey = pipelineMappingPairKey(tokenId, kalshiTicker);

  const pmRecord = buildPipelineTradeEvFromPricing({
    lookupKey: pmKey,
    platform: "polymarket",
    tokenId,
    kalshiTicker,
    mappingPairKey,
    pmOb,
    kalshiOb,
    pmMid,
    kalshiMid,
    ensemblePTrue,
    baselinePTrue: ensemblePTrue,
    marketPrior,
  });

  const kalshiRecord = buildPipelineTradeEvFromPricing({
    lookupKey: kalshiKey,
    platform: "kalshi",
    tokenId,
    kalshiTicker,
    mappingPairKey,
    pmOb,
    kalshiOb,
    pmMid,
    kalshiMid,
    ensemblePTrue,
    baselinePTrue: ensemblePTrue,
    marketPrior,
  });

  if (!pmRecord || !kalshiRecord) {
    const crossMid =
      pmMid != null && kalshiMid != null
        ? (pmMid + kalshiMid) / 2
        : (pmMid ?? kalshiMid ?? marketPrior);
    const pmMarket = resolvePlatformMarket(pmMid, kalshiMid, crossMid);
    const kalshiMarket = resolvePlatformMarket(kalshiMid, pmMid, crossMid);
    const pricingPTrue =
      computePricingPTrue({
        mappingPairKey,
        platform: "polymarket",
        pmOb,
        kalshiOb,
        pmMid,
        kalshiMid,
        ensemblePTrue,
      })?.pTrue ?? ensemblePTrue ?? crossMid;

    const fallbackPm = buildOkPipelineTradeEv({
      lookupKey: pmKey,
      platform: "polymarket",
      tokenId,
      kalshiTicker,
      pTrue: pricingPTrue,
      pMarket: pmMarket,
    });
    const fallbackKalshi = buildOkPipelineTradeEv({
      lookupKey: kalshiKey,
      platform: "kalshi",
      tokenId,
      kalshiTicker,
      pTrue: pricingPTrue,
      pMarket: kalshiMarket,
    });
    await persistTradeEvLookups(
      pmKey,
      kalshiKey,
      fallbackPm,
      fallbackKalshi,
      redisBatch
    );
    return { pmRecord: fallbackPm, kalshiRecord: fallbackKalshi };
  }

  await persistTradeEvLookups(
    pmKey,
    kalshiKey,
    pmRecord,
    kalshiRecord,
    redisBatch
  );

  return { pmRecord, kalshiRecord };
}

async function persistMappingPTrue(
  db: Db,
  mapping: {
    id: number;
    polymarketTokenId: string;
    kalshiTicker: string;
    polymarketTitle: string;
    kalshiTitle: string;
  },
  pTrue: number,
  opts: {
    pmMid: number | null;
    kalshiMid: number | null;
    marketPrior: number;
    pmOb?: MappingRedisPrefetch["pmOb"];
    kalshiOb?: MappingRedisPrefetch["kalshiOb"];
    sourceType: string;
    modelVersion: string;
    variance?: number;
    sourceScore?: number;
    logSuffix: string;
  },
  redisBatch: EvPipelineRedisWriteBatch
): Promise<PipelineTradeEv | null> {
  const tokenId = mapping.polymarketTokenId.toLowerCase();
  const kalshiTicker = mapping.kalshiTicker.toUpperCase();
  const variance = opts.variance ?? 0.05;
  const sourceScore = opts.sourceScore ?? 0.7;

  try {
    await db.insert(trueProbabilities).values({
      mappingId: mapping.id > 0 ? mapping.id : null,
      polymarketTokenId: tokenId,
      kalshiTicker,
      pTrue: fmtProb(pTrue),
      sourceScore: fmtProb(sourceScore),
      variance: fmtProb(variance),
      sourceType: opts.sourceType,
      modelVersion: opts.modelVersion,
      contributors: [
        {
          source: opts.sourceType,
          weight: 1,
          p: pTrue,
          variance,
        },
      ],
    });
  } catch (error) {
    console.error("[DB WRITE ERROR]", error);
    throw error;
  }

  redisBatch.queuePTrue(tokenId, {
    pTrue,
    variance,
    sourceScore,
    sourceType: opts.sourceType,
    kalshiTicker,
    calculatedAt: new Date().toISOString(),
  });

  await appendOddsHistory(tokenId, {
    ts: new Date().toISOString(),
    pmMid: opts.pmMid,
    kalshiMid: opts.kalshiMid,
    marketPrior: opts.marketPrior,
    pTrue,
  });

  const cachedLookups = await cacheLookupEvForMapping(
    tokenId,
    kalshiTicker,
    opts.pmMid,
    opts.kalshiMid,
    opts.marketPrior,
    redisBatch,
    opts.pmOb ?? null,
    opts.kalshiOb ?? null,
    pTrue
  );

  const pricingPreview = computePricingPTrue({
    mappingPairKey: pipelineMappingPairKey(tokenId, kalshiTicker),
    platform: "polymarket",
    pmOb: opts.pmOb,
    kalshiOb: opts.kalshiOb,
    pmMid: opts.pmMid,
    kalshiMid: opts.kalshiMid,
  });
  const displayPTrue = pricingPreview?.pTrue ?? pTrue;
  const crossArbPercent =
    pricingPreview?.pmMid != null && pricingPreview.kalshiMid != null
      ? Math.abs(pricingPreview.pmMid - pricingPreview.kalshiMid) * 100
      : 0;

  console.info(
    `[ev-pipeline] computePTrue ${tokenId} ↔ ${kalshiTicker}: ensemble_p_true=${pTrue.toFixed(4)} pricing_p_true=${displayPTrue.toFixed(4)} pm_mid=${opts.pmMid?.toFixed(4) ?? "—"} kalshi_mid=${opts.kalshiMid?.toFixed(4) ?? "—"} cross_arb=${crossArbPercent.toFixed(1)}% cached_lookups=${cachedLookups ? 2 : 0} ${opts.logSuffix}`
  );

  return cachedLookups?.pmRecord ?? null;
}

export interface MappedPairEvSnapshot {
  pTrue: number | null;
  grossEvPercent: number | null;
  netEvPercent: number | null;
  averageEv: number | null;
  pmMid: number | null;
  kalshiMid: number | null;
  computedAt: string;
}

export interface ComputeEvForMappedPairInput {
  id?: number;
  polymarketTokenId: string;
  kalshiTicker: string;
  polymarketTitle: string;
  kalshiTitle: string;
  pmMid: number | null;
  kalshiMid: number | null;
  pmOb?: CachedOrderBookMid | null;
  kalshiOb?: CachedOrderBookMid | null;
}

function snapshotFromPmRecord(
  pmRecord: PipelineTradeEv | null | undefined
): MappedPairEvSnapshot | null {
  if (!pmRecord || pmRecord.status !== "ok") return null;
  const netEvPercent = pmRecord.netEvPercent ?? null;
  const grossEvPercent = pmRecord.grossEvPercent ?? netEvPercent;
  return {
    pTrue: pmRecord.pTrue ?? null,
    grossEvPercent,
    netEvPercent,
    averageEv: netEvPercent,
    pmMid: pmRecord.pmMid ?? null,
    kalshiMid: pmRecord.kalshiMid ?? null,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Eager ensemble + pricing EV for a newly mapped pair.
 * Seeds trade EV lookups (local + Redis batch) and returns primary-market snapshot.
 */
export async function computeEvForMappedPair(
  db: Db,
  input: ComputeEvForMappedPairInput,
  redisBatch: EvPipelineRedisWriteBatch
): Promise<MappedPairEvSnapshot | null> {
  const tokenId = input.polymarketTokenId.toLowerCase();
  const kalshiTicker = input.kalshiTicker.toUpperCase();
  const pmMid = input.pmMid;
  const kalshiMid = input.kalshiMid;
  const marketPrior =
    pmMid != null && kalshiMid != null
      ? (pmMid + kalshiMid) / 2
      : (pmMid ?? kalshiMid ?? 0.5);

  const pmOb =
    input.pmOb ??
    (pmMid != null
      ? {
          bid: pmMid,
          ask: pmMid,
          mid: pmMid,
          ts: Date.now(),
        }
      : null);
  const kalshiOb =
    input.kalshiOb ??
    (kalshiMid != null
      ? {
          bid: kalshiMid,
          ask: kalshiMid,
          mid: kalshiMid,
          ts: Date.now(),
        }
      : null);

  const mapping = {
    id: input.id ?? 0,
    polymarketTokenId: tokenId,
    kalshiTicker,
    polymarketTitle: input.polymarketTitle,
    kalshiTitle: input.kalshiTitle,
  };

  const spec = parseDerivativeFromMapping({
    polymarketTitle: input.polymarketTitle,
    kalshiTitle: input.kalshiTitle,
    kalshiTicker,
  });

  if (spec && !spec.isPrimary) {
    const anchorStore = createDerivativeAnchorStore();
    const derived = deriveDerivativePTrue(spec, anchorStore, marketPrior);
    if (derived) {
      try {
        const pmRecord = await persistMappingPTrue(db, mapping, derived.pTrue, {
          pmMid,
          kalshiMid,
          marketPrior,
          pmOb,
          kalshiOb,
          sourceType: derived.method,
          modelVersion: "derivative_pricing_v2",
          logSuffix: `(mapping-time ${derived.marketClass})`,
        }, redisBatch);
        return snapshotFromPmRecord(pmRecord);
      } catch (deriveErr) {
        console.error(
          "[ev-pipeline] mapping-time derivative EV failed:",
          deriveErr instanceof Error ? deriveErr.message : deriveErr
        );
      }
    }
  }

  try {
    const pTrueResult = await resolveMappingEnsemblePTrue({
      tokenId,
      kalshiTicker,
      title: input.polymarketTitle || input.kalshiTitle,
      pmMid,
      kalshiMid,
      marketPrior,
      pmOb,
      kalshiOb,
    });

    const pmRecord = await persistMappingPTrue(db, mapping, pTrueResult.pTrue, {
      pmMid,
      kalshiMid,
      marketPrior,
      pmOb,
      kalshiOb,
      sourceType: pTrueResult.source,
      modelVersion: "pipeline_v2",
      sourceScore: pTrueResult.confidence,
      logSuffix: `(mapping-time ${pTrueResult.source})`,
    }, redisBatch);

    return snapshotFromPmRecord(pmRecord);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ev-pipeline] mapping-time ensemble EV failed:", message);

    try {
      const pmRecord = await seedBaselineEvForMapping(
        tokenId,
        kalshiTicker,
        pmMid,
        kalshiMid,
        marketPrior,
        redisBatch,
        pmOb,
        kalshiOb
      );
      return snapshotFromPmRecord(pmRecord);
    } catch (fallbackErr) {
      console.error(
        "[ev-pipeline] mapping-time baseline EV failed:",
        fallbackErr instanceof Error ? fallbackErr.message : fallbackErr
      );
    }
  }

  return null;
}

/** Pricing-engine baseline when ensemble is unavailable — cross/standalone resting mids. */
async function seedBaselineEvForMapping(
  tokenId: string,
  kalshiTicker: string,
  pmMid: number | null,
  kalshiMid: number | null,
  marketPrior: number,
  redisBatch: EvPipelineRedisWriteBatch,
  pmOb: MappingRedisPrefetch["pmOb"] = null,
  kalshiOb: MappingRedisPrefetch["kalshiOb"] = null,
  ensemblePTrue: number | null = null
): Promise<PipelineTradeEv | null> {
  const cached = await cacheLookupEvForMapping(
    tokenId,
    kalshiTicker,
    pmMid,
    kalshiMid,
    marketPrior,
    redisBatch,
    pmOb,
    kalshiOb,
    ensemblePTrue
  );

  const pricingPreview = computePricingPTrue({
    mappingPairKey: pipelineMappingPairKey(tokenId, kalshiTicker),
    platform: "polymarket",
    pmOb,
    kalshiOb,
    pmMid,
    kalshiMid,
  });

  console.info(
    `[ev-pipeline] computePTrue baseline fallback ${tokenId} ↔ ${kalshiTicker}: pricing_p_true=${pricingPreview?.pTrue.toFixed(4) ?? "—"} pm=${pmMid?.toFixed(4) ?? "—"} kalshi=${kalshiMid?.toFixed(4) ?? "—"}`
  );

  return cached?.pmRecord ?? null;
}

/**
 * Stage 3 — compute p_true + cache trade EV at pm:{tokenId} / kalshi:{ticker}.
 */
export async function processMappedPTrue(
  db: Db,
  recentMatches: MatchedPair[] = [],
  options?: { dbLimit?: number }
): Promise<number> {
  const mappings = await loadMappingsForPTrue(
    db,
    recentMatches,
    options?.dbLimit ?? 2000
  );
  if (mappings.length === 0) return 0;

  const anchorStore = createDerivativeAnchorStore();
  const ordered = sortMappingsForDerivativePricing(mappings);
  const redisPrefetch = await prefetchMappingRedisBatch(ordered, {
    includePTrue: false,
  });
  const redisBatch = new EvPipelineRedisWriteBatch();
  let processed = 0;

  for (const mapping of ordered) {
    const tokenId = mapping.polymarketTokenId.toLowerCase();
    const kalshiTicker = mapping.kalshiTicker.toUpperCase();
    const prefetch =
      redisPrefetch.get(mappingRedisPairKey(tokenId, kalshiTicker)) ??
      emptyMappingPrefetch();
    const { pmMid, kalshiMid, marketPrior } = marketContextFromPrefetch(prefetch);

    const spec = parseDerivativeFromMapping({
      polymarketTitle: mapping.polymarketTitle,
      kalshiTitle: mapping.kalshiTitle,
      kalshiTicker,
    });

    if (spec && !spec.isPrimary) {
      const derived = deriveDerivativePTrue(spec, anchorStore, marketPrior);
      if (derived) {
        try {
          await persistMappingPTrue(db, mapping, derived.pTrue, {
            pmMid,
            kalshiMid,
            marketPrior,
            pmOb: prefetch.pmOb,
            kalshiOb: prefetch.kalshiOb,
            sourceType: derived.method,
            modelVersion: "derivative_pricing_v2",
            logSuffix: `(${derived.marketClass} ${derived.detail})`,
          }, redisBatch);
          processed += 1;
          continue;
        } catch (deriveErr) {
          console.error(
            "[ev-pipeline] derivative persist failed:",
            deriveErr instanceof Error ? deriveErr.message : deriveErr
          );
        }
      }
    }

    try {
      const pTrueResult = await resolveMappingEnsemblePTrue({
        tokenId,
        kalshiTicker,
        title: mapping.polymarketTitle || mapping.kalshiTitle,
        pmMid,
        kalshiMid,
        marketPrior,
        pmOb: prefetch.pmOb,
        kalshiOb: prefetch.kalshiOb,
      });

      if (spec) {
        updateDerivativeAnchorFromPrimary(
          anchorStore,
          spec,
          pTrueResult.pTrue,
          marketPrior
        );
      }

      await persistMappingPTrue(db, mapping, pTrueResult.pTrue, {
        pmMid,
        kalshiMid,
        marketPrior,
        pmOb: prefetch.pmOb,
        kalshiOb: prefetch.kalshiOb,
        sourceType: pTrueResult.source,
        modelVersion: "pipeline_v2",
        sourceScore: pTrueResult.confidence,
        logSuffix: `(${pTrueResult.source})`,
      }, redisBatch);

      processed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Batch EV Fetch Error:", message);

      if (spec) {
        const derived = deriveDerivativePTrue(spec, anchorStore, marketPrior);
        if (derived) {
          try {
            await persistMappingPTrue(db, mapping, derived.pTrue, {
              pmMid,
              kalshiMid,
              marketPrior,
              pmOb: prefetch.pmOb,
              kalshiOb: prefetch.kalshiOb,
              sourceType: derived.method,
              modelVersion: "derivative_pricing_v2",
              logSuffix: `(fallback ${derived.marketClass} ${derived.detail})`,
            }, redisBatch);
            processed += 1;
            continue;
          } catch (deriveErr) {
            console.error(
              "[ev-pipeline] derivative fallback failed:",
              deriveErr instanceof Error ? deriveErr.message : deriveErr
            );
          }
        }
      }

      try {
        await seedBaselineEvForMapping(
          tokenId,
          kalshiTicker,
          pmMid,
          kalshiMid,
          marketPrior,
          redisBatch,
          prefetch.pmOb,
          prefetch.kalshiOb
        );
        processed += 1;
      } catch (fallbackErr) {
        console.error(
          "[ev-pipeline] baseline EV seed failed:",
          fallbackErr instanceof Error ? fallbackErr.message : fallbackErr
        );
      }
    }
  }

  try {
    await redisBatch.flush();
  } catch (flushErr) {
    console.warn(
      "[ev-pipeline] processMappedPTrue Redis flush failed:",
      flushErr instanceof Error ? flushErr.message : flushErr
    );
  }

  return processed;
}

/**
 * Safety pass — re-cache lookup EV using stored p_true when trader rollup is skipped.
 */
export async function ensureMappedTradeEvLookups(
  db: Db,
  recentMatches: MatchedPair[] = []
): Promise<number> {
  const mappings = await loadMappingsForPTrue(db, recentMatches);
  if (mappings.length === 0) return 0;

  const ordered = sortMappingsForDerivativePricing(mappings);
  const redisPrefetch = await prefetchMappingRedisBatch(ordered, {
    includePTrue: true,
  });
  const anchorStore = createDerivativeAnchorStore();
  const redisBatch = new EvPipelineRedisWriteBatch();
  let cached = 0;

  for (const mapping of ordered) {
    try {
      const tokenId = mapping.polymarketTokenId.toLowerCase();
      const kalshiTicker = mapping.kalshiTicker.toUpperCase();
      const prefetch =
        redisPrefetch.get(mappingRedisPairKey(tokenId, kalshiTicker)) ??
        emptyMappingPrefetch();
      const pTrue = prefetch.pTrue?.pTrue ?? null;

      if (pTrue != null && Number.isFinite(pTrue)) {
        const spec = parseDerivativeFromMapping({
          polymarketTitle: mapping.polymarketTitle,
          kalshiTitle: mapping.kalshiTitle,
          kalshiTicker,
        });
        if (spec) {
          const { marketPrior } = marketContextFromPrefetch(prefetch);
          updateDerivativeAnchorFromPrimary(anchorStore, spec, pTrue, marketPrior);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[ev-pipeline] ensureMappedTradeEvLookups anchor seed:", message);
    }
  }

  for (const mapping of ordered) {
    try {
      const tokenId = mapping.polymarketTokenId.toLowerCase();
      const kalshiTicker = mapping.kalshiTicker.toUpperCase();
      const prefetch =
        redisPrefetch.get(mappingRedisPairKey(tokenId, kalshiTicker)) ??
        emptyMappingPrefetch();
      const pTrue = prefetch.pTrue?.pTrue ?? null;
      const { pmMid, kalshiMid, marketPrior } = marketContextFromPrefetch(prefetch);

      if (pTrue == null || !Number.isFinite(pTrue)) {
        const spec = parseDerivativeFromMapping({
          polymarketTitle: mapping.polymarketTitle,
          kalshiTitle: mapping.kalshiTitle,
          kalshiTicker,
        });
        if (spec) {
          const derived = deriveDerivativePTrue(spec, anchorStore, marketPrior);
          if (derived) {
            const cachedPair = await cacheLookupEvForMapping(
              tokenId,
              kalshiTicker,
              pmMid,
              kalshiMid,
              marketPrior,
              redisBatch,
              prefetch.pmOb,
              prefetch.kalshiOb,
              derived.pTrue
            );
            if (cachedPair) cached += 1;
            continue;
          }
        }

        const baselineRecord = await seedBaselineEvForMapping(
          tokenId,
          kalshiTicker,
          pmMid,
          kalshiMid,
          marketPrior,
          redisBatch,
          prefetch.pmOb,
          prefetch.kalshiOb
        );
        if (baselineRecord) cached += 1;
        continue;
      }

      const cachedPair = await cacheLookupEvForMapping(
        tokenId,
        kalshiTicker,
        pmMid,
        kalshiMid,
        marketPrior,
        redisBatch,
        prefetch.pmOb,
        prefetch.kalshiOb,
        pTrue
      );

      if (cachedPair) cached += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[ev-pipeline] ensureMappedTradeEvLookups:", message);
    }
  }

  try {
    await redisBatch.flush();
  } catch (flushErr) {
    console.warn(
      "[ev-pipeline] ensureMappedTradeEvLookups Redis flush failed:",
      flushErr instanceof Error ? flushErr.message : flushErr
    );
  }

  return cached;
}

export interface BackfillPTrueOptions {
  dbLimit?: number;
  /** Flush lookup cache before recompute. */
  flushLookups?: boolean | "stale-only";
}

export interface BackfillPTrueResult {
  processed: number;
  flushed?: import("@/lib/evPipeline/redisCache").FlushEvLookupResult;
}

/**
 * Recompute p_true + trade EV lookups for DB mappings (Phase 5 backfill).
 */
export async function backfillMappedPTrue(
  db: Db,
  options: BackfillPTrueOptions = {}
): Promise<BackfillPTrueResult> {
  const dbLimit = options.dbLimit ?? 5000;
  let flushed: BackfillPTrueResult["flushed"];

  if (options.flushLookups) {
    const { flushEvLookupCache } = await import("@/lib/evPipeline/redisCache");
    flushed = await flushEvLookupCache({
      staleOnly: options.flushLookups === "stale-only",
    });
  }

  const processed = await processMappedPTrue(db, [], { dbLimit });
  return { processed, flushed };
}
