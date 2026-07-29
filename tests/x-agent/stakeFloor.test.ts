import { describe, expect, it } from "vitest";
import {
  classifyStakeFloorTier,
  resolveStakeFloorUsd,
  STAKE_FLOOR_DEFAULT_USD,
  STAKE_FLOOR_MACRO_POLITICAL_USD,
  STAKE_FLOOR_SPORTS_ENTERTAINMENT_USD,
} from "@/lib/x-agent/stakeFloor";

describe("stakeFloor", () => {
  it("classifies sports markets at the $10k tier", () => {
    const resolution = resolveStakeFloorUsd("Lakers vs Celtics NBA game");
    expect(classifyStakeFloorTier("Lakers vs Celtics NBA game")).toBe(
      "sports_entertainment"
    );
    expect(resolution.tier).toBe("sports_entertainment");
    expect(resolution.floorUsd).toBe(STAKE_FLOOR_SPORTS_ENTERTAINMENT_USD);
  });

  it("classifies entertainment markets at the $10k tier", () => {
    const resolution = resolveStakeFloorUsd("Will the movie win an Oscar?");
    expect(resolution.tier).toBe("sports_entertainment");
    expect(resolution.floorUsd).toBe(STAKE_FLOOR_SPORTS_ENTERTAINMENT_USD);
  });

  it("classifies political markets at the $25k tier", () => {
    const resolution = resolveStakeFloorUsd(
      "Will Trump win the 2028 presidential election?"
    );
    expect(resolution.tier).toBe("macro_political");
    expect(resolution.floorUsd).toBe(STAKE_FLOOR_MACRO_POLITICAL_USD);
  });

  it("classifies macro liquidity markets at the $25k tier", () => {
    const resolution = resolveStakeFloorUsd("Fed rate cut in March?");
    expect(resolution.tier).toBe("macro_political");
    expect(resolution.floorUsd).toBe(STAKE_FLOOR_MACRO_POLITICAL_USD);
  });

  it("uses the $15k default tier for uncategorized markets", () => {
    const resolution = resolveStakeFloorUsd("Will China invade Taiwan?");
    expect(resolution.tier).toBe("default");
    expect(resolution.floorUsd).toBe(STAKE_FLOOR_DEFAULT_USD);
  });
});
