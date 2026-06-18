"use client";

import type { FeedTrade } from "@/lib/kalshiTrades";
import type { TradeSummary } from "@/lib/polymarket";
import type { WhaleTrade } from "@/lib/whaleTrades";

const SESSION_PREFIX = "marketpulse:pendingTrade:v1:";
const pendingByHash = new Map<string, TradeSummary>();

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
