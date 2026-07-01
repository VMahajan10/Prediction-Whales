import { desc, eq, ne } from "drizzle-orm";
import type { getDb } from "@/lib/crossmarket/store/db";
import {
  marketMappings,
  trueProbabilities,
} from "@/lib/crossmarket/store/schema";
import { calculatePTrue } from "@/lib/ai/probabilityEngine";
import type { MatchedPair } from "@/lib/evPipeline/types";
import {
  pipelineEvLookupKeyKalshi,
  pipelineEvLookupKeyPm,
} from "@/lib/evPipeline/types";
import {
  buildOkPipelineTradeEv,
} from "@/lib/evPipeline/tradeEvRecord";
import {
  EvPipelineRedisWriteBatch,
  mappingRedisPairKey,
  prefetchMappingRedisBatch,
  type MappingRedisPrefetch,
} from "@/lib/evPipeline/redisCache";
import {
  createDerivativeAnchorStore,
  deriveDerivativePTrue,
  parseDerivativeFromMapping,
  sortMappingsForDerivativePricing,
  updateDerivativeAnchorFromPrimary,
} from "@/lib/evPipeline/derivativePTrue";

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

async function persistTradeEvLookups(
  pmKey: string,
  kalshiKey: string,
  pmRecord: ReturnType<typeof buildOkPipelineTradeEv>,
  kalshiRecord: ReturnType<typeof buildOkPipelineTradeEv>,
  redisBatch: EvPipelineRedisWriteBatch
): Promise<void> {
  redisBatch.queueTradeEvLookups(pmKey, kalshiKey, pmRecord, kalshiRecord);
}

async function loadMappingsForPTrue(
  db: Db,
  recentMatches: MatchedPair[]
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
    .limit(2000);

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
  pTrue: number,
  pmMid: number | null,
  kalshiMid: number | null,
  marketPrior: number,
  redisBatch: EvPipelineRedisWriteBatch
): Promise<number> {
  if (!Number.isFinite(pTrue)) return 0;

  const pmKey = pipelineEvLookupKeyPm(tokenId);
  const kalshiKey = pipelineEvLookupKeyKalshi(kalshiTicker);
  const crossMid =
    pmMid != null && kalshiMid != null
      ? (pmMid + kalshiMid) / 2
      : (pmMid ?? kalshiMid ?? marketPrior);

  const pmMarket = resolvePlatformMarket(pmMid, kalshiMid, crossMid);
  const kalshiMarket = resolvePlatformMarket(kalshiMid, pmMid, crossMid);

  const pmRecord = buildOkPipelineTradeEv({
    lookupKey: pmKey,
    platform: "polymarket",
    tokenId,
    kalshiTicker,
    pTrue,
    pMarket: pmMarket,
  });

  const kalshiRecord = buildOkPipelineTradeEv({
    lookupKey: kalshiKey,
    platform: "kalshi",
    tokenId,
    kalshiTicker,
    pTrue,
    pMarket: kalshiMarket,
  });

  await persistTradeEvLookups(pmKey, kalshiKey, pmRecord, kalshiRecord, redisBatch);

  return 2;
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
    sourceType: string;
    modelVersion: string;
    variance?: number;
    sourceScore?: number;
    logSuffix: string;
  },
  redisBatch: EvPipelineRedisWriteBatch
): Promise<number> {
  const tokenId = mapping.polymarketTokenId.toLowerCase();
  const kalshiTicker = mapping.kalshiTicker.toUpperCase();
  const variance = opts.variance ?? 0.05;
  const sourceScore = opts.sourceScore ?? 0.7;

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

  redisBatch.queuePTrue(tokenId, {
    pTrue,
    variance,
    sourceScore,
    sourceType: opts.sourceType,
    kalshiTicker,
    calculatedAt: new Date().toISOString(),
  });

  const cachedLookups = await cacheLookupEvForMapping(
    tokenId,
    kalshiTicker,
    pTrue,
    opts.pmMid,
    opts.kalshiMid,
    opts.marketPrior,
    redisBatch
  );

  const pmMarket = resolvePlatformMarket(
    opts.pmMid,
    opts.kalshiMid,
    opts.marketPrior
  );
  const preview = buildOkPipelineTradeEv({
    lookupKey: pipelineEvLookupKeyPm(tokenId),
    platform: "polymarket",
    tokenId,
    kalshiTicker,
    pTrue,
    pMarket: pmMarket,
  });

  if (preview.netEvPercent === 0) {
    console.log("⚠️ [Backend Zero EV]", {
      pmMid: opts.pmMid,
      kalshiMid: opts.kalshiMid,
      pTrue,
      netEvPercent: preview.netEvPercent,
    });
  }

  console.info(
    `[ev-pipeline] computePTrue ${tokenId} ↔ ${kalshiTicker}: p_true=${pTrue.toFixed(4)} pm_mid=${opts.pmMid?.toFixed(4) ?? "—"} kalshi_mid=${opts.kalshiMid?.toFixed(4) ?? "—"} cached_lookups=${cachedLookups} netEvPercent=${preview.netEvPercent} ${opts.logSuffix}`
  );

  return 1;
}

