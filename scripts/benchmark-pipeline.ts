/**
 * Isolated mapping benchmark — compare strategies for match count vs non-zero EV coverage.
 *
 * Usage:
 *   npx tsx scripts/benchmark-pipeline.ts
 *
 * Requires OPENAI_API_KEY in .env.local (embeddings only; no DB writes).
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { countryNameToPm } from "../lib/sportsTeamMatch";
import { inferMarketCategory } from "../lib/marketCategory";
import { embedTexts, isEmbeddingConfigured, cosineSimilarity } from "../lib/evPipeline/embeddings";
import { buildNormalizedEmbeddingText } from "../lib/evPipeline/embeddingTextNormalize";
import {
  extractContractTokens,
  buildAllScoredPairs,
  greedyMatchFromPairs,
  hasCrossMarketTokenEvidence,
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
import { buildOkPipelineTradeEv } from "../lib/evPipeline/tradeEvRecord";
import {
  BROAD_SIMILARITY_THRESHOLD,
  DEFAULT_SIMILARITY_THRESHOLD,
  FALLBACK_SIMILARITY_THRESHOLD,
  MINIMUM_SIMILARITY_THRESHOLD,
  type MatchedPair,
  type NormalizedMarketContract,
} from "../lib/evPipeline/types";

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

const SPORTS_VECTOR_THRESHOLD = 0.45;

interface BenchmarkConfig {
  id: string;
  label: string;
  /** Rebuild contract text before embedding / token extraction. */
  prepareMarkets?: (
    pm: NormalizedMarketContract[],
    kalshi: NormalizedMarketContract[]
  ) => {
    pm: NormalizedMarketContract[];
    kalshi: NormalizedMarketContract[];
  };
  /** When set, sports contracts use this threshold for pure vector pairs. */
  sportsVectorThreshold?: number;
}

interface BenchmarkResult {
  config: BenchmarkConfig;
  polymarketCount: number;
  kalshiCount: number;
  embeddedCount: number;
  totalMatches: number;
  mappingPairKeys: number;
  nonZeroEvPairs: number;
  pricedPairs: number;
  lowConfidenceMatches: number;
  appliedThreshold: number;
  matchMethods: Record<string, number>;
  durationMs: number;
  sampleMatches: Array<{
    pairKey: string;
    method: string;
    score: number;
    netEvPercent: number;
    pmTitle: string;
    kalshiTitle: string;
  }>;
}

