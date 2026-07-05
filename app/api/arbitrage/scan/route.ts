import { NextRequest, NextResponse } from "next/server";
import {
  parseStakeUsd,
  scanArbitrageWindowsBatch,
  scanArbitrageWindowsWithStake,
} from "@/lib/arbitrageFinder/windowService";

export const dynamic = "force-dynamic";

interface ScanPairBody {
  polymarketTokenId?: string;
  kalshiTicker?: string;
  pmTokenId?: string;
  ticker?: string;
}

export async function POST(request: NextRequest) {
  try {
    let body: {
      pairs?: ScanPairBody[];
      stake?: number;
      stakeUsd?: number;
      bestOnly?: boolean;
      useCache?: boolean;
      mappingLimit?: number;
      maxCombinedCost?: number;
    };

    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body", results: [], windows: [] },
        { status: 400 }
      );
    }

    const stakeUsd = parseStakeUsd(body.stakeUsd ?? body.stake);
    const bestOnly = body.bestOnly ?? false;
    const useCache = body.useCache ?? true;
    const maxCombinedCost = body.maxCombinedCost;

    if (body.pairs?.length) {
      const pairs = body.pairs
        .map((pair) => ({
          polymarketTokenId:
            pair.polymarketTokenId ?? pair.pmTokenId ?? "",
          kalshiTicker: pair.kalshiTicker ?? pair.ticker ?? "",
        }))
        .filter((pair) => pair.polymarketTokenId && pair.kalshiTicker);

      const batch = await scanArbitrageWindowsBatch(pairs, {
        stakeUsd,
        bestOnly,
        useCache,
        maxCombinedCost,
      });

      return NextResponse.json({
        stakeUsd,
        results: batch.results,
        scanDurationMs: batch.scanDurationMs,
        actionableCount: batch.results.filter((r) => r.best?.isActionable).length,
      });
    }

    const scan = await scanArbitrageWindowsWithStake({
      stakeUsd,
      bestOnly,
      useCache,
      maxCombinedCost,
      mappingLimit: body.mappingLimit,
    });

    return NextResponse.json({
      stakeUsd,
      windows: scan.windows,
      scannedPairs: scan.scannedPairs,
      actionableCount: scan.actionableCount,
      scanDurationMs: scan.scanDurationMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Arbitrage batch scan failed";
    console.error("[api/arbitrage/scan] POST failed:", err);
    return NextResponse.json({ error: message, windows: [] }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const mappingLimitRaw = params.get("mappingLimit");
    const topRaw = params.get("top");
    const stakeUsd = parseStakeUsd(params.get("stake") ?? params.get("stakeUsd"));
    const actionableOnly = params.get("actionableOnly") !== "false";
    const mappingLimit = mappingLimitRaw
      ? parseInt(mappingLimitRaw, 10)
      : 250;
    const top = topRaw ? parseInt(topRaw, 10) : 50;

    const scan = await scanArbitrageWindowsWithStake({
      stakeUsd,
      mappingLimit: Number.isFinite(mappingLimit) ? mappingLimit : 250,
      bestOnly: false,
    });

    let windows = scan.windows;
    if (actionableOnly) {
      windows = windows.filter((w) => w.isActionable);
    }
    windows = windows
      .sort((a, b) => b.roiPercent - a.roiPercent)
      .slice(0, Math.max(1, Number.isFinite(top) ? top : 50));

    return NextResponse.json({
      stakeUsd,
      windows,
      scannedPairs: scan.scannedPairs,
      actionableCount: scan.actionableCount,
      scanDurationMs: scan.scanDurationMs,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Arbitrage scan failed";
    console.error("[api/arbitrage/scan] GET failed:", err);
    return NextResponse.json(
      { error: message, windows: [], scannedPairs: 0, actionableCount: 0 },
      { status: 500 }
    );
  }
}
