import { Redis } from "@upstash/redis";
import {
  buildCrossMarketBookIndex,
  type OutcomeBooks,
} from "@/lib/crossMarketEv";

const CACHE_KEY = "cross-market-ev:index:v4";
const CACHE_TTL_SEC = 45;
const REVALIDATE_AFTER_MS = 30_000;

export interface SerializedEvIndexEntry extends OutcomeBooks {
  id: string;
}

export interface CachedEvIndexPayload {
  generatedAt: string;
  entries: SerializedEvIndexEntry[];
  cachedAt: number;
}

let redis: Redis | null = null;
let memoryCache: CachedEvIndexPayload | null = null;
let inflightBuild: Promise<CachedEvIndexPayload> | null = null;

function isRedisEnabled(): boolean {
  return !!(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  );
}

function getRedis(): Redis | null {
  if (!isRedisEnabled()) return null;
  if (!redis) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
  return redis;
}

function serializeIndex(
  index: Map<string, OutcomeBooks>
): CachedEvIndexPayload {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    generatedAt: new Date(nowSec * 1000).toISOString(),
    entries: Array.from(index.entries()).map(([id, entry]) => ({
      id,
      game: entry.game,
      outcome: entry.outcome,
      kalshi: entry.kalshi,
      polymarket: entry.polymarket,
      manifold: entry.manifold,
      sportsbook: entry.sportsbook,
      label: entry.label,
    })),
    cachedAt: Date.now(),
  };
}

async function readCache(): Promise<CachedEvIndexPayload | null> {
  const client = getRedis();
  if (client) {
    try {
      const raw = await client.get<CachedEvIndexPayload | string>(CACHE_KEY);
      if (raw) {
        const parsed =
          typeof raw === "string"
            ? (JSON.parse(raw) as CachedEvIndexPayload)
            : raw;
        if (parsed?.entries) {
          memoryCache = parsed;
          return parsed;
        }
      }
    } catch (err) {
      console.warn("[crossMarketEvIndexStore] redis read failed:", err);
    }
  }

  if (
    memoryCache &&
    Date.now() - memoryCache.cachedAt < CACHE_TTL_SEC * 1000
  ) {
    return memoryCache;
  }
  return null;
}

async function writeCache(payload: CachedEvIndexPayload): Promise<void> {
  memoryCache = payload;
  const client = getRedis();
  if (!client) return;

  try {
    await client.set(CACHE_KEY, payload, { ex: CACHE_TTL_SEC });
  } catch (err) {
    console.warn("[crossMarketEvIndexStore] redis write failed:", err);
  }
}

async function buildAndCache(): Promise<CachedEvIndexPayload> {
  if (!inflightBuild) {
    inflightBuild = (async () => {
      const index = await buildCrossMarketBookIndex();
      const payload = serializeIndex(index);
      await writeCache(payload);
      return payload;
    })().finally(() => {
      inflightBuild = null;
    });
  }
  return inflightBuild;
}

function shouldRevalidate(cachedAt: number): boolean {
  return Date.now() - cachedAt >= REVALIDATE_AFTER_MS;
}

/** Return cached index immediately; rebuild only on cold miss (single-flight). */
export async function getCrossMarketEvIndex(): Promise<CachedEvIndexPayload> {
  const cached = await readCache();
  if (cached) {
    if (shouldRevalidate(cached.cachedAt)) {
      void buildAndCache();
    }
    return cached;
  }
  return buildAndCache();
}

/** Force a background cache refresh (used by periodic client refresh). */
export function refreshCrossMarketEvIndexInBackground(): void {
  void buildAndCache();
}

export function entriesToMap(
  entries: SerializedEvIndexEntry[]
): Map<string, OutcomeBooks> {
  const map = new Map<string, OutcomeBooks>();
  for (const entry of entries) {
    map.set(entry.id, {
      game: entry.game,
      outcome: entry.outcome,
      kalshi: entry.kalshi,
      polymarket: entry.polymarket,
      manifold: entry.manifold ?? null,
      sportsbook: entry.sportsbook ?? null,
      label: entry.label,
    });
  }
  return map;
}
