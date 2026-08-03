import { describe, expect, it } from "vitest";
import { collectUniqueWhaleAssetEvTargets } from "@/lib/evPipeline/whaleFeedEvTargets";

describe("collectUniqueWhaleAssetEvTargets", () => {
  it("dedupes multiple trades on the same PM asset", () => {
    const asset = "0xabc123";
    const targets = collectUniqueWhaleAssetEvTargets([
      { assetId: asset, price: 0.9 },
      { assetId: asset, price: 0.55 },
      { assetId: asset, price: 0.52 },
    ]);

    expect(targets).toHaveLength(1);
    expect(targets[0]!.assetId).toBe(asset.toLowerCase());
    expect(targets[0]!.tradePrice).toBe(0.52);
  });

  it("skips rows without assetId", () => {
    const targets = collectUniqueWhaleAssetEvTargets([
      { assetId: null, price: 0.5 },
      { assetId: "  ", price: 0.5 },
    ]);

    expect(targets).toHaveLength(0);
  });
});
