/**
 * Phase 0–4 EV pipeline unit tests — run with:
 *   npm run test:phase0-phase1
 */
import assert from "node:assert/strict";
import { calculateTrueEV } from "@/lib/finance/evEngine";
import {
  buildPipelineTradeEvFromPTrue,
  computeTradeEvDisplay,
} from "@/lib/evPipeline/computeTradeEv";
import { EV_FORMULA_VERSION } from "@/lib/evPipeline/pTrueTypes";
import {
  canResolvePTrueAsset,
  resolvePTrueSync,
} from "@/lib/evPipeline/pTrueEnsembleResolver";
import {
  buildPipelineTradeEvFromPricing,
  computePricingPTrue,
  computeTradeEvPricing,
} from "@/lib/evPipeline/pricing";
import {
  coalesceDisplayEvPercent,
  resolvePipelineDisplayEv,
  sanitizeEvPercent,
  sealClientTradeEvPayload,
  strictApiTradeEvPayload,
  toEvDisplayPercent,
} from "@/lib/evPipeline/tradeEvRecord";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import {
  buildLooseParsedGameKey,
  isSportsMarketProbe,
  parseGameFromPmSlug,
  parseGenericPmGameSlug,
  parseVsTitleTeams,
  probeMentionsTeamToken,
} from "@/lib/evPipeline/sportsSlugParse";
import { enrichConsensusIndexWithPropKeys } from "@/lib/evPipeline/consensusIndexEnrich";
import { outcomeMatchId, type OutcomeBooks } from "@/lib/crossMarketEv";
import { inferMarketCategory } from "@/lib/marketCategory";
import { parseSportsDerivativeFromMapping } from "@/lib/evPipeline/sportsDerivativePTrue";
import {
  appendOddsHistory,
  clearOddsHistoryMemory,
  clearSimilarMarketCandidates,
  findSimilarMarkets,
  formatRagChunksForPrompt,
  retrieveMarketContext,
  setSimilarMarketCandidates,
} from "@/lib/ai/rag";
import { formatRagContextForPrompt } from "@/lib/ai/probabilityEngine";

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

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
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

function approx(a: number, b: number, eps = 0.05): void {
  assert.ok(
    Math.abs(a - b) <= eps,
    `expected ${a} ≈ ${b} (±${eps})`
  );
}

console.log("\nPhase 0 — canonical EV & contracts\n");

test("computeTradeEvDisplay uses binary_true_ev_v1 formula", () => {
  const pTrue = 0.65;
  const pMarket = 0.52;
  const display = computeTradeEvDisplay({
    pTrue,
    executionPrice: pMarket,
    platform: "polymarket",
  });
  const engine = calculateTrueEV(pTrue, pMarket, "polymarket");
  assert.equal(display.formula, EV_FORMULA_VERSION);
  approx(display.grossEv, engine.grossEv, 1e-9);
  approx(display.netEv, engine.netEv, 1e-9);
  approx(display.netEvPercent, toEvDisplayPercent(engine.netEv), 0.01);
});

test("computeTradeEvDisplay preserves negative EV (overpriced trade)", () => {
  const display = computeTradeEvDisplay({
    pTrue: 0.35,
    executionPrice: 0.59,
    platform: "polymarket",
  });
  assert.ok(display.netEvPercent < 0, `expected negative, got ${display.netEvPercent}`);
  approx(display.netEvPercent, -24, 0.2);
});

test("sanitizeEvPercent preserves negative percentages", () => {
  assert.equal(sanitizeEvPercent(-43.4), -43.4);
  assert.equal(sanitizeEvPercent(0), 0);
  assert.equal(sanitizeEvPercent(-0), 0);
});

test("coalesceDisplayEvPercent prefers netEvPercent over stale averageEv=0", () => {
  const ev = coalesceDisplayEvPercent({
    netEvPercent: -43.4,
    grossEvPercent: null,
    averageEv: 0,
  });
  assert.equal(ev, -43.4);
});

