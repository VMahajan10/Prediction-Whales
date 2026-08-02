/**
 * Arbitrage Finder — Phase 6 observability tests.
 *
 * Usage:
 *   npm run test:arb-phase06
 */
import assert from "node:assert/strict";
import {
  aggregateScanCoverage,
  diagnosePairScan,
  formatArbitrageScanCoverageSummary,
  ARB_ORDER_BOOK_STALE_MS,
} from "@/lib/arbitrageFinder/observability/pairDiagnostics";
import { pipelineMappingPairKey } from "@/lib/evPipeline/crossAssetLookup";
import { mappingRedisPairKey } from "@/lib/evPipeline/redisCache";
import type {
  ArbPairMapping,
  ArbitrageWindow,
} from "@/lib/arbitrageFinder/types";

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

const mapping: ArbPairMapping = {
  polymarketTokenId: "abc123",
  kalshiTicker: "KXTEST",
  orientation: "same",
  matchMethod: "vector",
};

const nowMs = 1_700_000_000_000;

function sampleWindow(actionable: boolean): ArbitrageWindow {
  return {
    windowId: "window:test:pm_yes_kalshi_no",
    mappingPairKey: "pair:test",
    polymarketTokenId: mapping.polymarketTokenId,
    kalshiTicker: mapping.kalshiTicker,
    strategy: "pm_yes_kalshi_no",
    legs: [
      {
        venue: "polymarket",
        side: "YES",
        contractId: mapping.polymarketTokenId,
        askPrice: 0.48,
        orderBookTs: nowMs - 5_000,
        source: "order_book",
      },
      {
        venue: "kalshi",
        side: "NO",
        contractId: mapping.kalshiTicker,
        askPrice: 0.49,
        orderBookTs: nowMs - 10_000,
        source: "order_book",
      },
    ],
    combinedCost: actionable ? 0.97 : 1.02,
    impliedSumPercent: actionable ? 97 : 102,
    inverseOddsSumPercent: actionable ? 97 : 102,
    isActionable: actionable,
    profitDeltaPerUnit: actionable ? 0.03 : -0.02,
    roiPercent: actionable ? 3.1 : -2,
    scannedAt: new Date(nowMs).toISOString(),
    maxLegStalenessMs: 10_000,
    orientation: "same",
    matchMethod: "vector",
  };
}

console.log("\nArbitrage Finder — Phase 6\n");

test("diagnosePairScan flags missing order books", () => {
  const diagnostic = diagnosePairScan({
    mapping,
    pmOb: null,
    kalshiOb: null,
    windows: [],
    nowMs,
  });
  assert.equal(diagnostic.hasBothOrderBooks, false);
  assert.ok(diagnostic.rejectReasons.includes("missing_order_book"));
});

test("diagnosePairScan marks stale books above threshold", () => {
  const diagnostic = diagnosePairScan({
    mapping,
    pmOb: { bid: 0.49, ask: 0.51, mid: 0.5, ts: nowMs - ARB_ORDER_BOOK_STALE_MS - 1 },
    kalshiOb: { bid: 0.49, ask: 0.51, mid: 0.5, ts: nowMs - 1_000 },
    windows: [],
    nowMs,
  });
  assert.equal(diagnostic.isStale, true);
});

test("aggregateScanCoverage computes rates and top ROI", () => {
  const windows = [sampleWindow(true), sampleWindow(false)];
  const diagnostics = [
    diagnosePairScan({
      mapping,
      pmOb: { bid: 0.49, ask: 0.51, mid: 0.5, ts: nowMs - 1_000 },
      kalshiOb: { bid: 0.49, ask: 0.51, mid: 0.5, ts: nowMs - 2_000 },
      windows: [windows[0]!],
      nowMs,
    }),
    diagnosePairScan({
      mapping: { ...mapping, kalshiTicker: "KXOTHER" },
      pmOb: null,
      kalshiOb: { bid: 0.49, ask: 0.51, mid: 0.5, ts: nowMs - 1_000 },
      windows: [],
      nowMs,
    }),
  ];

  const report = aggregateScanCoverage({
    diagnostics,
    windows,
    scanDurationMs: 42,
    scannedAt: new Date(nowMs).toISOString(),
    mappingLimit: 250,
    totalMappingsInDb: 500,
    redisEnabled: true,
  });

  assert.equal(report.scannedPairs, 2);
  assert.equal(report.pairsWithBothBooks, 1);
  assert.equal(report.pairsMissingPmBook, 1);
  assert.equal(report.actionableWindowCount, 1);
  assert.equal(report.topActionableRoiPercent, 3.1);
  assert.ok(report.bothBooksRatePercent === 50);
});

test("formatArbitrageScanCoverageSummary includes key lines", () => {
  const report = aggregateScanCoverage({
    diagnostics: [
      diagnosePairScan({
        mapping,
        pmOb: { bid: null, ask: null, mid: 0.5, ts: nowMs - 1_000 },
        kalshiOb: { bid: null, ask: null, mid: 0.5, ts: nowMs - 2_000 },
        windows: [sampleWindow(true)],
        nowMs,
      }),
    ],
    windows: [sampleWindow(true)],
    scanDurationMs: 10,
    scannedAt: new Date(nowMs).toISOString(),
    mappingLimit: 100,
    totalMappingsInDb: 100,
    redisEnabled: false,
  });

  const summary = formatArbitrageScanCoverageSummary(report);
  assert.ok(summary.includes("[arb-finder] scan coverage summary"));
  assert.ok(summary.includes("redis: disabled"));
});

test("prefetch batch uses mappingRedisPairKey (not pipelineMappingPairKey)", () => {
  const tokenId = "abc123";
  const ticker = "KXTEST";
  const redisKey = mappingRedisPairKey(tokenId, ticker);
  const pipelineKey = pipelineMappingPairKey(tokenId, ticker);

  assert.notEqual(redisKey, pipelineKey);
  assert.equal(redisKey, "abc123:KXTEST");
  assert.equal(pipelineKey, "pair:abc123:KXTEST");
});

console.log("\n" + "─".repeat(48));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("─".repeat(48) + "\n");

if (failed > 0) process.exit(1);
