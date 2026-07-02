/**
 * Analyze mapped pairs: true arbitrage delta vs true 0% EV vs fake 0% (missing mids).
 *
 * Usage:
 *   npx tsx scripts/check-true-zeros.ts
 *
 * Requires OPENAI_API_KEY in .env.local (embeddings only; no DB writes).
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  embedTexts,
  isEmbeddingConfigured,
  cosineSimilarity,
} from "../lib/evPipeline/embeddings";
import {
  extractContractTokens,
  buildAllScoredPairs,
  greedyMatchFromPairs,
  type ScoredCandidatePair,
  type ContractTokens,
} from "../lib/evPipeline/matchTokens";
import {
  DEFAULT_KALSHI_MAX_PAGES,
  DEFAULT_PM_LIMIT,
  fetchAndNormalizeMarkets,
} from "../lib/evPipeline/marketFetch";
import {
  matchSportsStructurePairs,
  mergeMatchedPairs,
} from "../lib/evPipeline/sportsStructureMatch";
import { pipelineMappingPairKey } from "../lib/evPipeline/crossAssetLookup";
import {
  BROAD_SIMILARITY_THRESHOLD,
  DEFAULT_SIMILARITY_THRESHOLD,
  FALLBACK_SIMILARITY_THRESHOLD,
  MINIMUM_SIMILARITY_THRESHOLD,
  type MatchedPair,
  type NormalizedMarketContract,
} from "../lib/evPipeline/types";

const EFFICIENT_MARKET_EPSILON = 0.001;

type EvBucket =
  | "true_arbitrage_delta"
  | "true_zero_ev"
  | "fake_zero_ev_missing_mids";

interface CategorizedPair {
  bucket: EvBucket;
  pairKey: string;
  pmMid: number | null;
  kalshiMid: number | null;
  midDelta: number | null;
  method: string;
  pmTitle: string;
  kalshiTitle: string;
}

function loadEnvLocal(): void {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

loadEnvLocal();

function midFromContract(
  contract: NormalizedMarketContract | undefined
): number | null {
  if (!contract) return null;
  if (contract.impliedProbability != null) return contract.impliedProbability;
  if (contract.yesBid != null && contract.yesAsk != null) {
    return (contract.yesBid + contract.yesAsk) / 2;
  }
  if (contract.yesBid != null) return contract.yesBid;
  if (contract.yesAsk != null) return contract.yesAsk;
  return null;
}

function runThresholdPass(
  allPairs: ScoredCandidatePair[],
  polymarket: NormalizedMarketContract[],
  kalshi: NormalizedMarketContract[],
  threshold: number,
  pmTokens: ContractTokens[],
  kalshiTokens: ContractTokens[],
  requireTokenEvidence = false
): MatchedPair[] {
  return greedyMatchFromPairs(allPairs, threshold, polymarket, kalshi, {
    pmTokens,
    kalshiTokens,
    requireTokenEvidence,
  }).map(({ pair, method }) => ({
    ...pair,
    matchMethod: method,
  }));
}

function runBaselineMapping(
  allPairs: ScoredCandidatePair[],
  polymarket: NormalizedMarketContract[],
  kalshi: NormalizedMarketContract[],
  pmTokens: ContractTokens[],
  kalshiTokens: ContractTokens[]
): { matches: MatchedPair[]; appliedThreshold: number } {
  const primaryThreshold = DEFAULT_SIMILARITY_THRESHOLD;
  let appliedThreshold = primaryThreshold;
  let matches = runThresholdPass(
    allPairs,
    polymarket,
    kalshi,
    primaryThreshold,
    pmTokens,
    kalshiTokens
  );

  if (matches.length === 0 && primaryThreshold > FALLBACK_SIMILARITY_THRESHOLD) {
    appliedThreshold = FALLBACK_SIMILARITY_THRESHOLD;
    matches = runThresholdPass(
      allPairs,
      polymarket,
      kalshi,
      appliedThreshold,
      pmTokens,
      kalshiTokens
    );
  }

  if (matches.length === 0 && appliedThreshold > MINIMUM_SIMILARITY_THRESHOLD) {
    appliedThreshold = MINIMUM_SIMILARITY_THRESHOLD;
    matches = runThresholdPass(
      allPairs,
      polymarket,
      kalshi,
      appliedThreshold,
      pmTokens,
      kalshiTokens,
      false
    );
  }

  if (appliedThreshold > BROAD_SIMILARITY_THRESHOLD) {
    appliedThreshold = BROAD_SIMILARITY_THRESHOLD;
    const broadMatches = runThresholdPass(
      allPairs,
      polymarket,
      kalshi,
      appliedThreshold,
      pmTokens,
      kalshiTokens,
      false
    );
    if (broadMatches.length > matches.length) {
      matches = broadMatches;
    }
  }

  return { matches, appliedThreshold };
}

function categorizePair(
  match: MatchedPair,
  pmByToken: Map<string, NormalizedMarketContract>,
  kalshiByTicker: Map<string, NormalizedMarketContract>
): CategorizedPair {
  const tokenId = match.polymarketTokenId.toLowerCase();
  const kalshiTicker = match.kalshiTicker.toUpperCase();
  const pairKey = pipelineMappingPairKey(tokenId, kalshiTicker);

  const pmMid = midFromContract(pmByToken.get(tokenId));
  const kalshiMid = midFromContract(kalshiByTicker.get(kalshiTicker));

  let bucket: EvBucket;
  let midDelta: number | null = null;

  if (pmMid == null || kalshiMid == null) {
    bucket = "fake_zero_ev_missing_mids";
  } else {
    midDelta = Math.abs(pmMid - kalshiMid);
    bucket =
      midDelta < EFFICIENT_MARKET_EPSILON
        ? "true_zero_ev"
        : "true_arbitrage_delta";
  }

  return {
    bucket,
    pairKey,
    pmMid,
    kalshiMid,
    midDelta,
    method: String(match.matchMethod ?? "unknown"),
    pmTitle: match.polymarketTitle,
    kalshiTitle: match.kalshiTitle,
  };
}

function bucketLabel(bucket: EvBucket): string {
  switch (bucket) {
    case "true_arbitrage_delta":
      return "True Arbitrage Delta";
    case "true_zero_ev":
      return "True 0.0% EV (Efficient Market)";
    case "fake_zero_ev_missing_mids":
      return "Fake 0.0% EV (Missing Data)";
  }
}

function printSummaryTable(
  categorized: CategorizedPair[],
  meta: {
    pmCount: number;
    kalshiCount: number;
    appliedThreshold: number;
    durationMs: number;
  }
): void {
  const total = categorized.length;
  const counts: Record<EvBucket, number> = {
    true_arbitrage_delta: 0,
    true_zero_ev: 0,
    fake_zero_ev_missing_mids: 0,
  };

  for (const row of categorized) {
    counts[row.bucket] += 1;
  }

  const pct = (n: number) =>
    total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0.0%";

  console.log("\n" + "=".repeat(78));
  console.log("TRUE ZERO EV ANALYSIS — Baseline Mapping Snapshot");
  console.log("=".repeat(78));
  console.log(
    `Snapshot: ${meta.pmCount} Polymarket + ${meta.kalshiCount} Kalshi contracts`
  );
  console.log(`Mapped pairs: ${total} | Applied threshold: ${meta.appliedThreshold}`);
  console.log(`Runtime: ${(meta.durationMs / 1000).toFixed(1)}s`);
  console.log(`Efficient-market epsilon: ±${EFFICIENT_MARKET_EPSILON}`);

  const colBucket = 42;
  const colCount = 8;
  const colPct = 8;
  console.log("\n" + "-".repeat(colBucket + colCount + colPct + 4));
  console.log(
    "Bucket".padEnd(colBucket) +
      "Count".padStart(colCount) +
      "Share".padStart(colPct)
  );
  console.log("-".repeat(colBucket + colCount + colPct + 4));

  const order: EvBucket[] = [
    "true_arbitrage_delta",
    "true_zero_ev",
    "fake_zero_ev_missing_mids",
  ];

  for (const bucket of order) {
    console.log(
      bucketLabel(bucket).padEnd(colBucket) +
        String(counts[bucket]).padStart(colCount) +
        pct(counts[bucket]).padStart(colPct)
    );
  }

  console.log("-".repeat(colBucket + colCount + colPct + 4));
  console.log(
    "Total mapped pairs".padEnd(colBucket) +
      String(total).padStart(colCount) +
      (total > 0 ? "100.0%" : "0.0%").padStart(colPct)
  );

  console.log("\nInterpretation:");
  console.log(
    `  • True Arbitrage Delta: both venues priced — mids differ by ≥ ${EFFICIENT_MARKET_EPSILON}`
  );
  console.log(
    `  • True 0.0% EV: both mids exist and are aligned (|Δ| < ${EFFICIENT_MARKET_EPSILON})`
  );
  console.log(
    "  • Fake 0.0% EV: mapping succeeded but pmMid and/or kalshiMid unavailable"
  );

  for (const bucket of order) {
    const samples = categorized.filter((row) => row.bucket === bucket).slice(0, 3);
    if (samples.length === 0) continue;

    console.log(`\nSample — ${bucketLabel(bucket)}:`);
    for (const row of samples) {
      const delta =
        row.midDelta != null ? `Δ=${row.midDelta.toFixed(4)}` : "Δ=n/a";
      const pm =
        row.pmMid != null ? `pm=${row.pmMid.toFixed(4)}` : "pm=—";
      const kx =
        row.kalshiMid != null ? `kx=${row.kalshiMid.toFixed(4)}` : "kx=—";
      console.log(`  • [${row.method}] ${row.pairKey} (${pm}, ${kx}, ${delta})`);
      console.log(`      PM: ${row.pmTitle.slice(0, 70)}`);
      console.log(`      KX: ${row.kalshiTitle.slice(0, 70)}`);
    }
  }

  console.log("");
}

async function main(): Promise<void> {
  if (!isEmbeddingConfigured()) {
    console.error(
      "OPENAI_API_KEY is required. Add it to .env.local and re-run."
    );
    process.exit(1);
  }

  const startedAt = Date.now();

  console.log("Loading market snapshot…");
  const fetched = await fetchAndNormalizeMarkets({
    polymarketLimit: DEFAULT_PM_LIMIT,
    kalshiMaxPages: DEFAULT_KALSHI_MAX_PAGES,
  });

  if (fetched.failures.length > 0) {
    console.warn("Fetch warnings:", fetched.failures.map((f) => f.message));
  }

  const polymarketMarkets = fetched.polymarket;
  const kalshiMarkets = fetched.kalshi;

  if (polymarketMarkets.length === 0 || kalshiMarkets.length === 0) {
    console.error("Cannot analyze — one or both platforms returned zero markets.");
    process.exit(1);
  }

  console.log(
    `Running baseline mapping on ${polymarketMarkets.length} PM + ${kalshiMarkets.length} Kalshi contracts…`
  );

  const sportsStructureMatches = matchSportsStructurePairs(
    polymarketMarkets,
    kalshiMarkets
  );

  const pmTokens = polymarketMarkets.map(extractContractTokens);
  const kalshiTokens = kalshiMarkets.map(extractContractTokens);

  const allTexts = [
    ...polymarketMarkets.map((m) => m.embeddingText),
    ...kalshiMarkets.map((m) => m.embeddingText),
  ];

  const embedded = await embedTexts(allTexts);
  if (embedded.vectors.length !== allTexts.length) {
    throw new Error(
      `Embedding mismatch (expected ${allTexts.length}, got ${embedded.vectors.length})`
    );
  }

  const pmVectors = embedded.vectors.slice(0, polymarketMarkets.length);
  const kalshiVectors = embedded.vectors.slice(polymarketMarkets.length);

  const allPairs = buildAllScoredPairs(
    pmVectors,
    kalshiVectors,
    pmTokens,
    kalshiTokens,
    cosineSimilarity
  );

  const { matches: vectorMatches, appliedThreshold } = runBaselineMapping(
    allPairs,
    polymarketMarkets,
    kalshiMarkets,
    pmTokens,
    kalshiTokens
  );

  const matches = mergeMatchedPairs(sportsStructureMatches, vectorMatches);

  const pmByToken = new Map(
    polymarketMarkets.map((m) => [m.tokenOrTicker.toLowerCase(), m])
  );
  const kalshiByTicker = new Map(
    kalshiMarkets.map((m) => [m.tokenOrTicker.toUpperCase(), m])
  );

  const categorized = matches.map((match) =>
    categorizePair(match, pmByToken, kalshiByTicker)
  );

  printSummaryTable(categorized, {
    pmCount: polymarketMarkets.length,
    kalshiCount: kalshiMarkets.length,
    appliedThreshold,
    durationMs: Date.now() - startedAt,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
