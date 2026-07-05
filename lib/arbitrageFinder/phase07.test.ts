/**
 * Arbitrage Finder — universal display resolver tests.
 *
 * Usage:
 *   npm run test:arb-phase07
 */
import assert from "node:assert/strict";
import { normalizeTradeOutcomeSide } from "@/lib/arbitrageFinder/displayUtils";
import {
  buildNeutralArbitrageSnapshot,
  hasSub100ArbitrageEdge,
} from "@/lib/arbitrageFinder/displayTypes";
import { evaluateBinaryBoxArbitrage } from "@/lib/finance/arbitrageEngine";

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

console.log("\nArbitrage Finder — Phase 7 (display)\n");

test("single-venue YES+NO math matches implied sum percent", () => {
  const math = evaluateBinaryBoxArbitrage(
    { askPrice: 0.48 },
    { askPrice: 0.49 }
  );
  assert.equal(math.impliedSumPercent, 97);
  assert.equal(math.isActionable, true);
  assert.ok(math.roiPercent > 0);
});

test("evaluateBinaryBoxArbitrage marks efficient market as non-actionable", () => {
  const math = evaluateBinaryBoxArbitrage(
    { askPrice: 0.52 },
    { askPrice: 0.51 }
  );
  assert.equal(math.isActionable, false);
  assert.equal(math.impliedSumPercent, 103);
});

test("normalizeTradeOutcomeSide maps yes/no labels", () => {
  assert.equal(normalizeTradeOutcomeSide("Yes"), "YES");
  assert.equal(normalizeTradeOutcomeSide("no"), "NO");
  assert.equal(normalizeTradeOutcomeSide("Maybe"), null);
});

test("sub-100 edge threshold is strict", () => {
  assert.equal(hasSub100ArbitrageEdge(99.9), true);
  assert.equal(hasSub100ArbitrageEdge(100), false);
  assert.equal(hasSub100ArbitrageEdge(100.1), false);
});

test("network fallback renders a finite neutral estimate", () => {
  const snapshot = buildNeutralArbitrageSnapshot({
    venue: "polymarket",
    contractId: "lol-token",
    referencePrice: 0.73,
  });
  assert.equal(snapshot.impliedSumPercent, 100);
  assert.equal(snapshot.legs[0].askPrice, 0.73);
  assert.ok(Math.abs(snapshot.legs[1].askPrice - 0.27) < 1e-9);
  assert.equal(snapshot.degraded, true);
  assert.equal(snapshot.isExecutable, false);
  assert.equal(snapshot.isActionable, false);
});

console.log("\n" + "─".repeat(48));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("─".repeat(48) + "\n");

if (failed > 0) process.exit(1);
