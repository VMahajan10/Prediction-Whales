import "server-only";

import { Redis } from "@upstash/redis";

export interface IpRateLimitResult {
  allowed: boolean;
  /** Seconds until the current window resets (when blocked). */
  retryAfterSec?: number;
}

type MemoryBucket = {
  count: number;
  resetAtMs: number;
};

const memoryBuckets = new Map<string, MemoryBucket>();

let redis: Redis | null = null;

function isRedisEnabled(): boolean {
  return !!(
    process.env.UPSTASH_REDIS_REST_URL?.trim() &&
    process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
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

function checkMemoryRateLimit(
  key: string,
  limit: number,
  windowSec: number,
  nowMs = Date.now()
): IpRateLimitResult {
  const bucket = memoryBuckets.get(key);
  if (!bucket || bucket.resetAtMs <= nowMs) {
    memoryBuckets.set(key, {
      count: 1,
      resetAtMs: nowMs + windowSec * 1000,
    });
    return { allowed: true };
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((bucket.resetAtMs - nowMs) / 1000)),
    };
  }

  return { allowed: true };
}

async function checkRedisRateLimit(
  client: Redis,
  key: string,
  limit: number,
  windowSec: number
): Promise<IpRateLimitResult> {
  const count = await client.incr(key);
  if (count === 1) {
    await client.expire(key, windowSec);
  }

  if (count <= limit) {
    return { allowed: true };
  }

  const ttl = await client.ttl(key);
  return {
    allowed: false,
    retryAfterSec: ttl > 0 ? ttl : windowSec,
  };
}

/** Fixed-window rate limit keyed by caller-supplied identifier (e.g. client IP). */
export async function checkIpRateLimit(
  key: string,
  limit: number,
  windowSec: number
): Promise<IpRateLimitResult> {
  const normalizedKey = key.trim() || "unknown";
  const client = getRedis();

  if (!client) {
    return checkMemoryRateLimit(normalizedKey, limit, windowSec);
  }

  try {
    return await checkRedisRateLimit(client, normalizedKey, limit, windowSec);
  } catch (error) {
    console.warn(
      "[rateLimit] Redis check failed — falling back to in-memory limiter",
      error instanceof Error ? error.message : error
    );
    return checkMemoryRateLimit(normalizedKey, limit, windowSec);
  }
}
