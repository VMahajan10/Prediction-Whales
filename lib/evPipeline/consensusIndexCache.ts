import type { CachedEvIndexPayload } from "@/lib/crossMarketEvIndexStore";

const CACHE_KEY = "cross-market-ev:index:v4";
const CACHE_TTL_SEC = 45;

let memoryPayload: CachedEvIndexPayload | null = null;

/** Persist enriched consensus payload (Redis + in-memory). */
export async function writeConsensusIndexPayload(
  payload: CachedEvIndexPayload
): Promise<void> {
  memoryPayload = payload;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;

  try {
    const { Redis } = await import("@upstash/redis");
    const client = new Redis({ url, token });
    await client.set(CACHE_KEY, payload, { ex: CACHE_TTL_SEC });
  } catch (err) {
    console.warn("[consensusIndexCache] redis write failed:", err);
  }
}

export function readConsensusIndexMemory(): CachedEvIndexPayload | null {
  return memoryPayload;
}
