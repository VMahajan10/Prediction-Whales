/**
 * Arbitrage Finder — Phase 0–1 unit tests.
 *
 * Usage:
 *   npm run test:arb-phase01
 */
import assert from "node:assert/strict";
import {
  computeRoiPercent,
  evaluateBinaryBoxArbitrage,
  evaluateDirectionalWindows,
  formatInverseOddsSumPercent,
} from "@/lib/finance/arbitrageEngine";
import {
  derivePartialYesNoAsksFromOrderBook,
  deriveYesNoAsksFromOrderBook,
} from "@/lib/finance/orderBookQuotes";
import { completeYesNoQuoteCandidates } from "@/lib/arbitrageFinder/quoteFallbackLadder";
import {
  pickBestActionableWindow,
  scanArbitrageWindowsForPair,
} from "@/lib/arbitrageFinder/windowScanner";
import type { ArbPairMapping } from "@/lib/arbitrageFinder/types";

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

const sampleMapping: ArbPairMapping = {
  polymarketTokenId: "12345",
  kalshiTicker: "KXTEST-YES",
  orientation: "same",
  matchMethod: "fuzzy_title",
};

console.log("\nArbitrage Finder — Phase 0–1\n");

test("evaluateBinaryBoxArbitrage detects sub-100% implied sum", () => {
  const result = evaluateBinaryBoxArbitrage(
    { askPrice: 0.48 },
    { askPrice: 0.49 }
  );
  assert.equal(result.isActionable, true);
  assert.equal(result.combinedCost, 0.97);
  assert.equal(result.impliedSumPercent, 97);
  assert.equal(result.profitDeltaPerUnit, 0.03);
  assert.ok(result.roiPercent > 3);
});

test("evaluateBinaryBoxArbitrage rejects efficient market (sum >= 100%)", () => {
  const result = evaluateBinaryBoxArbitrage(
    { askPrice: 0.52 },
    { askPrice: 0.51 }
  );
  assert.equal(result.isActionable, false);
  assert.equal(result.rejectReason, "sum_gte_threshold");
  assert.equal(result.impliedSumPercent, 103);
});

test("formatInverseOddsSumPercent matches implied probability sum", () => {
  const inverse = formatInverseOddsSumPercent(0.48, 0.49);
  assert.equal(inverse, 97);
});

test("computeRoiPercent matches locked margin on capital", () => {
  assert.equal(computeRoiPercent(0.97), 3.1);
});

test("evaluateDirectionalWindows evaluates both directions", () => {
  const result = evaluateDirectionalWindows(0.48, 0.52, 0.51, 0.49);
  assert.ok(result.pmYesKalshiNo);
  assert.ok(result.kalshiYesPmNo);
  assert.equal(result.pmYesKalshiNo!.combinedCost, 0.97);
  assert.equal(result.kalshiYesPmNo!.combinedCost, 1.03);
  assert.equal(result.pmYesKalshiNo!.isActionable, true);
  assert.equal(result.kalshiYesPmNo!.isActionable, false);
});

test("deriveYesNoAsksFromOrderBook derives NO ask from YES bid", () => {
  const asks = deriveYesNoAsksFromOrderBook({
    bid: 0.46,
    ask: 0.48,
    mid: 0.47,
    ts: Date.now(),
  });
  assert.ok(asks);
  assert.equal(asks!.yesAsk, 0.48);
  assert.equal(asks!.noAsk, 0.54);
});

test("partial order book preserves YES ask when opposing bid is dry", () => {
  const asks = derivePartialYesNoAsksFromOrderBook({
    bid: null,
    ask: 0.73,
    mid: 0.73,
    ts: Date.now(),
  });
  assert.equal(asks.yesAsk, 0.73);
  assert.equal(asks.noAsk, null);
});

test("pTrue fills only the missing opposing quote", () => {
  const quotes = completeYesNoQuoteCandidates({
    venue: "polymarket",
    yesAsk: 0.73,
    noAsk: null,
    fairYes: 0.69,
    fairSource: "p_true",
  });
  assert.equal(quotes.yesAsk, 0.73);
  assert.equal(quotes.noAsk, 0.31);
  assert.equal(quotes.yesSource, "order_book");
  assert.equal(quotes.noSource, "p_true");
  assert.equal(quotes.isExecutable, false);
});

test("LoL team labels treat the token trade as the selected proposition", () => {
  const quotes = completeYesNoQuoteCandidates({
    venue: "polymarket",
    yesAsk: null,
    noAsk: null,
    tradeOutcomeSide: "T1",
    tradePrice: 0.73,
    fairYes: 0.69,
    fairSource: "p_true",
  });
  assert.equal(quotes.yesAsk, 0.73);
  assert.equal(quotes.noAsk, 0.31);
  assert.equal(quotes.yesSource, "trade_price");
  assert.equal(quotes.noSource, "p_true");
});

test("consensus and universal-prior tiers always return finite quotes", () => {
  for (const fairSource of ["consensus", "universal_prior"] as const) {
    const quotes = completeYesNoQuoteCandidates({
      venue: "polymarket",
      yesAsk: null,
      noAsk: null,
      fairYes: 0.57,
      fairSource,
    });
    assert.ok(Number.isFinite(quotes.yesAsk));
    assert.ok(Number.isFinite(quotes.noAsk));
    assert.equal(quotes.yesAsk + quotes.noAsk, 1);
    assert.equal(quotes.degraded, true);
  }
});

test("scanArbitrageWindowsForPair materializes ArbitrageWindow contract", () => {
  const now = Date.now();
  const windows = scanArbitrageWindowsForPair(
    {
      mapping: sampleMapping,
      pmOb: { bid: 0.46, ask: 0.48, mid: 0.47, ts: now },
      kalshiOb: { bid: 0.49, ask: 0.51, mid: 0.5, ts: now },
    },
    { scannedAt: "2026-06-22T00:00:00.000Z", nowMs: now }
  );

  assert.ok(windows.length >= 1);
  const best = pickBestActionableWindow(windows);
  assert.ok(best);
  assert.equal(best!.strategy, "pm_yes_kalshi_no");
  assert.equal(best!.polymarketTokenId, "12345");
  assert.equal(best!.kalshiTicker, "KXTEST-YES");
  assert.equal(best!.legs.length, 2);
  assert.ok(best!.isActionable);
  assert.ok(best!.windowId.includes("pair:12345:KXTEST-YES"));
});

test("scanArbitrageWindowsForPair skips inverted mappings", () => {
  const windows = scanArbitrageWindowsForPair({
    mapping: { ...sampleMapping, orientation: "inverted" },
    pmOb: { bid: 0.46, ask: 0.48, mid: 0.47, ts: Date.now() },
    kalshiOb: { bid: 0.48, ask: 0.5, mid: 0.49, ts: Date.now() },
  });
  assert.equal(windows.length, 0);
});

console.log("\n" + "─".repeat(48));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("─".repeat(48) + "\n");

if (failed > 0) process.exit(1);
