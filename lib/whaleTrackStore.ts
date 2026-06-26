import { Redis } from "@upstash/redis";
import type { CategoryStats, ClvStats, TrackRecord } from "@/lib/polymarket";

const CACHE_VERSION = "v6";
const KEY_PREFIX = `whale:stats:${CACHE_VERSION}:`;
const TTL_SEC = 600; // 10 minutes

export interface CachedWhaleStats {
  trackRecord: TrackRecord;
  openPositionCount: number;
  categoryStats: CategoryStats[];
  clvStats: ClvStats;
  cachedAt: number;
}

let redis: Redis | null = null;

export function isTrackRecordCacheEnabled(): boolean {
  return !!(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  );
}

function getRedis(): Redis | null {
  if (!isTrackRecordCacheEnabled()) return null;
  if (!redis) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
  return redis;
}

export async function getCachedTrackRecord(
  wallet: string
): Promise<CachedWhaleStats | null> {
  const client = getRedis();
  if (!client) return null;

  try {
    const key = `${KEY_PREFIX}${wallet.toLowerCase()}`;
    const raw = await client.get<CachedWhaleStats | string>(key);
    if (!raw) return null;

    const parsed =
      typeof raw === "string" ? (JSON.parse(raw) as CachedWhaleStats) : raw;

    if (!parsed?.trackRecord) return null;
    return parsed;
  } catch (err) {
    console.warn("[whaleTrackStore] cache read failed:", err);
    return null;
  }
}

export async function setCachedTrackRecord(
  wallet: string,
  trackRecord: TrackRecord,
  openPositionCount: number,
  categoryStats: CategoryStats[] = [],
  clvStats?: ClvStats
): Promise<boolean> {
  const client = getRedis();
  if (!client) return false;

  try {
    const key = `${KEY_PREFIX}${wallet.toLowerCase()}`;
    const payload: CachedWhaleStats = {
      trackRecord,
      openPositionCount,
      categoryStats,
      clvStats: clvStats ?? {
        avgClv: null,
        weightedClv: null,
        showWeighted: false,
        coverage: 0,
        totalClosed: 0,
        hasEnoughCoverage: false,
        coverageFloor: 5,
        positions: [],
      },
      cachedAt: Date.now(),
    };
    await client.set(key, payload, { ex: TTL_SEC });
    return true;
  } catch (err) {
    console.warn("[whaleTrackStore] cache write failed:", err);
    return false;
  }
}
