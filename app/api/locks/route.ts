import { NextRequest, NextResponse } from "next/server";
import {
  parseStakeUsd,
  scanArbitrageWindowsWithStake,
} from "@/lib/arbitrageFinder/windowService";

export const dynamic = "force-dynamic";

const EMPTY_LOCKS = {
  locks: [],
  windows: [],
  scannedPairs: 0,
  actionableCount: 0,
  scanDurationMs: 0,
};

/** Cross-venue lock scanner — returns empty locks instead of hard-failing the UI. */
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
      locks: windows,
      windows,
      scannedPairs: scan.scannedPairs,
      actionableCount: scan.actionableCount,
      scanDurationMs: scan.scanDurationMs,
    });
  } catch (error) {
    console.error("[api/locks]", error);
    return NextResponse.json(EMPTY_LOCKS);
  }
}
