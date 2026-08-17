"use client";

import { resolveAppApiUrl } from "@/lib/appBaseUrl";
import type { FeedTrade } from "@/lib/feedTradeTypes";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import {
  pipelineEvLookupKey,
} from "@/lib/evPipeline/types";
import { normalizePipelineTradeEv } from "@/lib/evPipeline/tradeEvRecord";
import { resolveFeedTradeEvPercent } from "@/lib/feedTradeEv";
import {
  enrichPipelineTradeEvCrossIds,
  indexPipelineTradeEvAliases,
  pipelineEvLookupAliases,
} from "@/lib/evPipeline/crossAssetLookup";
import {
  pipelineEvKeyForTrade,
  pipelineEvKeyForWhale,
} from "@/lib/pipelineEvLookupHelpers";
import type { PipelineEvRequestItem } from "@/lib/types/ev";
import type { MarketSummary } from "@/lib/polymarket";
import type { WhaleTrade } from "@/lib/whaleTrades";

export type { PipelineEvRequestItem } from "@/lib/types/ev";
export { pipelineEvKeyForTrade, pipelineEvKeyForWhale } from "@/lib/pipelineEvLookupHelpers";

const REFRESH_MS = 45_000;

export function resolvePolymarketPipelineTokenId(
  tradeAssetId?: string | null,
  matchedMarket?: Pick<MarketSummary, "clobTokenIds" | "source"> | null
): string | undefined {
  if (tradeAssetId?.trim()) return tradeAssetId.trim();
  if (
    matchedMarket?.source === "polymarket" &&
    matchedMarket.clobTokenIds?.[0]
  ) {
    return matchedMarket.clobTokenIds[0];
  }
  return undefined;
}

export function normalizePipelineEvEntry(
  entry: PipelineTradeEv | null | undefined,
  lookupKey?: string,
  executionPrice?: number | null
): PipelineTradeEv | null {
  if (!entry) return null;
  const enriched = enrichPipelineTradeEvCrossIds(entry, lookupKey ?? entry.key);
  const normalizeOptions =
    executionPrice != null ? { executionPrice } : undefined;
  return (
    normalizePipelineTradeEv(enriched, lookupKey ?? enriched.key, normalizeOptions) ??
    enriched
  );
}

type Listener = (index: Map<string, PipelineTradeEv>, loading: boolean) => void;

let index = new Map<string, PipelineTradeEv>();
let loading = true;
let listeners = new Set<Listener>();
let fetchPromise: Promise<void> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let subscriberCount = 0;
let lastItemsKey = "";
let activeRequestItems: PipelineEvRequestItem[] = [];

function notify(): void {
  listeners.forEach((listener) => {
    listener(index, loading);
  });
}

function feedTradeToRequestItem(
  trade: FeedTrade
): PipelineEvRequestItem | null {
  if (trade.source === "polymarket" && trade.assetId) {
    return {
      source: "polymarket",
      tokenId: trade.assetId,
      tradePrice: trade.price,
    };
  }
  if (trade.source === "kalshi" && trade.ticker) {
    return {
      source: "kalshi",
      kalshiTicker: trade.ticker,
      tradePrice: trade.price,
    };
  }
  return null;
}

export function whaleTradeToRequestItem(
  trade: WhaleTrade
): PipelineEvRequestItem | null {
  const platform = (trade.platform ?? trade.source ?? "").toLowerCase();
  if (platform === "polymarket" && trade.assetId) {
    return {
      source: "polymarket",
      tokenId: trade.assetId,
      tradePrice: trade.price,
    };
  }
  if (platform === "kalshi" && trade.ticker) {
    return {
      source: "kalshi",
      kalshiTicker: trade.ticker,
      tradePrice: trade.price,
    };
  }
  return null;
}

/** Resolve pipeline EV from batch index using pm:/kalshi:/pair: aliases. */
export function resolvePipelineEvForWhale(
  index: Map<string, PipelineTradeEv>,
  trade: WhaleTrade
): PipelineTradeEv | null {
  const key = pipelineEvKeyForWhale(trade);
  if (!key) return null;

  const direct = index.get(key);
  if (direct) {
    logPipelineEvDebug(trade, direct);
    return direct;
  }

  const platform = (trade.platform ?? trade.source ?? "").toLowerCase();
  const tokenId = platform === "polymarket" ? trade.assetId : undefined;
  const kalshiTicker = platform === "kalshi" ? trade.ticker : undefined;

  for (const alias of pipelineEvLookupAliases({
    key,
    tokenId: tokenId ?? null,
    kalshiTicker: kalshiTicker ?? null,
  })) {
    const hit = index.get(alias);
    if (hit) {
      logPipelineEvDebug(trade, hit);
      return hit;
    }
  }

  return null;
}

