import "server-only";

import { z } from "zod";
import { categorizeMarketByRegex } from "@/lib/categorizerRegex";
import {
  MARKET_FEED_CATEGORIES,
  normalizeMarketFeedCategory,
  type MarketFeedCategory,
} from "@/lib/constants/categories";

export type { MarketFeedCategory } from "@/lib/constants/categories";

const LRU_MAX = 500;
const REDIS_PREFIX = "marketpulse:category:";
const REDIS_TTL_SEC = 60 * 60 * 24 * 30;

const memoryCache = new Map<string, MarketFeedCategory>();
const memoryOrder: string[] = [];

function normalizeCacheKey(title: string, eventSlug?: string): string {
  const slug = eventSlug?.trim().toLowerCase();
  if (slug) return `slug:${slug}`;
  return `title:${title.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

function rememberInMemory(key: string, category: MarketFeedCategory): void {
  if (memoryCache.has(key)) {
    memoryCache.set(key, category);
    return;
  }
  memoryCache.set(key, category);
  memoryOrder.push(key);
  while (memoryOrder.length > LRU_MAX) {
    const oldest = memoryOrder.shift();
    if (oldest) memoryCache.delete(oldest);
  }
}

function parseCategory(value: unknown): MarketFeedCategory | null {
  return normalizeMarketFeedCategory(
    typeof value === "string" ? value : undefined
  );
}

async function getRedisClient(): Promise<{
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: string, opts: { ex: number }) => Promise<unknown>;
} | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const { Redis } = await import("@upstash/redis");
  return new Redis({ url, token });
}

async function readCategoryCache(key: string): Promise<MarketFeedCategory | null> {
  const mem = memoryCache.get(key);
  if (mem) return mem;

  const client = await getRedisClient();
  if (!client) return null;

  try {
    const raw = await client.get(`${REDIS_PREFIX}${key}`);
    const parsed = parseCategory(
      typeof raw === "string" ? raw : (raw as { category?: string })?.category
    );
    if (parsed) rememberInMemory(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

async function writeCategoryCache(
  key: string,
  category: MarketFeedCategory
): Promise<void> {
  rememberInMemory(key, category);

  const client = await getRedisClient();
  if (!client) return;

  try {
    await client.set(`${REDIS_PREFIX}${key}`, category, { ex: REDIS_TTL_SEC });
  } catch {
    // Best-effort cache write.
  }
}

const LlmCategorySchema = z.object({
  category: z.enum(["SPORTS", "POLITICS", "CULTURE"]),
});

function isLlmConfigured(): boolean {
  return !!(
    process.env.OPENAI_API_KEY?.trim() || process.env.AI_GATEWAY_API_KEY?.trim()
  );
}

async function classifyWithOpenAi(title: string): Promise<MarketFeedCategory | null> {
  if (!isLlmConfigured()) return null;

  try {
    const { generateObject } = await import("ai");
    const { openai } = await import("@ai-sdk/openai");
    const { withOpenAiLimiter } = await import("@/lib/ai/openaiLimiter");

    const modelId =
      process.env.MARKET_CATEGORY_LLM_MODEL?.trim() ||
      process.env.PROBABILITY_LLM_MODEL?.trim() ||
      "gpt-4o-mini";

    const { object } = await withOpenAiLimiter(() =>
      generateObject({
        model: openai(modelId),
        schema: LlmCategorySchema,
        system:
          "Classify this prediction market title into exactly one category: SPORTS, POLITICS, CULTURE. Return JSON: { category: string }",
        prompt: title.trim(),
        temperature: 0,
      })
    );

    return parseCategory(object.category);
  } catch (error) {
    console.warn("[categorizer] OpenAI classification failed", {
      error: error instanceof Error ? error.message : error,
    });
    return null;
  }
}

export interface CategorizeMarketOptions {
  /** Skip LLM fallback (regex + cache only). */
  skipLlm?: boolean;
  /** Backfill matching DB rows after classification. */
  backfillDb?: boolean;
  /** Kalshi ticker or Polymarket slug for DB backfill. */
  marketKey?: string;
}

/**
 * Classify a market title into a feed category (regex → cache → OpenAI fallback).
 */
export async function categorizeMarket(
  title: string,
  eventSlug?: string,
  options?: CategorizeMarketOptions
): Promise<MarketFeedCategory> {
  const trimmedTitle = title.trim();
  const cacheKey = normalizeCacheKey(trimmedTitle, eventSlug ?? options?.marketKey);

  const cached = await readCategoryCache(cacheKey);
  if (cached) return cached;

  const regexHit = categorizeMarketByRegex(trimmedTitle, eventSlug);
  if (regexHit) {
    await writeCategoryCache(cacheKey, regexHit);
    if (options?.backfillDb) {
      await backfillMarketCategoryInDatabase(regexHit, {
        title: trimmedTitle,
        eventSlug,
        ticker: options.marketKey,
      });
    }
    return regexHit;
  }

  if (!options?.skipLlm) {
    const llmHit = await classifyWithOpenAi(trimmedTitle);
    if (llmHit) {
      await writeCategoryCache(cacheKey, llmHit);
      if (options?.backfillDb) {
        await backfillMarketCategoryInDatabase(llmHit, {
          title: trimmedTitle,
          eventSlug,
          ticker: options.marketKey,
        });
      }
      return llmHit;
    }
  }

  const fallback: MarketFeedCategory = "OTHER";
  await writeCategoryCache(cacheKey, fallback);
  return fallback;
}

export interface MarketCategoryBackfillInput {
  title?: string;
  eventSlug?: string;
  ticker?: string;
}

/**
 * Backfill `category` on historical rows that share the same market identity.
 */
export async function backfillMarketCategoryInDatabase(
  category: MarketFeedCategory,
  input: MarketCategoryBackfillInput
): Promise<void> {
  const { isDatabaseEnabled } = await import("@/lib/crossmarket/store/db");
  if (!isDatabaseEnabled()) return;

  const { eq, sql } = await import("drizzle-orm");
  const { getDb } = await import("@/lib/crossmarket/store/db");
  const { feedTrades, kalshiShadowTrades } = await import(
    "@/lib/crossmarket/store/schema"
  );

  const db = getDb();
  const title = input.title?.trim();
  const ticker = input.ticker?.trim();

  try {
    if (title) {
      await db
        .update(feedTrades)
        .set({ category, updatedAt: sql`now()` })
        .where(eq(feedTrades.title, title));
    }

    if (ticker) {
      await db
        .update(kalshiShadowTrades)
        .set({ category })
        .where(eq(kalshiShadowTrades.ticker, ticker));
    } else if (title) {
      await db
        .update(kalshiShadowTrades)
        .set({ category })
        .where(sql`${kalshiShadowTrades.rawPayload}->>'title' = ${title}`);
    }
  } catch (error) {
    console.warn("[categorizer] category backfill failed", {
      error: error instanceof Error ? error.message : error,
    });
  }
}

// Re-export for server callers that only need regex (e.g. tests).
export { categorizeMarketByRegex } from "@/lib/categorizerRegex";
export { MARKET_FEED_CATEGORIES, normalizeMarketFeedCategory };
