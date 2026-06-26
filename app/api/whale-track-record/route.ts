import { NextResponse } from "next/server";
import {
  buildWhaleTrackRecord,
  needsTrackRecordRecompute,
  repairTrackRecord,
  resolveWalletByTradeHash,
} from "@/lib/polymarket";
import {
  getCachedTrackRecord,
  isTrackRecordCacheEnabled,
  setCachedTrackRecord,
} from "@/lib/whaleTrackStore";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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
    if (cached && !needsTrackRecordRecompute(cached.trackRecord)) {
      const trackRecord = repairTrackRecord(cached.trackRecord);
      return NextResponse.json({
        wallet,
        trackRecord,
        openPositionCount: cached.openPositionCount,
        categoryStats: cached.categoryStats ?? [],
        clvStats: cached.clvStats ?? null,
        resolved: true,
        cached: true,
        cacheEnabled: isTrackRecordCacheEnabled(),
      });
    }

    const result = await buildWhaleTrackRecord(wallet);
    const trackRecord = result.trackRecord
      ? repairTrackRecord(result.trackRecord)
      : null;

    if (trackRecord) {
      await setCachedTrackRecord(
        wallet,
        trackRecord,
        result.openPositionCount,
        result.categoryStats,
        result.clvStats
      );
    }

    return NextResponse.json({
      ...result,
      trackRecord,
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
