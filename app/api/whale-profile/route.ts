import { NextResponse } from "next/server";
import {
  fetchMarkets,
  fetchTrades,
  type MarketSummary,
} from "@/lib/polymarket";
import {
  buildMarketContext,
  findMarketForTrade,
  findRelatedTrades,
  findTradeByHash,
} from "@/lib/whaleProfile";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function fetchKalshiMarkets(): Promise<MarketSummary[]> {
  try {
    const base =
      process.env.VERCEL_URL != null
        ? `https://${process.env.VERCEL_URL}`
        : "http://localhost:3000";
    const res = await fetch(`${base}/api/kalshi`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return [];
    const data: { markets?: MarketSummary[] } = await res.json();
    return data.markets ?? [];
  } catch {
    return [];
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const hash = searchParams.get("hash");

    if (!hash) {
      return NextResponse.json(
        { error: "Missing hash parameter" },
        { status: 400 }
      );
    }

    const [trades, pmMarkets, kalshiMarkets] = await Promise.all([
      fetchTrades(),
      fetchMarkets().catch(() => []),
      fetchKalshiMarkets(),
    ]);

    const trade = findTradeByHash(trades, hash);
    const relatedTrades = trade ? findRelatedTrades(trades, trade) : [];
    const allMarkets = [...pmMarkets, ...kalshiMarkets];
    const matchedMarket = trade ? findMarketForTrade(trade, allMarkets) : null;
    const marketContext = trade
      ? buildMarketContext(trade, matchedMarket)
      : {
          currentProbability: null,
          priceAtTrade: 0,
          delta: 0,
        };

    return NextResponse.json({
      trade,
      relatedTrades,
      marketContext,
      matchedMarket,
    });
  } catch (err) {
    return NextResponse.json(
      {
        trade: null,
        relatedTrades: [],
        marketContext: {
          currentProbability: null,
          priceAtTrade: 0,
          delta: 0,
        },
        matchedMarket: null,
        error: String(err),
      },
      { status: 500 }
    );
  }
}
