import { fetchTokenPriceHistory } from "@/lib/backtest/priceHistory";
import type { MarketResolution } from "@/lib/backtest/types";

const SETTLE_NEAR = 0.05;

/**
 * When Gamma has no row for an older market, infer resolution time from the
 * outcome token's CLOB series (last observation = when trading stopped).
 */
export async function supplementResolutionFromClob(
  resolution: MarketResolution,
  assetIds: string[]
): Promise<MarketResolution> {
  if (resolution.resolutionFinal && resolution.resolvedAt != null) {
    return resolution;
  }

  for (const assetId of assetIds) {
    const { points } = await fetchTokenPriceHistory(assetId);
    if (points.length < 2) continue;

    const sorted = [...points].sort((a, b) => a.t - b.t);
    const tail = sorted.slice(-6);
    if (tail.length < 3) continue;

    const settledHigh = tail.every((pt) => pt.p >= 1 - SETTLE_NEAR);
    const settledLow = tail.every((pt) => pt.p <= SETTLE_NEAR);
    if (!settledHigh && !settledLow) {
      continue;
    }

    let collapseStart = sorted.length;
    const settled = settledHigh ? 1 : 0;
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      const near =
        settled === 1
          ? sorted[i].p >= 1 - SETTLE_NEAR
          : sorted[i].p <= SETTLE_NEAR;
      if (near) collapseStart = i;
      else break;
    }
    if (collapseStart === 0 || collapseStart >= sorted.length) continue;

    const resolvedAt = sorted[collapseStart].t;
    if (!Number.isFinite(resolvedAt) || resolvedAt <= 0) continue;

    return {
      ...resolution,
      marketTitle: resolution.marketTitle,
      resolutionFinal: true,
      resolutionStatus: "resolved",
      resolvedAt,
      winningAsset: settledHigh ? assetId : resolution.winningAsset,
    };
  }

  return resolution;
}
