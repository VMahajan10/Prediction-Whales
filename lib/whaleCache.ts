"use client";

import type { TradeSummary } from "@/lib/polymarket";

/**
 * Client-side cache of live whale trades detected over the WebSocket.
 *
 * Live trades arrive in-browser (sub-second) but the REST Data API that the
 * whale detail page reads from is CDN-cached for ~300s. To bridge that gap we
 * persist each detected whale to localStorage keyed by transaction hash, so the
 * detail page can resolve it instantly on click instead of showing
 * "Whale trade not found" until the REST cache catches up.
 */

const STORAGE_KEY = "marketpulse:whaleCache:v1";
const MAX_ENTRIES = 300;
const TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

interface CacheEntry {
  trade: TradeSummary;
  cachedAt: number;
}

type CacheMap = Record<string, CacheEntry>;

function readMap(): CacheMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as CacheMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeMap(map: CacheMap): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Quota or serialization failure — non-fatal, cache is best-effort.
  }
}

function prune(map: CacheMap): CacheMap {
  const now = Date.now();
  const entries = Object.entries(map)
    .filter(([, e]) => now - e.cachedAt < TTL_MS)
    .sort((a, b) => b[1].cachedAt - a[1].cachedAt)
    .slice(0, MAX_ENTRIES);
  return Object.fromEntries(entries);
}

export function cacheWhaleTrade(trade: TradeSummary): void {
  const hash = trade.transactionHash;
  if (!hash) return;

  const map = readMap();
  if (map[hash]) return; // first-write wins; preserves original detection data

  map[hash] = { trade, cachedAt: Date.now() };
  writeMap(prune(map));
}

export function getCachedWhaleTrade(hash: string): TradeSummary | null {
  if (!hash) return null;
  const map = readMap();
  const entry = map[hash];
  if (!entry) return null;
  if (Date.now() - entry.cachedAt >= TTL_MS) return null;
  return entry.trade;
}
