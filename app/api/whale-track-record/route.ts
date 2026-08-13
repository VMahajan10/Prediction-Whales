import { NextResponse } from "next/server";
import { publicApiErrorMessage } from "@/lib/apiError";
import {
  buildWhaleTrackRecord,
  needsTrackRecordRecompute,
  repairTrackRecord,
  resolveWalletByTradeHash,
} from "@/lib/polymarket";
import { resolveTraderIntelligence } from "@/lib/traderIntelligence";
import { loadPipelineTraderEvAnalytics } from "@/lib/evPipeline/traderEvLookup";
import { CLOSED_POSITIONS_API_LIMIT } from "@/lib/traderProfile";
import {
  getCachedTrackRecord,
  isTrackRecordCacheEnabled,
  setCachedTrackRecord,
} from "@/lib/whaleTrackStore";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const EMPTY_POSITIONS = {
  closedPositions: [] as const,
  openPositions: [] as const,
  closedPositionsFetched: 0,
  closedPositionsApiLimit: CLOSED_POSITIONS_API_LIMIT,
};

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
        crossMarketEvStats: null,
        traderIntelligence: null,
        pipelineEvAnalytics: null,
        resolved: false,
        ...EMPTY_POSITIONS,
      });
    }

    const pipelineEvAnalytics = await loadPipelineTraderEvAnalytics(wallet);

    const cached = await getCachedTrackRecord(wallet);
    if (cached && !needsTrackRecordRecompute(cached.trackRecord)) {
      const trackRecord = repairTrackRecord(cached.trackRecord);
      const traderIntelligence =
        resolveTraderIntelligence(
          cached.clvStats ?? null,
          cached.crossMarketEvStats ?? null,
          trackRecord,
          pipelineEvAnalytics
        );
      return NextResponse.json({
        wallet,
        trackRecord,
        openPositionCount: cached.openPositionCount,
        categoryStats: cached.categoryStats ?? [],
        clvStats: cached.clvStats ?? null,
        crossMarketEvStats: cached.crossMarketEvStats ?? null,
        traderIntelligence,
        pipelineEvAnalytics,
        closedPositions: cached.closedPositions ?? [],
        openPositions: cached.openPositions ?? [],
        closedPositionsFetched:
          cached.closedPositionsFetched ?? cached.closedPositions?.length ?? 0,
        closedPositionsApiLimit:
          cached.closedPositionsApiLimit ?? CLOSED_POSITIONS_API_LIMIT,
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
        result.clvStats,
        result.crossMarketEvStats,
        result.closedPositions,
        result.openPositions,
        result.closedPositionsFetched,
        result.closedPositionsApiLimit
      );
    }

    return NextResponse.json({
      ...result,
      trackRecord,
      traderIntelligence: resolveTraderIntelligence(
        result.clvStats ?? null,
        result.crossMarketEvStats ?? null,
        trackRecord,
        pipelineEvAnalytics
      ),
      pipelineEvAnalytics,
      cached: false,
      cacheEnabled: isTrackRecordCacheEnabled(),
    });
  } catch (error) {
    const message = publicApiErrorMessage(error, "Failed to fetch track record");
    console.error("[api/whale-track-record]", error);
    return NextResponse.json(
      {
        wallet: null,
        trackRecord: null,
        openPositionCount: 0,
        categoryStats: [],
        clvStats: null,
        crossMarketEvStats: null,
        traderIntelligence: null,
        resolved: false,
        error: message,
        ...EMPTY_POSITIONS,
      },
      { status: 500 }
    );
  }
}
