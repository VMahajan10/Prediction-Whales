import { Redis } from "@upstash/redis";
import type { PipelineTradeEv, EvPlatform } from "@/lib/evPipeline/types";
import {
  normalizePipelineLookupKey,
  pipelineEvLookupKeyKalshi,
  pipelineEvLookupKeyPm,
} from "@/lib/evPipeline/types";
import { normalizePipelineTradeEv } from "@/lib/evPipeline/tradeEvRecord";
import {
  enrichPipelineTradeEvCrossIds,
  indexPipelineTradeEvAliases,
  normalizeKalshiTicker,
  normalizePmTokenId,
  pipelineEvLookupAliases,
  pipelineMappingPairKey,
} from "@/lib/evPipeline/crossAssetLookup";

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
  const enriched = enrichPipelineTradeEvCrossIds(record, lookupKey);
  const normalized = normalizePipelineTradeEv(enriched, lookupKey);
  if (!normalized || normalized.status !== "ok") return null;

  const cache = initGlobalLocalEvCache();
  indexPipelineTradeEvAliases(cache, normalized, lookupKey);

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

  const cache = getLocalEvCache();
  for (const key of Array.from(candidates)) {
    if (!key) continue;
    for (const alias of pipelineEvLookupAliases({ key })) {
      const cached = cache.get(alias);
      if (!cached) continue;
      return (
        normalizePipelineTradeEv({ ...cached, key: cached.key ?? key }, key) ??
        cached
      );
    }
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
      indexPipelineTradeEvAliases(cache, normalized, lookupKey);
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
  /** Ensemble p_true on the primary PM market. */
  pTrue?: number | null;
  /** Resting-mid average EV % (alias: netEvPercent at mapping time). */
  averageEv?: number | null;
  grossEvPercent?: number | null;
  netEvPercent?: number | null;
  evComputedAt?: string;
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
  /** Time-series implied prob snapshots for RAG context. */
  oddsHistory: (polymarketTokenId: string) =>
    `${EV_REDIS_PREFIX}:rag:odds:${polymarketTokenId.toLowerCase()}`,
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

/** Max commands per Upstash pipeline HTTP request. */
const REDIS_PIPELINE_CHUNK_SIZE = 200;

type RedisSetCommand = {
  key: string;
  value: unknown;
  ex: number;
};

function logRedisBatchError(label: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (isRedisQuotaOrLimitError(err)) {
    console.log(
      `[Pipeline Redis Bypass] ${label} quota/limit hit — local cache remains authoritative`
    );
    return;
  }
  console.warn(`[ev/redis] ${label} failed:`, message);
}

/**
 * Batch GET keys via Redis pipeline — one HTTP round-trip per chunk.
 */
export async function execRedisReadPipeline(
  keys: string[]
): Promise<Map<string, unknown>> {
  const client = getRedis();
  const result = new Map<string, unknown>();
  if (!client || keys.length === 0) return result;

  const uniqueKeys = Array.from(new Set(keys));

  try {
    for (let i = 0; i < uniqueKeys.length; i += REDIS_PIPELINE_CHUNK_SIZE) {
      const chunk = uniqueKeys.slice(i, i + REDIS_PIPELINE_CHUNK_SIZE);
      const pipeline = client.pipeline();
      for (const key of chunk) {
        pipeline.get(key);
      }
      const execResult = (await pipeline.exec()) as unknown[] | null;
      chunk.forEach((key, idx) => {
        result.set(key, execResult?.[idx] ?? null);
      });
    }
  } catch (err) {
    logRedisBatchError("execRedisReadPipeline", err);
  }

  return result;
}

/** Batch SET keys via Redis pipeline — one HTTP round-trip per chunk. */
export async function execRedisWritePipeline(
  commands: RedisSetCommand[]
): Promise<void> {
  const client = getRedis();
  if (!client || commands.length === 0) return;

  try {
    for (let i = 0; i < commands.length; i += REDIS_PIPELINE_CHUNK_SIZE) {
      const chunk = commands.slice(i, i + REDIS_PIPELINE_CHUNK_SIZE);
      const pipeline = client.pipeline();
      for (const cmd of chunk) {
        pipeline.set(cmd.key, cmd.value, { ex: cmd.ex });
      }
      await pipeline.exec();
    }
  } catch (err) {
    logRedisBatchError("execRedisWritePipeline", err);
  }
}

export interface MappingRedisPrefetch {
  pmOb: CachedOrderBookMid | null;
  kalshiOb: CachedOrderBookMid | null;
  pTrue: CachedPTrue | null;
}

export function mappingRedisPairKey(
  polymarketTokenId: string,
  kalshiTicker: string
): string {
  return `${polymarketTokenId.toLowerCase()}:${kalshiTicker.toUpperCase()}`;
}

/** Prefetch order-book mids (and optional p_true) for a mapping batch. */
export async function prefetchMappingRedisBatch(
  mappings: Array<{ polymarketTokenId: string; kalshiTicker: string }>,
  options: { includePTrue?: boolean } = {}
): Promise<Map<string, MappingRedisPrefetch>> {
  const byPair = new Map<string, MappingRedisPrefetch>();
  if (mappings.length === 0) return byPair;

  const keysToFetch: string[] = [];
  const pairMeta: Array<{
    pairKey: string;
    pmKey: string;
    kalshiKey: string;
    pTrueKey: string | null;
  }> = [];

  for (const mapping of mappings) {
    const tokenId = mapping.polymarketTokenId.toLowerCase();
    const kalshiTicker = mapping.kalshiTicker.toUpperCase();
    const pairKey = mappingRedisPairKey(tokenId, kalshiTicker);
    const pmKey = evRedisKeys.orderBookPm(tokenId);
    const kalshiKey = evRedisKeys.orderBookKalshi(kalshiTicker);
    const pTrueKey = options.includePTrue ? evRedisKeys.pTrue(tokenId) : null;

    keysToFetch.push(pmKey, kalshiKey);
    if (pTrueKey) keysToFetch.push(pTrueKey);

    pairMeta.push({ pairKey, pmKey, kalshiKey, pTrueKey });
  }

  const raw = await execRedisReadPipeline(keysToFetch);

  for (const meta of pairMeta) {
    byPair.set(meta.pairKey, {
      pmOb: (raw.get(meta.pmKey) as CachedOrderBookMid | null) ?? null,
      kalshiOb: (raw.get(meta.kalshiKey) as CachedOrderBookMid | null) ?? null,
      pTrue:
        meta.pTrueKey != null
          ? ((raw.get(meta.pTrueKey) as CachedPTrue | null) ?? null)
          : null,
    });
  }

  return byPair;
}

/** Deferred Redis writes — local cache seeded immediately, Redis flushed in one batch. */
export class EvPipelineRedisWriteBatch {
  private pTrueWrites: Array<{ tokenId: string; value: CachedPTrue }> = [];
  private lookupWrites: Array<{ lookupKey: string; value: PipelineTradeEv }> =
    [];
  private orderBookWrites: Array<{ key: string; value: CachedOrderBookMid }> =
    [];
  private mappingWrites: CachedMapping[] = [];

  queuePTrue(tokenId: string, value: CachedPTrue): void {
    this.pTrueWrites.push({ tokenId: tokenId.toLowerCase(), value });
  }

  queueOrderBookMid(key: string, value: CachedOrderBookMid): void {
    this.orderBookWrites.push({ key, value });
  }

  queueMappingBothWays(mapping: CachedMapping): void {
    this.mappingWrites.push({
      ...mapping,
      polymarketTokenId: mapping.polymarketTokenId.toLowerCase(),
      kalshiTicker: mapping.kalshiTicker.toUpperCase(),
    });
  }

  queueTradeEvLookups(
    pmKey: string,
    kalshiKey: string,
    pmRecord: PipelineTradeEv,
    kalshiRecord: PipelineTradeEv
  ): void {
    seedPipelineLocalEvCache(pmKey, pmRecord);
    seedPipelineLocalEvCache(kalshiKey, kalshiRecord);

    const pmNormalized =
      normalizePipelineTradeEv(
        enrichPipelineTradeEvCrossIds(
          { ...pmRecord, key: pmRecord.key ?? pmKey },
          pmKey
        ),
        pmKey
      ) ?? pmRecord;
    const kalshiNormalized =
      normalizePipelineTradeEv(
        enrichPipelineTradeEvCrossIds(
          { ...kalshiRecord, key: kalshiRecord.key ?? kalshiKey },
          kalshiKey
        ),
        kalshiKey
      ) ?? kalshiRecord;

    this.lookupWrites.push({ lookupKey: pmKey, value: pmNormalized });
    this.lookupWrites.push({ lookupKey: kalshiKey, value: kalshiNormalized });
  }

  get pendingWriteCount(): number {
    return (
      this.pTrueWrites.length +
      this.lookupWrites.length +
      this.orderBookWrites.length +
      this.mappingWrites.length * 2
    );
  }

  async flush(): Promise<void> {
    if (this.pendingWriteCount === 0) return;

    const commands: RedisSetCommand[] = [];

    for (const row of this.orderBookWrites) {
      commands.push({
        key: row.key,
        value: row.value,
        ex: EV_REDIS_TTL.orderBookSec,
      });
    }

    for (const mapping of this.mappingWrites) {
      commands.push({
        key: evRedisKeys.mappingByPm(mapping.polymarketTokenId),
        value: mapping,
        ex: EV_REDIS_TTL.mappingSec,
      });
      commands.push({
        key: evRedisKeys.mappingByKalshi(mapping.kalshiTicker),
        value: mapping,
        ex: EV_REDIS_TTL.mappingSec,
      });
    }

    for (const row of this.pTrueWrites) {
      commands.push({
        key: evRedisKeys.pTrue(row.tokenId),
        value: row.value,
        ex: EV_REDIS_TTL.pTrueSec,
      });
    }

    for (const row of this.lookupWrites) {
      commands.push({
        key: evRedisKeys.tradeEvLookup(row.lookupKey),
        value: row.value,
        ex: EV_REDIS_TTL.pTrueSec,
      });
    }

    await execRedisWritePipeline(commands);
  }
}

/** Flush many order-book mids in one pipeline round-trip. */
export async function cacheOrderBookMidBatch(
  entries: Array<{ key: string; value: CachedOrderBookMid }>
): Promise<void> {
  const batch = new EvPipelineRedisWriteBatch();
  for (const entry of entries) {
    batch.queueOrderBookMid(entry.key, entry.value);
  }
  await batch.flush();
}

/** Flush bilateral mapping cache entries in one pipeline round-trip. */
export async function cacheMappingBothWaysBatch(
  mappings: CachedMapping[]
): Promise<void> {
  const batch = new EvPipelineRedisWriteBatch();
  for (const mapping of mappings) {
    batch.queueMappingBothWays(mapping);
  }
  await batch.flush();
}

export async function cacheOrderBookMid(
  key: string,
  value: CachedOrderBookMid
): Promise<void> {
  await cacheOrderBookMidBatch([{ key, value }]);
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

/** Batch-read PM-side mapping rows for trade EV enrichment. */
export async function prefetchMappingsByPmTokenIds(
  tokenIds: string[]
): Promise<Map<string, CachedMapping>> {
  const unique = Array.from(
    new Set(
      tokenIds
        .map((id) => normalizePmTokenId(id))
        .filter((id): id is string => !!id)
    )
  );
  const result = new Map<string, CachedMapping>();
  if (unique.length === 0) return result;

  const keys = unique.map((id) => evRedisKeys.mappingByPm(id));
  const raw = await execRedisReadPipeline(keys);
  unique.forEach((id, idx) => {
    const mapping = raw.get(keys[idx]) as CachedMapping | null;
    if (mapping) result.set(id, mapping);
  });
  return result;
}

/** Batch-read Kalshi-side mapping rows for trade EV enrichment. */
export async function prefetchMappingsByKalshiTickers(
  tickers: string[]
): Promise<Map<string, CachedMapping>> {
  const unique = Array.from(
    new Set(
      tickers
        .map((t) => normalizeKalshiTicker(t))
        .filter((t): t is string => !!t)
    )
  );
  const result = new Map<string, CachedMapping>();
  if (unique.length === 0) return result;

  const keys = unique.map((ticker) => evRedisKeys.mappingByKalshi(ticker));
  const raw = await execRedisReadPipeline(keys);
  unique.forEach((ticker, idx) => {
    const mapping = raw.get(keys[idx]) as CachedMapping | null;
    if (mapping) result.set(ticker, mapping);
  });
  return result;
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
  seedPipelineLocalEvCache(lookupKey, value);
  await safeCacheTradeEvLookupRedis(lookupKey, value);
}

/** Redis-only write — never throws; local cache must be seeded separately. */
export async function safeCacheTradeEvLookupRedis(
  lookupKey: string,
  value: PipelineTradeEv
): Promise<void> {
  const client = getRedis();
  if (!client) return;

  const normalized =
    normalizePipelineTradeEv({ ...value, key: value.key ?? lookupKey }, lookupKey) ??
    value;

  try {
    await client.set(evRedisKeys.tradeEvLookup(lookupKey), normalized, {
      ex: EV_REDIS_TTL.pTrueSec,
    });
  } catch (err) {
    if (isRedisQuotaOrLimitError(err)) {
      console.log(
        "[Pipeline Redis Bypass] Database full, proceeding with local memory fallback only"
      );
    } else {
      console.warn(
        "[ev/redis] cacheTradeEvLookup failed:",
        err instanceof Error ? err.message : err
      );
    }
  }
}

export async function getTradeEvLookupRedisOnly(
  lookupKey: string
): Promise<PipelineTradeEv | null> {
  const client = getRedis();
  if (!client) return null;

  try {
    const raw = await client.get<PipelineTradeEv>(
      evRedisKeys.tradeEvLookup(lookupKey)
    );
    if (!raw) return null;

    return (
      normalizePipelineTradeEv(
        { ...raw, key: raw.key ?? lookupKey },
        lookupKey
      ) ?? null
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isRedisQuotaOrLimitError(err)) {
      console.warn(
        "[ev/redis] getTradeEvLookupRedisOnly quota/limit hit — skipping Redis read"
      );
    } else {
      console.warn("[ev/redis] getTradeEvLookupRedisOnly failed:", message);
    }
    return null;
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
  await cacheMappingBothWaysBatch([mapping]);
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

const REDIS_SCAN_PAGE_SIZE = 200;
const REDIS_DELETE_CHUNK_SIZE = 200;

/** SCAN keys under the EV Redis namespace (Upstash-compatible). */
export async function scanEvRedisKeys(
  match: string,
  limit = 10_000
): Promise<string[]> {
  const client = getRedis();
  if (!client) return [];

  const keys: string[] = [];
  let cursor = 0;

  try {
    do {
      const [nextCursor, found] = await client.scan(cursor, {
        match,
        count: REDIS_SCAN_PAGE_SIZE,
      });
      cursor = Number(nextCursor);
      keys.push(...found);
      if (keys.length >= limit) break;
    } while (cursor !== 0);
  } catch (err) {
    console.warn(
      "[ev/redis] scanEvRedisKeys failed:",
      err instanceof Error ? err.message : err
    );
  }

  return keys.slice(0, limit);
}

export async function deleteEvRedisKeys(keys: string[]): Promise<number> {
  const client = getRedis();
  if (!client || keys.length === 0) return 0;

  let deleted = 0;
  try {
    for (let i = 0; i < keys.length; i += REDIS_DELETE_CHUNK_SIZE) {
      const chunk = keys.slice(i, i + REDIS_DELETE_CHUNK_SIZE);
      await client.del(...chunk);
      deleted += chunk.length;
    }
  } catch (err) {
    console.warn(
      "[ev/redis] deleteEvRedisKeys failed:",
      err instanceof Error ? err.message : err
    );
  }

  return deleted;
}

export interface FlushEvLookupResult {
  scanned: number;
  deleted: number;
  stale: number;
}

/**
 * Flush trade EV lookup cache keys (`ev:v1:lookup:*`).
 * When staleOnly=true, deletes entries failing the Phase 4 display contract.
 */
export async function flushEvLookupCache(options?: {
  staleOnly?: boolean;
  scanLimit?: number;
}): Promise<FlushEvLookupResult> {
  const pattern = `${EV_REDIS_PREFIX}:lookup:*`;
  const keys = await scanEvRedisKeys(pattern, options?.scanLimit ?? 5000);
  if (keys.length === 0) {
    return { scanned: 0, deleted: 0, stale: 0 };
  }

  if (!options?.staleOnly) {
    const deleted = await deleteEvRedisKeys(keys);
    return { scanned: keys.length, deleted, stale: 0 };
  }

  const { isStaleEvLookupPayload } = await import(
    "@/lib/evPipeline/tradeEvRecord"
  );
  const staleKeys: string[] = [];

  for (let i = 0; i < keys.length; i += REDIS_SCAN_PAGE_SIZE) {
    const chunk = keys.slice(i, i + REDIS_SCAN_PAGE_SIZE);
    const batch = await execRedisReadPipeline(chunk);
    for (const key of chunk) {
      const raw = batch.get(key) as PipelineTradeEv | undefined;
      if (raw && isStaleEvLookupPayload(raw)) {
        staleKeys.push(key);
      }
    }
  }

  const deleted = await deleteEvRedisKeys(staleKeys);
  return { scanned: keys.length, deleted, stale: staleKeys.length };
}

/** Delete all keys under `ev:v1:*` (order books, mappings, lookups, p_true, etc.). */
export async function flushAllEvRedisKeys(
  scanLimit = 20_000
): Promise<FlushEvLookupResult> {
  const keys = await scanEvRedisKeys(`${EV_REDIS_PREFIX}:*`, scanLimit);
  const deleted = await deleteEvRedisKeys(keys);
  return { scanned: keys.length, deleted, stale: 0 };
}
