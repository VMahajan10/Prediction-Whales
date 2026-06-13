import { NextResponse } from "next/server";
import { fetchTrades } from "@/lib/polymarket";

export async function GET() {
  try {
    const trades = await fetchTrades();
    return NextResponse.json(
      { trades },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
        },
      }
    );
  } catch (err) {
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
