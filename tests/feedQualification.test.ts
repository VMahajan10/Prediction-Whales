import { describe, expect, it } from "vitest";
import {
  isQualifiedFeedTrade,
  meetsFeedStakeThreshold,
  meetsWalletAvgEvThreshold,
  MIN_AVG_EV_THRESHOLD,
  MIN_STAKE_THRESHOLD,
} from "@/lib/feedQualification";

describe("feedQualification", () => {
  it("enforces the minimum stake threshold", () => {
    expect(meetsFeedStakeThreshold(MIN_STAKE_THRESHOLD)).toBe(true);
    expect(meetsFeedStakeThreshold(MIN_STAKE_THRESHOLD - 1)).toBe(false);
  });

  it("enforces the minimum wallet avg EV threshold", () => {
    expect(meetsWalletAvgEvThreshold(MIN_AVG_EV_THRESHOLD)).toBe(true);
    expect(meetsWalletAvgEvThreshold(MIN_AVG_EV_THRESHOLD - 0.001)).toBe(
      false
    );
    expect(meetsWalletAvgEvThreshold(-0.001)).toBe(false);
  });

  it("blocks unqualified trades when wallet avg EV is known", () => {
    expect(
      isQualifiedFeedTrade({
        stakeUsd: MIN_STAKE_THRESHOLD,
        walletAvgEv: -0.011,
        resolvedBetsCount: 400,
      })
    ).toBe(false);

    expect(
      isQualifiedFeedTrade({
        stakeUsd: MIN_STAKE_THRESHOLD,
        walletAvgEv: MIN_AVG_EV_THRESHOLD,
        resolvedBetsCount: 400,
      })
    ).toBe(true);
  });
});
