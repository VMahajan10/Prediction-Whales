/**
 * Phase 4 — frontend / API EV display contract tests.
 *
 * Usage:
 *   npm run test:phase4
 */
import assert from "node:assert/strict";
import {
  coalesceDisplayEvPercent,
  pipelineEvTooltip,
  resolveDetailPanelDisplayEv,
  resolvePipelineDisplayEv,
  sanitizeEvPercent,
  sealClientTradeEvPayload,
  strictApiTradeEvPayload,
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

console.log("\nPhase 4 — frontend contract & API sealing\n");

test("coalesceDisplayEvPercent prefers netEvPercent over stale averageEv=0", () => {
  const ev = coalesceDisplayEvPercent({
    netEvPercent: -43.4,
    grossEvPercent: null,
    averageEv: 0,
  });
  assert.equal(ev, -43.4);
});

test("sanitizeEvPercent preserves negative percentages", () => {
  assert.equal(sanitizeEvPercent(-43.4), -43.4);
});

test("strictApiTradeEvPayload keeps negative netEvPercent and syncs averageEv", () => {
  const payload = strictApiTradeEvPayload({
    key: "pm:test",
    status: "ok",
    tokenId: "123",
    kalshiTicker: null,
    netEvPercent: -18.5,
    netEv: -0.185,
    grossEv: -0.185,
    grossEvPercent: -18.5,
    averageEv: 0,
    pTrue: 0.35,
    pMarket: 0.535,
  });
  assert.equal(payload.netEvPercent, -18.5);
  assert.equal(payload.averageEv, -18.5);
});

test("resolvePipelineDisplayEv prefers netEvPercent over stale averageEv=0", () => {
  const display = resolvePipelineDisplayEv({
    key: "pm:test",
    status: "ok",
    tokenId: "123",
    kalshiTicker: null,
    netEvPercent: -12.3,
    netEv: -0.123,
    grossEv: -0.123,
    grossEvPercent: -12.3,
    averageEv: 0,
    pTrue: 0.41,
    pMarket: 0.533,
    pTrueLowConfidence: true,
    pTrueSource: "universal_prior",
  });
  assert.ok(display);
  assert.equal(display!.netEvPercent, -12.3);
  assert.equal(display!.lowConfidence, true);
  assert.equal(display!.pTrueSource, "universal_prior");
});

test("resolvePipelineDisplayEv returns null for unmapped payloads", () => {
  assert.equal(
    resolvePipelineDisplayEv({
      key: "pm:missing",
      status: "unmapped",
      tokenId: null,
      kalshiTicker: null,
      netEvPercent: null,
      netEv: 0,
      grossEv: 0,
      grossEvPercent: null,
    }),
    null
  );
});

test("resolveDetailPanelDisplayEv coalesces netEvPercent without status ok", () => {
  const display = resolveDetailPanelDisplayEv({
    key: "pm:pending",
    status: "ok",
    tokenId: "tok",
    kalshiTicker: null,
    netEvPercent: -1.1,
    netEv: -0.011,
    grossEv: -0.011,
    grossEvPercent: -1.1,
    averageEv: 0,
    pTrue: null,
    pTrueLowConfidence: true,
    pTrueSource: "universal_prior",
  });
  assert.ok(display);
  assert.equal(display!.netEvPercent, -1.1);
  assert.equal(display!.lowConfidence, true);
});

test("resolveDetailPanelDisplayEv derives signed EV from p_true + execution price", () => {
  const display = resolveDetailPanelDisplayEv(
    {
      key: "kalshi:KX-TEST",
      status: "ok",
      tokenId: null,
      kalshiTicker: "KX-TEST",
      netEvPercent: null,
      netEv: 0,
      grossEv: 0,
      grossEvPercent: null,
      averageEv: 0,
      pTrue: 0.45,
      pMarket: 0.5,
      pTrueLowConfidence: false,
      pTrueSource: "universal_prior",
    },
    0.456
  );
  assert.ok(display);
  assert.ok(display!.netEvPercent < 0, `expected negative EV, got ${display!.netEvPercent}`);
});

test("sealClientTradeEvPayload aligns averageEv with netEvPercent", () => {
  const sealed = sealClientTradeEvPayload({
    key: "pm:seal",
    status: "ok",
    tokenId: "seal",
    kalshiTicker: "KX-SEAL",
    netEvPercent: 8.2,
    netEv: 0.082,
    grossEv: 0.082,
    grossEvPercent: 8.2,
    averageEv: 0,
    pTrue: 0.58,
    pMarket: 0.5,
    pTrueSource: "cross_venue_ob",
  });
  assert.equal(sealed.netEvPercent, 8.2);
  assert.equal(sealed.averageEv, 8.2);
});

test("pipelineEvTooltip includes low-confidence and source metadata", () => {
  const display = resolvePipelineDisplayEv({
    key: "pm:tip",
    status: "ok",
    tokenId: "tip",
    kalshiTicker: null,
    netEvPercent: 5,
    netEv: 0.05,
    grossEv: 0.05,
    grossEvPercent: 5,
    pTrue: 0.55,
    pMarket: 0.5,
    pTrueLowConfidence: true,
    pTrueSource: "rag_ensemble",
    evFormulaVersion: "binary_true_ev_v1",
  });
  assert.ok(display);
  const tip = pipelineEvTooltip(
    {
      key: "pm:tip",
      status: "ok",
      tokenId: "tip",
      kalshiTicker: null,
      netEvPercent: 5,
      netEv: 0.05,
      grossEv: 0.05,
      grossEvPercent: 5,
      pTrue: 0.55,
      pMarket: 0.5,
      pTrueLowConfidence: true,
      pTrueSource: "rag_ensemble",
      evFormulaVersion: "binary_true_ev_v1",
    },
    display!
  );
  assert.ok(tip.includes("rag_ensemble"));
  assert.ok(tip.includes("low-confidence"));
});

console.log(`\n${"─".repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(48)}\n`);

if (failed > 0) {
  process.exit(1);
}