function logPipelineEvDebug(trade: WhaleTrade, pipeline: PipelineTradeEv): void {
  if (process.env.NODE_ENV === "production") return;

  const rawEv =
    pipeline.netEvPercent ??
    pipeline.averageEv ??
    pipeline.grossEvPercent ??
    null;
  const outputEv = resolveFeedTradeEvPercent(
    {
      price: trade.price,
      netEvPercent: trade.netEvPercent,
      grossEvPercent: trade.grossEvPercent,
    },
    pipeline
  );

  console.log(
    `[EV Debug] Market: ${trade.title} | Raw EV: ${rawEv ?? "null"} | Output EV: ${outputEv ?? "null"}`
  );
}

function dedupeRequestItems(
  items: PipelineEvRequestItem[]
): PipelineEvRequestItem[] {
  const unique = new Map<string, PipelineEvRequestItem>();
  for (const item of items) {
    const key = pipelineEvLookupKey(item);
    if (key) unique.set(key, item);
  }
  return Array.from(unique.values());
}

/** Assets resolved per request — buffer rows are listed first for priority hydration. */
const EV_BATCH_CHUNK_SIZE = 16;
/** Browser / remote EV HTTP — long enough for cold ensemble hydration. */
const EV_HTTP_TIMEOUT_MS = 60_000;

async function fetchPipelineEvHttp(
  url: string,
  init: RequestInit
): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(EV_HTTP_TIMEOUT_MS),
  });
}

function createTimeoutPipelineEvEntry(
  lookupKey: string,
  item: PipelineEvRequestItem
): PipelineTradeEv {
  return {
    key: lookupKey,
    status: "timeout",
    tokenId: item.tokenId?.trim().toLowerCase() ?? null,
    kalshiTicker: item.kalshiTicker?.trim().toUpperCase() ?? null,
    mappingPairKey: null,
    netEvPercent: null,
    netEv: 0,
    grossEv: 0,
    grossEvPercent: null,
    averageEv: null,
    pTrue: null,
    pMarket: null,
    pmMid: null,
    kalshiMid: null,
    pTrueSource: null,
    pTrueConfidence: null,
    pTrueLowConfidence: false,
    evFormulaVersion: null,
  };
}

async function fetchPipelineEvChunk(
  items: PipelineEvRequestItem[]
): Promise<Map<string, PipelineTradeEv>> {
  const fullUrl = resolveAppApiUrl("/api/ev/trades");
  const executionPriceByKey = new Map<string, number>();
  for (const item of items) {
    const lookupKey = pipelineEvLookupKey(item);
    if (!lookupKey || item.tradePrice == null) continue;
    if (!Number.isFinite(item.tradePrice)) continue;
    executionPriceByKey.set(lookupKey, item.tradePrice);
  }

  try {
    const res = await fetchPipelineEvHttp(fullUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });

    if (!res.ok) {
      console.warn(
        "[pipelineEvClient] EV batch HTTP error:",
        res.status,
        fullUrl
      );
      return softTimeoutChunkFallback(items);
    }

    const data = (await res.json()) as {
      entries?: PipelineTradeEv[];
      byKey?: Record<string, PipelineTradeEv>;
    };

    const next = new Map<string, PipelineTradeEv>();
    for (const entry of data.entries ?? []) {
      const normalized = normalizePipelineEvEntry(
        entry,
        entry.key,
        executionPriceByKey.get(entry.key)
      );
      if (normalized) indexPipelineTradeEvAliases(next, normalized, entry.key);
    }
    for (const [key, entry] of Object.entries(data.byKey ?? {})) {
      if (next.has(key)) continue;
      const normalized = normalizePipelineEvEntry(
        entry,
        key,
        executionPriceByKey.get(key)
      );
      if (normalized) indexPipelineTradeEvAliases(next, normalized, key);
    }
    return next;
  } catch (error) {
    const err = error as Error & { cause?: unknown };
    console.warn(
      "[pipelineEvClient] Failed target URL:",
      fullUrl,
      err?.cause || err
    );
    return softTimeoutChunkFallback(items);
  }
}

function softTimeoutChunkFallback(
  items: PipelineEvRequestItem[]
): Map<string, PipelineTradeEv> {
  const next = new Map<string, PipelineTradeEv>();
  for (const item of items) {
    const lookupKey = pipelineEvLookupKey(item);
    if (!lookupKey) continue;
    const timeoutEntry = createTimeoutPipelineEvEntry(lookupKey, item);
    indexPipelineTradeEvAliases(next, timeoutEntry, lookupKey);
  }
  return next;
}

export interface FetchPipelineEvBatchOptions {
  /** Called after each chunk resolves with everything accumulated so far. */
  onPartial?: (index: Map<string, PipelineTradeEv>) => void;
}

