"use client";

import type { FeedTrade } from "@/lib/kalshiTrades";
import type { KalshiTradeDetail } from "@/lib/kalshiDetail";
import { feedTradeToKalshiDetail } from "@/lib/kalshiDetail";
import type { TradeSummary } from "@/lib/polymarket";
import type { WhaleTrade } from "@/lib/whaleTrades";

const SESSION_PREFIX = "marketpulse:pendingTrade:v1:";
const KALSHI_SESSION_PREFIX = "marketpulse:pendingKalshiTrade:v1:";
const pendingByHash = new Map<string, TradeSummary>();
const pendingKalshiById = new Map<string, KalshiTradeDetail>();

function hashKey(hash: string): string {
  return decodeURIComponent(hash).toLowerCase();
}

function sessionKey(key: string): string {
  return `${SESSION_PREFIX}${key}`;
}

export function feedTradeToSummary(trade: FeedTrade): TradeSummary | null {
  if (!trade.transactionHash) return null;
  return {
    id: trade.id,
    title: trade.title,
    side: trade.side,
    outcome: trade.outcome,
    price: trade.price,
    size: trade.usdNotional,
    timestamp: trade.timestamp,
    transactionHash: trade.transactionHash,
    slug: trade.slug,
  };
}

export function stashTradeForNavigation(trade: TradeSummary | WhaleTrade): void {
  if (!trade.transactionHash) return;
  const key = hashKey(trade.transactionHash);
  pendingByHash.set(key, trade);
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(sessionKey(key), JSON.stringify(trade));
    } catch {
      // In-memory map still works
    }
  }
}

export function consumeStashedTrade(hash: string): TradeSummary | null {
  const key = hashKey(hash);
  const fromMemory = pendingByHash.get(key);
  if (fromMemory) {
    pendingByHash.delete(key);
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.removeItem(sessionKey(key));
      } catch {
        // ignore
      }
    }
    return fromMemory;
  }

  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(sessionKey(key));
    if (!raw) return null;
    window.sessionStorage.removeItem(sessionKey(key));
    return JSON.parse(raw) as TradeSummary;
  } catch {
    return null;
  }
}

function kalshiSessionKey(tradeId: string): string {
  return `${KALSHI_SESSION_PREFIX}${tradeId}`;
}

function normalizeKalshiTradeId(tradeId: string): string {
  return decodeURIComponent(tradeId);
}

/** Read stashed Kalshi trade without removing it (safe for Strict Mode remounts). */
export function peekStashedKalshiTrade(
  tradeId: string
): { trade: KalshiTradeDetail; ticker: string } | null {
  const key = normalizeKalshiTradeId(tradeId);
  const fromMemory = pendingKalshiById.get(key);
  if (fromMemory) {
    return { trade: fromMemory, ticker: fromMemory.ticker };
  }

  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(kalshiSessionKey(key));
    if (!raw) return null;
    return JSON.parse(raw) as { trade: KalshiTradeDetail; ticker: string };
  } catch {
    return null;
  }
}

/** Synchronous stash read for first paint (avoids skeleton flash on feed navigation). */
export function initialKalshiTradeFromStash(
  tradeId: string
): KalshiTradeDetail | null {
  return peekStashedKalshiTrade(tradeId)?.trade ?? null;
}

export function stashKalshiTradeForNavigation(trade: FeedTrade): void {
  const detail = feedTradeToKalshiDetail(trade);
  if (!detail) return;
  const key = detail.tradeId;
  pendingKalshiById.set(key, detail);
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(
        kalshiSessionKey(key),
        JSON.stringify({ trade: detail, ticker: detail.ticker })
      );
    } catch {
      // In-memory map still works
    }
  }
}

export function consumeStashedKalshiTrade(
  tradeId: string
): { trade: KalshiTradeDetail; ticker: string } | null {
  const key = normalizeKalshiTradeId(tradeId);
  const fromMemory = pendingKalshiById.get(key);
  if (fromMemory) {
    pendingKalshiById.delete(key);
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.removeItem(kalshiSessionKey(key));
      } catch {
        // ignore
      }
    }
    return { trade: fromMemory, ticker: fromMemory.ticker };
  }

  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(kalshiSessionKey(key));
    if (!raw) return null;
    window.sessionStorage.removeItem(kalshiSessionKey(key));
    return JSON.parse(raw) as { trade: KalshiTradeDetail; ticker: string };
  } catch {
    return null;
  }
}
