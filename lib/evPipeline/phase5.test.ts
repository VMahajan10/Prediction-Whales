/**
 * Phase 5 — observability & backfill unit tests.
 *
 * Usage:
 *   npm run test:phase5
 */
import assert from "node:assert/strict";
import {
  aggregatePTrueSourceCoverage,
  dedupeLatestPTrueRows,
  formatPipelineCoverageSummary,
  type LatestPTrueRow,
} from "@/lib/evPipeline/pipelineCoverage";
import {
  isStaleEvLookupPayload,
  sealClientTradeEvPayload,
} from "@/lib/evPipeline/tradeEvRecord";

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

console.log("\nPhase 5 — observability & backfill\n");

test("dedupeLatestPTrueRows keeps newest calculated_at per token", () => {
  const rows: LatestPTrueRow[] = [
    {
      tokenId: "abc",
      kalshiTicker: "KX-A",
      sourceType: "universal_prior",
      sourceScore: 0.2,
      pTrue: 0.5,
      calculatedAt: new Date("2026-06-01"),
    },
    {
      tokenId: "abc",
      kalshiTicker: "KX-A",
      sourceType: "cross_venue_ob",
      sourceScore: 0.8,
      pTrue: 0.55,
      calculatedAt: new Date("2026-06-10"),
    },
  ];
  const latest = dedupeLatestPTrueRows(rows);
  assert.equal(latest.length, 1);
  assert.equal(latest[0]!.sourceType, "cross_venue_ob");
});

test("aggregatePTrueSourceCoverage counts high and low tiers", () => {
  const summary = aggregatePTrueSourceCoverage([
    {
      tokenId: "a",
      kalshiTicker: null,
      sourceType: "cross_venue_ob",
      sourceScore: 0.9,
      pTrue: 0.5,
      calculatedAt: new Date(),
    },
    {
      tokenId: "b",
      kalshiTicker: null,
      sourceType: "universal_prior",
      sourceScore: 0.1,
      pTrue: 0.5,
      calculatedAt: new Date(),
    },
    {
      tokenId: "c",
      kalshiTicker: null,
      sourceType: "rag_ensemble",
      sourceScore: 0.25,
      pTrue: 0.46,
      calculatedAt: new Date(),
    },
  ]);
  assert.equal(summary.highTierCount, 1);
  assert.equal(summary.lowTierCount, 1);
  assert.equal(summary.lowConfidenceScoreCount, 2);
  assert.equal(summary.bySource.cross_venue_ob, 1);
});

test("isStaleEvLookupPayload detects averageEv=0 with signed netEvPercent", () => {
  assert.equal(
    isStaleEvLookupPayload({
      key: "pm:x",
      status: "ok",
      tokenId: "x",
      kalshiTicker: null,
      netEvPercent: -43.4,
      netEv: -0.434,
      grossEv: -0.434,
      grossEvPercent: -43.4,
      averageEv: 0,
      pTrue: 0.35,
      pMarket: 0.55,
    }),
    true
  );
  assert.equal(
    isStaleEvLookupPayload(
      sealClientTradeEvPayload({
        key: "pm:ok",
        status: "ok",
        tokenId: "ok",
        kalshiTicker: null,
        netEvPercent: -12,
        netEv: -0.12,
        grossEv: -0.12,
        grossEvPercent: -12,
        averageEv: -12,
        pTrue: 0.4,
        pMarket: 0.52,
      })
    ),
    false
  );
});

test("formatPipelineCoverageSummary includes tier totals", () => {
  const text = formatPipelineCoverageSummary({
    mappingCount: 100,
    latestPTrueCount: 80,
    bySource: { cross_venue_ob: 50, rag_ensemble: 30 },
    highTierCount: 50,
    lowTierCount: 5,
    lowConfidenceScoreCount: 10,
    redisEnabled: true,
    redisLookupSample: { scanned: 20, stale: 2, ok: 17, unmapped: 1 },
  });
  assert.ok(text.includes("cross_venue_ob: 50"));
  assert.ok(text.includes("stale=2"));
});

console.log(`\n${"─".repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(48)}\n`);

if (failed > 0) {
  process.exit(1);
}
