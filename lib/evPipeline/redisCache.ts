import { Redis } from "@upstash/redis";
import type { PipelineTradeEv, EvPlatform } from "@/lib/evPipeline/types";
import {
  normalizePipelineLookupKey,
  pipelineEvLookupKeyKalshi,
  pipelineEvLookupKeyPm,
} from "@/lib/evPipeline/types";
import { normalizePipelineTradeEv } from "@/lib/evPipeline/tradeEvRecord";

type GlobalWithLocalEvCache = typeof globalThis & {
  localEvCache?: Map<string, PipelineTradeEv>;
};

/** Ensure the in-process fallback map exists (survives Redis quota errors). */
export function initGlobalLocalEvCache(): Map<string, PipelineTradeEv> {
  const globalRef = globalThis as GlobalWithLocalEvCache;
  globalRef.localEvCache = globalRef.localEvCache || new Map();
  return globalRef.localEvCache;
}

function getLocalEvCache(): Map<string, PipelineTradeEv> {
  return initGlobalLocalEvCache();
}

/**
 * Persist a computed trade EV payload into globalThis.localEvCache.
 * Used by the cron pipeline so batch API reads succeed when Redis is unavailable.
 */
export function seedPipelineLocalEvCache(
  lookupKey: string,
  record: PipelineTradeEv
): PipelineTradeEv | null {
  const normalized = normalizePipelineTradeEv(
    { ...record, key: record.key ?? lookupKey },
    lookupKey
  );
  if (!normalized || normalized.status !== "ok") return null;

  initGlobalLocalEvCache().set(lookupKey, normalized);

  const evPercent = normalized.netEvPercent ?? 0;
  console.log(
    `[Pipeline Cache] Seeding key: ${lookupKey} with ${evPercent}% EV`
  );

  return normalized;
}

function isRedisQuotaOrLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /max requests limit exceeded|quota|limit exceeded|429/i.test(message);
}

function readLocalTradeEvLookup(
  lookupKey: string,
  source?: EvPlatform
): PipelineTradeEv | null {
  const candidates = new Set<string>();
  const normalized = normalizePipelineLookupKey(lookupKey, source);
  candidates.add(normalized);
  candidates.add(lookupKey.trim());
  if (source === "polymarket") {
    candidates.add(pipelineEvLookupKeyPm(lookupKey.replace(/^pm:/i, "")));
  }
  if (source === "kalshi") {
    candidates.add(
      pipelineEvLookupKeyKalshi(lookupKey.replace(/^kalshi:/i, ""))
    );
  }

  for (const key of Array.from(candidates)) {
    if (!key) continue;
    const cached = getLocalEvCache().get(key);
    if (!cached) continue;
    return (
      normalizePipelineTradeEv({ ...cached, key: cached.key ?? key }, key) ??
      cached
    );
  }

  return null;
}

/** Append/update entries — never clears previously cached market IDs. */
export function mergeLocalEvCache(
  entries: Record<string, PipelineTradeEv> | Map<string, PipelineTradeEv>
): void {
  const cache = getLocalEvCache();
  const pairs =
    entries instanceof Map
      ? Array.from(entries.entries())
      : Object.entries(entries);

  for (const [lookupKey, value] of pairs) {
    const normalized = normalizePipelineTradeEv(
      { ...value, key: value.key ?? lookupKey },
      lookupKey
    );
    if (normalized) {
      cache.set(lookupKey, normalized);
    }
  }
}

export { readLocalTradeEvLookup };

/**
 * Upstash Redis key layout for the EV pipeline.
 *
 * Design goals:
 * - Sub-10ms reads on hot paths (order book midpoints, latest p_true)
 * - Short TTLs on prices; longer TTLs on mappings / trader rollups
 * - Namespaced keys to avoid collisions with kalshi:history:, clv:line:, etc.
 */

export const EV_REDIS_PREFIX = "ev:v1";

export const EV_REDIS_TTL = {
  /** Order book snapshot — refresh every cron tick (~5–15s). */
  orderBookSec: 10,
  /** Latest p_true per token — recomputed each pipeline run. */
  pTrueSec: 90,
  /** Bilateral mapping lookup — stable unless markets change. */
  mappingSec: 300,
  /** Per-wallet live EV rollup for profile / copy signal. */
  traderLiveSec: 120,
  /** Cron mutual exclusion lock. */
  pipelineLockSec: 240,
  /** Last successful pipeline metadata. */
  pipelineMetaSec: 3600,
} as const;

export interface CachedOrderBookMid {
  bid: number | null;
  ask: number | null;
  mid: number;
  ts: number;
}

