import {
  computeKalshiMarketFlow,
  fetchKalshiCandlesticks,
  fetchKalshiMarketDetail,
  fetchKalshiOrderBook,
  fetchKalshiTradesForTicker,
  findKalshiTradeById,
} from "@/lib/kalshiDetail";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

let cache: Map<
  string,
  { data: unknown; timestamp: number }
> = new Map();

const CACHE_MS = 15_000;

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache(key: string, data: unknown): void {
  cache.set(key, { data, timestamp: Date.now() });
  if (cache.size > 200) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
}

export async function GET(request: NextRequest) {
  const tradeId = request.nextUrl.searchParams.get("trade_id");
  const ticker = request.nextUrl.searchParams.get("ticker");

  if (!tradeId) {
    return NextResponse.json(
      { error: "trade_id required" },
      { status: 400 }
    );
  }

  const cacheKey = `${tradeId}:${ticker ?? ""}`;
  const cached = getCached(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    const trade = await findKalshiTradeById(tradeId, ticker ?? undefined);
    if (!trade) {
      return NextResponse.json({ error: "Trade not found" }, { status: 404 });
    }

    const resolvedTicker = trade.ticker;

    const [market, orderbook, candlesticks, tickerTrades] = await Promise.all([
      fetchKalshiMarketDetail(resolvedTicker),
      fetchKalshiOrderBook(resolvedTicker),
      fetchKalshiCandlesticks(resolvedTicker),
      fetchKalshiTradesForTicker(resolvedTicker, 150),
    ]);

    const marketFlow = computeKalshiMarketFlow(tickerTrades);
    const relatedTrades = tickerTrades
      .filter((t) => t.tradeId !== trade.tradeId)
      .slice(0, 10);

    const payload = {
      trade,
      market,
      orderbook,
      candlesticks,
      marketFlow,
      relatedTrades,
    };

    setCache(cacheKey, payload);
    return NextResponse.json(payload);
  } catch (err) {
    console.error("[api/kalshi/trade-detail]", err);
    return NextResponse.json(
      { error: "Failed to load Kalshi trade detail" },
      { status: 502 }
    );
  }
}
