/**
 * Arbitrage Finder — Phase 2 unit tests (stake optimizer + service helpers).
 *
 * Usage:
 *   npm run test:arb-phase02
 */
import assert from "node:assert/strict";
import {
  applyVenueStakeConstraints,
  optimizeEqualPayoutStakeSplit,
} from "@/lib/finance/arbitrageStakeMath";
import {
  attachStakePlan,
  attachStakeToBestWindow,
  buildStakePlan,
} from "@/lib/arbitrageFinder/stakeOptimizer";
import { parseStakeUsd } from "@/lib/arbitrageFinder/windowService";
import type { ArbitrageWindow } from "@/lib/arbitrageFinder/types";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(
      `    ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

const actionableWindow: ArbitrageWindow = {
  windowId: "window:pair:12345:KXTEST:pm_yes_kalshi_no",
  mappingPairKey: "pair:12345:KXTEST",
  polymarketTokenId: "12345",
  kalshiTicker: "KXTEST",
  strategy: "pm_yes_kalshi_no",
  legs: [
    {
      venue: "polymarket",
      side: "YES",
      contractId: "12345",
      askPrice: 0.48,
      orderBookTs: Date.now(),
      source: "order_book",
    },
    {
      venue: "kalshi",
      side: "NO",
      contractId: "KXTEST",
      askPrice: 0.49,
      orderBookTs: Date.now(),
      source: "order_book",
    },
  ],
  combinedCost: 0.97,
  impliedSumPercent: 97,
  inverseOddsSumPercent: 97,
  isActionable: true,
  profitDeltaPerUnit: 0.03,
  roiPercent: 3.1,
  scannedAt: new Date().toISOString(),
  maxLegStalenessMs: 1000,
  orientation: "same",
  matchMethod: "fuzzy_title",
};

console.log("\nArbitrage Finder — Phase 2\n");

test("optimizeEqualPayoutStakeSplit splits stake by ask weights", () => {
  const split = optimizeEqualPayoutStakeSplit({
    legAAsk: 0.48,
    legBAsk: 0.49,
    totalStakeUsd: 500,
  });
  assert.ok(split);
  assert.equal(split!.legAStakeUsd + split!.legBStakeUsd, 500);
  assert.ok(split!.guaranteedPayoutUsd > 500);
  assert.ok(split!.lockedProfitUsd > 0);
  assert.ok(Math.abs(split!.lockedRoiPercent - 3.1) < 0.2);
});

test("optimizeEqualPayoutStakeSplit rejects non-actionable combined cost", () => {
  const split = optimizeEqualPayoutStakeSplit({
    legAAsk: 0.52,
    legBAsk: 0.51,
    totalStakeUsd: 500,
  });
  assert.equal(split, null);
});

test("buildStakePlan attaches ArbStakePlan to actionable window", () => {
  const plan = buildStakePlan(actionableWindow, { totalStakeUsd: 1000 });
  assert.ok(plan);
  assert.equal(plan!.totalStakeUsd, 1000);
  assert.equal(plan!.legStakesUsd[0] + plan!.legStakesUsd[1], 1000);
  assert.ok(plan!.lockedProfitUsd > 0);
});

test("attachStakePlan returns window with stakePlan", () => {
  const withStake = attachStakePlan(actionableWindow, { totalStakeUsd: 250 });
  assert.ok(withStake.stakePlan);
  assert.equal(withStake.stakePlan!.totalStakeUsd, 250);
});

test("attachStakeToBestWindow picks highest ROI actionable window", () => {
  const weaker: ArbitrageWindow = {
    ...actionableWindow,
    windowId: "window:weak",
    roiPercent: 1.2,
    combinedCost: 0.99,
  };
  const best = attachStakeToBestWindow([weaker, actionableWindow], {
    totalStakeUsd: 100,
  });
  assert.ok(best);
  assert.equal(best!.windowId, actionableWindow.windowId);
  assert.ok(best!.stakePlan);
});

test("applyVenueStakeConstraints scales up sub-minimum legs", () => {
  const split = optimizeEqualPayoutStakeSplit({
    legAAsk: 0.48,
    legBAsk: 0.49,
    totalStakeUsd: 5,
  });
  assert.ok(split);
  const adjusted = applyVenueStakeConstraints(split!, { pmMinUsd: 10 });
  assert.ok(adjusted.legAStakeUsd >= 10);
  assert.ok(adjusted.legBStakeUsd >= 10);
});

test("parseStakeUsd normalizes valid stake query values", () => {
  assert.equal(parseStakeUsd("500"), 500);
  assert.equal(parseStakeUsd(250.5), 250.5);
  assert.equal(parseStakeUsd("0"), null);
  assert.equal(parseStakeUsd("abc"), null);
});

console.log("\n" + "─".repeat(48));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("─".repeat(48) + "\n");

if (failed > 0) process.exit(1);
