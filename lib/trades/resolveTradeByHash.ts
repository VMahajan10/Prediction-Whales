import "server-only";

import { sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { feedTrades } from "@/lib/crossmarket/store/schema";
import type { TradeSummary } from "@/lib/polymarket";
import { normalizeTrade, type DataTrade } from "@/lib/polymarket";
import {
  getCachedPolymarketTradeByHash,
  getCachedPolymarketTradesList,
  peekCachedPolymarketTradesList,
} from "@/lib/trades/polymarketTradesCache";
import { findRelatedTrades, findTradeByHash } from "@/lib/whaleProfile";

const DETAIL_RESPONSE_TTL_MS = 60_000;

type DetailCacheEntry = {
  trade: TradeSummary;
  relatedTrades: TradeSummary[];
  cachedAt: number;
};

function detailCache(): Map<string, DetailCacheEntry> {
  const g = globalThis as typeof globalThis & {
    __tradeDetailResponseCache?: Map<string, DetailCacheEntry>;
  };
  if (!g.__tradeDetailResponseCache) {
    g.__tradeDetailResponseCache = new Map();
  }
  return g.__tradeDetailResponseCache;
}

function normalizeHash(hash: string): string {
  return decodeURIComponent(hash).trim().toLowerCase();
}

function feedRowToTradeSummary(
  row: typeof feedTrades.$inferSelect
): TradeSummary | null {
  const hash = row.transactionHash?.trim();
  if (row.payload && typeof row.payload === "object") {
    const raw = row.payload as DataTrade;
    if (raw.transactionHash || hash) {
      const merged: DataTrade = {
        ...raw,
        transactionHash: raw.transactionHash || hash || row.tradeId,
        title: raw.title || row.title,
        proxyWallet: raw.proxyWallet ?? row.proxyWallet ?? undefined,
      };
      return normalizeTrade(merged, 0);
    }
  }
  if (!hash) return null;
  const ts = Math.floor(row.tradedAt.getTime() / 1000);
  return {
    id: row.tradeId,
    title: row.title,
    side: "BUY",
    outcome: "Yes",
    price: 0.5,
    size: row.stakeAmount,
    timestamp: ts,
    transactionHash: hash,
    proxyWallet: row.proxyWallet ?? undefined,
  };
}

async function loadTradeFromFeedDb(
  hash: string
): Promise<TradeSummary | null> {
  if (!isDatabaseEnabled()) return null;
  const db = getDb();
  const rows = await db
    .select()
    .from(feedTrades)
    .where(sql`lower(${feedTrades.transactionHash}) = ${hash}`)
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return feedRowToTradeSummary(row);
}

export async function resolvePolymarketTradeDetail(
  hash: string
): Promise<{ trade: TradeSummary | null; relatedTrades: TradeSummary[] }> {
  const normalized = normalizeHash(hash);
  if (!normalized) {
    return { trade: null, relatedTrades: [] };
  }

  const cachedDetail = detailCache().get(normalized);
  if (cachedDetail && Date.now() - cachedDetail.cachedAt < DETAIL_RESPONSE_TTL_MS) {
    return {
      trade: cachedDetail.trade,
      relatedTrades: cachedDetail.relatedTrades,
    };
  }

  let trade =
    (await loadTradeFromFeedDb(normalized)) ??
    (await getCachedPolymarketTradeByHash(normalized));

  if (!trade) {
    const trades = await getCachedPolymarketTradesList();
    trade = findTradeByHash(trades, normalized);
  }

  if (!trade) {
    return { trade: null, relatedTrades: [] };
  }

  const list =
    peekCachedPolymarketTradesList() ?? (await getCachedPolymarketTradesList());
  const relatedTrades = findRelatedTrades(list, trade);

  detailCache().set(normalized, {
    trade,
    relatedTrades,
    cachedAt: Date.now(),
  });

  return { trade, relatedTrades };
}