/** Shared POST /api/ev/trades batch fetch — returns map keyed by API `key` field. */
export async function fetchPipelineEvBatch(
  items: PipelineEvRequestItem[],
  options?: FetchPipelineEvBatchOptions
): Promise<Map<string, PipelineTradeEv>> {
  const deduped = dedupeRequestItems(items);
  if (deduped.length === 0) return new Map();

  const accumulated = new Map<string, PipelineTradeEv>();

  for (let i = 0; i < deduped.length; i += EV_BATCH_CHUNK_SIZE) {
    const chunk = deduped.slice(i, i + EV_BATCH_CHUNK_SIZE);
    const resolved = await fetchPipelineEvChunk(chunk);
    if (resolved.size === 0) continue;

    Array.from(resolved.entries()).forEach(([key, value]) => {
      accumulated.set(key, value);
    });
    options?.onPartial?.(new Map(accumulated));
  }

  return accumulated;
}

async function fetchPipelineEv(
  itemsKey: string,
  items: PipelineEvRequestItem[]
): Promise<void> {
  if (fetchPromise) return fetchPromise;

  fetchPromise = (async () => {
    try {
      const deduped = dedupeRequestItems(items);
      if (deduped.length === 0) {
        index = new Map();
        lastItemsKey = itemsKey;
        return;
      }

      const mergeIntoIndex = (fetched: Map<string, PipelineTradeEv>) => {
        const merged = new Map(index);
        Array.from(fetched.entries()).forEach(([key, value]) => {
          merged.set(key, value);
        });
        index = merged;
      };

      const fetched = await fetchPipelineEvBatch(deduped, {
        onPartial: (partial) => {
          mergeIntoIndex(partial);
          notify();
        },
      });
      mergeIntoIndex(fetched);
      lastItemsKey = itemsKey;
    } catch {
      // Optional enrichment — card falls back to em dash
    } finally {
      loading = false;
      notify();
      fetchPromise = null;
    }
  })();

  return fetchPromise;
}

export function subscribePipelineEvForTrades(
  trades: FeedTrade[],
  listener: Listener
): () => void {
  const items = trades
    .map(feedTradeToRequestItem)
    .filter((item): item is PipelineEvRequestItem => item != null);
  activeRequestItems = items;
  listeners.add(listener);
  subscriberCount += 1;

  const itemsKey = trades
    .map((t) => `${t.source}:${t.id}:${t.assetId ?? ""}:${t.ticker ?? ""}`)
    .join("|");

  listener(index, loading);

  if (itemsKey !== lastItemsKey) {
    loading = true;
    notify();
    void fetchPipelineEv(itemsKey, items);
  }

  if (subscriberCount === 1) {
    refreshTimer = setInterval(() => {
      void fetchPipelineEv(lastItemsKey, activeRequestItems);
    }, REFRESH_MS);
  }

  return () => {
    listeners.delete(listener);
    subscriberCount -= 1;
    if (subscriberCount === 0 && refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  };
}

export function buildWhalePipelineEvRequests(
  whales: WhaleTrade[]
): PipelineEvRequestItem[] {
  return dedupeRequestItems(
    whales
      .map(whaleTradeToRequestItem)
      .filter((item): item is PipelineEvRequestItem => item != null)
  );
}

export async function fetchPipelineTradeEv(input: {
  source: "polymarket" | "kalshi";
  tokenId?: string;
  kalshiTicker?: string;
  tradePrice?: number;
}): Promise<PipelineTradeEv | null> {
  const params = new URLSearchParams({ source: input.source });
  if (input.tokenId) params.set("tokenId", input.tokenId);
  if (input.kalshiTicker) params.set("kalshiTicker", input.kalshiTicker);
  if (input.tradePrice != null) {
    params.set("price", String(input.tradePrice));
  }

  const fullUrl = resolveAppApiUrl(`/api/ev/trades?${params.toString()}`);

  try {
    const res = await fetchPipelineEvHttp(fullUrl, { method: "GET" });
    if (!res.ok) {
      console.warn(
        "[pipelineEvClient] EV GET HTTP error:",
        res.status,
        fullUrl
      );
      const lookupKey = pipelineEvLookupKey(input);
      return lookupKey
        ? createTimeoutPipelineEvEntry(lookupKey, input)
        : null;
    }
    const data = (await res.json()) as { entry?: PipelineTradeEv | null };
    return data.entry ?? null;
  } catch (error) {
    const err = error as Error & { cause?: unknown };
    console.warn(
      "[pipelineEvClient] Failed target URL:",
      fullUrl,
      err?.cause || err
    );
    const lookupKey = pipelineEvLookupKey(input);
    return lookupKey ? createTimeoutPipelineEvEntry(lookupKey, input) : null;
  }
}
