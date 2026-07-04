import { evRedisKeys, isEvRedisEnabled } from "@/lib/evPipeline/redisCache";
import type { OddsHistoryPoint } from "@/lib/ai/rag/types";

const MAX_POINTS = 48;
const TTL_SECONDS = 7 * 24 * 60 * 60;

const memoryStore = new Map<string, OddsHistoryPoint[]>();

function normalizeTokenId(tokenId: string): string {
  return tokenId.trim().toLowerCase();
}

async function getRedisClient() {
  if (!isEvRedisEnabled()) return null;
  const { Redis } = await import("@upstash/redis");
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
}

function trimHistory(points: OddsHistoryPoint[]): OddsHistoryPoint[] {
  return points.slice(-MAX_POINTS);
}

export async function appendOddsHistory(
  tokenId: string,
  point: OddsHistoryPoint
): Promise<void> {
  const key = normalizeTokenId(tokenId);
  const existing = memoryStore.get(key) ?? [];
  const next = trimHistory([...existing, point]);
  memoryStore.set(key, next);

  const client = await getRedisClient();
  if (!client) return;

  try {
    await client.set(evRedisKeys.oddsHistory(key), next, { ex: TTL_SECONDS });
  } catch (err) {
    console.warn(
      "[rag/oddsHistory] append failed:",
      err instanceof Error ? err.message : err
    );
  }
}

export async function getOddsHistory(
  tokenId: string,
  limit = 12
): Promise<OddsHistoryPoint[]> {
  const key = normalizeTokenId(tokenId);
  const cached = memoryStore.get(key);
  if (cached?.length) return cached.slice(-limit);

  const client = await getRedisClient();
  if (!client) return [];

  try {
    const raw = await client.get<OddsHistoryPoint[]>(evRedisKeys.oddsHistory(key));
    if (!raw?.length) return [];
    memoryStore.set(key, raw);
    return raw.slice(-limit);
  } catch {
    return [];
  }
}

/** Test helper — reset in-memory store. */
export function clearOddsHistoryMemory(): void {
  memoryStore.clear();
}