test("strictApiTradeEvPayload keeps negative netEvPercent", () => {
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

test("buildPipelineTradeEvFromPTrue returns ok with metadata", () => {
  const pTrueResult = resolvePTrueSync({
    mappingPairKey: "pair:abc:KXTEST",
    platform: "polymarket",
    pmMid: 0.48,
    kalshiMid: 0.52,
    ensemblePTrue: 0.61,
  });
  const record = buildPipelineTradeEvFromPTrue("pm:abc", pTrueResult, {
    platform: "polymarket",
    tokenId: "abc",
    kalshiTicker: "KXTEST",
    mappingPairKey: "pair:abc:KXTEST",
    executionPrice: 0.55,
  });
  assert.equal(record.status, "ok");
  assert.ok(record.pTrue != null && Number.isFinite(record.pTrue));
  assert.ok(record.netEvPercent != null && Number.isFinite(record.netEvPercent));
  assert.equal(record.evFormulaVersion, EV_FORMULA_VERSION);
  assert.ok(record.pTrueSource != null);
});

console.log("\nPhase 1 — ensemble resolver & pricing integration\n");

test("resolvePTrueSync never returns null — universal prior when fully dry", () => {
  const result = resolvePTrueSync({
    mappingPairKey: null,
    platform: "polymarket",
    pmOb: null,
    kalshiOb: null,
    pmMid: null,
    kalshiMid: null,
  });
  assert.ok(Number.isFinite(result.pTrue));
  assert.equal(result.source, "universal_prior");
  assert.ok(result.lowConfidence);
});

test("resolvePTrueSync tier 1 — cross-venue OB for paired mapping", () => {
  const result = resolvePTrueSync({
    mappingPairKey: "pair:tok:KXTICK",
    platform: "polymarket",
    pmOb: { bid: 0.44, ask: 0.46, mid: 0.45, ts: Date.now() },
    kalshiOb: { bid: 0.54, ask: 0.56, mid: 0.55, ts: Date.now() },
  });
  assert.equal(result.source, "cross_venue_ob");
  assert.ok(result.pTrue > 0.44 && result.pTrue < 0.56);
  assert.equal(result.pricingMode, "paired_cross");
});

test("resolvePTrueSync tier 3 — ensemble when OB dry", () => {
  const result = resolvePTrueSync({
    mappingPairKey: "pair:tok:KXTICK",
    platform: "polymarket",
    pmMid: null,
    kalshiMid: null,
    ensemblePTrue: 0.62,
  });
  assert.equal(result.source, "cached_ensemble");
  approx(result.pTrue, 0.62, 1e-6);
});

test("resolvePTrueSync ignores placeholder ensemble 0.5 when standalone OB exists", () => {
  const result = resolvePTrueSync({
    mappingPairKey: null,
    platform: "polymarket",
    pmOb: { bid: 0.998, ask: 0.999, mid: 0.9985, ts: Date.now() },
    ensemblePTrue: 0.5,
  });
  assert.equal(result.source, "standalone_ob");
  approx(result.pTrue, 0.9985, 1e-4);
});

test("resolvePTrueSync tier 2 — sportsbook consensus on standalone PM", () => {
  const result = resolvePTrueSync({
    mappingPairKey: null,
    platform: "polymarket",
    pmMid: null,
    kalshiMid: null,
    exchangeMid: 0.57,
  });
  assert.equal(result.source, "sportsbook_consensus");
  approx(result.pTrue, 0.57, 1e-6);
  assert.equal(result.pricingMode, "exchange_consensus");
});

test("computePricingPTrue always returns finite pTrue (no null)", () => {
  const priced = computePricingPTrue({
    mappingPairKey: null,
    platform: "kalshi",
    pmMid: null,
    kalshiMid: null,
  });
  assert.ok(Number.isFinite(priced.pTrue));
  assert.ok(priced.pTrueSource != null);
});

test("computeTradeEvPricing always returns signed EV with execution price", () => {
  const pricing = computeTradeEvPricing({
    lookupKey: "pm:whale",
    mappingPairKey: "pair:tok:KXTICK",
    platform: "polymarket",
    tokenId: "tok",
    kalshiTicker: "KXTICK",
    ensemblePTrue: 0.65,
    executionPrice: 0.59,
    pmMid: null,
    kalshiMid: null,
  });
  assert.ok(Number.isFinite(pricing.pTrue));
  assert.ok(Number.isFinite(pricing.netEvPercent));
  assert.ok(pricing.netEvPercent > 0, "underpriced vs fair should be positive EV");
  assert.equal(pricing.evFormulaVersion, EV_FORMULA_VERSION);
});

test("computeTradeEvPricing negative EV when trade overpays fair value", () => {
  const pricing = computeTradeEvPricing({
    lookupKey: "pm:overpay",
    mappingPairKey: null,
    platform: "polymarket",
    tokenId: "overpay",
    ensemblePTrue: 0.35,
    executionPrice: 0.59,
    pmMid: 0.59,
  });
  assert.ok(pricing.netEvPercent < 0, `expected negative, got ${pricing.netEvPercent}`);
});

test("buildPipelineTradeEvFromPricing always returns status ok", () => {
  const record = buildPipelineTradeEvFromPricing({
    lookupKey: "kalshi:KXDRY",
    mappingPairKey: null,
    platform: "kalshi",
    kalshiTicker: "KXDRY",
    pmMid: null,
    kalshiMid: null,
  });
  assert.equal(record.status, "ok");
  assert.ok(record.pTrue != null && Number.isFinite(record.pTrue));
  assert.ok(record.netEvPercent != null && Number.isFinite(record.netEvPercent));
});

test("canResolvePTrueAsset identifies resolvable assets", () => {
  assert.equal(canResolvePTrueAsset({ tokenId: "123" }), true);
  assert.equal(canResolvePTrueAsset({ kalshiTicker: "KXTEST" }), true);
  assert.equal(canResolvePTrueAsset({}), false);
});

test("identity trap avoided — ensemble wins over identical venue mid", () => {
  const pricing = computeTradeEvPricing({
    lookupKey: "pm:trap",
    mappingPairKey: null,
    platform: "polymarket",
    tokenId: "trap",
    ensemblePTrue: 0.65,
    executionPrice: 0.52,
    pmMid: 0.52,
  });
  assert.notEqual(pricing.pTrue, pricing.pMarket);
  approx(pricing.pTrue, 0.65, 1e-6);
});

console.log("\nPhase 2 — sports slug parse & consensus enrichment\n");

test("parseGenericPmGameSlug handles esports slugs", () => {
  const parsed = parseGenericPmGameSlug("lol-t1-geng-2026-03-15-t1");
  assert.ok(parsed);
  assert.equal(parsed!.league, "lol");
  assert.equal(parsed!.pmTeamA, "t1");
  assert.equal(parsed!.pmTeamB, "geng");
  assert.ok(parsed!.isEsports);
});

test("parseGameFromPmSlug works without Kalshi team code mapping", () => {
  const game = parseGameFromPmSlug("cs2-navi-faze-2026-04-01-navi");
  assert.ok(game);
  assert.equal(game!.pmTeamA, "navi");
  assert.equal(game!.pmTeamB, "faze");
});

test("parseVsTitleTeams extracts esports team tokens", () => {
  const teams = parseVsTitleTeams("LoL: T1 vs. Gen.G — Map 1 Winner?");
  assert.ok(teams);
  assert.ok(teams!.teamA.length >= 2);
  assert.ok(teams!.teamB.length >= 2);
});

test("isSportsMarketProbe detects esports titles", () => {
  assert.equal(
    isSportsMarketProbe(null, "CS2: NAVI vs FaZe — Match Winner"),
    true
  );
  assert.equal(inferMarketCategory("LEC Spring: G2 vs Fnatic"), "SPORTS");
});

test("parseSportsDerivativeFromMapping parses esports slug pairs", () => {
  const spec = parseSportsDerivativeFromMapping({
    polymarketTitle: "LoL: T1 vs Gen.G",
    kalshiTitle: "T1 vs GenG",
    kalshiTicker: "KXLOLGAME-T1GENG",
    slug: "lol-t1-geng-2026-03-15-t1",
  });
  assert.ok(spec);
  assert.equal(spec!.game.pmTeamA, "t1");
  assert.equal(spec!.game.pmTeamB, "geng");
});

test("enrichConsensusIndexWithPropKeys adds prop alias entries", () => {
  const game = buildLooseParsedGameKey("usa", "mex", "2026-06-15");
  const matchId = outcomeMatchId(game, "team_a");
  const index = new Map<string, OutcomeBooks>([
    [
      matchId,
      {
        game,
        outcome: "team_a",
        kalshi: null,
        polymarket: null,
        manifold: null,
        sportsbook: {
          bid: 0.44,
          ask: 0.46,
          mid: 0.45,
          spread: 0.02,
          label: "total_over 2.5",
          source: "sportsbook",
          quoteUpdatedAt: Math.floor(Date.now() / 1000),
        },
        label: "USA vs MEX total over 2.5",
      } satisfies OutcomeBooks,
    ],
  ]);

  const enriched = enrichConsensusIndexWithPropKeys(index);
  assert.ok(enriched.size > index.size);
  assert.ok(
    Array.from(enriched.keys()).some((key) => key.includes("|prop:over"))
  );
});

test("probeMentionsTeamToken matches slug tokens in titles", () => {
  const probe = "lol t1 vs geng map 1 winner";
  assert.equal(probeMentionsTeamToken(probe, "t1"), true);
  assert.equal(probeMentionsTeamToken(probe, "geng"), true);
});

test("findSimilarMarkets ranks title overlap", () => {
  clearSimilarMarketCandidates();
  setSimilarMarketCandidates([
    {
      tokenId: "a",
      kalshiTicker: "KX-A",
      title: "Lakers vs Celtics NBA Finals Game 7",
      pTrue: 0.55,
      pmMid: 0.54,
      kalshiMid: 0.56,
      sourceType: "cached_ensemble",
    },
    {
      tokenId: "c",
      kalshiTicker: "KX-C",
      title: "Warriors vs Celtics NBA playoff series",
      pTrue: 0.48,
      pmMid: null,
      kalshiMid: null,
      sourceType: "cached_ensemble",
    },
    {
      tokenId: "b",
      kalshiTicker: "KX-B",
      title: "Fed rate cut in March 2026",
      pTrue: 0.4,
      pmMid: null,
      kalshiMid: null,
      sourceType: "rag_ensemble",
    },
  ]);

  const hits = findSimilarMarkets("NBA Finals Lakers Celtics winner", "a", 2);
  assert.ok(hits.some((h) => h.tokenId === "c"));
  assert.ok(!hits.some((h) => h.tokenId === "b"));
});

test("formatRagChunksForPrompt orders by relevance", () => {
  const text = formatRagChunksForPrompt([
    {
      id: "low",
      kind: "mapping",
      title: "Low",
      body: "low relevance",
      relevance: 0.2,
    },
    {
      id: "high",
      kind: "order_book",
      title: "High",
      body: "high relevance",
      relevance: 0.9,
    },
  ]);
  assert.ok(text.indexOf("High") < text.indexOf("Low"));
  assert.equal(formatRagContextForPrompt([]), "");
});

console.log("\nPhase 3 — contextual RAG layer\n");

async function runPhase3Tests(): Promise<void> {
  await testAsync("retrieveMarketContext bundles odds history and OB snapshot", async () => {
    clearOddsHistoryMemory();
    await appendOddsHistory("tok123", {
      ts: "2026-06-01T12:00:00.000Z",
      pmMid: 0.42,
      kalshiMid: 0.44,
      marketPrior: 0.43,
      pTrue: 0.45,
    });

    const bundle = await retrieveMarketContext({
      tokenId: "tok123",
      title: "Candidate X wins 2026 election",
      pmMid: 0.41,
      kalshiMid: 0.43,
      marketPrior: 0.42,
    });

    assert.ok(bundle.chunks.some((c) => c.kind === "odds_history"));
    assert.ok(bundle.chunks.some((c) => c.kind === "order_book"));
    assert.ok(bundle.contextIds.includes("odds:tok123"));
    assert.ok(bundle.contextText.includes("Implied probability history"));
  });
}

void (async () => {
  await runPhase3Tests();

  console.log(`\n${"─".repeat(48)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"─".repeat(48)}\n`);

  if (failed > 0) {
    process.exit(1);
  }
})();
