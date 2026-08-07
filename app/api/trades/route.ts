import { NextResponse } from "next/server";
import { fetchTrades } from "@/lib/polymarket";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const trades = (await fetchTrades())
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 20);
    return NextResponse.json(
      {
        trades: trades.map((t) => ({
          ...t,
          proxyWallet: t.proxyWallet ?? undefined,
        })),
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
        },
      }
    );
  } catch (err) {
    console.error("[api/trades]", err);
    return NextResponse.json(
      { trades: [], error: String(err) },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
        },
      }
    );
  }
}
