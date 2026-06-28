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
  cachePTrue,
  cacheTradeEvLookup,
  evRedisKeys,
  getOrderBookMid,
  getPTrue,
  seedPipelineLocalEvCache,
} from "@/lib/evPipeline/redisCache";

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
  marketPrior: number
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

  seedPipelineLocalEvCache(pmKey, pmRecord);
  seedPipelineLocalEvCache(kalshiKey, kalshiRecord);

  await cacheTradeEvLookup(pmKey, pmRecord);
  await cacheTradeEvLookup(kalshiKey, kalshiRecord);

  return 2;
}

/** Baseline edge (0%) when AI ensemble is unavailable — pTrue equals platform mid. */
async function seedBaselineEvForMapping(
  tokenId: string,
  kalshiTicker: string,
  pmMid: number | null,
  kalshiMid: number | null,
  marketPrior: number
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

  seedPipelineLocalEvCache(pmKey, pmRecord);
  seedPipelineLocalEvCache(kalshiKey, kalshiRecord);
  await cacheTradeEvLookup(pmKey, pmRecord);
  await cacheTradeEvLookup(kalshiKey, kalshiRecord);

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

  let processed = 0;

  for (const mapping of mappings) {
    try {
      const tokenId = mapping.polymarketTokenId.toLowerCase();
      const kalshiTicker = mapping.kalshiTicker.toUpperCase();

      const pmOb = await getOrderBookMid(evRedisKeys.orderBookPm(tokenId));
      const kalshiOb = await getOrderBookMid(
        evRedisKeys.orderBookKalshi(kalshiTicker)
      );
      const pmMid = pmOb?.mid ?? null;
      const kalshiMid = kalshiOb?.mid ?? null;
      const marketPrior =
        pmMid != null && kalshiMid != null
          ? (pmMid + kalshiMid) / 2
          : (pmMid ?? kalshiMid ?? 0.5);

      const ensemble = await calculatePTrue({
        marketTitle: mapping.polymarketTitle || mapping.kalshiTitle,
        marketContext: "",
        marketPrior,
      });

      await db.insert(trueProbabilities).values({
        mappingId: mapping.id > 0 ? mapping.id : null,
        polymarketTokenId: tokenId,
        kalshiTicker,
        pTrue: fmtProb(ensemble.pTrue),
        sourceScore: fmtProb(ensemble.sourceScore),
        variance: fmtProb(ensemble.variance),
        sourceType: "ensemble",
        modelVersion: "pipeline_v1",
        contributors: ensemble.contributors.map((c) => ({
          source: c.source,
          weight: c.weight,
          p: c.impliedProbability,
          variance: ensemble.variance,
        })),
      });

      await cachePTrue(tokenId, {
        pTrue: ensemble.pTrue,
        variance: ensemble.variance,
        sourceScore: ensemble.sourceScore,
        sourceType: "ensemble",
        kalshiTicker,
        calculatedAt: new Date().toISOString(),
      });

      const cachedLookups = await cacheLookupEvForMapping(
        tokenId,
        kalshiTicker,
        ensemble.pTrue,
        pmMid,
        kalshiMid,
        marketPrior
      );

      const pmMarket = resolvePlatformMarket(pmMid, kalshiMid, marketPrior);
      const preview = buildOkPipelineTradeEv({
        lookupKey: pipelineEvLookupKeyPm(tokenId),
        platform: "polymarket",
        tokenId,
        kalshiTicker,
        pTrue: ensemble.pTrue,
        pMarket: pmMarket,
      });

      console.info(
        `[ev-pipeline] computePTrue ${tokenId} ↔ ${kalshiTicker}: p_true=${ensemble.pTrue.toFixed(4)} pm_mid=${pmMid?.toFixed(4) ?? "—"} kalshi_mid=${kalshiMid?.toFixed(4) ?? "—"} cached_lookups=${cachedLookups} netEvPercent=${preview.netEvPercent}`
      );

      processed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Batch EV Fetch Error:", message);
      try {
        const tokenId = mapping.polymarketTokenId.toLowerCase();
        const kalshiTicker = mapping.kalshiTicker.toUpperCase();
        const pmOb = await getOrderBookMid(evRedisKeys.orderBookPm(tokenId));
        const kalshiOb = await getOrderBookMid(
          evRedisKeys.orderBookKalshi(kalshiTicker)
        );
        const pmMid = pmOb?.mid ?? null;
        const kalshiMid = kalshiOb?.mid ?? null;
        const marketPrior =
          pmMid != null && kalshiMid != null
            ? (pmMid + kalshiMid) / 2
            : (pmMid ?? kalshiMid ?? 0.5);
        await seedBaselineEvForMapping(
          tokenId,
          kalshiTicker,
          pmMid,
          kalshiMid,
          marketPrior
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

  let cached = 0;

  for (const mapping of mappings) {
    try {
      const tokenId = mapping.polymarketTokenId.toLowerCase();
      const kalshiTicker = mapping.kalshiTicker.toUpperCase();

      const pTrueCached = await getPTrue(tokenId);
      let pTrue = pTrueCached?.pTrue ?? null;

      const pmOb = await getOrderBookMid(evRedisKeys.orderBookPm(tokenId));
      const kalshiOb = await getOrderBookMid(
        evRedisKeys.orderBookKalshi(kalshiTicker)
      );
      const pmMid = pmOb?.mid ?? null;
      const kalshiMid = kalshiOb?.mid ?? null;
      const marketPrior =
        pmMid != null && kalshiMid != null
          ? (pmMid + kalshiMid) / 2
          : (pmMid ?? kalshiMid ?? 0.5);

      if (pTrue == null || !Number.isFinite(pTrue)) {
        const written = await seedBaselineEvForMapping(
          tokenId,
          kalshiTicker,
          pmMid,
          kalshiMid,
          marketPrior
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
        marketPrior
      );

      if (written > 0) cached += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[ev-pipeline] ensureMappedTradeEvLookups:", message);
    }
  }

  return cached;
}
