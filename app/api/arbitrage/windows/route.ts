import { NextRequest, NextResponse } from "next/server";
import { publicApiErrorMessage } from "@/lib/apiError";
import {
  getArbitrageWindowsForPair,
  parseStakeUsd,
} from "@/lib/arbitrageFinder/windowService";

export const dynamic = "force-dynamic";

function parseBoolean(raw: string | null, defaultValue: boolean): boolean {
  if (raw == null || raw === "") return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return defaultValue;
}

function parseMaxCombinedCost(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const pmTokenId =
      params.get("pmTokenId") ??
      params.get("tokenId") ??
      params.get("assetId");
    const kalshiTicker = params.get("kalshiTicker") ?? params.get("ticker");
    const stakeUsd = parseStakeUsd(params.get("stake") ?? params.get("stakeUsd"));
    const bestOnly = parseBoolean(params.get("bestOnly"), false);
    const useCache = parseBoolean(params.get("useCache"), true);
    const maxCombinedCost = parseMaxCombinedCost(
      params.get("maxCombinedCost")
    );

    if (!pmTokenId && !kalshiTicker) {
      return NextResponse.json(
        {
          error: "Provide pmTokenId and/or kalshiTicker",
          windows: [],
          best: null,
        },
        { status: 400 }
      );
    }

    const result = await getArbitrageWindowsForPair(
      { pmTokenId, kalshiTicker },
      {
        stakeUsd,
        bestOnly,
        useCache,
        maxCombinedCost,
      }
    );

    return NextResponse.json({
      pairKey: result.pairKey,
      windows: result.windows,
      best: result.best,
      fromCache: result.fromCache,
      stakeUsd,
    });
  } catch (err) {
    const message = publicApiErrorMessage(err, "Arbitrage window scan failed");
    console.error("[api/arbitrage/windows] GET failed:", err);
    return NextResponse.json({ error: message, windows: [], best: null }, { status: 500 });
  }
}
