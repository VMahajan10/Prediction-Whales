import "server-only";

import {
  fetchTradesFromDataApi,
  type TradeSummary,
} from "@/lib/polymarket";

const DEFAULT_TTL_MS = 45_000;

type TradesCacheState = {
  trades: TradeSummary[];
  byHash: Map<string, TradeSummary>;
  fetchedAt: number;
};

function ttlMs(): number {
  const raw = process.env.POLYMARKET_TRADES_CACHE_TTL_MS;
  if (raw == null || raw === "") return DEFAULT_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

function getState(): TradesCacheState {
  const g = globalThis as typeof globalThis & {
    __polymarketTradesCache?: TradesCacheState;
  };
  if (!g.__polymarketTradesCache) {
    g.__polymarketTradesCache = {
      trades: [],
      byHash: new Map(),
      fetchedAt: 0,
    };
  }
  return g.__polymarketTradesCache;
}

function indexTrades(trades: TradeSummary[]): Map<string, TradeSummary> {
  const byHash = new Map<string, TradeSummary>();
  for (const t of trades) {
    const h = t.transactionHash?.toLowerCase();
    if (h && !byHash.has(h)) byHash.set(h, t);
  }
  return byHash;
}

/** Shared in-memory cache for Data API `/trades` poll (trade detail + list routes). */
export async function getCachedPolymarketTradesList(): Promise<TradeSummary[]> {
  const state = getState();
  if (
    state.trades.length > 0 &&
    Date.now() - state.fetchedAt < ttlMs()
  ) {
    return state.trades;
  }

  const trades = await fetchTradesFromDataApi();
  state.trades = trades;
  state.byHash = indexTrades(trades);
  state.fetchedAt = Date.now();
  return trades;
}

export async function getCachedPolymarketTradeByHash(
  hash: string
): Promise<TradeSummary | null> {
  const normalized = decodeURIComponent(hash).trim().toLowerCase();
  if (!normalized) return null;

  const state = getState();
  if (
    state.byHash.size > 0 &&
    Date.now() - state.fetchedAt < ttlMs()
  ) {
    const hit = state.byHash.get(normalized);
    if (hit) return hit;
  }

  await getCachedPolymarketTradesList();
  return getState().byHash.get(normalized) ?? null;
}

export function peekCachedPolymarketTradesList(): TradeSummary[] | null {
  const state = getState();
  if (state.trades.length === 0 || Date.now() - state.fetchedAt >= ttlMs()) {
    return null;
  }
  return state.trades;
}
