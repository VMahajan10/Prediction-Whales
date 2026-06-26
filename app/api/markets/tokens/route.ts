import { NextResponse } from "next/server";
import { fetchTokenRegistry } from "@/lib/polymarket";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const registry = await fetchTokenRegistry();
    return NextResponse.json(registry);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch token registry";
    console.error("[api/markets/tokens]", message);
    return NextResponse.json(
      { tokenIds: [], tokens: {}, error: message },
      { status: 500 }
    );
  }
}
