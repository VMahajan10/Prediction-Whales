"use client";

import type { FeedTrade } from "@/lib/kalshiTrades";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import {
  pipelineEvLookupKey,
  pipelineEvLookupKeyKalshi,
  pipelineEvLookupKeyPm,
} from "@/lib/evPipeline/types";
import { normalizePipelineTradeEv } from "@/lib/evPipeline/tradeEvRecord";
import type { WhaleTrade } from "@/lib/whaleTrades";

const REFRESH_MS = 45_000;

export interface PipelineEvRequestItem {
  source: "polymarket" | "kalshi";
  tokenId?: string;
  kalshiTicker?: string;
  tradePrice?: number;
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

export function pipelineEvKeyForTrade(trade: FeedTrade): string | null {
  if (trade.source === "polymarket" && trade.assetId) {
    return pipelineEvLookupKeyPm(trade.assetId);
  }
  if (trade.source === "kalshi" && trade.ticker) {
    return pipelineEvLookupKeyKalshi(trade.ticker);
  }
  return null;
}

export function pipelineEvKeyForWhale(trade: WhaleTrade): string | null {
  if (trade.source === "polymarket" && trade.assetId) {
    return pipelineEvLookupKeyPm(trade.assetId);
  }
  if (trade.source === "kalshi" && trade.ticker) {
    return pipelineEvLookupKeyKalshi(trade.ticker);
  }
  return null;
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

/** Shared POST /api/ev/trades batch fetch — returns map keyed by API `key` field. */
export async function fetchPipelineEvBatch(
  items: PipelineEvRequestItem[]
): Promise<Map<string, PipelineTradeEv>> {
  const deduped = dedupeRequestItems(items);
  if (deduped.length === 0) return new Map();

  const res = await fetch("/api/ev/trades", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: deduped }),
  });

  if (!res.ok) return new Map();

  const data: {
    entries?: PipelineTradeEv[];
    byKey?: Record<string, PipelineTradeEv>;
  } = await res.json();

  const next = new Map<string, PipelineTradeEv>();
  for (const entry of data.entries ?? []) {
    const normalized = normalizePipelineTradeEv(entry, entry.key);
    if (normalized) next.set(normalized.key, normalized);
  }
  for (const [key, entry] of Object.entries(data.byKey ?? {})) {
    if (next.has(key)) continue;
    const normalized = normalizePipelineTradeEv(entry, key);
    if (normalized) next.set(key, normalized);
  }
  return next;
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

      const fetched = await fetchPipelineEvBatch(deduped);
      const merged = new Map(index);
      Array.from(fetched.entries()).forEach(([key, value]) => {
        merged.set(key, value);
      });
      index = merged;
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

  const res = await fetch(`/api/ev/trades?${params.toString()}`);
  if (!res.ok) return null;
  const data: { entry?: PipelineTradeEv | null } = await res.json();
  return data.entry ?? null;
}