export interface CachedPTrue {
  pTrue: number;
  variance: number | null;
  sourceScore: number | null;
  sourceType: string;
  kalshiTicker: string | null;
  calculatedAt: string;
}

export interface CachedMapping {
  polymarketTokenId: string;
  kalshiTicker: string;
  confidenceScore: number;
  orientation: "same" | "inverted";
  matchMethod: string;
}

export interface CachedTraderEv {
  averageEv: number | null;
  totalPortfolioEv: number | null;
  tradeCount: number;
  closedTradeCount: number;
  updatedAt: string;
}

export interface PipelineRunMeta {
  runId: string;
  finishedAt: string;
  stages: Record<string, { ok: boolean; count?: number; ms?: number }>;
}

export const evRedisKeys = {
  orderBookPm: (tokenId: string) =>
    `${EV_REDIS_PREFIX}:ob:pm:${tokenId.toLowerCase()}`,
  orderBookKalshi: (ticker: string) =>
    `${EV_REDIS_PREFIX}:ob:kalshi:${ticker.toUpperCase()}`,
  pTrue: (polymarketTokenId: string) =>
    `${EV_REDIS_PREFIX}:ptrue:${polymarketTokenId.toLowerCase()}`,
  mappingByPm: (polymarketTokenId: string) =>
    `${EV_REDIS_PREFIX}:map:pm:${polymarketTokenId.toLowerCase()}`,
  mappingByKalshi: (kalshiTicker: string) =>
    `${EV_REDIS_PREFIX}:map:kalshi:${kalshiTicker.toUpperCase()}`,
  traderLive: (wallet: string, platform: "polymarket" | "kalshi" | "all") =>
    `${EV_REDIS_PREFIX}:trader:${wallet.toLowerCase()}:${platform}`,
  pipelineLock: () => `${EV_REDIS_PREFIX}:pipeline:lock`,
  pipelineMeta: () => `${EV_REDIS_PREFIX}:pipeline:last_run`,
  /** Batch lookup cache — key suffix is pm:{tokenId} or kalshi:{ticker}. */
  tradeEvLookup: (lookupKey: string) => `${EV_REDIS_PREFIX}:lookup:${lookupKey}`,
} as const;

let redis: Redis | null = null;

export function isEvRedisEnabled(): boolean {
  return !!(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  );
}

function getRedis(): Redis | null {
  if (!isEvRedisEnabled()) return null;
  if (!redis) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
  return redis;
}

export async function cacheOrderBookMid(
  key: string,
  value: CachedOrderBookMid
): Promise<void> {
  const client = getRedis();
  if (!client) return;
  try {
    await client.set(key, value, { ex: EV_REDIS_TTL.orderBookSec });
  } catch (err) {
    console.warn(
      "[ev/redis] cacheOrderBookMid failed:",
      err instanceof Error ? err.message : err
    );
  }
}

