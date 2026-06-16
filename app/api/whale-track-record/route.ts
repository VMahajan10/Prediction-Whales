import { NextResponse } from "next/server";
import {
  buildWhaleTrackRecord,
  resolveWalletByTradeHash,
} from "@/lib/polymarket";
import {
  getCachedTrackRecord,
  isTrackRecordCacheEnabled,
  setCachedTrackRecord,
} from "@/lib/whaleTrackStore";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const walletParam = searchParams.get("wallet");
  const hash = searchParams.get("hash");

  if (!walletParam && !hash) {
    return NextResponse.json(
      { error: "Provide wallet or hash query parameter" },
      { status: 400 }
    );
  }

  try {
    let wallet = walletParam?.toLowerCase() ?? null;

    if (!wallet && hash) {
      wallet = await resolveWalletByTradeHash(hash);
    }

    if (!wallet) {
      return NextResponse.json({
        wallet: null,
        trackRecord: null,
        openPositionCount: 0,
        categoryStats: [],
        clvStats: null,
        resolved: false,
      });
    }

    const cached = await getCachedTrackRecord(wallet);
    if (cached) {
      return NextResponse.json({
        wallet,
        trackRecord: cached.trackRecord,
        openPositionCount: cached.openPositionCount,
        categoryStats: cached.categoryStats ?? [],
        clvStats: cached.clvStats ?? null,
        resolved: true,
        cached: true,
        cacheEnabled: isTrackRecordCacheEnabled(),
      });
    }

    const result = await buildWhaleTrackRecord(wallet);

    if (result.trackRecord) {
      await setCachedTrackRecord(
        wallet,
        result.trackRecord,
        result.openPositionCount,
        result.categoryStats,
        result.clvStats
      );
    }

    return NextResponse.json({
      ...result,
      cached: false,
      cacheEnabled: isTrackRecordCacheEnabled(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch track record";
    console.error("[api/whale-track-record]", message);
    return NextResponse.json(
      {
        wallet: null,
        trackRecord: null,
        openPositionCount: 0,
        categoryStats: [],
        clvStats: null,
        resolved: false,
        error: message,
      },
      { status: 500 }
    );
  }
}