function variantANormalizeTitle(title: string): string {
  let text = title.trim().toLowerCase();
  text = text
    .replace(/\bwinner\??\b/gi, "")
    .replace(/\?+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const vs = text.match(
    /\b([a-z][a-z\s'’.\-]{1,40}?)\s+(?:vs\.?|versus|v\.?)\s+([a-z][a-z\s'’.\-]{1,40}?)\b/i
  );
  if (vs) {
    const a = countryNameToPm(vs[1].trim()) ?? vs[1].trim();
    const b = countryNameToPm(vs[2].trim()) ?? vs[2].trim();
    text = text.replace(vs[0], `${a} vs ${b}`);
  }

  return text.replace(/\s+/g, " ").trim();
}

function applyVariantANormalization(
  markets: NormalizedMarketContract[]
): NormalizedMarketContract[] {
  return markets.map((m) => {
    const title = variantANormalizeTitle(m.title);
    const description = m.description
      .toLowerCase()
      .replace(/\bwinner\??\b/gi, "")
      .replace(/\?+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return {
      ...m,
      title,
      description,
      embeddingText: buildNormalizedEmbeddingText(title, description, m.platform),
    };
  });
}

function isSportsContract(contract: NormalizedMarketContract): boolean {
  return inferMarketCategory(contract.title) === "SPORTS";
}

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

function effectivePairThreshold(
  row: ScoredCandidatePair,
  pm: NormalizedMarketContract,
  km: NormalizedMarketContract,
  baseThreshold: number,
  sportsVectorThreshold: number | undefined
): number {
  if (
    sportsVectorThreshold != null &&
    row.method === "vector" &&
    (isSportsContract(pm) || isSportsContract(km))
  ) {
    return sportsVectorThreshold;
  }
  return baseThreshold;
}

function greedyMatchWithSportsThreshold(
  pairs: ScoredCandidatePair[],
  threshold: number,
  polymarket: NormalizedMarketContract[],
  kalshi: NormalizedMarketContract[],
  pmTokens: ContractTokens[],
  kalshiTokens: ContractTokens[],
  sportsVectorThreshold: number | undefined,
  requireTokenEvidence = false
): MatchedPair[] {
  const matches: MatchedPair[] = [];
  const usedPm = new Set<number>();
  const usedKalshi = new Set<number>();

  for (const row of pairs) {
    const pm = polymarket[row.pmIndex];
    const km = kalshi[row.kalshiIndex];
    const pairThreshold = effectivePairThreshold(
      row,
      pm,
      km,
      threshold,
      sportsVectorThreshold
    );

    if (row.adjustedScore < pairThreshold) continue;

    if (requireTokenEvidence && row.method === "vector") {
      if (
        !hasCrossMarketTokenEvidence(
          pmTokens[row.pmIndex],
          kalshiTokens[row.kalshiIndex],
          row.method
        )
      ) {
        continue;
      }
    }

    if (usedPm.has(row.pmIndex) || usedKalshi.has(row.kalshiIndex)) continue;

    usedPm.add(row.pmIndex);
    usedKalshi.add(row.kalshiIndex);

    matches.push({
      polymarketTokenId: pm.tokenOrTicker,
      polymarketConditionId: pm.externalId,
      kalshiTicker: km.tokenOrTicker,
      similarity: Math.round(row.adjustedScore * 1000) / 1000,
      rawSimilarity: Math.round(row.rawScore * 1000) / 1000,
      polymarketTitle: pm.title,
      kalshiTitle: km.title,
      matchMethod: row.method,
    });
  }

  return matches;
}

function runThresholdPass(
  allPairs: ScoredCandidatePair[],
  polymarket: NormalizedMarketContract[],
  kalshi: NormalizedMarketContract[],
  threshold: number,
  pmTokens: ContractTokens[],
  kalshiTokens: ContractTokens[],
  config: BenchmarkConfig,
  requireTokenEvidence = false
): MatchedPair[] {
  if (config.sportsVectorThreshold != null) {
    return greedyMatchWithSportsThreshold(
      allPairs,
      threshold,
      polymarket,
      kalshi,
      pmTokens,
      kalshiTokens,
      config.sportsVectorThreshold,
      requireTokenEvidence
    );
  }

  return greedyMatchFromPairs(allPairs, threshold, polymarket, kalshi, {
    pmTokens,
    kalshiTokens,
    requireTokenEvidence,
  }).map(({ pair, method }) => ({
    ...pair,
    matchMethod: method,
  }));
}

function runThresholdCascade(
  allPairs: ScoredCandidatePair[],
  polymarket: NormalizedMarketContract[],
  kalshi: NormalizedMarketContract[],
  pmTokens: ContractTokens[],
  kalshiTokens: ContractTokens[],
  config: BenchmarkConfig
): { matches: MatchedPair[]; appliedThreshold: number } {
  const primaryThreshold = DEFAULT_SIMILARITY_THRESHOLD;
  let appliedThreshold = primaryThreshold;
  let matches = runThresholdPass(
    allPairs,
    polymarket,
    kalshi,
    primaryThreshold,
    pmTokens,
    kalshiTokens,
    config
  );

  if (matches.length === 0 && primaryThreshold > FALLBACK_SIMILARITY_THRESHOLD) {
    appliedThreshold = FALLBACK_SIMILARITY_THRESHOLD;
    matches = runThresholdPass(
      allPairs,
      polymarket,
      kalshi,
      appliedThreshold,
      pmTokens,
      kalshiTokens,
      config
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
      config,
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
      config,
      false
    );
    if (broadMatches.length > matches.length) {
      matches = broadMatches;
    }
  }

  return { matches, appliedThreshold };
}

function estimatePairEv(
  match: MatchedPair,
  pmByToken: Map<string, NormalizedMarketContract>,
  kalshiByTicker: Map<string, NormalizedMarketContract>
): {
  netEvPercent: number;
  priced: boolean;
  mappingPairKey: string;
} {
  const tokenId = match.polymarketTokenId.toLowerCase();
  const kalshiTicker = match.kalshiTicker.toUpperCase();
  const pairKey = pipelineMappingPairKey(tokenId, kalshiTicker);

  const pm = pmByToken.get(tokenId);
  const km = kalshiByTicker.get(kalshiTicker);
  const pmMid = midFromContract(pm);
  const kalshiMid = midFromContract(km);

  if (pmMid == null || kalshiMid == null) {
    return { netEvPercent: 0, priced: false, mappingPairKey: pairKey };
  }

  const pmEv = buildOkPipelineTradeEv({
    lookupKey: `pm:${tokenId}`,
    platform: "polymarket",
    tokenId,
    kalshiTicker,
    pTrue: kalshiMid,
    pMarket: pmMid,
  });

  const kalshiEv = buildOkPipelineTradeEv({
    lookupKey: `kalshi:${kalshiTicker}`,
    platform: "kalshi",
    tokenId,
    kalshiTicker,
    pTrue: pmMid,
    pMarket: kalshiMid,
  });

  const netEvPercent = Math.max(
    Math.abs(pmEv.netEvPercent ?? 0),
    Math.abs(kalshiEv.netEvPercent ?? 0)
  );

  return { netEvPercent, priced: true, mappingPairKey: pairKey };
}

async function runBenchmarkPass(
  snapshotPm: NormalizedMarketContract[],
  snapshotKalshi: NormalizedMarketContract[],
  config: BenchmarkConfig
): Promise<BenchmarkResult> {
  const startedAt = Date.now();

  const prepared = config.prepareMarkets
    ? config.prepareMarkets(snapshotPm, snapshotKalshi)
    : { pm: snapshotPm, kalshi: snapshotKalshi };

  const polymarketMarkets = prepared.pm;
  const kalshiMarkets = prepared.kalshi;

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
      `${config.id}: embedding mismatch (expected ${allTexts.length}, got ${embedded.vectors.length})`
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

  const { matches: vectorMatches, appliedThreshold } = runThresholdCascade(
    allPairs,
    polymarketMarkets,
    kalshiMarkets,
    pmTokens,
    kalshiTokens,
    config
  );

  const matches = mergeMatchedPairs(sportsStructureMatches, vectorMatches);

  const pmByToken = new Map(
    polymarketMarkets.map((m) => [m.tokenOrTicker.toLowerCase(), m])
  );
  const kalshiByTicker = new Map(
    kalshiMarkets.map((m) => [m.tokenOrTicker.toUpperCase(), m])
  );

  const pairKeys = new Set<string>();
  let nonZeroEvPairs = 0;
  let pricedPairs = 0;
  let lowConfidenceMatches = 0;
  const matchMethods: Record<string, number> = {};
  const sampleMatches: BenchmarkResult["sampleMatches"] = [];

  for (const match of matches) {
    const method = String(match.matchMethod ?? "unknown");
    matchMethods[method] = (matchMethods[method] ?? 0) + 1;

    if ((match.similarity ?? 0) < MINIMUM_SIMILARITY_THRESHOLD) {
      lowConfidenceMatches += 1;
    }

    const ev = estimatePairEv(match, pmByToken, kalshiByTicker);
    pairKeys.add(ev.mappingPairKey);

    if (ev.priced) pricedPairs += 1;
    if (ev.priced && ev.netEvPercent !== 0) nonZeroEvPairs += 1;

    if (sampleMatches.length < 5) {
      sampleMatches.push({
        pairKey: ev.mappingPairKey,
        method,
        score: match.similarity,
        netEvPercent: ev.netEvPercent,
        pmTitle: match.polymarketTitle,
        kalshiTitle: match.kalshiTitle,
      });
    }
  }

  return {
    config,
    polymarketCount: polymarketMarkets.length,
    kalshiCount: kalshiMarkets.length,
    embeddedCount: embedded.vectors.length,
    totalMatches: matches.length,
    mappingPairKeys: pairKeys.size,
    nonZeroEvPairs,
    pricedPairs,
    lowConfidenceMatches,
    appliedThreshold,
    matchMethods,
    durationMs: Date.now() - startedAt,
    sampleMatches,
  };
}

function printResult(result: BenchmarkResult): void {
  console.log(`\n${"─".repeat(72)}`);
  console.log(`${result.config.label} (${result.config.id})`);
  console.log(`${"─".repeat(72)}`);
  console.log(
    `Contracts: PM ${result.polymarketCount} | Kalshi ${result.kalshiCount} | embedded ${result.embeddedCount}`
  );
  console.log(`Total matches:          ${result.totalMatches}`);
  console.log(`Active mappingPairKeys: ${result.mappingPairKeys}`);
  console.log(`Priced pairs (both mids): ${result.pricedPairs}`);
  console.log(`Non-zero EV pairs:      ${result.nonZeroEvPairs}`);
  console.log(
    `Low-confidence (<${MINIMUM_SIMILARITY_THRESHOLD}): ${result.lowConfidenceMatches}`
  );
  console.log(`Applied threshold:      ${result.appliedThreshold}`);
  console.log(`Duration:               ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`Match methods:          ${JSON.stringify(result.matchMethods)}`);

  if (result.sampleMatches.length > 0) {
    console.log("Sample matches:");
    for (const row of result.sampleMatches) {
      console.log(
        `  • [${row.method} score=${row.score.toFixed(3)} EV=${row.netEvPercent.toFixed(1)}%] ${row.pairKey}`
      );
      console.log(`      PM: ${row.pmTitle.slice(0, 72)}`);
      console.log(`      KX: ${row.kalshiTitle.slice(0, 72)}`);
    }
  }
}

function printSummary(results: BenchmarkResult[]): void {
  console.log(`\n${"=".repeat(72)}`);
  console.log("SUMMARY");
  console.log(`${"=".repeat(72)}`);

  const header =
    "Strategy".padEnd(28) +
    "Matches".padStart(10) +
    "PairKeys".padStart(10) +
    "NonZeroEV".padStart(12) +
    "LowConf".padStart(10);
  console.log(header);
  console.log("-".repeat(header.length));

  for (const row of results) {
    console.log(
      row.config.label.padEnd(28) +
        String(row.totalMatches).padStart(10) +
        String(row.mappingPairKeys).padStart(10) +
        String(row.nonZeroEvPairs).padStart(12) +
        String(row.lowConfidenceMatches).padStart(10)
    );
  }

  const byNonZeroEv = [...results].sort(
    (a, b) => b.nonZeroEvPairs - a.nonZeroEvPairs
  );
  const byMatches = [...results].sort(
    (a, b) => b.totalMatches - a.totalMatches
  );

  console.log(
    `\nBest non-zero EV coverage: ${byNonZeroEv[0].config.label} (${byNonZeroEv[0].nonZeroEvPairs} pairs)`
  );
  console.log(
    `Most total matches:        ${byMatches[0].config.label} (${byMatches[0].totalMatches} pairs)`
  );

  const bestQuality = [...results].sort((a, b) => {
    const scoreA = a.nonZeroEvPairs - a.lowConfidenceMatches * 0.5;
    const scoreB = b.nonZeroEvPairs - b.lowConfidenceMatches * 0.5;
    return scoreB - scoreA;
  })[0];
  console.log(
    `Best quality-adjusted score: ${bestQuality.config.label} (nonZeroEV - 0.5×lowConf = ${(
      bestQuality.nonZeroEvPairs -
      bestQuality.lowConfidenceMatches * 0.5
    ).toFixed(1)})`
  );
}

const CONFIGS: BenchmarkConfig[] = [
  {
    id: "baseline",
    label: "Baseline (current)",
  },
  {
    id: "variantA",
    label: "Variant A (title normalize)",
    prepareMarkets: (pm, kalshi) => ({
      pm: applyVariantANormalization(pm),
      kalshi: applyVariantANormalization(kalshi),
    }),
  },
  {
    id: "variantB",
    label: "Variant B (sports vector 0.45)",
    sportsVectorThreshold: SPORTS_VECTOR_THRESHOLD,
  },
];

async function main(): Promise<void> {
  if (!isEmbeddingConfigured()) {
    console.error(
      "OPENAI_API_KEY is required. Add it to .env.local and re-run."
    );
    process.exit(1);
  }

  console.log("Pipeline mapping benchmark");
  console.log(
    `Fetching static snapshot (PM limit=${DEFAULT_PM_LIMIT}, Kalshi pages=${DEFAULT_KALSHI_MAX_PAGES})…`
  );

  const fetched = await fetchAndNormalizeMarkets({
    polymarketLimit: DEFAULT_PM_LIMIT,
    kalshiMaxPages: DEFAULT_KALSHI_MAX_PAGES,
  });

  if (fetched.failures.length > 0) {
    console.warn("Fetch warnings:", fetched.failures.map((f) => f.message));
  }

  const snapshotPm = fetched.polymarket;
  const snapshotKalshi = fetched.kalshi;

  console.log(
    `Snapshot loaded: ${snapshotPm.length} Polymarket + ${snapshotKalshi.length} Kalshi contracts`
  );

  if (snapshotPm.length === 0 || snapshotKalshi.length === 0) {
    console.error("Cannot benchmark — one or both platforms returned zero markets.");
    process.exit(1);
  }

  const results: BenchmarkResult[] = [];

  for (const config of CONFIGS) {
    console.log(`\nRunning ${config.label}…`);
    const result = await runBenchmarkPass(snapshotPm, snapshotKalshi, config);
    results.push(result);
    printResult(result);
  }

  printSummary(results);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
