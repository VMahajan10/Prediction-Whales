import { NextResponse } from "next/server";
import { publicApiErrorMessage } from "@/lib/apiError";
import { getCrossMarketEvIndex } from "@/lib/crossMarketEvIndexStore";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const payload = await getCrossMarketEvIndex();
    return NextResponse.json({
      generatedAt: payload.generatedAt,
      entries: payload.entries,
      cachedAt: payload.cachedAt,
    });
  } catch (err) {
    console.error("[cross-market-ev/index]", err);
    return NextResponse.json(
      { error: publicApiErrorMessage(err, "Failed to load cross-market EV index") },
      { status: 500 }
    );
  }
}