export async function getOrderBookMid(
  key: string
): Promise<CachedOrderBookMid | null> {
  const client = getRedis();
  if (!client) return null;
  try {
    return client.get<CachedOrderBookMid>(key);
  } catch (err) {
    console.warn(
      "[ev/redis] getOrderBookMid failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

export async function getMappingByKalshi(
  kalshiTicker: string
): Promise<CachedMapping | null> {
  const client = getRedis();
  if (!client) return null;
  try {
    return client.get<CachedMapping>(
      evRedisKeys.mappingByKalshi(kalshiTicker.toUpperCase())
    );
  } catch {
    return null;
  }
}

export async function getMappingByPm(
  polymarketTokenId: string
): Promise<CachedMapping | null> {
  const client = getRedis();
  if (!client) return null;
  try {
    return client.get<CachedMapping>(
      evRedisKeys.mappingByPm(polymarketTokenId.toLowerCase())
    );
  } catch {
    return null;
  }
}

export async function getTraderEv(
  wallet: string,
  platform: "polymarket" | "kalshi" | "all"
): Promise<CachedTraderEv | null> {
  const client = getRedis();
  if (!client) return null;
  try {
    return client.get<CachedTraderEv>(
      evRedisKeys.traderLive(wallet.toLowerCase(), platform)
    );
  } catch {
    return null;
  }
}

export async function cachePTrue(
  polymarketTokenId: string,
  value: CachedPTrue
): Promise<void> {
  const client = getRedis();
  if (!client) return;
  try {
    await client.set(evRedisKeys.pTrue(polymarketTokenId), value, {
      ex: EV_REDIS_TTL.pTrueSec,
    });
  } catch (err) {
    console.warn(
      "[ev/redis] cachePTrue failed:",
      err instanceof Error ? err.message : err
    );
  }
}

export async function getPTrue(
  polymarketTokenId: string
): Promise<CachedPTrue | null> {
  const client = getRedis();
  if (!client) return null;
  try {
    return client.get<CachedPTrue>(evRedisKeys.pTrue(polymarketTokenId));
  } catch (err) {
    console.warn(
      "[ev/redis] getPTrue failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

export async function cacheTradeEvLookup(
  lookupKey: string,
  value: PipelineTradeEv
): Promise<void> {
  const normalized =
    normalizePipelineTradeEv({ ...value, key: value.key ?? lookupKey }, lookupKey) ??
    value;
  initGlobalLocalEvCache().set(lookupKey, normalized);

  const client = getRedis();
  if (!client) return;
  try {
    await client.set(evRedisKeys.tradeEvLookup(lookupKey), normalized, {
      ex: EV_REDIS_TTL.pTrueSec,
    });
  } catch (err) {
    console.warn(
      "[ev/redis] cacheTradeEvLookup failed:",
      err instanceof Error ? err.message : err
    );
  }
}

export async function getTradeEvLookup(
  lookupKey: string
): Promise<PipelineTradeEv | null> {
  const client = getRedis();
  if (!client) {
    return readLocalTradeEvLookup(lookupKey);
  }

  try {
    const raw = await client.get<PipelineTradeEv>(
      evRedisKeys.tradeEvLookup(lookupKey)
    );
    if (!raw) {
      return readLocalTradeEvLookup(lookupKey);
    }

    const normalized = normalizePipelineTradeEv(
      { ...raw, key: raw.key ?? lookupKey },
      lookupKey
    );
    if (normalized) {
      getLocalEvCache().set(lookupKey, normalized);
    }
    return normalized;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isRedisQuotaOrLimitError(err)) {
      console.warn(
        "[ev/redis] getTradeEvLookup quota/limit hit — using localEvCache fallback"
      );
    } else {
      console.warn("[ev/redis] getTradeEvLookup failed:", message);
    }
    return readLocalTradeEvLookup(lookupKey);
  }
}

export async function cacheMappingBothWays(
  mapping: CachedMapping
): Promise<void> {
  const client = getRedis();
  if (!client) return;
  try {
    const payload = mapping;
    await Promise.all([
      client.set(evRedisKeys.mappingByPm(mapping.polymarketTokenId), payload, {
        ex: EV_REDIS_TTL.mappingSec,
      }),
      client.set(evRedisKeys.mappingByKalshi(mapping.kalshiTicker), payload, {
        ex: EV_REDIS_TTL.mappingSec,
      }),
    ]);
  } catch (err) {
    console.warn(
      "[ev/redis] cacheMappingBothWays failed:",
      err instanceof Error ? err.message : err
    );
  }
}

export async function cacheTraderEv(
  wallet: string,
  platform: "polymarket" | "kalshi" | "all",
  value: CachedTraderEv
): Promise<void> {
  const client = getRedis();
  if (!client) return;
  try {
    await client.set(evRedisKeys.traderLive(wallet, platform), value, {
      ex: EV_REDIS_TTL.traderLiveSec,
    });
  } catch (err) {
    console.warn(
      "[ev/redis] cacheTraderEv failed:",
      err instanceof Error ? err.message : err
    );
  }
}

export async function acquirePipelineLock(runId: string): Promise<boolean> {
  const client = getRedis();
  if (!client) return true;
  try {
    const result = await client.set(evRedisKeys.pipelineLock(), runId, {
      nx: true,
      ex: EV_REDIS_TTL.pipelineLockSec,
    });
    return result === "OK";
  } catch (err) {
    console.warn(
      "[ev/redis] acquirePipelineLock failed — proceeding without lock:",
      err instanceof Error ? err.message : err
    );
    return true;
  }
}

export async function releasePipelineLock(runId: string): Promise<void> {
  const client = getRedis();
  if (!client) return;
  try {
    const current = await client.get<string>(evRedisKeys.pipelineLock());
    if (current === runId) {
      await client.del(evRedisKeys.pipelineLock());
    }
  } catch (err) {
    console.warn(
      "[ev/redis] releasePipelineLock failed:",
      err instanceof Error ? err.message : err
    );
  }
}

export async function writePipelineMeta(meta: PipelineRunMeta): Promise<void> {
  const client = getRedis();
  if (!client) return;
  try {
    await client.set(evRedisKeys.pipelineMeta(), meta, {
      ex: EV_REDIS_TTL.pipelineMetaSec,
    });
  } catch (err) {
    console.warn(
      "[ev/redis] writePipelineMeta failed:",
      err instanceof Error ? err.message : err
    );
  }
}
