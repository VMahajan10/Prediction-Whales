import { NextResponse } from "next/server";
import { fetchWhaleBackfill } from "@/lib/polymarket";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const trades = await fetchWhaleBackfill();
    return NextResponse.json({ trades });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch whale backfill";
    console.error("[api/whales/backfill]", message);
    return NextResponse.json({ trades: [], error: message }, { status: 500 });
  }
}
