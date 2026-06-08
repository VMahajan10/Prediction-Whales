import { NextResponse } from "next/server";
import { fetchMarkets } from "@/lib/polymarket";
import { fetchPredictItMarkets } from "@/lib/predictit";
import {
  buildMarketContext,
  findMarketForTrade,
  findRelatedTrades,
  findTradeByHash,
} from "@/lib/whaleProfile";
import type { TradeSummary } from "@/lib/polymarket";

async function fetchAllTrades(): Promise<TradeSummary[]> {
  const res = await fetch("https://data-api.polymarket.com/trades?limit=200", {
    next: { revalidate: 0 },
  });

  if (!res.ok) {
    throw new Error(`Trades API error: ${res.status}`);
  }

  const data = await res.json();
  const raw = Array.isArray(data) ? data : (data.trades ?? []);

  return raw.map(
    (
      t: {
        id?: string;
        market?: string;
        title?: string;
        side: "BUY" | "SELL";
        outcome?: string;
        outcomeIndex?: string;
        price: number;
        size?: number | string;
        usdcSize?: number | string;
        timestamp?: number;
        transactionHash?: string;
        txHash?: string;
      },
      index: number
    ): TradeSummary => ({
      id: t.id ?? `trade-${index}`,
      title: t.market ?? t.title ?? "Unknown",
      side: t.side,
      outcome: t.outcome ?? String(t.outcomeIndex ?? ""),
      price: t.price,
      size: parseFloat(String(t.size ?? t.usdcSize ?? 0)),
      timestamp: t.timestamp ?? Math.floor(Date.now() / 1000),
      transactionHash: t.transactionHash ?? t.txHash ?? "",
    })
  );
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

    const [trades, pmMarkets, piMarkets] = await Promise.all([
      fetchAllTrades(),
      fetchMarkets().catch(() => []),
      fetchPredictItMarkets().catch(() => []),
    ]);

    const trade = findTradeByHash(trades, hash);
    const relatedTrades = trade ? findRelatedTrades(trades, trade) : [];
    const allMarkets = [...pmMarkets, ...piMarkets];
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
