import {
  computeKalshiMarketFlow,
  fetchKalshiCandlesticks,
  fetchKalshiMarketDetail,
  fetchKalshiOrderBook,
  fetchKalshiTradesForTicker,
} from "@/lib/kalshiDetail";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const ticker = request.nextUrl.searchParams.get("ticker");
  const excludeTradeId = request.nextUrl.searchParams.get("exclude_trade_id");

  if (!ticker) {
    return NextResponse.json({ error: "ticker required" }, { status: 400 });
  }

  try {
    const [market, orderbook, candlesticks, tickerTrades] = await Promise.all([
      fetchKalshiMarketDetail(ticker),
      fetchKalshiOrderBook(ticker),
      fetchKalshiCandlesticks(ticker),
      fetchKalshiTradesForTicker(ticker, 150),
    ]);

    const marketFlow = computeKalshiMarketFlow(tickerTrades);
    const relatedTrades = tickerTrades
      .filter((t) => t.tradeId !== excludeTradeId)
      .slice(0, 10);

    return NextResponse.json({
      market,
      orderbook,
      candlesticks,
      marketFlow,
      relatedTrades,
    });
  } catch (err) {
    console.error("[api/kalshi/market-enrich]", err);
    return NextResponse.json(
      { error: "Failed to load Kalshi market enrichment" },
      { status: 502 }
    );
  }
}
