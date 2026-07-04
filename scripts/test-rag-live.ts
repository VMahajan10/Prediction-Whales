/**
 * Live RAG + OpenAI integration smoke test.
 *
 * Usage:
 *   npm run test:rag-live
 *
 * Requires OPENAI_API_KEY (or AI_GATEWAY_API_KEY) in .env.local or .env.
 * Does not write to DB. Makes one real LLM call via fetchMarketSentiment.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  appendOddsHistory,
  clearOddsHistoryMemory,
  computeRagPTrue,
  retrieveMarketContext,
  setSimilarMarketCandidates,
} from "../lib/ai/rag";

function loadEnvFile(filename: string): void {
  const path = join(process.cwd(), filename);
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

loadEnvFile(".env");
loadEnvFile(".env.local");

const hasOpenAi = !!process.env.OPENAI_API_KEY?.trim();
const hasGateway = !!process.env.AI_GATEWAY_API_KEY?.trim();
const model = process.env.PROBABILITY_LLM_MODEL ?? "gpt-4o";

function fmtPct(p: number): string {
  return `${(p * 100).toFixed(2)}%`;
}

async function main(): Promise<void> {
  console.log("\n── RAG live integration test ──\n");

  console.log("Environment:");
  console.log(`  OPENAI_API_KEY:     ${hasOpenAi ? "set ✓" : "missing ✗"}`);
  console.log(`  AI_GATEWAY_API_KEY: ${hasGateway ? "set ✓" : "missing ✗"}`);
  console.log(`  PROBABILITY_LLM_MODEL: ${model}`);

  if (!hasOpenAi && !hasGateway) {
    console.error(
      "\nNo LLM API key found. Add OPENAI_API_KEY to .env.local and re-run.\n"
    );
    process.exit(1);
  }

  const tokenId = "rag-smoke-test-token";
  const title = "Will the Lakers beat the Celtics in Game 7 of the 2026 NBA Finals?";
  const marketPrior = 0.52;

  clearOddsHistoryMemory();
  await appendOddsHistory(tokenId, {
    ts: "2026-06-10T18:00:00.000Z",
    pmMid: 0.48,
    kalshiMid: 0.5,
    marketPrior: 0.49,
    pTrue: 0.47,
  });
  await appendOddsHistory(tokenId, {
    ts: "2026-06-11T18:00:00.000Z",
    pmMid: 0.51,
    kalshiMid: 0.53,
    marketPrior: 0.52,
    pTrue: null,
  });

  setSimilarMarketCandidates([
    {
      tokenId: "similar-nba-001",
      kalshiTicker: "KX-NBA-LAL",
      title: "Lakers vs Celtics NBA Finals — series winner",
      pTrue: 0.54,
      pmMid: 0.53,
      kalshiMid: 0.55,
      sourceType: "cached_ensemble",
    },
    {
      tokenId: "similar-fed-001",
      kalshiTicker: "KX-FED-MAR",
      title: "Fed cuts rates in March 2026",
      pTrue: 0.38,
      pmMid: null,
      kalshiMid: null,
      sourceType: "rag_ensemble",
    },
  ]);

  console.log("\n1) Retrieval (no LLM)…");
  const bundle = await retrieveMarketContext({
    tokenId,
    title,
    pmMid: 0.51,
    kalshiMid: 0.53,
    exchangeMid: 0.5,
    marketPrior,
  });
  console.log(`  Chunks retrieved: ${bundle.chunks.length}`);
  for (const chunk of bundle.chunks) {
    console.log(`    - [${chunk.kind}] ${chunk.title} (${chunk.id})`);
  }
  const hasOdds = bundle.chunks.some((c) => c.kind === "odds_history");
  const hasSimilar = bundle.chunks.some((c) => c.kind === "similar_market");
  if (!hasOdds || !hasSimilar) {
    console.error("\n  ✗ Retrieval missing expected chunk types.");
    process.exit(1);
  }
  console.log("  ✓ Retrieval OK (odds history + similar markets present)");

  console.log("\n2) RAG ensemble (LLM call)…");
  const started = Date.now();
  const result = await computeRagPTrue({
    tokenId,
    title,
    pmMid: 0.51,
    kalshiMid: 0.53,
    exchangeMid: 0.5,
    marketPrior,
    supplementalContext:
      "Injury report: Lakers star listed questionable. Celtics on 3-day rest. Public money leaning Lakers.",
  });
  const ms = Date.now() - started;

  const { engine } = result;
  const llmOk = engine.sentiment.source === "llm" && !engine.usedFallback;

  console.log(`  Latency: ${ms}ms`);
  console.log(`  Context ids: ${result.contextIds.join(", ")}`);
  console.log(`  Market prior: ${fmtPct(marketPrior)}`);
  console.log(`  p_true (RAG): ${fmtPct(engine.pTrue)}`);
  console.log(`  Source score: ${engine.sourceScore.toFixed(3)}`);
  console.log(`  Sentiment source: ${engine.sentiment.source}`);
  console.log(`  Sentiment impact: ${engine.sentiment.impactScore.toFixed(3)}`);
  console.log(`  Sentiment reliability: ${engine.sentiment.reliability.toFixed(3)}`);
  console.log(`  Reasoning: ${engine.sentiment.reasoning.slice(0, 200)}`);
  console.log(`  Used fallback: ${engine.usedFallback ? "yes ✗" : "no ✓"}`);
  console.log(`  Contributors: ${engine.contributors.length}`);

  const movedFromPrior = Math.abs(engine.pTrue - marketPrior) > 0.001;

  console.log("\n── Verdict ──");
  if (llmOk && movedFromPrior) {
    console.log(
      "  ✓ RAG is working: OpenAI graded retrieved context and shifted p_true from the prior."
    );
    process.exit(0);
  }
  if (llmOk && !movedFromPrior) {
    console.log(
      "  ~ LLM responded but p_true equals prior (neutral context grading). RAG plumbing OK."
    );
    process.exit(0);
  }
  console.log(
    "  ✗ LLM did not run successfully — check OPENAI_API_KEY, billing, and server logs."
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("\nRAG live test failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