/** Baseline edge (0%) when AI ensemble is unavailable — pTrue equals platform mid. */
async function seedBaselineEvForMapping(
  tokenId: string,
  kalshiTicker: string,
  pmMid: number | null,
  kalshiMid: number | null,
  marketPrior: number,
  redisBatch: EvPipelineRedisWriteBatch
): Promise<number> {
  const crossMid =
    pmMid != null && kalshiMid != null
      ? (pmMid + kalshiMid) / 2
      : (pmMid ?? kalshiMid ?? marketPrior);
  const pmMarket = resolvePlatformMarket(pmMid, kalshiMid, crossMid);
  const kalshiMarket = resolvePlatformMarket(kalshiMid, pmMid, crossMid);

  const pmKey = pipelineEvLookupKeyPm(tokenId);
  const kalshiKey = pipelineEvLookupKeyKalshi(kalshiTicker);

  const pmRecord = buildOkPipelineTradeEv({
    lookupKey: pmKey,
    platform: "polymarket",
    tokenId,
    kalshiTicker,
    pTrue: pmMarket,
    pMarket: pmMarket,
  });

  const kalshiRecord = buildOkPipelineTradeEv({
    lookupKey: kalshiKey,
    platform: "kalshi",
    tokenId,
    kalshiTicker,
    pTrue: kalshiMarket,
    pMarket: kalshiMarket,
  });

  await persistTradeEvLookups(pmKey, kalshiKey, pmRecord, kalshiRecord, redisBatch);

  console.log("⚠️ [Backend Zero EV]", {
    pmMid,
    kalshiMid,
    pTrue: pmMarket,
    netEvPercent: 0,
  });

  console.info(
    `[ev-pipeline] computePTrue baseline fallback ${tokenId} ↔ ${kalshiTicker}: pm=${pmMarket.toFixed(4)} kalshi=${kalshiMarket.toFixed(4)} (0% edge)`
  );

  return 2;
}

/**
 * Stage 3 — compute p_true + cache trade EV at pm:{tokenId} / kalshi:{ticker}.
 */
export async function processMappedPTrue(
  db: Db,
  recentMatches: MatchedPair[] = []
): Promise<number> {
  const mappings = await loadMappingsForPTrue(db, recentMatches);
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
      const ensemble = await calculatePTrue({
        marketTitle: mapping.polymarketTitle || mapping.kalshiTitle,
        marketContext: "",
        marketPrior,
      });

      if (spec) {
        updateDerivativeAnchorFromPrimary(
          anchorStore,
          spec,
          ensemble.pTrue,
          marketPrior
        );
      }

      await persistMappingPTrue(db, mapping, ensemble.pTrue, {
        pmMid,
        kalshiMid,
        marketPrior,
        sourceType: "ensemble",
        modelVersion: "pipeline_v1",
        variance: ensemble.variance,
        sourceScore: ensemble.sourceScore,
        logSuffix: "(ensemble)",
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
          redisBatch
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
            const written = await cacheLookupEvForMapping(
              tokenId,
              kalshiTicker,
              derived.pTrue,
              pmMid,
              kalshiMid,
              marketPrior,
              redisBatch
            );
            if (written > 0) cached += 1;
            continue;
          }
        }

        const written = await seedBaselineEvForMapping(
          tokenId,
          kalshiTicker,
          pmMid,
          kalshiMid,
          marketPrior,
          redisBatch
        );
        if (written > 0) cached += 1;
        continue;
      }

      const written = await cacheLookupEvForMapping(
        tokenId,
        kalshiTicker,
        pTrue,
        pmMid,
        kalshiMid,
        marketPrior,
        redisBatch
      );

      if (written > 0) cached += 1;
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
