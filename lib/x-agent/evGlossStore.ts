import { Redis } from "@upstash/redis";
import type { PrismaClient } from "@prisma/client";
import { isEvGloss, type EvGloss } from "@/constants/evGlosses";
import { fetchLastEvGlossFromQueue } from "@/lib/templates/queueHelpers";

const REDIS_LAST_EV_GLOSS_KEY = "x-agent:meta:last_ev_gloss";

type GlobalWithEvGlossCache = typeof globalThis & {
  __xAgentLastEvGloss?: string;
};

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

function readMemoryLastEvGloss(): EvGloss | null {
  const cached = (globalThis as GlobalWithEvGlossCache).__xAgentLastEvGloss;
  return isEvGloss(cached) ? cached : null;
}

function writeMemoryLastEvGloss(gloss: EvGloss): void {
  (globalThis as GlobalWithEvGlossCache).__xAgentLastEvGloss = gloss;
}

/**
 * Most recently queued EV gloss (`last_ev_gloss`).
 * Order: Redis → Postgres queue history → in-process fallback.
 */
export async function fetchLastEvGloss(
  prisma?: PrismaClient | null
): Promise<EvGloss | null> {
  const client = getRedis();
  if (client) {
    try {
      const raw = await client.get<string>(REDIS_LAST_EV_GLOSS_KEY);
      if (isEvGloss(raw)) return raw;
    } catch (error) {
      console.warn("[x-agent/evGlossStore] Redis read failed", {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  if (prisma) {
    try {
      const fromQueue = await fetchLastEvGlossFromQueue(prisma);
      if (isEvGloss(fromQueue)) {
        writeMemoryLastEvGloss(fromQueue);
        return fromQueue;
      }
    } catch (error) {
      console.warn("[x-agent/evGlossStore] queue history read failed", {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  return readMemoryLastEvGloss();
}

/** Persist `last_ev_gloss` to Redis + in-process cache after a draft is queued. */
export async function persistLastEvGloss(gloss: string): Promise<void> {
  if (!isEvGloss(gloss)) return;

  writeMemoryLastEvGloss(gloss);

  const client = getRedis();
  if (!client) return;

  try {
    await client.set(REDIS_LAST_EV_GLOSS_KEY, gloss);
  } catch (error) {
    console.warn("[x-agent/evGlossStore] Redis write failed", {
      error: error instanceof Error ? error.message : error,
    });
  }
}

/** Test helper — reset in-process gloss cache. */
export function clearLastEvGlossCacheForTests(): void {
  delete (globalThis as GlobalWithEvGlossCache).__xAgentLastEvGloss;
}
