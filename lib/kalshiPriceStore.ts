import { Redis } from "@upstash/redis";

const MAX_POINTS = 360;
const KEY_PREFIX = "kalshi:history:";

export interface PricePoint {
  t: number;
  p: number;
}

interface RecordableMarket {
  id: string;
  probability: number;
}

let redis: Redis | null = null;

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  if (!redis) {
    redis = new Redis({ url, token });
  }
  return redis;
}

export async function recordPrices(markets: RecordableMarket[]): Promise<void> {
  const client = getRedis();
  if (!client) return;

  const now = Math.floor(Date.now() / 1000);

  for (const market of markets) {
    const key = `${KEY_PREFIX}${market.id}`;
    const prob = market.probability;

    try {
      const existing = (await client.get<PricePoint[]>(key)) ?? [];

      const last = existing[existing.length - 1];
      if (!last || Math.abs(last.p - prob) > 0.001) {
        const updated = [...existing, { t: now, p: prob }].slice(-MAX_POINTS);

        await client.set(key, updated, { ex: 86400 });
      }
    } catch {
      // Silently fail — don't break the API route
    }
  }
}

export async function getHistory(ticker: string): Promise<PricePoint[]> {
  const client = getRedis();
  if (!client) return [];

  try {
    const key = `${KEY_PREFIX}${ticker}`;
    return (await client.get<PricePoint[]>(key)) ?? [];
  } catch {
    return [];
  }
}
