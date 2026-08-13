import { NextResponse } from "next/server";
import { publicApiErrorMessage } from "@/lib/apiError";
import { fetchTokenRegistry } from "@/lib/polymarket";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const registry = await fetchTokenRegistry();
    return NextResponse.json(registry);
  } catch (error) {
    const message = publicApiErrorMessage(error, "Failed to fetch token registry");
    console.error("[api/markets/tokens]", error);
    return NextResponse.json(
      { tokenIds: [], tokens: {}, error: message },
      { status: 500 }
    );
  }
}
