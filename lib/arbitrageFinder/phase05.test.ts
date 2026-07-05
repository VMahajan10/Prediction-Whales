/**
 * Arbitrage Finder — Phase 5 feed utils tests.
 *
 * Usage:
 *   npm run test:arb-phase05
 */
import assert from "node:assert/strict";
import {
  filterActionableWindows,
  formatArbLockLabel,
  topArbitrageWindows,
} from "@/lib/arbitrageFinder/feedUtils";
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

function sampleWindow(
  id: string,
  roi: number,
  actionable: boolean
): ArbitrageWindow {
  return {
    windowId: id,
    mappingPairKey: `pair:${id}`,
    polymarketTokenId: "1234567890",
    kalshiTicker: "KXTEST",
    strategy: "pm_yes_kalshi_no",
    legs: [
      {
        venue: "polymarket",
        side: "YES",
        contractId: "1234567890",
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
    combinedCost: actionable ? 0.97 : 1.02,
    impliedSumPercent: actionable ? 97 : 102,
    inverseOddsSumPercent: actionable ? 97 : 102,
    isActionable: actionable,
    profitDeltaPerUnit: actionable ? 0.03 : -0.02,
    roiPercent: roi,
    scannedAt: new Date().toISOString(),
    maxLegStalenessMs: 1000,
    orientation: "same",
    matchMethod: "fuzzy_title",
  };
}

console.log("\nArbitrage Finder — Phase 5\n");

test("filterActionableWindows keeps only actionable rows", () => {
  const rows = filterActionableWindows([
    sampleWindow("a", 3, true),
    sampleWindow("b", 1, false),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.windowId, "a");
});

test("topArbitrageWindows sorts by ROI and caps results", () => {
  const rows = topArbitrageWindows(
    [
      sampleWindow("low", 1.2, true),
      sampleWindow("high", 4.5, true),
      sampleWindow("skip", 9, false),
    ],
    1
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.windowId, "high");
});

test("formatArbLockLabel renders signed lock percent", () => {
  assert.equal(formatArbLockLabel(sampleWindow("x", 2.3, true)), "+2.3% lock");
});

console.log("\n" + "─".repeat(48));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("─".repeat(48) + "\n");

if (failed > 0) process.exit(1);
