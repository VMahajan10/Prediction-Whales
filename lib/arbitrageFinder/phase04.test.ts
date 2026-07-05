/**
 * Arbitrage Finder — Phase 4 whale identifier tests.
 *
 * Usage:
 *   npm run test:arb-phase04
 */
import assert from "node:assert/strict";
import { resolveArbIdentifiersForWhaleTrade } from "@/lib/arbitrageFinder/resolveWhaleArbIdentifiers";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import type { WhaleTrade } from "@/lib/whaleTrades";

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

const pmWhale: WhaleTrade = {
  source: "polymarket",
  assetId: "pm-token-1",
  title: "Test",
  outcome: "Yes",
  side: "BUY",
  price: 0.5,
  size: 1000,
  usdNotional: 1000,
  detectedAt: Date.now(),
  isLive: true,
  transactionHash: "0xabc",
  id: "1",
  timestamp: Date.now() / 1000,
};

const kalshiWhale: WhaleTrade = {
  ...pmWhale,
  source: "kalshi",
  ticker: "KXTEST-YES",
  assetId: undefined,
};

const pipeline: PipelineTradeEv = {
  key: "pm:pm-token-1",
  status: "ok",
  tokenId: "pm-token-1",
  kalshiTicker: "KXTEST-YES",
  netEvPercent: 2,
  netEv: 0.02,
  grossEv: 0.02,
  grossEvPercent: 2,
  pTrue: 0.55,
};

console.log("\nArbitrage Finder — Phase 4\n");

test("resolveArbIdentifiersForWhaleTrade maps polymarket whale", () => {
  const ids = resolveArbIdentifiersForWhaleTrade(pmWhale, pipeline);
  assert.equal(ids.pmTokenId, "pm-token-1");
  assert.equal(ids.kalshiTicker, "KXTEST-YES");
});

test("resolveArbIdentifiersForWhaleTrade maps kalshi whale", () => {
  const ids = resolveArbIdentifiersForWhaleTrade(kalshiWhale, pipeline);
  assert.equal(ids.pmTokenId, "pm-token-1");
  assert.equal(ids.kalshiTicker, "KXTEST-YES");
});

test("resolveArbIdentifiersForWhaleTrade falls back to trade assetId", () => {
  const ids = resolveArbIdentifiersForWhaleTrade(pmWhale, null);
  assert.equal(ids.pmTokenId, "pm-token-1");
  assert.equal(ids.kalshiTicker, null);
});

console.log("\n" + "─".repeat(48));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("─".repeat(48) + "\n");

if (failed > 0) process.exit(1);
